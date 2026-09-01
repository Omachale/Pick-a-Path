/**
 * Sky Path — the maze-guide game mode, as a mountable module.
 *
 * Extracted verbatim from the standalone prototype (prototype-threejs/src/
 * main.js), which was a module-scope script that owned the whole page: it
 * appended its canvas to document.body, sized itself from window.innerWidth,
 * read its fork sequence out of location.search, and imported Supabase
 * directly to sync choices. All four of those are now caller concerns.
 *
 * The rule this file exists to enforce: **Sky Path knows nothing about the
 * network, the lobby, or the URL.** It takes options in and hands events
 * back out. That is what lets the session layer own the round (mount on
 * 'playing', unmount on 'results', rotate the guide between rounds) and what
 * will let a second game mode slot in beside it without touching this file.
 *
 * Boundary note: this module owns its canvas *and* its own in-game HUD
 * (the fork buttons, hint line, character select), injecting that markup
 * into the container itself rather than exposing it to React. React owns
 * everything outside the game surface — join, lobby, grouping, results.
 * Keeping the in-game chrome here keeps the game module self-contained and
 * portable, and avoids a per-frame React render for a HUD that updates from
 * the animation loop.
 *
 * Choosing is deliberately *not* applied locally. When the player taps, this
 * module calls `onForkChoice` and changes nothing; the owner decides and
 * calls `applyChoice()` back. In solo play the owner applies it
 * immediately; in a room it goes via the relay so every device applies the
 * same choice in the same order — see TODO.md, "a player taps, the guide
 * cannot".
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { SKY_PATH_CHROME, SKY_PATH_CSS } from './chrome.js';
import { attachCrowdHarness } from './crowdHarness.js';
import { attachBgTuner } from './bgTuner.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buildIsland } from './islandGen.js';
import { buildNameTagCanvas, normalizePlayerName } from './nameTag.js';
import { buildBridge, disposeBridge, BRIDGE_DEFAULTS, BRIDGE_ANCHORS } from './bridgeGen.js';
import { createBridgeWind } from './bridgeWind.js';

// Rapier ships as WASM and needs an async init before any RAPIER.* class can
// be used. Module-scope so it happens once per page load, not once per mount.
await RAPIER.init();

/**
 * @param {HTMLElement} container  sized by its own CSS; the canvas fills it
 * @param {object} options
 * @param {string|null} options.forks       'LRLLRR' — one L/R per fork; null = random
 * @param {'guide'|'player'} options.role   which layer of information to show
 * @param {boolean} options.canAct          whether this device shows the fork buttons
 * @param {(forkIndex: number, side: 'left'|'right') => void} options.onForkChoice
 * @param {(result: {success: boolean, forkIndex: number, correctCount: number}) => void} options.onRoundEnd
 * @returns {{applyChoice: Function, reset: Function, dispose: Function}}
 */
export function mountSkyPath(container, options = {}) {
  const {
    forks: forksOverride = null,
    role: initialRole = 'guide',
    canAct = true,
    onForkChoice = null,
    onRoundEnd = null,
    crowd = 0,
  } = options;

  container.classList.add('skypath-surface');
  container.innerHTML = SKY_PATH_CHROME;
  if (!document.getElementById('skypath-css')) {
    const style = document.createElement('style');
    style.id = 'skypath-css';
    style.textContent = SKY_PATH_CSS;
    document.head.appendChild(style);
  }
  const $ = (id) => container.querySelector('#' + id);

  let disposed = false;
  let rafId = null;

  const T_START = performance.now();

  // ---------------------------------------------------------------- journey shape
  //
  // The path is generated as a chain of straight legs (a "trunk" leading to a
  // fork, then a "branch" out of it) advancing from a running cursor of
  // {x, z, heading}. heading 0 means "walking toward -Z", which is also the
  // direction the temple sits in. The choice made at each fork determines the
  // heading of everything downstream, and the route is built **one fork at a
  // time** as those choices are made rather than all up front — see the journey
  // section further down for why that matters for fairness, not just memory.

  const N_FORKS = 6; // fixed for a given round; would come from teacher setup in a real build
  // Each branch's turn off centre. This was 12° for as long as branches led to
  // *different* destinations, "kept tight so a run of same-direction picks
  // can't build up a big drift" — that reason died with converging branches
  // (Step 4): both sides now land on the same target whichever is picked, so
  // lateral drift is set entirely by templeHeading()/HEADING_CORRECTION and
  // this angle contributes none of it.
  //
  // What it *does* now control is how far apart the two branches are where
  // they meet an island: 2 * ISLAND_RADIUS * sin(angle) between their two
  // edge points. At 12° that came to 2.49 units against a paved path width of
  // ~2.45 — i.e. the two paths were touching at their widest before any
  // curvature was applied at all, which is half of why they never read as two
  // separate routes (the other half was the crossing bug, see genForkCurve).
  // This is why the angle has to move whenever ISLAND_RADIUS does: shrinking
  // the island shrinks this same gap right along with it (both scale with
  // ISLAND_RADIUS), so the angle is re-picked each time to keep it — see
  // FORK_PINCH_WIDTH below, which the two are tuned together against.
  const FORK_HALF_ANGLE = THREE.MathUtils.degToRad(30);
  const HEADING_CORRECTION = 0.7; // how strongly the trunk after a branch re-aims at the temple (0 = keep the branch's heading, 1 = point straight at it) — see templeHeading()
  const TRUNK_SEGMENTS = 4;
  const BRANCH_SEGMENTS = 3;

  // World scale: the island is the base unit, and path spacing derives from
  // it — not the other way around. This used to run backwards (TEMPLE_DISTANCE
  // was picked first, path lengths derived from it, and island size was a
  // separate number chosen by eye), and the two collided: islands ended up
  // wider than the spacing meant to hold them. The island's size is authored
  // art (Blender) and about to have stones relate to its edge too, so it
  // drives everything else now. See TODO.md "World scale rework" for the full
  // reasoning. ISLAND_RADIUS must match the deck's own scale target
  // (ISLAND_TARGET_RADIUS, set from this same constant further down).
  const ISLAND_RADIUS = 4; // world units — was 6; shrunk by a third, 2026-08-28. See FORK_HALF_ANGLE/FORK_PINCH_WIDTH above and below: both were re-tuned alongside this, since the gap they carve between the two branches at an island scales with ISLAND_RADIUS too and would otherwise have closed to overlapping.
  const ISLAND_PATH_GAP = 8; // visible gap between two islands' *edges* — the one real pacing knob
  const FORK_DISTANCE = 2 * ISLAND_RADIUS + ISLAND_PATH_GAP; // forward distance, fork centre to fork centre

  // The character, separately, was shrunk for a sense of scale — but "the
  // world is big" has to mean the *world* is big relative to a normal-sized
  // person, not that the person has shrunk inside a normal-sized world. That
  // distinction matters concretely: it means a stone must stay the same size
  // relative to the character it always was — shrinking both together would
  // just be zooming out, not scale — while the island and path, which really
  // are meant to be huge, correctly do *not* carry this factor (an earlier
  // pass wrongly reasoned the opposite way round; corrected 2026-08-27).
  // FIGURE_SCALE is applied to the character (FIGURE_H below) and to
  // anything sized *relative to the character* rather than relative to the
  // world — currently just STONE_SIZE.
  const FIGURE_SCALE = 0.72;

  // CRUISE_FRACTION is how much of the whole trip the N_FORKS ordinary forks
  // cover; the gap between CRUISE_FRACTION and STOP_FRACTION is the dramatic
  // final close-in walked only on a correct last pick (see choose()); the
  // last (1 - STOP_FRACTION) is just clearance so the camera never ends up
  // clipped into the temple's plane. TEMPLE_DISTANCE is a *result*, not an
  // input: whatever distance makes CRUISE_FRACTION of the trip equal
  // N_FORKS * FORK_DISTANCE. The temple is a backdrop billboard, so it is
  // free to move without needing its own scale re-tuned.
  const CRUISE_FRACTION = 0.75;
  const STOP_FRACTION = 0.9;
  const CRUISE_DISTANCE = N_FORKS * FORK_DISTANCE;
  const TEMPLE_DISTANCE = CRUISE_DISTANCE / CRUISE_FRACTION; // straight-line world distance from spawn to the temple
  const APPROACH_DISTANCE = TEMPLE_DISTANCE * (STOP_FRACTION - CRUISE_FRACTION);

  // Trunk:branch pacing shape (branch slightly longer than trunk) — only the
  // ratio matters here, the absolute scale is fixed below by CRUISE_DISTANCE.
  const ROUND_SHAPE_TRUNK = 6.0;
  const ROUND_SHAPE_BRANCH = 6.5;
  const ROUND_UNIT = ROUND_SHAPE_TRUNK + ROUND_SHAPE_BRANCH * Math.cos(FORK_HALF_ANGLE);
  const ROUND_SCALE = CRUISE_DISTANCE / (N_FORKS * ROUND_UNIT);
  const TRUNK_LEN = ROUND_SHAPE_TRUNK * ROUND_SCALE;
  const BRANCH_LEN = ROUND_SHAPE_BRANCH * ROUND_SCALE;

  // Converging branches (Step 4, added 2026-08-27, reworked 2026-08-28 — see
  // TODO.md "Fork branches: both routes lead to the same island"): both
  // branches of a fork now curve all the way to the *same* next island,
  // rather than heading off to two separate destinations. This is what makes
  // island positions deterministic — the next island's position no longer
  // depends on which side the player picks — which the planned intro camera
  // move needs (it has to know where every island in the round will be
  // before the player has chosen anything).
  //
  // Each branch covers the fork's *entire* forward span to the next island —
  // `FORK_DISTANCE`, not some shorter branch-only distance — because the two
  // branches used to converge onto a single shared line partway there, with
  // a separate plain trunk carrying that one line the rest of the way in.
  // Luke's call, 2026-08-28: that read as the two paths becoming one before
  // they'd actually arrived. The fix is symmetry — arrival should mirror
  // departure, staying two separate lines the whole way and only joining on
  // the *next* island's own deck, exactly as they only separated on *this*
  // one's. See genForkCurve() below for the shape that produces; there is no
  // separate "trunk" phase for forks any more (TRUNK_LEN/TRUNK_SEGMENTS
  // remain in use for the intro walk to fork 1 only, which has no branching
  // to mirror).
  const FORK_CURVE_SEGMENTS = 8; // waypoints per branch past the island's edge — enough to read as a curve, not a kink

  // Where each branch meets an island, in that island's own local frame:
  // EDGE_LATERAL to its own side of the centreline, EDGE_FORWARD along the
  // island's heading. Both edge points (leaving one island, reaching the
  // next) use the same pair — see genForkCurve.
  const EDGE_LATERAL = ISLAND_RADIUS * Math.sin(FORK_HALF_ANGLE); // 2.0 at 30°/R4 — half the gap between the two branches at an island
  const EDGE_FORWARD = ISLAND_RADIUS * Math.cos(FORK_HALF_ANGLE);

  // Pinches the two branches *toward* each other at their midpoint, not away
  // — the opposite of a lens/eye shape. Luke's illustration, 2026-08-28: the
  // two lines should read as curving toward one another without ever
  // touching, each still landing on its own separate point on the next
  // island — an hourglass waist, not a bulge.
  //
  // The budget this has to live inside: the branches are 2 * EDGE_LATERAL
  // (3.96) apart at each island, and each is ~2.45 wide once paved (see
  // PATH_WIDTH/STONE_COLS/STONE_SIZE), leaving ~1.5 units of daylight there.
  // Each unit of pinch closes that gap by 2. At 0.5 the waist keeps ~0.5
  // units of daylight — tighter than before ISLAND_RADIUS shrank (that
  // shrink took the whole budget down with it, both ends scaling with
  // ISLAND_RADIUS via EDGE_LATERAL), but still positive. Matching the
  // *proportions* of the illustration (waist roughly half the end gap) would
  // need to close this further still and would put the two paved paths in
  // contact — that isn't a tuning problem but a width one, and belongs with
  // the 3D stones work, which is what actually sets how wide a path is.
  const FORK_PINCH_WIDTH = 0.5;

  // The wrong branch is generated with the exact same curve as a correct one
  // would be (see genForkCurve) and only diverges from it by being cut short.
  // Both fractions are of the *branch's own total length*, measured via
  // truncateAtFraction() below rather than assumed. At this geometry the fog
  // curtain (CURTAIN_DIST, below) sits at roughly 40% along the branch and
  // the mirrored arrival edge — where the branch reaches the next island —
  // at roughly 70%; these two fractions sit in the open-air gap between
  // those two landmarks, comfortably past the curtain and comfortably short
  // of the island. Stones stop at WRONG_GAP_FRACTION — the gap the
  // player falls through; the queue (and so the fall trigger, see the main
  // loop's `leg.queue.length === 0` case) runs a little further, to
  // WRONG_FALL_FRACTION, so the last stride is onto bare air inside the fog
  // rather than a wall stopping dead at the last stone.
  const WRONG_GAP_FRACTION = 0.6;
  const WRONG_FALL_FRACTION = 0.68;

  // Correct side is randomised per fork — including runs of the same side
  // (left,left,left,... etc). The heading-correction step above pulls the
  // world-absolute heading back toward 0 after every fork regardless of which
  // side was taken, so a same-direction streak damps out rather than
  // compounding; nothing here assumes an alternating pattern.
  //
  // For testing a specific pattern (e.g. an all-left run to check how the path
  // visuals handle a strong sideways veer), append ?forks=LLLRRR to the URL —
  // one L/R per fork, case-insensitive, missing/extra forks fall back to
  // random. Example: index.html?forks=LLLLLL
  function genCorrectSequence() {
    const override = forksOverride;
    return Array.from({ length: N_FORKS }, (_, i) => {
      const forced = override?.[i]?.toUpperCase();
      if (forced === 'L') return 'left';
      if (forced === 'R') return 'right';
      return Math.random() < 0.5 ? 'left' : 'right';
    });
  }
  const CORRECT_BY_FORK = genCorrectSequence();

  // Fork 1 = dawn, last fork = dusk, evenly spread between. Also doubles as the
  // sun's position parameter: 0 = dawn horizon, 1 = dusk horizon.
  function timeOfDay(forkIdx1) {
    return N_FORKS <= 1 ? 0.5 : (forkIdx1 - 1) / (N_FORKS - 1);
  }
  function timeLabel(p) {
    if (p < 0.15) return 'Dawn';
    if (p < 0.4) return 'Morning';
    if (p < 0.6) return 'Midday';
    if (p < 0.85) return 'Afternoon';
    return 'Dusk';
  }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.z - b.z);
  }
  function pathLength(pts) {
    let s = 0;
    for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
    return s;
  }

  /** Unit-ish forward vector for a heading, scaled by d. heading 0 = -Z. */
  function forward(heading, d) {
    return { x: Math.sin(heading) * d, z: -Math.cos(heading) * d };
  }
  function advance(pos, heading, d) {
    const f = forward(heading, d);
    return { x: pos.x + f.x, z: pos.z + f.z };
  }
  /** A straight run of `segments` waypoints from `from`, `len` total, along `heading`. */
  function genStraight(from, heading, len, segments) {
    const pts = [];
    for (let i = 1; i <= segments; i++) pts.push(advance(from, heading, (len * i) / segments));
    return pts;
  }

  /**
   * The sin(pi*t)-pinched run of `segments` waypoints from `fromPt` to
   * `toPt`. `sideSign` is the side this branch departed on (+1 right, -1
   * left, matching genForkCurve) — the curve pinches *toward the opposite
   * side* (negative of its own side) at its midpoint, tapering back to
   * exactly `sideSign`'s own straight line at both ends. Ends exactly on
   * `toPt`.
   */
  function genBowPoints(fromPt, toPt, sideSign, segments) {
    const dx = toPt.x - fromPt.x;
    const dz = toPt.z - fromPt.z;
    const legHeading = Math.atan2(dx, -dz);
    const pts = [];
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const pinchAmt = -FORK_PINCH_WIDTH * Math.sin(Math.PI * t) * sideSign;
      const off = forward(legHeading + Math.PI / 2, pinchAmt);
      pts.push({ x: fromPt.x + dx * t + off.x, z: fromPt.z + dz * t + off.z });
    }
    return pts;
  }

  /**
   * One fork branch: straight from `cursor` to the island's edge along
   * cursor.heading ± FORK_HALF_ANGLE (sideSign = +1 right, -1 left), then a
   * bowed curve (genBowPoints, above) onward.
   *
   * `mirrorArrival` picks which of two shapes that curve takes, and is false
   * only for the last fork of a round (there is no next island to mirror
   * into there — `target` is just the point the final approach to the temple
   * starts from):
   *  - **true** (every fork but the last): the curve runs to the *matching*
   *    edge point of the `target` island — mirrored the same way, off
   *    target.heading — then one final straight step onto `target` itself.
   *    Arrival mirrors departure on purpose (Luke, 2026-08-28): the two
   *    branches used to bow together and merge into one line while still out
   *    in open air, well short of the destination, which read wrong —
   *    departing an island fans out from its centre to two edge points, so
   *    arriving at the next should be the same shape reversed, staying two
   *    separate lines all the way to that island's edge and only joining on
   *    its deck, not before it. This is also why the branch now runs the
   *    fork's whole `FORK_DISTANCE` rather than a shorter branch-only span —
   *    see the constants above.
   *  - **false** (last fork only): the curve runs straight to `target`
   *    itself, the older single-point convergence — there being no island to
   *    stay separate toward, the two lines have nothing to mirror and simply
   *    join before the temple approach picks up from there.
   */
  function genForkCurve(cursor, target, sideSign, segments, mirrorArrival) {
    // Both edge points are the same offset in their own island's local frame:
    // `EDGE_LATERAL` to this branch's own side, `EDGE_FORWARD` along the
    // island's heading — forward of centre on departure, behind it on
    // arrival. Written via localToWorld rather than advance() because the
    // arrival point needs the *forward* component negated and the *lateral*
    // one kept: `advance(target, heading + offset, -ISLAND_RADIUS)` negates
    // both, which silently put each branch's arrival on the *opposite* side
    // from its departure. That made the two branches cross in an X and meet
    // at the midpoint — "converging significantly too early" (Luke,
    // 2026-08-28). It went unnoticed for a round of fixes because the
    // distance between the two arrival points is identical either way, so
    // measuring that gap could never detect it; only the signed lateral
    // offset can.
    const departEdge = localToWorld(cursor, sideSign * EDGE_LATERAL, EDGE_FORWARD);
    if (!mirrorArrival) return [departEdge, ...genBowPoints(departEdge, target, sideSign, segments)];
    const arriveEdge = localToWorld(target, sideSign * EDGE_LATERAL, -EDGE_FORWARD);
    return [departEdge, ...genBowPoints(departEdge, arriveEdge, sideSign, segments), { x: target.x, z: target.z }];
  }

  /**
   * Cuts a waypoint chain (as walked from `fromPos`) off at `fraction` of its
   * own total length, interpolating a new final point exactly at the cut
   * rather than snapping to the nearest existing waypoint. Used to give the
   * wrong branch a shorter stone run and an even-shorter walkable queue,
   * both measured against the curve's real length rather than guessed at —
   * see WRONG_GAP_FRACTION / WRONG_FALL_FRACTION above.
   */
  function truncateAtFraction(fromPos, pts, fraction) {
    const total = pathLength([fromPos, ...pts]);
    const targetLen = total * fraction;
    const out = [];
    let prev = fromPos;
    let acc = 0;
    for (const pt of pts) {
      const segLen = dist(prev, pt);
      if (acc + segLen >= targetLen) {
        const t = segLen > 1e-6 ? (targetLen - acc) / segLen : 0;
        out.push({ x: prev.x + (pt.x - prev.x) * t, z: prev.z + (pt.z - prev.z) * t });
        return out;
      }
      out.push(pt);
      acc += segLen;
      prev = pt;
    }
    return out;
  }
  /** World position offset from a cursor by a lateral (right) and forward amount in its local frame. */
  function localToWorld(cursor, right, fwd) {
    const f = forward(cursor.heading, fwd);
    const r = forward(cursor.heading + Math.PI / 2, right);
    return { x: cursor.x + f.x + r.x, z: cursor.z + f.z + r.z };
  }

  // ---------------------------------------------------------------- renderer / scene
  //
  // `powerPreference: 'high-performance'` forces the discrete GPU on hybrid-
  // graphics laptops, which is the faster choice when it works but is also
  // the option most likely to hit a blocklisted/misbehaving driver (seen in
  // practice as Firefox's "Exhausted GL driver options" — it tried every
  // ANGLE/EGL backend it knows and none of them would create a context for
  // that GPU). Retry with progressively safer options rather than failing
  // outright the first time a context can't be created, and if every attempt
  // fails, replace the loading spinner with an actual message — silently
  // hanging on "Loading sky path…" forever is a worse failure mode than a
  // blunt error.
  function createRenderer() {
    const attempts = [
      { antialias: true, powerPreference: 'high-performance' },
      { antialias: true }, // let the browser pick the GPU
      { antialias: false }, // antialiasing itself can be part of what's failing
      { antialias: false, failIfMajorPerformanceCaveat: false }, // accept a software/slow fallback rather than none
    ];
    let lastErr;
    for (const opts of attempts) {
      try {
        return new THREE.WebGLRenderer(opts);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  let renderer;
  try {
    renderer = createRenderer();
  } catch (err) {
    const loaderEl = $('loader');
    if (loaderEl) {
      loaderEl.innerHTML =
        '<div style="max-width: 320px; text-align: center; line-height: 1.5;">' +
        "Your browser couldn't create a 3D graphics context, so this can't run here.<br><br>" +
        'Try: enabling hardware acceleration in your browser settings, updating your graphics drivers, or a different browser (Chrome/Edge tend to recover from this better than Firefox).' +
        '</div>';
    }
    throw err;
  }
  // Sized from the container, not the window: the game is a panel in a
  // larger app now, and during a round it may not be the whole viewport.
  // `|| window.inner*` covers a container that hasn't been laid out yet
  // (zero-sized), which would otherwise give a NaN aspect ratio.
  const surfaceWidth = () => container.clientWidth || window.innerWidth;
  const surfaceHeight = () => container.clientHeight || window.innerHeight;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(surfaceWidth(), surfaceHeight());
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x1d3f66, 1);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  // One mild atmospheric fog for both roles — purely for depth. Hiding the
  // path ahead is no longer this fog's job: that's the curtain props standing
  // at each junction (see makeCurtain), which is why there is no longer a
  // per-role near/far swap here.
  scene.fog = new THREE.Fog(0xbcd8ea, 24, 260);

  // The far plane has to clear the whole backdrop rig with room to spare. It
  // clips at constant *view-space* depth, so an axis-aligned backdrop panel
  // meets it at an angle once the camera yaws — the panel gets sliced off along
  // a diagonal that sweeps across it as the camera turns, rather than simply
  // vanishing. At the old 400 that started biting as soon as the sky was pushed
  // past ~380 out, which is well inside the range the composition needs.
  //
  // `near` is raised alongside it: depth precision goes as the near/far ratio,
  // and near is by far the stronger term, so lifting it from 0.1 to 0.5 buys
  // back most of what the longer far plane costs. Nothing in the scene comes
  // within half a unit of the camera — it trails 7.3 behind the walker and
  // looks 4.6 ahead of it.
  const camera = new THREE.PerspectiveCamera(52, surfaceWidth() / surfaceHeight(), 0.5, 5000);

  // Lighting: one key light that stands in for the sun. Its position, colour and
  // intensity are all driven by sunP (0 = dawn, 0.5 = midday, 1 = dusk) each
  // frame — see applySun() below. Plus a cool sky/ground fill that dims a little
  // at the edges of the day.
  const key = new THREE.DirectionalLight(0xfff0d0, 2.0);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -10;
  key.shadow.camera.right = 10;
  key.shadow.camera.top = 10;
  key.shadow.camera.bottom = -10;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 40;
  key.shadow.bias = -0.0012;
  key.shadow.normalBias = 0.02;
  scene.add(key);
  scene.add(key.target);

  const hemi = new THREE.HemisphereLight(0xbfe0f5, 0x6b5a44, 0.5);
  scene.add(hemi);

  const SUN_DAWN = new THREE.Color(0xff7043);
  const SUN_NOON = new THREE.Color(0xfff6e0);
  const SUN_DUSK = new THREE.Color(0xff5a3c);
  const sunColorScratch = new THREE.Color();

  /** Lerp across three stops: p<0.5 blends A→B, p>=0.5 blends B→C. Mutates `out`. */
  function threeStopLerp(out, a, b, c, p) {
    if (p < 0.5) return out.copy(a).lerp(b, p / 0.5);
    return out.copy(b).lerp(c, (p - 0.5) / 0.5);
  }

  /** Move/recolour the key light for a point in the day, p in [0, 1]. */
  function applySun(p) {
    const angle = p * Math.PI; // 0 = one horizon, PI/2 = overhead, PI = other horizon
    const R = 16;
    const H = 13;
    const BASE_Y = 2.2;
    key.position.set(-Math.cos(angle) * R, BASE_Y + Math.sin(angle) * H, 6);

    threeStopLerp(sunColorScratch, SUN_DAWN, SUN_NOON, SUN_DUSK, p);
    key.color.copy(sunColorScratch);

    const DAWN_I = 0.5;
    const NOON_I = 2.2;
    const DUSK_I = 0.5;
    key.intensity =
      p < 0.5 ? THREE.MathUtils.lerp(DAWN_I, NOON_I, p / 0.5) : THREE.MathUtils.lerp(NOON_I, DUSK_I, (p - 0.5) / 0.5);

    hemi.intensity = THREE.MathUtils.lerp(0.32, 0.5, Math.sin(angle));
  }

  // The sky, clouds and peaks are deliberately *unlit* (MeshBasicMaterial) so
  // they stay flat poster colour — which means the key light above never
  // touches them. Without this, moving/recolouring the light only shows up on
  // the small strip of lit ground, which reads as no change at all. So the
  // atmosphere itself — backdrop tint, fog colour, background colour — is
  // driven from sunP too. Cut-outs (figure, pillars, markers) are deliberately
  // left out of this so they keep their flat "puppet" colour throughout.
  const atmosphereMaterials = [];
  const TINT_DAWN = new THREE.Color(0xecd0bf);
  const TINT_NOON = new THREE.Color(0xffffff);
  const TINT_DUSK = new THREE.Color(0xe7c9bd);
  const FOG_DAWN = new THREE.Color(0xe7a37c);
  const FOG_NOON = new THREE.Color(0xbcd8ea);
  const FOG_DUSK = new THREE.Color(0xcf8266);
  const CLEAR_DAWN = new THREE.Color(0x6b4a5a);
  const CLEAR_NOON = new THREE.Color(0x1d3f66);
  const CLEAR_DUSK = new THREE.Color(0x5a3a52);
  const tintScratch = new THREE.Color();
  const fogScratch = new THREE.Color();
  const clearScratch = new THREE.Color();

  function applyAtmosphere(p) {
    threeStopLerp(tintScratch, TINT_DAWN, TINT_NOON, TINT_DUSK, p);
    for (const mat of atmosphereMaterials) mat.color.copy(tintScratch);

    threeStopLerp(fogScratch, FOG_DAWN, FOG_NOON, FOG_DUSK, p);
    scene.fog.color.copy(fogScratch);

    threeStopLerp(clearScratch, CLEAR_DAWN, CLEAR_NOON, CLEAR_DUSK, p);
    renderer.setClearColor(clearScratch, 1);
  }

  // ---------------------------------------------------------------- asset loading

  const manager = new THREE.LoadingManager();
  const loader = new THREE.TextureLoader(manager);
  const bar = container.querySelector('#bar > i');

  // Texture loads are in flight for a second or so after mount, and a round
  // can be unmounted inside that window (a teacher ending it early, React
  // StrictMode's mount/unmount/mount in dev). The callbacks then fire against
  // a container that dispose() has already emptied, so both guard on
  // `disposed` — without it, onLoad throws on a null #loader.
  manager.onProgress = (_url, loaded, total) => {
    if (disposed) return;
    bar.style.width = `${Math.round((loaded / total) * 100)}%`;
  };

  const tex = (name, { repeatWrap = false, ext = 'png', linear = false, tile = false } = {}) => {
    const t = loader.load(`textures/${name}.${ext}`);
    // `linear` is for data textures (noise fields the shader does maths on)
    // rather than pictures — sRGB decoding would bend the value distribution
    // the shader is calibrated against.
    t.colorSpace = linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    if (repeatWrap) t.wrapS = THREE.RepeatWrapping;
    if (tile) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  };

  const TEX = {
    // Real art test (Option B): one wide dawn→noon→dusk strip, panned via UV
    // offset instead of tinted, since it already carries its own colour grading.
    skyStrip: tex('skybig', { ext: 'jpg' }),
    landSea: tex('landsea', { ext: 'jpg' }),
    cloudReal: tex('cloud-real'),
    cloud2: tex('cloud-2'),
    cloud3: tex('cloud-3'),
    peaks: tex('peaks', { repeatWrap: true }),
    cloudDeck: tex('cloud-deck', { repeatWrap: true }),
    cloudsFar: tex('clouds-far', { repeatWrap: true }),
    cloudsMid: tex('clouds-mid', { repeatWrap: true }),
    cloudDense: tex('cloud-dense', { ext: 'webp', tile: true }),
    cloudLight: tex('cloud-light', { tile: true }),
    stoneA: tex('stone-a'),
    stoneB: tex('stone-b'),
    stoneC: tex('stone-c'),
    stoneD: tex('stone-d'),
    pillar: tex('pillar'),
    safe: tex('marker-safe'),
    hazard: tex('marker-hazard'),
    fogNoise: tex('fog-noise', { linear: true, tile: true }),
    fogPuff: tex('fog-puff'),
    temple: tex('temple', { ext: 'webp' }),
    gull1: tex('gull-1', { ext: 'webp' }),
    gull2: tex('gull-2', { ext: 'webp' }),
    islandDeck1: tex('island-circle'),
  };

  // ---------------------------------------------------------------- island models
  //
  // Hand-modelled islands (Blender, starting from an islandGen.js export —
  // see TODO.md), each a base mesh plus a texture for its deck. Registered
  // with the shared `manager` like every other asset, so the character-select
  // screen doesn't show until these are ready too.
  const ISLAND_MODELS = [{ model: 'models/island-basic-v2.glb', deckTex: TEX.islandDeck1 }];
  const gltfLoader = new GLTFLoader(manager);
  const islandTemplates = []; // filled in as each model's onLoad fires

  for (const { model, deckTex } of ISLAND_MODELS) {
    gltfLoader.load(model, (gltf) => {
      // Exported by islandProto.js's "export .glb" button, which hands over
      // exactly the group buildIsland() returns (rock, then deck). Node names
      // aren't a reliable way to find the deck, though — Blender's own export
      // (after whatever hand editing happens there) has changed exactly what
      // gets split into which named node between every version of this file
      // so far, including merging the deck into the same mesh object as the
      // rock. What's stable regardless is the *shape*: the deck is a flat
      // disc (near-zero vertical extent) sitting on top of a rock body that
      // is not, so the flattest mesh in the file is the deck.
      let deckMesh = null;
      let flattestHeight = Infinity;
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.computeBoundingBox();
        const box = o.geometry.boundingBox;
        const height = box.max.y - box.min.y;
        if (height < flattestHeight) {
          flattestHeight = height;
          deckMesh = o;
        }
      });
      // Cloned rather than edited in place: the deck's material has been
      // shared with stray extra geometry in more than one export so far (a
      // Blender artifact, not something this code can prevent) — editing it
      // directly risks texturing whatever else that material happens to
      // touch.
      const deckMat = deckMesh.material.clone();
      deckMat.map = deckTex;
      deckMat.vertexColors = false;
      deckMat.color.set(0xffffff);
      deckMat.needsUpdate = true;
      deckMesh.material = deckMat;

      // The deck's *horizontal* reach — how far from the island's axis you
      // can still be standing on paving. Measured straight off the vertices,
      // deliberately, rather than via a bounding volume: `Box3` around a flat
      // disc is a square, and `Box3.getBoundingSphere()` returns that box's
      // half-diagonal, which overstates a disc of radius r as r*sqrt(2). That
      // is not a rounding error — it silently shrank every island to 1/sqrt(2)
      // (71%) of its intended size while the code went on believing the
      // number it asked for, which is what put the walkable edge 1.76 units
      // inside where the stone-suppression radius assumed it was. Anything
      // derived from this (ISLAND_CLEAR_R, WRONG_STUB_LEN, spacing) inherits
      // the error, so it is worth measuring exactly.
      gltf.scene.updateWorldMatrix(true, true);
      const dPos = deckMesh.geometry.attributes.position;
      const dVert = new THREE.Vector3();
      let deckRadius = 0;
      for (let i = 0; i < dPos.count; i++) {
        // Through the mesh's own transform: the deck has been a separately
        // translated child node in some exports and merged into the rock's
        // mesh in others, so its vertices are not always already in the
        // scene root's space.
        dVert.fromBufferAttribute(dPos, i).applyMatrix4(deckMesh.matrixWorld);
        deckRadius = Math.max(deckRadius, Math.hypot(dVert.x, dVert.z));
      }
      // Rescale to the size the game is laid out around (ISLAND_TARGET_RADIUS
      // below) — this export's own scale depends on whatever the tuning
      // page's size slider happened to be at export time, and on the Blender
      // edit afterward, neither of which has any reason to already match.
      const scale = ISLAND_TARGET_RADIUS / deckRadius;
      const t = { scene: gltf.scene, scale, deckRadiusScaled: deckRadius * scale };
      islandTemplates.push(t);
      // startJourney() (below) runs synchronously at mount, long before any
      // network fetch can resolve — so the very first fork's island is
      // *always* built from the procedural fallback, not a rare race. Once a
      // model does arrive, swap it into any island still standing on that
      // fallback rather than leaving it stuck with the placeholder rock for
      // the rest of the round.
      upgradeFallbackIslands(t);
    });
  }

  // ---------------------------------------------------------------- character roster
  //
  // Each character loads a single texture (the front-facing art).
  // New characters just need an entry here — the selection screen and rig are
  // both built from this list, not hardcoded to any one character.
  const ROSTER = [
    { key: 'woman2', tex: 'figure-woman2', ext: 'webp' },
    { key: 'indy', tex: 'figure-indy', ext: 'png' },
    { key: 'woman1', tex: 'figure-woman1', ext: 'webp' },
    { key: 'alien', tex: 'figure-alien', ext: 'webp' },
    { key: 'bat', tex: 'figure-bat', ext: 'webp' },
    { key: 'dolphin', tex: 'figure-dolphin', ext: 'webp' },
    { key: 'ghost', tex: 'figure-ghost', ext: 'webp' },
    { key: 'man1', tex: 'figure-man1', ext: 'webp' },
    { key: 'man2', tex: 'figure-man2', ext: 'webp' },
    { key: 'meerkat', tex: 'figure-meerkat', ext: 'webp' },
    { key: 'monkey', tex: 'figure-monkey', ext: 'webp' },
    { key: 'robot', tex: 'figure-robot', ext: 'webp' },
    { key: 'wizard', tex: 'figure-wizard', ext: 'webp' },
  ];
  const CHAR_TEX = {};
  for (const c of ROSTER) {
    CHAR_TEX[c.key] = { front: tex(c.tex, { ext: c.ext }) };
  }

  // A small fixed palette rather than a free colour picker — every option here
  // has been checked against the backing art, which a free picker couldn't
  // guarantee (very low saturation, for instance, would wash out the fold
  // shading the split preserves).
  const PALETTE = [
    { key: 'blue', label: 'Blue', hex: 0x5a9fe0 },
    { key: 'red', label: 'Red', hex: 0xd9564a },
    { key: 'green', label: 'Green', hex: 0x5cb86c },
    { key: 'yellow', label: 'Yellow', hex: 0xe0b93c },
    { key: 'purple', label: 'Purple', hex: 0x9a6fd6 },
    { key: 'orange', label: 'Orange', hex: 0xe08a3c },
    { key: 'teal', label: 'Teal', hex: 0x3fb8b0 },
    { key: 'pink', label: 'Pink', hex: 0xe07fb0 },
  ];

  // ---------------------------------------------------------------- panel helpers

  /**
   * An unlit flat panel. Used for every distant layer — sky, peaks, cloud banks.
   * Unlit keeps the poster-flat look and costs almost nothing to draw.
   */
  function backdrop(map, { w, h, x = 0, y = 0, z, order, fog = true, opacity = 1, tint = true, parent = scene }) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({
        map,
        transparent: true,
        depthWrite: false,
        opacity,
        fog,
        side: THREE.DoubleSide,
      })
    );
    mesh.position.set(x, y, z);
    mesh.renderOrder = order;
    parent.add(mesh);
    if (tint) atmosphereMaterials.push(mesh.material);
    return mesh;
  }

  /**
   * An upright cut-out standing on the path.
   *
   * Deliberately *unlit*: a key light from above barely grazes a vertical plane,
   * so lighting these would just render them dark and muddy. Flat painted colour
   * is also the look we want. They still cast real shadows — casting is a depth
   * pass and does not care that the material is unlit — and that shadow is what
   * ties the cut-out to the ground.
   */
  function cutout(map, { w, h, x = 0, y = 0, z, castShadow = true, fog = true }) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({
        map,
        transparent: true,
        alphaTest: 0.45,
        side: THREE.DoubleSide,
        fog,
      })
    );
    mesh.position.set(x, y + h / 2, z);
    mesh.castShadow = castShadow;
    scene.add(mesh);
    return mesh;
  }

  // ---------------------------------------------------------------- the layers
  //
  // Back to front. The z values are the whole trick: real distance in a real
  // perspective camera is what makes the parallax correct rather than faked.

  /**
   * The sky, as a section of a cylinder wrapped around the camera.
   *
   * A flat panel cannot cover a wide view. Its angular width is 2*atan(w/2d),
   * so the only ways to widen it are to bring it closer — which crops it
   * vertically and makes it loom — or to stretch it. Neither survives the
   * camera panning: the panel's vertical edges swing into frame, which is
   * exactly the artefact this replaces.
   *
   * Bending the same panel into an arc fixes it outright. Every point stays at
   * `radius` from the camera, so nothing foreshortens and there is no edge to
   * find until you pass `arcDeg/2` off-centre. It is also strictly better value
   * than the flat version: the same strip of texture bent at the same distance
   * covers arcLength/radius radians instead of 2*atan(w/2d), which is more.
   *
   * Kept a section rather than a full 360 ring on purpose. Only a third of the
   * sky strip is visible at a time (the rest is other times of day), so
   * wrapping it the whole way round would smear that third over four times the
   * angle. A section spends the texture where the camera can actually look.
   *
   * `arcDeg` and `height` are related: the image is undistorted when the arc
   * length (radius * arc in radians) divided by the height matches the visible
   * third's own aspect ratio. SKY_ASPECT below carries that number.
   */
  function skyShell(map, { radius, height, y, arcDeg, order, opacity = 1, parent = scene }) {
    const build = (deg) => {
      const arc = THREE.MathUtils.degToRad(deg);
      // thetaStart puts the middle of the arc on -z, i.e. straight ahead.
      return new THREE.CylinderGeometry(1, 1, 1, 96, 1, true, Math.PI - arc / 2, arc);
    };
    const mesh = new THREE.Mesh(
      build(arcDeg),
      new THREE.MeshBasicMaterial({
        map,
        transparent: true,
        depthWrite: false,
        opacity,
        fog: false,
        // The camera is inside the cylinder, so it is the inner face we need.
        side: THREE.BackSide,
      })
    );
    // Unit geometry scaled to size, so radius and height stay independent
    // dials for the tuner without rebuilding anything.
    mesh.scale.set(radius, height, radius);
    mesh.position.set(0, y, 0);
    mesh.renderOrder = order;
    // Changing the arc is the one adjustment that does need new geometry.
    mesh.userData.shell = {
      arcDeg,
      setArc(deg) {
        mesh.geometry.dispose();
        mesh.geometry = build(deg);
        mesh.userData.shell.arcDeg = deg;
      },
    };
    parent.add(mesh);
    return mesh;
  }

  /**
   * A cloud deck: a flat panel lying horizontally far below the path. Seen edge-on
   * from above it reads as an endless floor of cloud, which is what actually
   * conveys "we are very high up" — vertical cloud panels just look like walls.
   */
  function deck(map, { w, d, y, z, repeat, order, opacity, tint = true, mirror = false, parent = scene }) {
    const m = map.clone();
    m.needsUpdate = true;
    // Mirrored wrapping flips every other copy, so a non-tiling photograph can
    // be repeated sideways with no seam at all — each join meets its own
    // reflection. For an aerial coastline that reads as the coast simply
    // continuing, which is what lets the deck run wider than the frame.
    m.wrapS = m.wrapT = mirror ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
    m.repeat.set(repeat[0], repeat[1]);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshBasicMaterial({
        map: m,
        transparent: true,
        depthWrite: false,
        opacity,
        fog: false,
      })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(0, y, z);
    mesh.renderOrder = order;
    parent.add(mesh);
    if (tint) atmosphereMaterials.push(mesh.material);
    return mesh;
  }

  // Sizing note: with a 52° vertical field of view, a panel at distance D spans
  // a frame roughly 0.98 * D tall. So a distant layer that should read as a thin
  // band near the horizon has to be *small* relative to its distance — getting
  // this wrong is what turns a sky into a white floor.

  // ---------------------------------------------------------- the world floor
  //
  // Two pieces only: one flat deck carrying land *and* sea in a single image,
  // and a curved sky wrapped around it. The coastline is painted into the art
  // rather than being a seam between two planes, which removes the whole class
  // of gap-at-the-join problem that dogged the split version.
  //
  // They live in a rig that follows the camera in x/z (see the animate loop),
  // which is what makes the composition hold. Fixed in world space these would
  // slide past as the walker advances — 6 forks is over 100 units of travel —
  // and the horizon would climb the screen over the course of a round.
  //
  // Both are sized with real margin beyond the frame, because the camera pans:
  // anything sized to *exactly* fill the view shows its edge the moment it
  // moves.
  const backdropRig = new THREE.Group();
  scene.add(backdropRig);

  const FLOOR_Y = -40; // how far the world floor sits below the path
  const HORIZON_Z = -360; // the deck's far edge — where the sea stops

  // The art is square (4000x4000). One tile is kept square so it never
  // stretches; the deck then repeats sideways to run far wider than the frame,
  // with MirroredRepeatWrapping so the copies meet as reflections and leave no
  // seam. Four tiles across puts the left and right edges ~1100 units off
  // centre at the horizon, which no amount of panning brings into shot.
  //
  // deck() lays the plane down such that the top of the image ends up at the
  // far edge, so the open sea at the top of LandSea.jpg lands at the horizon
  // and the fields at the bottom end up nearest — the way round we want
  // without any flipping. Its depth also puts the near edge behind the camera,
  // so there is ground underfoot rather than an edge in shot.
  const LANDSEA_D = 562;
  const LANDSEA_TILES = 4;
  const landSea = deck(TEX.landSea, {
    w: LANDSEA_D * LANDSEA_TILES,
    d: LANDSEA_D,
    y: FLOOR_Y,
    z: HORIZON_Z + LANDSEA_D / 2,
    repeat: [LANDSEA_TILES, 1],
    mirror: true,
    order: 0.5,
    opacity: 1,
    parent: backdropRig,
  });

  // The sky strip is one wide dawn→noon→dusk image; only a third of it is
  // visible at once (repeat.x = 1/3), and offset.x pans across it as sunP goes
  // 0→1. tint:false because the art already carries the correct colour grading
  // — multiplying a day-cycle tint over it would double the effect.
  //
  // Curved rather than flat so that panning never finds its vertical edges —
  // see skyShell. Its radius sits just beyond the deck's far edge and it draws
  // after the deck, so pulling the radius in eats into the back of the sea,
  // which is the adjustment that sets where the horizon reads.
  TEX.skyStrip.wrapS = THREE.ClampToEdgeWrapping;
  TEX.skyStrip.repeat.set(1 / 3, 1);
  const SKY_R = 400;
  const SKY_ARC = 160; // degrees; edges sit 80° off centre, far outside any pan
  // Undistorted height: the visible third of the 8000x2000 strip is 4:3, so the
  // arc length and the height have to hold that same ratio.
  const SKY_ASPECT = 8000 / 3 / 2000;
  const SKY_H = (SKY_R * THREE.MathUtils.degToRad(SKY_ARC)) / SKY_ASPECT;
  const sky = skyShell(TEX.skyStrip, {
    radius: SKY_R,
    height: SKY_H,
    arcDeg: SKY_ARC,
    y: FLOOR_Y - 10 + SKY_H / 2,
    order: 0.6,
    parent: backdropRig,
  });

  // Which of the older ambient cloud layers survive alongside the wind sheets,
  // settled by eye on 2026-08-26 rather than derived from anything:
  //
  //   horizonBank  off — its job was hiding where the old decks ran out, and
  //                      the land/sea deck now reaches the horizon on its own.
  //   deckDeep     on  — reads as distant cloud far below, well under the wind
  //   deckHigh     on    sheets, and gives the drop past the path edge a floor.
  //   cloudRows    off — the four recycling billboard rows; they occupied the
  //                      same band the wind sheets now own, and doubled up.
  //
  // The fork curtains are not part of this: those are gameplay, not weather.
  const LEGACY_HORIZON_BANK = false;
  const LEGACY_FAR_DECKS = true;
  const LEGACY_CLOUD_ROWS = false;

  // ------------------------------------------------------------ wind clouds
  //
  // Two horizontal sheets of cloud just under the path, blowing right to left
  // across the player's view — the top, lighter one noticeably faster than the
  // dense one beneath it, which is what sells them as two separate altitudes
  // rather than one texture with a pattern in it.
  //
  // "Tiled to infinity" is two tricks working together. The sheets live in the
  // camera-following backdropRig, so they are always centred on the viewer and
  // can never be walked off; and their UV offsets are driven from the camera's
  // own position, which cancels that following exactly. The result is a texture
  // that stays pinned to the world — full parallax as the walker moves — on a
  // mesh that is always underneath them. Wind is then simply an extra term
  // added to the same offset.
  //
  // Sign, once, so it never has to be re-derived: deck() lays the plane so
  // local +x is world +x and local +y is world -z. Raising offset.x slides the
  // sampled texel right, which drags the image left. The player faces -z, so
  // their right hand is +x — image drifting toward -x is right-to-left across
  // their view, which is the direction asked for.
  const WIND_TILE_W = 60; // world size of one cloud tile across
  const WIND_TILE_D = WIND_TILE_W / (2400 / 1309); // ...and along, at the art's own aspect
  const WIND_EXTENT = 1400; // sheet size; only has to outrun the frame, not the world

  // Neither cloud image tiles seamlessly — each is a single ragged patch with
  // transparent margins — so one sheet repeats as an obvious grid of gaps.
  // Every layer is therefore built from several passes of cloud art at
  // *different tile sizes*, so each pass's gaps fall on another's cloud.
  //
  // The scales are deliberately awkward ratios: 1 : 1.47 : 4.3 only realign
  // after tens of tiles, far outside anything visible. Phase shifts stop them
  // coinciding at the origin, and `mirror` flips a pass's UVs so it isn't even
  // the same image at a different size.
  //
  // The third pass is the one doing the real work against uniformity. Two
  // passes at similar scales fix the grid but leave the cover statistically
  // even everywhere — the eye reads that as flat. A pass at 4.3x has tiles
  // ~260 units across, which is large enough to be *composition* rather than
  // texture: it thickens whole regions and opens whole clearings, so the sheet
  // has weather in it rather than a uniform mat. `swap` gives it the other
  // layer's art, so the big shapes don't echo the small ones.
  const WIND_PASSES = [
    { scale: 1, mirror: false, phase: [0, 0], dy: 0, alpha: 0.78, swap: false },
    { scale: 1.47, mirror: true, phase: [0.37, 0.61], dy: -0.9, alpha: 0.62, swap: false },
    { scale: 4.3, mirror: false, phase: [0.13, 0.29], dy: -2.2, alpha: 0.5, swap: true },
  ];

  // Gaps: a shared grid of soft holes punched through every pass of a layer.
  //
  // Two things make this work that a naive "drop every Nth tile" would not.
  //
  // First, the grid is shared. Each pass tiles at its own scale, so if each
  // dropped 1-in-N of its *own* tiles, a real gap would need all three to drop
  // in the same place — odds of (1/N)^3. Instead every pass hashes the same
  // world-space cell, so when a cell is chosen the whole layer opens at once.
  //
  // Second, the hole is a soft blob inside its cell rather than the cell
  // itself. Clearing a whole cell would leave hard straight edges where the
  // cell boundary cut through cloud, which reads far worse than the uniformity
  // it was meant to fix. The blob is jittered off-centre and sized to stay
  // inside its cell, so no boundary is ever visible. Cells are the base tile's
  // shape, so the holes come out slightly stretched along the wind.
  //
  // Hashing is the sine-free integer hash: the cell coordinate grows without
  // bound as the wind blows, and a sin() hash bands badly once its input gets
  // large.
  const HOLE_GLSL_HEAD = `
    varying vec2 vCloudXZ;
    uniform vec2 uCellSize;
    uniform vec2 uCellPan;
    uniform float uHoleCut;
    uniform float uStagger;
    float cloudHash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
  `;
  const HOLE_GLSL_BODY = `
    if (uHoleCut > 0.0) {
      vec2 q = (vCloudXZ + uCellPan) / uCellSize;
      // Same running-bond shift as the texture, so a hole always sits inside
      // one staggered tile rather than straddling two.
      q.x += uStagger * mod(floor(q.y), 2.0);
      vec2 cell = vec2(floor(q.x), floor(q.y));
      if (cloudHash(cell) < uHoleCut) {
        vec2 centre = vec2(cloudHash(cell + 11.3), cloudHash(cell + 27.7)) * 0.5 + 0.25;
        float radius = 0.30 + 0.18 * cloudHash(cell + 5.1);
        float d = length(fract(q) - centre);
        diffuseColor.a *= smoothstep(radius * 0.55, radius, d);
      }
    }
  `;

  // Running bond: every other row of tiles is shifted half a tile sideways, so
  // the vertical seams between tiles never line up into a continuous column.
  // This is the one thing the passes-at-different-scales trick cannot do, since
  // a UV transform is affine and a stagger is not.
  //
  // It has to replace the map lookup rather than pre-multiply the UV, because
  // vMapUv is a fragment input and is read-only. And it needs explicit
  // gradients: uv.x jumps half a tile at each row boundary, so the implicit
  // derivative spikes there and the GPU drops to the coarsest mip — a blurred
  // line along every row. textureGrad with the *unstaggered* derivatives gives
  // the mip level the pixel actually deserves. Guarded on __VERSION__ so the
  // shader still compiles if three ever emits GLSL ES 1.00 here, where the
  // worst case is that faint seam rather than a broken material.
  const STAGGER_GLSL = `
    #ifdef USE_MAP
      vec2 stagUv = vMapUv;
      stagUv.x += uStagger * mod(floor(stagUv.y), 2.0);
      #if __VERSION__ >= 300
        diffuseColor *= textureGrad( map, stagUv, dFdx( vMapUv ), dFdy( vMapUv ) );
      #else
        diffuseColor *= texture2D( map, stagUv );
      #endif
    #endif
  `;

  /** Adds the hole-punch to one sheet's material; returns its uniform set. */
  function punchHoles(mesh) {
    const mat = mesh.material;
    const held = {
      uCellSize: { value: new THREE.Vector2(WIND_TILE_W, WIND_TILE_D) },
      uCellPan: { value: new THREE.Vector2() },
      uHoleCut: { value: 0 },
      uStagger: { value: 0.5 },
    };
    // Three's default program cache key ignores onBeforeCompile, so without
    // this an ordinary MeshBasicMaterial could be handed our patched program,
    // or vice versa.
    mat.customProgramCacheKey = () => 'windCloudHoles';
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, held);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vCloudXZ;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvCloudXZ = (modelMatrix * vec4(transformed, 1.0)).xz;'
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>' + HOLE_GLSL_HEAD)
        .replace('#include <map_fragment>', STAGGER_GLSL)
        .replace('#include <alphatest_fragment>', HOLE_GLSL_BODY + '#include <alphatest_fragment>');
    };
    return held;
  }

  // Speeds in world units per second. The ratio matters more than the absolute
  // numbers: 3x is comfortably past the point where the eye reads two layers.
  const wind = { dense: 1.6, light: 5.0 };

  /**
   * One cloud altitude, built as WIND_PASSES sheets that move as a unit.
   *
   * Every pass is driven at the same *world* speed — each divides the same
   * blown distance by its own tile size — so they never drift apart and keep
   * reading as one layer rather than several.
   *
   * `map` is the layer's own art; `other` is the neighbouring layer's, used by
   * any pass marked `swap`.
   */
  function windLayer(map, other, { y, order, opacity }) {
    const passes = WIND_PASSES.map((cfg, i) => {
      const tileW = WIND_TILE_W * cfg.scale;
      const tileD = WIND_TILE_D * cfg.scale;
      // A negative repeat mirrors the tile. The offset maths below is written
      // in terms of the repeat itself, so the sign is handled for free.
      const rx = (cfg.mirror ? -1 : 1) * (WIND_EXTENT / tileW);
      const ry = WIND_EXTENT / tileD;
      const mesh = deck(cfg.swap ? other : map, {
        w: WIND_EXTENT,
        d: WIND_EXTENT,
        y: y + cfg.dy,
        z: 0, // centred on the camera; the rig does the following
        repeat: [rx, ry],
        order: order + i * 0.05,
        opacity: opacity * cfg.alpha,
        tint: false,
        parent: backdropRig,
      });
      return { rx, ry, phase: cfg.phase, dy: cfg.dy, mesh, holes: punchHoles(mesh) };
    });
    // Duck-typed `visible`/`y` so the tuner can drive a layer exactly as if it
    // were the single mesh it used to be. `chaos` scales the big pass alone,
    // which is the dial between "even mat" and "patchy weather".
    return {
      passes,
      get y() {
        return passes[0].mesh.position.y;
      },
      set y(v) {
        for (const p of passes) p.mesh.position.y = v + p.dy;
      },
      get visible() {
        return passes[0].mesh.visible;
      },
      set visible(v) {
        for (const p of passes) p.mesh.visible = v;
      },
      get chaos() {
        return passes[passes.length - 1].mesh.material.opacity;
      },
      set chaos(v) {
        passes[passes.length - 1].mesh.material.opacity = v;
      },
      // Expressed as the denominator the slider shows: 8 means one cell in 8
      // is opened. 0 is off, which the shader short-circuits on.
      get gaps() {
        const cut = passes[0].holes.uHoleCut.value;
        return cut > 0 ? Math.round(1 / cut) : 0;
      },
      set gaps(n) {
        const cut = n > 0 ? 1 / n : 0;
        for (const p of passes) p.holes.uHoleCut.value = cut;
      },
      // 0 = plain grid, 0.5 = classic running bond.
      get stagger() {
        return passes[0].holes.uStagger.value;
      },
      set stagger(v) {
        for (const p of passes) p.holes.uStagger.value = v;
      },
    };
  }

  // renderOrder 5 and 5.2: after every distant backdrop, before the ground.
  // These sit below the path, so the stones must always draw over them.
  const cloudDense = windLayer(TEX.cloudDense, TEX.cloudLight, { y: -16.9, order: 5, opacity: 1 });
  const cloudLight = windLayer(TEX.cloudLight, TEX.cloudDense, { y: -20.6, order: 5.2, opacity: 0.9 });

  // Tuned by eye through the slider panel on 2026-08-26 and baked here. See
  // bgTuner.js for how to put the sliders back.
  //
  // Note the heights: `cloudLight` ended up *below* `cloudDense`, which is the
  // opposite of how they were first built and of what their names imply. It was
  // chosen deliberately from the look of it. One consequence worth knowing if
  // these are ever retuned: draw order is fixed by renderOrder (5 vs 5.2), not
  // by depth, so the lower sheet currently paints over the higher one. With two
  // pale semi-transparent sheets that is not visible, but swapping the two
  // `order` values would make it physically right if it ever does show.
  cloudDense.gaps = 4;
  cloudLight.gaps = 2;
  cloudDense.chaos = 0.5;
  cloudLight.chaos = 0.5;
  cloudDense.stagger = 0.5;
  cloudLight.stagger = 0.5;

  // Distance blown so far, kept as its own accumulator rather than derived from
  // elapsed time, so the speeds can be retuned live without the clouds jumping.
  const windDist = { dense: 0, light: 0 };

  function updateWindClouds(dt) {
    windDist.dense += wind.dense * dt;
    windDist.light += wind.light * dt;
    const { x: cx, z: cz } = camera.position;
    for (const [layer, blown] of [
      [cloudDense, windDist.dense],
      [cloudLight, windDist.light],
    ]) {
      for (const p of layer.passes) {
        // Written against the repeat rather than the tile size so a mirrored
        // pass (negative repeat) stays world-locked and blows the same way.
        const o = p.mesh.material.map.offset;
        o.x = (p.rx / WIND_EXTENT) * (cx + blown) + p.phase[0];
        o.y = (-p.ry / WIND_EXTENT) * cz + p.phase[1];
        // Same blown distance, same sign convention: the gaps travel with the
        // cloud they are cut from rather than sitting still in the world.
        p.holes.uCellPan.value.set(blown, 0);
      }
    }
  }

  // Both of these were missing `parent: backdropRig` — every other backdrop
  // layer (landSea, sky, the cloud decks) rides the camera-following rig so
  // it always sits the same apparent distance away, but these two were fixed
  // at an absolute world Z instead. That went unnoticed as long as the
  // journey never travelled far enough to reach z=-100/-118, but the world
  // scale rework pushed TEMPLE_DISTANCE out to 160 (from 70) specifically so
  // path spacing could fit the island — which put both bands *inside* the
  // now-longer walk instead of beyond it. The player was walking through a
  // fixed-position translucent panel meant to be perpetually distant scenery,
  // which is the "grey area that appears then disappears" — it does not move
  // as the camera approaches, so it grows, fills the view, then is passed
  // through and left behind.
  const peaksBand = backdrop(TEX.peaks, { w: 190, h: 17, y: -1.5, z: -118, order: 1, fog: false, opacity: 0.75, parent: backdropRig });

  // soft band of cloud along the horizon, hiding where the decks run out
  const horizonBank = backdrop(TEX.cloudsFar, { w: 200, h: 11, y: -2.5, z: -100, order: 2, fog: false, opacity: 0.9, parent: backdropRig });

  // Two cloud decks lying flat, a long way down. Because they are far below, they
  // only occupy a band near the horizon — the open blue between them and the path
  // is what actually conveys height.
  // Both decks stop well short of the camera. Leaving open blue immediately below
  // the path is the difference between "suspended over a void" and "standing on a
  // white floor" — a deck that runs under your feet just reads as ground.
  const deckDeep = deck(TEX.cloudDeck, { w: 1800, d: 1200, y: -95, z: -800, repeat: [18, 12], order: 3, opacity: 0.55 });
  const deckHigh = deck(TEX.cloudDeck, { w: 900, d: 620, y: -40, z: -390, repeat: [11, 8], order: 4, opacity: 0.75 });
  horizonBank.visible = LEGACY_HORIZON_BANK;
  deckDeep.visible = LEGACY_FAR_DECKS;
  deckHigh.visible = LEGACY_FAR_DECKS;

  // The temple: a single flat billboard-style cut-out, planted at a fixed world
  // position straight ahead. No manual scaling logic needed — a real
  // perspective camera makes it grow on its own as the player gets closer.
  // fog:false so it stays visible through the heavy player-side fog too; it's
  // meant to be the one landmark you can always see.
  // TODO: once the approach has more than one fork of buildup, add 2–3 layers
  // of props in front of it (pillars, trees) for depth — flat single billboard
  // is a deliberate placeholder for now.
  // TODO: a ground-plane "approach" image — cobblestones/steps laid flat,
  // perpendicular to the temple's own billboard, its near edge meeting the
  // temple's base — for the player to walk onto for the last stretch.
  // Source art was widened (2048x1112 -> 3686x1668: +80% width, +50% height —
  // not a uniform scale). TEMPLE_H below is scaled by that same +50% height
  // growth; TEMPLE_ASPECT is read straight from the new art, so width follows
  // along at its own correct +80% automatically rather than needing a second
  // constant to track.
  const TEMPLE_ASPECT = 1024 / 463;
  // Sized/placed so it starts noticeably large (~4x the frame-height fraction
  // a "realistic" small building at this distance would read as) and fills
  // nearly the whole frame by the final approach — measured directly in the
  // browser and tuned by eye, not derived from the sizing-note formula above,
  // against TEMPLE_DISTANCE_REF (70 — TEMPLE_DISTANCE's old fixed value).
  // TEMPLE_DISTANCE became a *derived* number in the world scale rework (see
  // TODO.md) and grew to 160 once ISLAND_RADIUS/ISLAND_PATH_GAP were set —
  // left uncompensated, the same absolute TEMPLE_H at more than double the
  // distance reads at under half its tuned apparent (angular) size. A
  // billboard that small resolves far less of its own texture detail, which
  // reads flatter and more "cartoonish" — this is almost certainly what
  // looked wrong after the last round of changes. Scaling by the ratio to the
  // distance this was actually tuned against keeps the apparent size correct
  // regardless of how TEMPLE_DISTANCE is derived from here on.
  const TEMPLE_DISTANCE_REF = 70;
  const TEMPLE_H = 13 * 1.5 * (TEMPLE_DISTANCE / TEMPLE_DISTANCE_REF);
  const temple = cutout(TEX.temple, {
    w: TEMPLE_H * TEMPLE_ASPECT,
    h: TEMPLE_H,
    x: 0,
    z: -TEMPLE_DISTANCE,
    castShadow: false,
    fog: false,
  });
  // The temple sits farther out (z=-200) than the sky panel (z=-170), so
  // three.js's automatic back-to-front transparent sort draws it *before* the
  // sky — and the sky, despite depthWrite:false, still depth-tests, so it then
  // paints straight over it. Explicit renderOrder (higher than every backdrop
  // layer above, 0-4) forces it to always draw after them regardless of distance.
  temple.renderOrder = 4.5;

  // Four rows of clouds below the path, receding into the distance — replacing
  // the two single "wisp" panels that used to sit here.
  //
  // Each row holds all three cloud images spread across x. The rows recycle:
  // once a row falls behind the camera it jumps CLOUD_SPAN further away, so
  // there is always another row rising into view ahead as the avatar walks.
  //
  // Sitting at CLOUD_Y below the path, a row only clears the bottom of the
  // frame from roughly 25 units out, so the effect is: appear far, sweep
  // closer, drop out of frame underfoot — which is the "passing them" read.
  const CLOUD_ROWS = 4;
  const CLOUD_ROW_SPACING = 20;
  const CLOUD_SPAN = CLOUD_ROWS * CLOUD_ROW_SPACING;
  const CLOUD_Y = -8;
  const CAM_BACK = 7.3; // how far behind the avatar the camera trails
  // Lowered 2026-08-27 alongside the character shrink (see TODO.md "World
  // scale rework"): pulling CAM_BACK in to compensate for a smaller figure
  // would fight the sense of scale being built here, so the pitch comes down
  // instead — a flatter, more horizon-level view reads as grander than a
  // closer, steeper one. CAM_HEIGHT was 3.9, CAM_LOOK_Y 1.25 (tuned against
  // the old, taller figure); this is a first pass, worth eyeballing live and
  // adjusting rather than trusting blind.
  const CAM_HEIGHT = 2.8;
  const CAM_LOOK_Y = 0.9;

  // Heights come from each image's own aspect ratio so nothing is stretched.
  const CLOUD_KINDS = [
    { map: TEX.cloudReal, w: 9.0, aspect: 1024 / 559 },
    { map: TEX.cloud2, w: 7.5, aspect: 562 / 245 },
    { map: TEX.cloud3, w: 8.2, aspect: 654 / 306 },
  ];

  // Deterministic per-row layout rather than random, so the composition is
  // reproducible and can be tuned by hand. xs are kept inside ~±10: further out
  // than that and a cloud has already left the frame sideways by the time the
  // row is close enough to see.
  const ROW_LAYOUT = [
    { xs: [-9.5, 1.0, 9.5], dy: 0.0, dz: [0, -3, 1.5] },
    { xs: [-10.5, -0.5, 8.0], dy: -1.4, dz: [-2, 1, -1] },
    { xs: [-8.0, 2.5, 10.5], dy: 0.9, dz: [1.5, -1.5, 0] },
    { xs: [-10.0, 0.0, 8.5], dy: -0.6, dz: [-1, 2, -2.5] },
  ];

  // One shared material per cloud image — 12 panels, 3 materials.
  const cloudMats = CLOUD_KINDS.map(({ map }) => {
    const mat = new THREE.MeshBasicMaterial({
      map,
      transparent: true,
      depthWrite: false,
      opacity: 0.9,
      fog: false,
      side: THREE.DoubleSide,
    });
    atmosphereMaterials.push(mat);
    return mat;
  });

  const cloudRows = [];
  for (let i = 0; i < CLOUD_ROWS; i++) {
    const layout = ROW_LAYOUT[i];
    const row = new THREE.Group();
    CLOUD_KINDS.forEach((kind, j) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(kind.w, kind.w / kind.aspect), cloudMats[j]);
      m.position.set(layout.xs[j], CLOUD_Y + layout.dy, layout.dz[j]);
      // renderOrder 5 = after the far decks, before the ground. These sit below
      // the path, so the ground should always draw over them.
      m.renderOrder = 5;
      row.add(m);
    });
    row.position.z = -i * CLOUD_ROW_SPACING;
    row.visible = LEGACY_CLOUD_ROWS;
    scene.add(row);
    cloudRows.push(row);
  }

  // The ground is built from small paving-stone instances dropped along the
  // *actual* waypoints of the route — trunk, both branches of every fork, and
  // the final approach (see scatterAlong, driven by buildJourney below) —
  // rather than one rigid pre-shaped art tile. That's what makes it track the
  // player's real turns exactly, at any heading, instead of approximating them.
  //
  // Four stone-cluster textures round-robin so it doesn't read as an obvious
  // repeat. Each variant is one THREE.InstancedMesh — capped at a fixed
  // capacity generous enough for a full playthrough — so however many hundred
  // stones end up on screen, it's still only 4 draw calls, which matters for
  // holding frame rate on the target phone.
  const STONE_SIZE = 1.0 * FIGURE_SCALE; // world units, square — scales with the character (see FIGURE_SCALE above), not with the world
  const STONE_COLS = 3; // stones across the path width
  const PATH_WIDTH = 2.6;
  const ROW_SPACING = STONE_SIZE * 0.83; // rows overlap along the direction of travel too, so no gaps
  const STONE_CAPACITY = 200; // per variant — one playthrough's worth plus headroom

  const FLATTEN_Q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  const UP = new THREE.Vector3(0, 1, 0);
  const stoneDummy = new THREE.Object3D();
  const stoneYawQ = new THREE.Quaternion();

  function makeStoneMesh(map) {
    const mesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(STONE_SIZE, STONE_SIZE),
      new THREE.MeshLambertMaterial({ map }),
      STONE_CAPACITY
    );
    mesh.count = 0;
    mesh.receiveShadow = true;
    mesh.renderOrder = 6;
    // Instances move via per-instance matrices, not this mesh's own transform,
    // which stays at the world origin forever — so THREE's default frustum
    // culling (built from the base geometry's tiny bounding sphere sitting at
    // that origin) culls the *entire* mesh the moment the origin itself drifts
    // out of view, even while individual instances near the camera are still
    // plainly on screen. Disabling culling is the fix; total instance count
    // here is modest enough that this costs nothing measurable.
    mesh.frustumCulled = false;
    scene.add(mesh);
    return mesh;
  }
  const stoneMeshes = [TEX.stoneA, TEX.stoneB, TEX.stoneC, TEX.stoneD].map(makeStoneMesh);
  let stoneVariant = 0; // round-robins which mesh gets the next stone

  function placeStone(x, z) {
    if (nearIsland(x, z)) return; // the island's own paving covers this
    const mesh = stoneMeshes[stoneVariant % stoneMeshes.length];
    stoneVariant++;
    if (mesh.count >= STONE_CAPACITY) return; // headroom exhausted — drop silently rather than throw
    stoneYawQ.setFromAxisAngle(UP, Math.random() * Math.PI * 2); // pavers don't need to face any particular way
    stoneDummy.quaternion.copy(stoneYawQ).multiply(FLATTEN_Q);
    stoneDummy.position.set(x, 0.01 + Math.random() * 0.01, z); // tiny y jitter avoids z-fighting between overlapping stones
    stoneDummy.updateMatrix();
    mesh.setMatrixAt(mesh.count, stoneDummy.matrix);
    mesh.count++;
    mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Lays rows of stones along a chain of waypoints.
   *
   * `phase` is the distance walked since the last row was laid; it is passed in
   * and returned rather than kept in module scope because the path is no longer
   * one single chain. At a fork, *both* branches must start from the same phase
   * (so the two sides look symmetrical leaving the fork), while the correct
   * branch's end phase is what carries on into the trunk beyond it.
   */
  function scatterAlong(fromPos, points, phase) {
    let prev = fromPos;
    let dSinceRow = phase;
    for (const pt of points) {
      const segLen = dist(prev, pt);
      if (segLen < 1e-6) { prev = pt; continue; }
      const ux = (pt.x - prev.x) / segLen;
      const uz = (pt.z - prev.z) / segLen;
      const nx = -uz;
      const nz = ux;
      let travelled = 0;
      while (dSinceRow + (segLen - travelled) >= ROW_SPACING) {
        travelled += ROW_SPACING - dSinceRow;
        const bx = prev.x + ux * travelled;
        const bz = prev.z + uz * travelled;
        for (let c = 0; c < STONE_COLS; c++) {
          const off = (c - (STONE_COLS - 1) / 2) * (PATH_WIDTH / STONE_COLS);
          const jitter = (Math.random() - 0.5) * 0.25;
          placeStone(bx + nx * (off + jitter), bz + nz * (off + jitter));
        }
        dSinceRow = 0;
      }
      dSinceRow += segLen - travelled;
      prev = pt;
    }
    return dSinceRow;
  }

  function resetGround() {
    for (const mesh of stoneMeshes) mesh.count = 0;
    stoneVariant = 0;
  }

  // ------------------------------------------------------------- fork islands
  //
  // Each fork stands on a floating rock island: the player lands on it, and
  // the two branches leave from its edge. This was first tried as a painted
  // billboard (a single fixed-angle image, yaw-rotated to face the camera and
  // leaned back to fake the missing depth) — see git history around
  // 2026-08-26 for that version and TODO.md for why it was shelved: a flat
  // card has a hard ceiling on how convincing it can be as the camera pans,
  // and its pillars/edges couldn't track the fork's actual branch angles.
  //
  // This is real geometry instead (islandGen.js), which sidesteps both
  // problems at once — no billboarding needed, since it's genuinely 3-D from
  // every angle.
  //
  // As of 2026-08-27 the shipped islands are hand-modelled: a shape found on
  // the tuning page at island-proto.html, exported to .glb, then refined in
  // Blender and given a real deck texture (see ISLAND_MODELS above, loaded
  // via GLTFLoader into `islandTemplates`). buildIsland() itself is still
  // used — as the generator that produces the starting mesh for that export
  // — just not to build what ships. Falling back to it directly here too, if
  // for some reason a model failed to load, is cheap insurance: better an
  // island with the old procedural rock than a fork with no island at all.
  // No grass: it was scattered right at the deck edge, on the far side of the
  // one spot players actually look closely at — the boundary they're about to
  // walk past — so it mostly just added noise there.
  //
  // size is 2*ISLAND_RADIUS (the world-scale master constant, set at the top
  // of the file) rather than its own number — the fallback's rock must be the
  // same size as the loaded models it stands in for, since path spacing
  // (FORK_DISTANCE) is now built around ISLAND_RADIUS specifically. A
  // mismatched fallback would reintroduce the same gap-or-overlap problem
  // this rework fixed, just for whichever fork happens to load before its
  // model arrives.
  const ISLAND_FALLBACK_PARAMS = { bump: 0.32, taper: 0.75, depth: 0.43, size: ISLAND_RADIUS * 2, grassCount: 0 };
  // The radius every model gets rescaled to on load (see ISLAND_MODELS
  // above) — the same ISLAND_RADIUS that FORK_DISTANCE is built around, so a
  // loaded model always occupies exactly the footprint the path was spaced
  // for, not whatever size it happened to be modelled at.
  const ISLAND_TARGET_RADIUS = ISLAND_RADIUS;
  let ISLAND_Y = 0; // nudges the deck off the walker's plane

  // Stones are suppressed within this radius of a fork so the island's own
  // paving shows there instead of loose pavers scattered over the rock.
  // Matched exactly to the deck radius — no margin needed, now that both this
  // and the deck's own size come from the same ISLAND_RADIUS constant.
  const ISLAND_CLEAR_R = ISLAND_TARGET_RADIUS;

  const islands = [];
  const islandSpots = []; // fork centres, registered before the stones arrive

  // ------------------------------------------------------------------ bridges
  //
  // Replace the scattered stone path between two islands (Luke, 2026-08-31 —
  // see TODO.md, "Rope bridges replace path stones", and bridgeGen.js /
  // bridgeWind.js for the generator and sway themselves, both settled on the
  // standalone tuning page at app/bridge-tuner.html). One shared wind instance
  // for the whole scene — every bridge's ropes/planks reference the same
  // uniforms, which is what makes the sway read as one consistent wind rather
  // than each bridge running its own clock (see bridgeWind.js's header for why
  // that mattered to Luke: front/back and the two parallel bridges of a fork
  // needed to lag each other while still visibly sharing one wind).
  const bridgeWind = createBridgeWind();
  const bridges = []; // flat list of every built bridge group, for clearJourney()

  // Scope of this port, deliberately: bridges connect two *islands*. The intro
  // trunk (spawn -> fork 1) and the final approach (last fork -> temple) are
  // NOT island-to-island — there is no island at the far end for a bridge's
  // posts to plant into (registerIsland() is never called for the temple
  // approach's target — see buildFork below), which would reproduce exactly
  // the mid-air-post bug the tuning page spent a whole round fixing, just at
  // a different spot. Both of those stretches keep the original stone path.
  // Only forks 1..N_FORKS-1's branches (fork -> fork, always island-to-island)
  // become bridges — see buildFork's isLastFork branch below.
  //
  // How far along its OWN bridge (not the old stone route's length, which no
  // longer exists once the branch is straight) the wrong side's plank gap
  // sits, and how many planks are missing there. Static for now — Luke's
  // asked-for "a plank breaks and drops as the player reaches it" animation
  // is an explicit later step (see TODO.md); this only replaces the old
  // "stones physically stop here" tell with an equivalent "planks are already
  // missing here" one, discovered at the same moment as before: past the fog
  // curtain, once already committed to the branch. The wrong branch's walk
  // queue is truncated at exactly this same fraction, so the player walks up
  // to the near edge of the gap and falls through it, rather than falling at
  // an arbitrary point on an otherwise-intact-looking deck.
  const BRIDGE_WRONG_GAP_T = 0.75;
  const BRIDGE_WRONG_MISSING = 2;

  /**
   * The waypoints for one bridge branch, mirroring genForkCurve()'s shape but
   * straight (a rope bridge cannot bow — see bridgeGen.js's planBow note) and
   * using BRIDGE_ANCHORS instead of EDGE_LATERAL/EDGE_FORWARD. Always called
   * with mirrorArrival=true here (the one false case, the last fork, keeps
   * genForkCurve/stones — see above), so always returns exactly
   * [departEdge, arriveEdge, target-centre].
   */
  function genBridgeRoute(cursor, target, sideSign) {
    const departEdge = localToWorld(cursor, sideSign * BRIDGE_ANCHORS.lateral, BRIDGE_ANCHORS.forward);
    const arriveEdge = localToWorld(target, sideSign * BRIDGE_ANCHORS.lateral, -BRIDGE_ANCHORS.forward);
    return [departEdge, arriveEdge, { x: target.x, z: target.z }];
  }

  /**
   * Marks where a fork will stand. Called *before* the run of stones leading
   * to it is laid, because placeStone needs to know to skip that area and the
   * trunk is scattered before the fork itself is built.
   */
  function registerIsland(pos) {
    islandSpots.push({ x: pos.x, z: pos.z });
  }

  function nearIsland(x, z) {
    for (const s of islandSpots) {
      if (Math.hypot(x - s.x, z - s.z) < ISLAND_CLEAR_R) return true;
    }
    return false;
  }

  /** Populates `group` (assumed empty) with a clone of template `t`. */
  function fillGroupFromTemplate(group, t) {
    group.userData.fromTemplate = true;
    for (const child of t.scene.clone().children) group.add(child);
    group.scale.setScalar(t.scale);
  }

  /**
   * Called whenever a model finishes loading (see ISLAND_MODELS above):
   * upgrades any island still standing on the procedural fallback — built
   * before this model was ready — to the real thing, in place. Only the
   * *contents* of the group change; its position (and any physics/suppression
   * bookkeeping keyed to that position) is untouched.
   */
  function upgradeFallbackIslands(t) {
    for (const group of islands) {
      if (group.userData.fromTemplate) continue;
      // The fallback owns every child outright (buildIsland() makes fresh
      // geometry/material each call), so this is a plain, safe dispose —
      // unlike the shared-resource case handled in clearJourney().
      for (const child of [...group.children]) {
        group.remove(child);
        child.geometry.dispose();
        child.material.dispose();
      }
      fillGroupFromTemplate(group, t);
    }
  }

  function spawnIsland(forkCursor) {
    const seed = Math.floor(Math.random() * 1e9);
    const group = new THREE.Group();
    if (islandTemplates.length) {
      // One of possibly several hand-modelled variants (see ISLAND_MODELS) —
      // picked at random per fork, same as the procedural version picked a
      // random seed, so no two forks need look alike.
      const t = islandTemplates[Math.floor(Math.random() * islandTemplates.length)];
      fillGroupFromTemplate(group, t);
    } else {
      // Model still loading — see upgradeFallbackIslands above, which
      // replaces this with a real model as soon as one is ready.
      for (const child of buildIsland({ seed, ...ISLAND_FALLBACK_PARAMS }).children) group.add(child);
    }
    group.position.set(forkCursor.x, ISLAND_Y, forkCursor.z);
    scene.add(group);
    islands.push(group);
    return group;
  }

  const pillars = [];

  function spawnPillars(forkCursor) {
    const pR = localToWorld(forkCursor, 1.55, 2.4);
    const pL = localToWorld(forkCursor, -1.5, 1.0);
    pillars.push(cutout(TEX.pillar, { w: 1.0, h: 2.6, x: pR.x, z: pR.z }));
    pillars.push(cutout(TEX.pillar, { w: 0.85, h: 2.2, x: pL.x, z: pL.z }));
  }

  // ---------------------------------------------------------------- fog curtains
  //
  // A curtain is the prop standing just past each fork that hides everything
  // beyond it. Because a closed curtain blocks the view, the path beyond can
  // already be standing there fully built without the player ever seeing it
  // get built — which is the whole point.
  //
  // It's built as a hybrid of two parts, because the two jobs pull against
  // each other: hiding the path *reliably*, and looking like mist.
  //
  //   1. One dense sheet does the hiding. Its alpha is computed in a shader
  //      from scrolling tileable noise, and is saturated to a solid 1 across
  //      the core while closed — so occlusion is guaranteed by construction,
  //      not by hoping enough sprites overlap.
  //   2. A ring of soft puff sprites in front of it does the looking. These
  //      are free to be loose and gappy precisely because the sheet behind
  //      them is already doing the occluding.
  //
  // Opening is a dissolve, not a curtain-parting: a threshold rises through
  // the noise field so holes open and widen and tendrils thin out, while the
  // puffs drift outward, shrink and fade. Nothing slides aside as a rigid
  // rectangle.
  //
  // Cost note: on a mid-range phone the budget here is overdraw, not CPU. The
  // sheet is ~1x fullscreen at its closest (the old three-layer stack was 3x),
  // which leaves room for the puffs — ~28 sprites at roughly 9% of frame each.
  // Only the nearest un-dissolved curtain is ever visible, since a closed one
  // hides every curtain behind it, so this cost is paid once at a time.
  // The sheet's *physical* quad is much bigger than the fog anyone will ever
  // see. Visibility is governed entirely by CORE_R*/FADE_R* below — the quad
  // just needs to be large enough that its edge sits well past FADE_R (plus
  // the domain warp's own reach), so that edge is provably always at alpha 0,
  // never something the geometry itself has to draw a line at.
  const FOG_W = 16;
  const FOG_H = 11.04; // scaled up with the visible radii to maintain margin past FADE_RY
  const FOG_Y = 1.6; // centre height — unrelated to FOG_H now; see CORE_RY/FADE_RY for what's actually visible
  const FOG_RISE = 0.9; // the bank lifts a little as it burns off
  const FOG_EXPAND = 0.14; // ...and swells slightly, as thinning fog does

  // The guaranteed-solid zone, in world units from the sheet's centre — must
  // cover the path corridor (±1.3) with a little margin. Nothing here ever
  // gets warped or faded; see the warp gate in FOG_FRAG for why that's exact,
  // not approximate. Scaled 30% larger to block more of downstream geometry.
  const FOG_CORE_RX = 2.106;
  const FOG_CORE_RY = 1.482;
  // Where alpha reaches 0. The gap between CORE and FADE is deliberately much
  // wider in X than Y — "wider is fine" for how gradually it dissipates
  // sideways, but a matching vertical expansion would undo the earlier fix
  // for the fog sitting too high. Scaled 30% to match the core.
  const FOG_FADE_RX = 8.58;
  const FOG_FADE_RY = 3.588;
  // Domain warp: bends the whole silhouette in flowing curves instead of a
  // smooth-but-still-rectangular product of two 1D falloffs, which is what
  // still read as a soft-edged box even after the noisy-border pass. Sized
  // well under (FADE - CORE) on each axis so the quad-size margin above still
  // holds even at the warp's full reach.
  const FOG_WARP_X = 1.0;
  const FOG_WARP_Y = 0.4;

  const PUFF_COUNT = 28;
  const PUFF_ALPHA = 0.5;
  const PUFF_SPREAD_X = 7.02; // scaled 20% more with the fog radii
  const PUFF_SPREAD_Y = 4.1184; // scaled 20% more with the fog radii
  const PUFF_SIZE = [1.1, 2.5];
  const PUFF_DEPTH = [0.05, 1.6]; // all in front of the sheet — see renderOrder note below
  const PUFF_PUSH = 2.6; // outward drift once dissolving
  const PUFF_LIFT = 1.5;

  // Was `BRANCH_LEN * 0.4` — a fraction of *path* length, with no reference to
  // the island's own size. At the old, smaller island (radius 3.5) that
  // happened to land past the deck edge; at the current radius (6) it lands
  // at ~4.2, well *inside* the deck — the curtain would stand on top of solid
  // paving rather than out past its edge. Tied directly to ISLAND_RADIUS
  // instead: this needs to track the island's actual size, not a fraction of
  // an unrelated path-length constant. (The wrong branch's own length used to
  // be tied to this the same way; as of the converging-branches rework it's a
  // fraction of the branch's own curve instead — see WRONG_GAP_FRACTION.)
  const CURTAIN_DIST = ISLAND_RADIUS + 1.5; // how far past the fork the curtain stands — must clear the deck's edge
  const CURTAIN_OPEN_LEAD = 1.6; // starts dissolving this far before the avatar reaches it
  const CURTAIN_OPEN_TIME = 1.0; // seconds to fully dissolve
  const CURTAIN_GUIDE_OPACITY = 0.28; // guide sees through it — the cheap version of "the guide can see ahead"

  const curtains = [];

  const FOG_VERT = /* glsl */ `
    varying vec2 vUv;
    varying vec2 vPos; // local xy in world units — see FOG_FRAG for why this replaced vUv there
    void main() {
      vUv = uv;
      vPos = position.xy;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

  // Three samples of one tiling noise texture at different scales, drifting in
  // different directions, stand in for fbm — enough churn to read as moving
  // fog. Extra texture samples cost ALU/bandwidth but no extra *blended*
  // pixels, which is the cheap direction to spend on mobile.
  //
  // Sampled from vPos (world units) rather than vUv: the quad is much bigger
  // than the visible fog (see FOG_W/H above), so UV-based frequencies would
  // have stretched — and blurred — the noise pattern across that extra empty
  // margin. World-space frequencies stay a fixed apparent size regardless of
  // how big the quad's own dead space is.
  //
  // uOpen drives a threshold sweeping through that noise field: at 0 the
  // smoothstep saturates to 1 everywhere in the core (guaranteed occlusion),
  // and by 1 it has passed above the field's maximum so nothing is left.
  const FOG_FRAG = /* glsl */ `
    uniform sampler2D uNoise;
    uniform float uTime;
    uniform float uOpen;
    uniform float uAlpha;
    uniform vec3 uColor;
    varying vec2 vUv;
    varying vec2 vPos;

    void main() {
      float n =
        0.50 * texture2D(uNoise, vPos * 0.14 + vec2( 0.013,  0.007) * uTime).r +
        0.30 * texture2D(uNoise, vPos * 0.29 + vec2(-0.021,  0.011) * uTime).r +
        0.20 * texture2D(uNoise, vPos * 0.60 + vec2( 0.008, -0.017) * uTime).r;

      // Denser low, wispier up top: reads as fog sitting on the path, and
      // means it burns off from above first as it dissolves.
      float vert = mix(1.0, 0.72, smoothstep(-2.0, 2.5, vPos.y));
      float base = (0.58 + 0.42 * n) * vert;

      float thr = mix(-0.30, 1.10, uOpen);
      float a = smoothstep(thr, thr + 0.38, base);

      // The silhouette: two independent per-axis falloffs (CORE_R* stays
      // solid, fades out to 0 by FADE_R*), rather than one shared distance —
      // that's deliberate, not a simplification, because it's what lets the
      // fade reach much further sideways (FOG_CORE_RX..FOG_FADE_RX is a wide
      // gap) without also pulling the vertical extent back up to where the
      // fog used to sit too high (FOG_CORE_RY..FOG_FADE_RY stays tight).
      //
      // A plain product of two such falloffs is still, structurally, a
      // rounded rectangle — soft-edged, but a rectangle. What breaks that up
      // is domain-warping the position before measuring it: bending the
      // sampled point along flowing noise, rather than jittering the boundary
      // in place, turns the contour into an organic blob instead of a box.
      // The warp is gated to exactly zero inside the guaranteed core (see
      // warpGate below), so it can never be the thing that lets something
      // through that was supposed to stay hidden.
      vec2 warpUv = vPos * 0.10 + vec2(0.037, 0.021) * uTime;
      vec2 warpN = vec2(
        texture2D(uNoise, warpUv).r - 0.5,
        texture2D(uNoise, warpUv * 1.3 + 3.7).r - 0.5
      );
      float gx = smoothstep(${FOG_CORE_RX}, ${FOG_CORE_RX + 0.8}, abs(vPos.x));
      float gy = smoothstep(${FOG_CORE_RY}, ${FOG_CORE_RY + 0.8}, abs(vPos.y));
      float warpGate = max(gx, gy);
      vec2 wp = vPos + warpN * vec2(${FOG_WARP_X}, ${FOG_WARP_Y}) * warpGate;

      float ex = 1.0 - smoothstep(${FOG_CORE_RX}, ${FOG_FADE_RX}, abs(wp.x));
      float ey = 1.0 - smoothstep(${FOG_CORE_RY}, ${FOG_FADE_RY}, abs(wp.y));
      a *= ex * ey;

      gl_FragColor = vec4(uColor, a * uAlpha);

      // THREE.Color holds values in the linear working space, and a raw
      // ShaderMaterial gets none of the output conversion the built-in
      // materials do for free — without this the fog draws markedly darker
      // than its own tint colour.
      #include <colorspace_fragment>
    }
  `;

  function makeCurtain(pos, heading) {
    const group = new THREE.Group();
    group.position.set(pos.x, FOG_Y, pos.z);
    group.rotation.y = heading; // plane's own normal is +Z, i.e. back toward the approaching avatar

    const sheet = new THREE.Mesh(
      new THREE.PlaneGeometry(FOG_W, FOG_H),
      new THREE.ShaderMaterial({
        uniforms: {
          uNoise: { value: TEX.fogNoise },
          uTime: { value: 0 },
          uOpen: { value: 0 },
          uAlpha: { value: 1 },
          uColor: { value: new THREE.Color(0xffffff) },
        },
        vertexShader: FOG_VERT,
        fragmentShader: FOG_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    sheet.renderOrder = 8; // after the stones and the temple
    group.add(sheet);

    // Puffs are one InstancedMesh — a single draw call however many there are.
    // They all sit *in front* of the sheet (PUFF_DEPTH is positive, and +Z
    // local faces the approaching avatar) because an InstancedMesh sorts as one
    // object: instances can't individually sort against the sheet, so keeping
    // them all on the near side makes "draw after the sheet" always correct.
    const puffs = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: TEX.fogPuff,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
        opacity: PUFF_ALPHA,
      }),
      PUFF_COUNT
    );
    puffs.renderOrder = 9;
    puffs.frustumCulled = false; // instances move via per-instance matrices; see the stone meshes for the same reasoning
    group.add(puffs);

    const seeds = [];
    for (let i = 0; i < PUFF_COUNT; i++) {
      seeds.push({
        bx: (Math.random() * 2 - 1) * PUFF_SPREAD_X,
        // biased low so the bank is thickest around path level
        by: -FOG_H / 2 + Math.pow(Math.random(), 0.7) * PUFF_SPREAD_Y,
        bz: PUFF_DEPTH[0] + Math.random() * (PUFF_DEPTH[1] - PUFF_DEPTH[0]),
        size: PUFF_SIZE[0] + Math.random() * (PUFF_SIZE[1] - PUFF_SIZE[0]),
        rot: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 0.25,
        p1: Math.random() * Math.PI * 2,
        p2: Math.random() * Math.PI * 2,
        p3: Math.random() * Math.PI * 2,
        delay: Math.random() * 0.4, // staggers which puffs wink out first
      });
    }

    scene.add(group);
    const curtain = { group, sheet, puffs, seeds, pos, heading, open: 0, opening: false, done: false };
    curtains.push(curtain);
    return curtain;
  }

  /** Smoothstep, matching the GLSL one so JS and shader easing agree. */
  const smoothstep = (edge0, edge1, x) => {
    const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  };

  const puffDummy = new THREE.Object3D();

  /**
   * Dissolves any curtain the avatar has walked up to, and keeps every
   * curtain's colour/opacity current. Colour comes from tintScratch, which
   * applyAtmosphere has already set for this frame — that way a curtain takes
   * the dawn/dusk grading like the rest of the sky without having to live in
   * atmosphereMaterials (whose entries are never removed, so putting
   * per-journey props in it would leak across resets).
   */
  function updateCurtains(dt, t) {
    const roleScale = role === 'guide' ? CURTAIN_GUIDE_OPACITY : 1;
    for (const c of curtains) {
      if (c.done) continue;
      if (!c.opening) {
        const f = forward(c.heading, 1);
        const ahead = (walker.x - c.pos.x) * f.x + (walker.z - c.pos.z) * f.z;
        if (ahead > -CURTAIN_OPEN_LEAD) c.opening = true;
      }
      if (c.opening) c.open = Math.min(1, c.open + dt / CURTAIN_OPEN_TIME);

      const u = c.sheet.material.uniforms;
      u.uTime.value = t;
      u.uOpen.value = c.open;
      u.uAlpha.value = roleScale;
      u.uColor.value.copy(tintScratch);
      c.sheet.position.y = FOG_RISE * c.open;
      c.sheet.scale.set(1 + FOG_EXPAND * c.open, 1 + FOG_EXPAND * 0.6 * c.open, 1);

      c.puffs.material.color.copy(tintScratch);
      c.puffs.material.opacity = PUFF_ALPHA * roleScale * (1 - smoothstep(0.55, 1.0, c.open));

      for (let i = 0; i < c.seeds.length; i++) {
        const s = c.seeds[i];
        // Sine fields rather than a real simulation: cheaper, and easier to
        // keep looking like a slow churn rather than drifting particles.
        const churnX = Math.sin(t * 0.32 + s.p1) * 0.28;
        const churnY = Math.sin(t * 0.24 + s.p2) * 0.2;
        const churnZ = Math.sin(t * 0.29 + s.p3) * 0.16;
        const spent = THREE.MathUtils.clamp((c.open - s.delay) / (1 - s.delay), 0, 1);
        const shrink = 1 - smoothstep(0, 1, spent);
        const push = Math.sign(s.bx || 1) * PUFF_PUSH * c.open;

        puffDummy.position.set(s.bx + churnX + push, s.by + churnY + PUFF_LIFT * c.open, s.bz + churnZ);
        puffDummy.rotation.set(0, 0, s.rot + t * s.rotSpeed);
        const sc = s.size * shrink;
        puffDummy.scale.set(sc, sc, 1);
        puffDummy.updateMatrix();
        c.puffs.setMatrixAt(i, puffDummy.matrix);
      }
      c.puffs.instanceMatrix.needsUpdate = true;

      if (c.open >= 1) {
        c.group.visible = false;
        c.done = true;
      }
    }
  }

  // ---------------------------------------------------------------- birds
  //
  // Two flying-gull cut-outs (a puppeteer's hand holding a bird-on-a-stick up
  // from off-screen — the same diorama "puppet theatre" idea as everything
  // else here) that appear at random real-time intervals, unrelated to the
  // player's progress. Each appearance spawns at a *fixed* world position, a
  // constant distance ahead of wherever the player currently is (not, as
  // before, halfway to the temple — that shrank as the player advanced,
  // which is why birds used to visibly grow across a playthrough). A fixed
  // distance from a moving reference point still isn't a fixed world
  // position, so a spawned bird still doesn't literally follow the player —
  // it just always *starts out* at the same apparent size, the same
  // real-perspective trick as the temple and clouds otherwise use. It flies
  // in along a random angled line (never through the top of the screen or
  // the path), hovers, then exits straight out from screen centre through
  // the hover point, flattened so it never angles back up through the top.
  // Depth-testing is off and render order is above everything else in the
  // scene (path, pillars, player) — birds are a screen-space overlay, not
  // scene geometry, so they must never be occluded by it; on a narrow/portrait
  // screen the reduced horizontal FOV can otherwise push a bird's world
  // position close enough to the path centreline for real 3-D pillars/ground
  // to legitimately z-test in front of it.
  const BIRD_KINDS = [
    { map: TEX.gull1, aspect: 347 / 1024 },
    { map: TEX.gull2, aspect: 351 / 529 },
  ];
  const BIRD_H = 26; // world-unit height of the whole cut-out (bird + stick + hand)
  const BIRD_DEPTH_OFFSET = 35; // world units ahead of the player a bird spawns — fixed, so apparent size never drifts
  const BIRD_NDC_X = 0.5; // how far toward a screen edge (in NDC, 0=centre, 1=edge) a bird hovers — clear of the path
  const BIRD_NDC_RADIUS = 1.6; // how far off-screen (in NDC units, from the hover point) a bird starts and ends up
  // The bottom of the image — the puppeteer's hand and the base of the stick — must
  // never be visible, at any point in the animation, on any screen shape: the whole
  // puppet-theatre illusion depends on it always reading as "held up from below
  // frame," never as the full cut-out floating free. Rise/hover/exit each aim for
  // their own on-screen target and don't individually guarantee that, so instead
  // it's enforced as a hard clamp every frame afterward (see updateBirds): whatever
  // the animation wants, the image is pushed down further if needed so its bottom
  // edge never rises above this NDC line, comfortably below the visible frame.
  const BIRD_BOTTOM_MAX_NDC_Y = -1.08;
  // Entry tilt, degrees, measured from "straight outward" on the bird's own side (0=horizontal outward, positive=upward,
  // negative=downward) — never an angle in absolute terms, so it's mechanically impossible for a bird whose hover point
  // is on the right to approach from anywhere left of it, or vice versa: the path/centre can't be crossed.
  // The positive end is capped well short of 90 so entry never approaches through the top of the screen either.
  const BIRD_ENTRY_TILT = [-80, 55];
  const BIRD_RISE_TIME = 1.6;
  const BIRD_HOVER_TIME = 3.5;
  const BIRD_EXIT_DURATION = 2; // seconds to cross from hover to off-screen — always exactly this long
  const BIRD_EXIT_MARGIN = 0.5; // extra seconds a bird stays after nominally reaching the edge, as slack for the estimate
  const BIRD_BOB_RATE = 4.2;
  const BIRD_BOB_HEIGHT = 0.36;
  const BIRD_BOB_LATERAL = 0.48;
  const BIRD_GAP = [1, 3]; // DEV: tightened for testing — restore to something like [16, 34] for real play

  /** Direction from the hover point outward on `side`, tilted by a random angle within BIRD_ENTRY_TILT. Always points away from centre. */
  function randomBirdDir(side) {
    const tiltDeg = THREE.MathUtils.lerp(BIRD_ENTRY_TILT[0], BIRD_ENTRY_TILT[1], Math.random());
    const tilt = tiltDeg * Math.PI / 180;
    return { x: side * Math.cos(tilt), y: Math.sin(tilt) };
  }

  function makeBirdMesh(kind) {
    const w = BIRD_H * kind.aspect;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, BIRD_H),
      new THREE.MeshBasicMaterial({
        map: kind.map,
        transparent: true,
        alphaTest: 0.35,
        side: THREE.DoubleSide,
        depthWrite: false,
        depthTest: false, // always drawn on top of scene geometry — see the header note above
      })
    );
    mesh.visible = false;
    mesh.renderOrder = 11; // above every other layer (guide markers are the previous highest, at 10) — only future decision UI sits above this
    scene.add(mesh);
    return mesh;
  }
  const birdMeshes = BIRD_KINDS.map(makeBirdMesh);

  // Where a screen-space (NDC) point actually sits in world space depends on
  // the camera's current position/pitch and how far away the target depth is —
  // there's no fixed world-Y that reads as "bottom of screen" or "the player's
  // eye line" across every point in the journey. So each anchor is solved for
  // with a real ray cast through the camera at spawn time, intersected with
  // the bird's fixed world-Z plane, rather than guessed as a constant.
  const birdRaycaster = new THREE.Raycaster();
  function ndcToWorldAtZ(ndcX, ndcY, z) {
    birdRaycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
    const o = birdRaycaster.ray.origin;
    const d = birdRaycaster.ray.direction;
    const t = (z - o.z) / d.z;
    return { x: o.x + d.x * t, y: o.y + d.y * t };
  }

  let bird = null; // { mesh, z, side, entryX, entryY, hoverX, hoverY, hoverNdcX, hoverNdcY, exitDirX, exitDirY, t }
  let birdTimer = THREE.MathUtils.lerp(BIRD_GAP[0], BIRD_GAP[1], Math.random());

  function maybeSpawnBird(dt) {
    if (bird || finished || falling) return;
    birdTimer -= dt;
    if (birdTimer > 0) return;
    birdTimer = THREE.MathUtils.lerp(BIRD_GAP[0], BIRD_GAP[1], Math.random());

    camera.updateMatrixWorld();
    // A fixed distance ahead of the player, clamped so a bird spawned very late in
    // the walk still lands short of the temple rather than at/behind its facade.
    const z = Math.max(walker.z - BIRD_DEPTH_OFFSET, -TEMPLE_DISTANCE + 10);
    const side = Math.random() < 0.5 ? -1 : 1;
    const hoverNdcX = side * BIRD_NDC_X;

    // "Roughly level with the player": found by asking where the avatar's own
    // head height projects to on screen right now, then reusing that same
    // screen fraction — not the avatar's world Y — for the bird's hover point,
    // since the bird sits at a very different depth.
    const eyeNdc = new THREE.Vector3(walker.x, FIGURE_H, walker.z).project(camera);

    // Entry point: a random tilt away from the hover point, always outward on
    // `side` (see randomBirdDir) so the bird approaches from off-screen without
    // ever crossing the centre/path.
    const entryDir = randomBirdDir(side);
    const entryNdcX = hoverNdcX + entryDir.x * BIRD_NDC_RADIUS;
    const entryNdcY = eyeNdc.y + entryDir.y * BIRD_NDC_RADIUS;

    const hoverWorld = ndcToWorldAtZ(hoverNdcX, eyeNdc.y, z);
    const entryWorld = ndcToWorldAtZ(entryNdcX, entryNdcY, z);

    // Exit direction: straight out from screen *centre* through the hover point — the
    // simplest way to guarantee it can never angle back across the centre/path — with
    // any upward component clamped flat, so it still never exits back through the top.
    const radialLen = Math.hypot(hoverNdcX, eyeNdc.y) || 1;
    let exitDirX = hoverNdcX / radialLen;
    let exitDirY = Math.min(eyeNdc.y / radialLen, 0);
    const exitLen = Math.hypot(exitDirX, exitDirY) || 1;
    exitDirX /= exitLen;
    exitDirY /= exitLen;

    const mesh = birdMeshes[Math.floor(Math.random() * birdMeshes.length)];
    mesh.position.set(entryWorld.x, entryWorld.y - BIRD_H / 2, z);
    mesh.material.opacity = 1; // undo any fade-out left over from a bird cut short by a fall (see cancelBirdsForFall)
    mesh.visible = true;
    bird = {
      mesh, z, side, t: 0,
      entryX: entryWorld.x, entryY: entryWorld.y,
      hoverX: hoverWorld.x, hoverY: hoverWorld.y,
      hoverNdcX, hoverNdcY: eyeNdc.y,
      exitDirX, exitDirY,
      fading: false, fadeT: 0,
    };
  }

  const BIRD_FALL_FADE = 0.3; // seconds — how fast any on-screen bird fades out once a fall starts
  /** Called once from startFall(): whatever bird is currently on screen fades
   * out over BIRD_FALL_FADE instead of finishing its own flight, and no new
   * bird spawns until the fall is over (see the `falling` check in
   * maybeSpawnBird) — a mid-air gust isn't the moment for wildlife spotting. */
  function cancelBirdsForFall() {
    if (bird && !bird.fading) {
      bird.fading = true;
      bird.fadeT = 0;
    }
  }

  let birdDebugFreeze = false; // dev-only: pauses updateBirds' own repositioning so a debug override sticks on screen
  /** Fly in along a random angled line, hover with a bob, then fly straight out past the screen edge. */
  function updateBirds(dt) {
    if (birdDebugFreeze) return;
    maybeSpawnBird(dt);
    if (!bird) return;

    if (bird.fading) {
      bird.fadeT += dt;
      bird.mesh.material.opacity = Math.max(0, 1 - bird.fadeT / BIRD_FALL_FADE);
      if (bird.fadeT >= BIRD_FALL_FADE) {
        bird.mesh.visible = false;
        bird = null;
      }
      return; // held in place while fading — no flight-path repositioning
    }

    bird.t += dt;
    const { mesh, z, t, entryX, entryY, hoverX, hoverY, hoverNdcX, hoverNdcY, exitDirX, exitDirY } = bird;
    const riseEnd = BIRD_RISE_TIME;
    const hoverEnd = riseEnd + BIRD_HOVER_TIME;
    camera.updateMatrixWorld();

    let topX, topY;
    if (t < riseEnd) {
      const p = smoothstep(0, riseEnd, t);
      topX = THREE.MathUtils.lerp(entryX, hoverX, p);
      topY = THREE.MathUtils.lerp(entryY, hoverY, p);
    } else if (t < hoverEnd) {
      const hp = t - riseEnd;
      topX = hoverX + Math.sin(hp * BIRD_BOB_RATE * 0.7 + 1.1) * BIRD_BOB_LATERAL;
      topY = hoverY + Math.sin(hp * BIRD_BOB_RATE) * BIRD_BOB_HEIGHT;
    } else {
      // Exit always takes exactly BIRD_EXIT_DURATION seconds. The interpolation has to
      // happen in *screen space*, not world space: near/past the screen edge, world
      // distance and screen distance stop corresponding to each other in any simple
      // way (that's what perspective foreshortening is), so a world-space lerp toward
      // an off-screen target moves at wildly different, direction-dependent rates on
      // screen — barely creeping for some directions, jumping most of the way almost
      // immediately for others. Lerping the NDC coordinates directly is linear by
      // construction, so screen-space progress is the same for every direction. Only
      // the *final* step — turning that NDC point into a world position for this
      // frame's render — needs the camera, so it's still redone fresh every frame,
      // which is what keeps this correct as the camera tracks the walking player.
      const p = smoothstep(0, BIRD_EXIT_DURATION, t - hoverEnd);
      const ndcX = hoverNdcX + exitDirX * BIRD_NDC_RADIUS * p;
      const ndcY = hoverNdcY + exitDirY * BIRD_NDC_RADIUS * p;
      const w = ndcToWorldAtZ(ndcX, ndcY, z);
      topX = w.x;
      topY = w.y;
    }

    // Hard floor: whatever the phase above wanted, never let the image's bottom
    // edge (BIRD_H below topY) rise above the safe off-screen line. Re-derived
    // every frame from the current camera, so it holds through camera motion and
    // on any aspect ratio, not just the one it happened to be tuned against.
    const ndcOfTop = new THREE.Vector3(topX, topY, z).project(camera);
    const safeBottom = ndcToWorldAtZ(ndcOfTop.x, BIRD_BOTTOM_MAX_NDC_Y, z);
    topY = Math.min(topY, safeBottom.y + BIRD_H);

    mesh.position.set(topX, topY - BIRD_H / 2, z);
    mesh.quaternion.copy(camera.quaternion); // billboard — always faces the camera

    if (t >= hoverEnd + BIRD_EXIT_DURATION + BIRD_EXIT_MARGIN) {
      mesh.visible = false;
      bird = null;
    }
  }

  // ---------------------------------------------------------------- the journey
  //
  // The route is built **one fork at a time**, not all at once up front. That is
  // a deliberate anti-cheat measure, not just a memory saving: because only the
  // *correct* branch of a fork feeds the cursor that the next fork is planted
  // from (see buildFork below), the mere world-position of a downstream fork's
  // pillars encodes which side was correct upstream of it. With the whole route
  // present from the start, a player could read the shape of the path, the
  // angle it takes toward the temple, and where the distant pillars sit, and
  // back-solve the current fork without ever needing the guide's clue. Building
  // on demand means that information does not exist yet to be read.
  //
  // The invariant this maintains: **at the moment any fork is being decided, no
  // geometry beyond that fork's own two branches exists.** The next fork is
  // built at the instant a correct choice is committed (see extendPastFork),
  // by which point the decision it would have leaked is already made.
  //
  // It is safe to build it right then, rather than partway through the walk,
  // because the new geometry lands well beyond the current fork's curtain — and
  // that curtain has not begun dissolving yet (updateCurtains only trips
  // `opening` once the walker is within CURTAIN_OPEN_LEAD of it, and the walker
  // is still standing at the fork). So it is hidden from the moment it exists,
  // with none of the mid-walk state machine that deferring it would need.
  //
  // Both branches of a fork are the same curve (see genForkCurve), converging
  // on the same next island, so they look identical up to the curtain. Past
  // it, the correct one carries on to that island while the wrong one's
  // stones simply run out mid-curve — invisible until you are already inside
  // the fog, which is what makes taking it a fall rather than a dead end you
  // could have seen coming. See WRONG_GAP_FRACTION / WRONG_FALL_FRACTION
  // above for exactly where.

  const sections = []; // one per fork, built on demand: { fork, correct, branch:{left,right}, extended, approach, curtain, nextCursor, endPhase }
  let introTrunkPts = [];

  // Where the *next* fork will be planted, and the stone-row phase carried along
  // the route to it. These were locals of the old single-pass build loop; they
  // have to persist between calls now that the loop is spread across choices.
  let journeyCursor = null; // {x, z, heading}
  let journeyPhase = 0;

  function clearJourney() {
    resetGround();
    for (const group of islands) {
      scene.remove(group);
      group.traverse((o) => {
        // A template-cloned island's Mesh children (rock, deck) share their
        // geometry and material with the template itself and every other
        // fork using it, including ones in the *next* round — Object3D.clone
        // copies those references, it doesn't duplicate the underlying GPU
        // resources. Disposing them here would break every other island
        // built from the same template, so a template-sourced island disposes
        // nothing. A procedural-fallback island (no template loaded yet) owns
        // everything it has — fresh geometry/material from that one
        // buildIsland() call — and disposes normally.
        const sharesTemplateResources = group.userData.fromTemplate;
        if ((o.isMesh || o.isInstancedMesh) && !sharesTemplateResources) {
          o.geometry.dispose();
          o.material.dispose();
        }
      });
    }
    islands.length = 0;
    islandSpots.length = 0;
    for (const p of pillars) {
      scene.remove(p);
      p.geometry.dispose();
      p.material.dispose();
    }
    pillars.length = 0;
    for (const c of curtains) {
      scene.remove(c.group);
      for (const part of [c.sheet, c.puffs]) {
        part.geometry.dispose();
        part.material.dispose();
      }
      c.puffs.dispose(); // InstancedMesh also owns its instance buffers
    }
    curtains.length = 0;
    for (const b of bridges) {
      scene.remove(b);
      disposeBridge(b);
    }
    bridges.length = 0;
    sections.length = 0;
    // Guards against a restart after falling on fork 1: nextIslandAlreadySpawned
    // could be left true (fork 1 pre-spawned fork 2's island, then the player
    // fell before ever reaching buildFork(2) to consume that flag), and the
    // island it refers to no longer exists — it was just disposed above.
    // Left uncleared, the next buildJourney()/buildFork(1) would believe its
    // own island had already been spawned and skip it entirely.
    nextIslandAlreadySpawned = false;
  }

  /**
   * The heading that points from `pos` straight at the temple, which sits at
   * (0, -TEMPLE_DISTANCE). Headings are measured with 0 = -Z, matching
   * forward(): a direction (dx, dz) is atan2(dx, -dz).
   */
  function templeHeading(pos) {
    return Math.atan2(-pos.x, TEMPLE_DISTANCE + pos.z);
  }

  /**
   * Plants fork `k` at the current journeyCursor: its pillars, both branches,
   * and its curtain. Records the shared destination (nextCursor) so
   * extendPastFork can carry on from there later, without rebuilding anything.
   *
   * The destination is fixed *before* either branch is drawn, and both curves
   * (see genForkCurve) are built to land on it — this is what "converging
   * branches" means: which side is correct no longer decides where the next
   * island sits, only whether the player's own branch actually reaches it.
   */
  // Set by the *previous* buildFork() call (see the spawnIsland(target) call
  // near the end of this function) when it already built the island this call
  // is about to stand on — reused instead of spawning a duplicate at the same
  // spot. Only ever true for forks 2..N_FORKS; fork 1 has no previous fork to
  // have pre-spawned it, and falls through to the plain spawnIsland(cursor)
  // below exactly as before.
  let nextIslandAlreadySpawned = false;

  function buildFork(k) {
    const cursor = journeyCursor;
    const correct = CORRECT_BY_FORK[k - 1];
    // The island art carries its own pillars, so the procedural pair is off.
    // spawnPillars(cursor) — kept callable for when extra props are wanted.
    if (nextIslandAlreadySpawned) {
      nextIslandAlreadySpawned = false;
    } else {
      spawnIsland(cursor);
    }

    const isLastFork = k === N_FORKS;

    // Straighten *toward the temple*, not merely toward world heading 0.
    // Correcting to 0 fixes the direction of travel but is blind to lateral
    // drift already accumulated, so a run of same-side correct picks used to
    // leave the walker tracking parallel to the temple's centreline rather
    // than converging on it — arriving off to one side. Aiming at the temple
    // itself straightens and re-centres in the same step, and needs no
    // separate drift term: the further off-centre the cursor is, the more
    // this heading differs from straight-ahead, so the pull scales itself.
    //
    // FORK_DISTANCE (the fork-to-fork forward span) is used here even for the
    // last fork, whose `target` isn't a real island — that keeps the overall
    // pacing (CRUISE_DISTANCE = N_FORKS * FORK_DISTANCE) unaffected by which
    // fork is last; only the curve *shape* differs there (mirrorArrival
    // below), not its forward reach.
    const straightEnd = advance(cursor, cursor.heading, FORK_DISTANCE);
    const targetHeading = THREE.MathUtils.lerp(cursor.heading, templeHeading(straightEnd), HEADING_CORRECTION);
    const target = { ...advance(cursor, targetHeading, FORK_DISTANCE), heading: targetHeading };
    const nextCursor = target;

    // Register the next island's stone-suppression zone before either branch
    // is scattered — same reasoning as buildJourney's intro trunk: whichever
    // side turns out correct runs stones right up to that island's edge, and
    // placeStone has to already know to leave that patch clear.
    //
    // The island's actual geometry is spawned here too, immediately — moved
    // one full fork earlier than a correct choice (Luke, 2026-09-02). It used
    // to wait for extendPastFork/buildFork(k+1), which only ever fires on a
    // correct pick, but "converging branches" (see this function's own doc
    // comment) means the next island's position has never depended on which
    // side turns out correct — there was nothing being protected by hiding
    // it, only a pop-in the moment a choice resolved. Revealing it now
    // doesn't leak which side is correct either: both branches' bridges
    // visibly run to the same island regardless, exactly as before.
    if (!isLastFork) {
      registerIsland(target);
      spawnIsland(target);
      nextIslandAlreadySpawned = true;
    }

    const branch = {};
    const forkPhase = journeyPhase; // both branches leave the fork on the same row phase
    let endPhase = forkPhase;

    if (isLastFork) {
      // No island at `target` for this one (see registerIsland above) — kept
      // as the original stone path; see the bridges section header for why.
      for (const side of ['left', 'right']) {
        const isCorrect = side === correct;
        const sideSign = side === 'right' ? 1 : -1;
        const fullPts = genForkCurve(cursor, target, sideSign, FORK_CURVE_SEGMENTS, false);
        if (isCorrect) {
          branch[side] = fullPts;
          endPhase = scatterAlong(cursor, fullPts, forkPhase);
        } else {
          const stonePts = truncateAtFraction(cursor, fullPts, WRONG_GAP_FRACTION);
          scatterAlong(cursor, stonePts, forkPhase); // dead-ends here — no phase carried forward
          branch[side] = truncateAtFraction(cursor, fullPts, WRONG_FALL_FRACTION);
        }
      }
    } else {
      // Both sides build an IDENTICAL bridge except for the wrong side's
      // plank gap — fairness stays structural (the old genForkCurve comment's
      // point still holds: nothing about the fork itself should tell the two
      // branches apart), only the gap and the walk queue's truncation differ.
      for (const side of ['left', 'right']) {
        const isCorrect = side === correct;
        const sideSign = side === 'right' ? 1 : -1;
        const [departEdge, arriveEdge, centreHop] = genBridgeRoute(cursor, target, sideSign);
        const bridgeOptions = isCorrect
          ? {}
          : { missingPlanks: BRIDGE_WRONG_MISSING, gapCenterT: BRIDGE_WRONG_GAP_T };
        const bridgeGroup = buildBridge(departEdge, arriveEdge, bridgeOptions, bridgeWind);
        scene.add(bridgeGroup);
        bridges.push(bridgeGroup);
        const info = bridgeGroup.userData.bridge;

        // Tag the two anchor points with which bridge they belong to and
        // where along it (0/1) — tick()'s walk loop reads these off
        // leg.queue/leg.lastPoint to set the walker's height and sway while
        // crossing. Every other waypoint (the short hop onto an island's own
        // deck, or a stone stretch elsewhere) is left untagged and so stays
        // flat — see the `head.bridge` check in tick().
        departEdge.bridge = info;
        departEdge.bridgeT = 0;
        arriveEdge.bridge = info;
        arriveEdge.bridgeT = 1;

        if (isCorrect) {
          branch[side] = [departEdge, arriveEdge, centreHop];
        } else {
          // Walk up to the near edge of this bridge's own gap, then fall —
          // same trigger point the missing planks sit at, so the player
          // never reaches a spot where the queue simply runs out for no
          // visible reason.
          const fallPoint = {
            x: THREE.MathUtils.lerp(departEdge.x, arriveEdge.x, BRIDGE_WRONG_GAP_T),
            z: THREE.MathUtils.lerp(departEdge.z, arriveEdge.z, BRIDGE_WRONG_GAP_T),
            bridge: info,
            bridgeT: BRIDGE_WRONG_GAP_T,
          };
          branch[side] = [departEdge, fallPoint];
        }
      }
      // No stones scattered on this stretch any more, so there is nothing for
      // `endPhase` to carry forward — left at `forkPhase`, which only matters
      // again once a later stone stretch (the last fork, or the final
      // approach) needs a starting phase, and there is no adjacent stone row
      // for it to stay continuous with regardless.
    }

    const sec = {
      fork: { ...cursor },
      correct,
      branch,
      extended: false,
      approach: null,
      nextCursor,
      endPhase,
    };
    sec.curtain = makeCurtain(advance(sec.fork, sec.fork.heading, CURTAIN_DIST), sec.fork.heading);
    sections.push(sec);
    return sec;
  }

  /**
   * Commits the correct branch of fork `k`: plants the *next* fork directly
   * at its destination (the branch itself already reaches that island — see
   * genForkCurve — so there is no separate trunk stretch left to lay), or, at
   * the last fork, lays the final approach to the temple instead. Called
   * from applyChoice() the moment a correct pick is made — see the journey
   * section header for why building this far ahead doesn't show the player
   * anything.
   *
   * Must run before applyChoice() reads sec.approach, since this is what
   * fills it in.
   */
  function extendPastFork(k) {
    const sec = sections[k - 1];
    if (!sec || sec.extended) return; // already extended — don't double-build
    sec.extended = true;
    const nextCursor = sec.nextCursor;
    journeyPhase = sec.endPhase;

    if (k < N_FORKS) {
      journeyCursor = { x: nextCursor.x, z: nextCursor.z, heading: nextCursor.heading };
      buildFork(k + 1);
    } else {
      const approachPts = genStraight(nextCursor, nextCursor.heading, APPROACH_DISTANCE, 3);
      journeyPhase = scatterAlong(nextCursor, approachPts, journeyPhase);
      sec.approach = approachPts;
    }
  }

  /**
   * Starts a fresh route: clears whatever the last run built, lays the intro
   * trunk, and plants fork 1. Nothing past fork 1 exists until it is chosen.
   */
  function buildJourney() {
    clearJourney();
    const origin = { x: 0, z: 0, heading: 0 };
    journeyPhase = ROW_SPACING;

    introTrunkPts = genStraight(origin, origin.heading, TRUNK_LEN, TRUNK_SEGMENTS);
    // Register fork 1's island *before* scattering: the trunk runs right into
    // it, and placeStone has to already know to leave that patch clear.
    const introEnd = introTrunkPts[introTrunkPts.length - 1];
    registerIsland(introEnd);
    journeyPhase = scatterAlong(origin, introTrunkPts, journeyPhase);

    journeyCursor = { x: introEnd.x, z: introEnd.z, heading: origin.heading };

    buildFork(1);
  }

  // The avatar is a rig of two stacked planes — the character art in front,
  // its recolourable cardboard backing just behind — rather than a single
  // cutout(), so the backing's tint can change per the player's selection
  // screen choice. Figure art is 400x563 (728x1024 source, resized) — wider
  // relative to its height than the old placeholder, so width is derived from
  // that aspect ratio rather than reused, to avoid a stretched look. Height is
  // 80% of the original placeholder's 2.2, then FIGURE_SCALE on top of that
  // (declared with the other world-scale constants near the top of the file —
  // see the comment there for why).
  const FIGURE_H = 2.2 * 0.8 * FIGURE_SCALE;
  const FIGURE_ASPECT = 400 / 563;

  // Name tag: sized off the figure's own width/height rather than a fixed
  // constant, so it scales correctly if FIGURE_H/FIGURE_SCALE ever change.
  // "Slightly wider than the card" (Luke, 2026-08-30) — 15% wider, a
  // starting value, easy to retune here if it reads too wide or too tight
  // once it's actually next to a figure in the game. Bumped 50% larger
  // still (1.15 -> 1.725) 2026-08-30 while testing whether alternating
  // tags above/below (see TEST_TAGS below) solves overlap between
  // closely-spaced players at this bigger size.
  const NAME_TAG_WIDTH_FACTOR = 1.725;
  const NAME_TAG_GAP = 0.12; // world units between the card's top edge and the tag's bottom edge

  /**
   * Builds one character rig: the character art as a single plane.
   * The group shares Object3D API so position/rotation work identically
   * to a Mesh, even though it contains one.
   */
  function makeCharacterRig(key) {
    const { front } = CHAR_TEX[key];
    const w = FIGURE_H * FIGURE_ASPECT;
    const group = new THREE.Group();

    const frontMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, FIGURE_H),
      new THREE.MeshBasicMaterial({ map: front, transparent: true, alphaTest: 0.45, side: THREE.DoubleSide })
    );
    frontMesh.castShadow = true;

    group.add(frontMesh);
    group.position.y = FIGURE_H / 2;
    scene.add(group);
    return { group, frontMesh };
  }

  function disposeRig(r) {
    scene.remove(r.group);
    r.frontMesh.geometry.dispose();
    r.frontMesh.material.dispose();
    removeNameTag(r);
  }

  let characterKey = ROSTER[0].key;
  let rig = makeCharacterRig(characterKey);
  let figure = rig.group;

  function setCharacter(key) {
    if (key !== characterKey) {
      const old = rig;
      characterKey = key;
      rig = makeCharacterRig(key);
      figure = rig.group;
      disposeRig(old);
    }
  }

  /**
   * Name tags: a screen-space DOM overlay, not a mesh on the rig.
   *
   * History: this started (2026-08-30) as a plane mesh parented to the
   * rig's group, positioned above the figure's head in local Y. That broke
   * the moment an alternate "below the card" placement was needed (see
   * TEST_TAGS below, for testing tag overlap between close-together
   * players): mirroring the above-the-head math put it *underground*,
   * because the ground is solid right at the feet — there's no open
   * "underneath" in world space the way there's open sky above the head.
   * Found live by extracting the mesh's actual world position; the tag was
   * there, just buried in the stone floor.
   *
   * Rewritten 2026-08-31 as a plain positioned <div> per tag, layered in
   * `#nameTagLayer` above the canvas, repositioned every frame by
   * projecting each rig's anchor point through the camera (`worldToScreen`
   * below). This sidesteps the ground problem entirely — a pixel offset
   * can't clip into terrain — and comes with two things Luke asked for
   * that were awkward as mesh-local geometry:
   *   - visibility is now a plain per-tag flag, not a position hack, so
   *     "hide while the card is moving, show once it's standing still on
   *     an island" (Luke, 2026-08-31 — see `moving` in updateNameTags) is
   *     one boolean, and any future per-avatar exception (an abduction
   *     animation that should hide the tag mid-flight, say) is too.
   *   - each viewer's own camera does the projecting, so who reads as
   *     "left" or "right" — and thus how far off-centre a tag lands — is
   *     naturally per-viewer with zero extra bookkeeping, which matters
   *     once other players are actually networked (see TODO.md).
   * No per-tag screen-collision layout yet (letting two tags overlap on
   * screen if the projected math says they should) — flagged in TODO.md as
   * the natural next step once there are several real networked players
   * to test it against, rather than guessed at now.
   */
  const nameTags = []; // { rig, localY, tagW, tagH, el, alwaysVisible }

  function worldToScreen(pos) {
    const v = pos.clone().project(camera);
    return {
      x: (v.x * 0.5 + 0.5) * surfaceWidth(),
      y: (1 - (v.y * 0.5 + 0.5)) * surfaceHeight(),
      behind: v.z > 1,
    };
  }

  // Run every frame regardless of state (see tick()) — visibility itself is
  // state-dependent, so the check has to happen every frame, not just while
  // walking. `moving` covers falling too: a mid-fall tag would be exactly
  // as nonsensical as a mid-walk one.
  function updateNameTags() {
    const moving = !!leg || falling;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    for (const t of nameTags) {
      if (moving && !t.alwaysVisible) {
        t.el.style.display = 'none';
        continue;
      }
      const anchor = t.rig.group.position.clone();
      anchor.y += t.localY;
      const center = worldToScreen(anchor);
      if (center.behind) {
        t.el.style.display = 'none';
        continue;
      }
      // Calibrate on-screen width by projecting two points a real tagW
      // apart at the anchor's own depth, rather than a fixed px size or a
      // distance-ratio guess — this is exactly the perspective size a 3D
      // plane of that world width would have rendered at, so it keeps
      // looking right if the camera FOV/distance ever changes, with
      // nothing here to re-tune.
      const half = right.clone().multiplyScalar(t.tagW / 2);
      const edgeA = worldToScreen(anchor.clone().add(half));
      const edgeB = worldToScreen(anchor.clone().sub(half));
      const pxWidth = Math.hypot(edgeA.x - edgeB.x, edgeA.y - edgeB.y);
      t.el.style.display = '';
      t.el.style.left = `${center.x}px`;
      t.el.style.top = `${center.y}px`;
      t.el.style.width = `${pxWidth}px`;
      t.el.style.height = `${pxWidth * (t.tagH / t.tagW)}px`;
    }
  }

  function removeNameTag(targetRig) {
    if (!targetRig.nameTag) return;
    const idx = nameTags.indexOf(targetRig.nameTag);
    if (idx !== -1) nameTags.splice(idx, 1);
    targetRig.nameTag.el.remove();
    targetRig.nameTag = null;
  }

  /**
   * Builds the name-tag canvas (async — it loads the letter/background art
   * on demand) and registers a screen-space tag for the given rig once
   * ready. Fire-and-forget from the Start button: by the time it resolves
   * the player is already walking, and the tag just appears a beat later
   * (hidden until they stop, per updateNameTags above). Guards against the
   * rig having been swapped or the game unmounted in the meantime (neither
   * happens for the player's own rig in the current flow — character can't
   * change after Start — but cheap to guard against regardless, and does
   * matter for TEST_TAGS companions, which are never "current" under the
   * default guard — see `isCurrent` below).
   *
   * Glow thickness/brightness and gamma/contrast/saturation were all tuned
   * live via a bottom-right slider panel (removed 2026-08-31 once Luke
   * settled on final numbers — see TODO.md for the values and the two real
   * bugs that turned up while tuning them). Not passing any tuning options
   * here at all, deliberately: buildNameTagCanvas's own defaults
   * (GLOW_BLUR_DEFAULT, GAMMA_DEFAULT, etc. in nameTag.js) already are
   * those final numbers, so there's nothing for this call site to override.
   */
  function attachNameTag(targetRig, name, glowColorHex, opts = {}) {
    if (!name) return;
    // `side` places the tag above the head or down near the feet (see the
    // TEST_TAGS block below for why "below" isn't a mirror-image offset).
    // `isCurrent` replaces the old hardcoded `rig === targetRig` guard
    // (which assumed the *only* rig in play was the player's own,
    // swappable one — not true once static companion rigs that never
    // change exist alongside it). `alwaysVisible` skips the
    // hide-while-moving rule entirely — unused today (every tag currently
    // follows the same rule, per Luke, 2026-08-31) but cheap to leave
    // wired in for whenever the player's own tag, say, needs to differ.
    const { side = 'above', isCurrent = () => rig === targetRig, alwaysVisible = false } = opts;
    const glowColor = `#${glowColorHex.toString(16).padStart(6, '0')}`;
    buildNameTagCanvas(name, { glowColor })
      .then(({ canvas, aspect }) => {
        if (disposed || !isCurrent()) return;
        removeNameTag(targetRig); // drop any previous tag for this rig first — avoids a leaked duplicate on re-attach
        const w = FIGURE_H * FIGURE_ASPECT;
        const tagW = w * NAME_TAG_WIDTH_FACTOR;
        const tagH = tagW * aspect;
        // "below" isn't a mirror of "above": the ground is solid right at
        // the figure's feet (world y=0), so mirroring the above-the-head
        // math buried the old mesh version under the stone floor. Instead
        // it hovers just above ground near the shins/knees, low enough to
        // read as "beneath the player" without clipping into the terrain.
        const localY = side === 'below'
          ? -(FIGURE_H / 2) + NAME_TAG_GAP + tagH / 2
          : FIGURE_H / 2 + NAME_TAG_GAP + tagH / 2;
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        const el = document.createElement('div');
        el.className = 'nameTagChip';
        el.appendChild(canvas);
        els.nameTagLayer.appendChild(el);
        const entry = { rig: targetRig, localY, tagW, tagH, el, alwaysVisible };
        targetRig.nameTag = entry;
        nameTags.push(entry);
      })
      .catch((err) => console.error('[nameTag] failed to build', err));
  }
  setCharacter(ROSTER[0].key);

  // ------------------------------------------------------------ TEST_TAGS
  // Temporary, gated behind ?testTags=1 — not a real multiplayer feature
  // (other players' positions aren't networked yet, see TODO.md). Spawns
  // four static "Player N" companions beside the real player so Luke can
  // eyeball whether alternating name tags above/below fixes overlap
  // between close-together players at the new 50%-bigger tag size.
  // Left-to-right: Player 1 (top), Player 2 (bottom), the real player as
  // "Player 3" (top), Player 4 (bottom), Player 5 (top) — bottom-tag
  // players also stand a little lower, per Luke, so their body position
  // roughly matches their tag position. Delete this whole block (and its
  // two call sites below) once the above/below question is settled.
  const TEST_TAGS = new URLSearchParams(location.search).has('testTags');
  const testCompanions = []; // { rig, offsetX, yStagger }

  function spawnTestCompanions() {
    const SPACING_X = FIGURE_H * FIGURE_ASPECT * 1.5;
    const STAGGER_Y = FIGURE_H * 0.15;
    // Spelled-out numbers, not digits — the letter art has no digit glyphs
    // (see normalizePlayerName/WORD_GAP), same reason the empty-input
    // default is "Player One" rather than "Player 1".
    const slots = [
      { label: 'Player One', offsetX: -2 * SPACING_X, side: 'above', yStagger: 0 },
      { label: 'Player Two', offsetX: -1 * SPACING_X, side: 'below', yStagger: -STAGGER_Y },
      { label: 'Player Four', offsetX: 1 * SPACING_X, side: 'below', yStagger: -STAGGER_Y },
      { label: 'Player Five', offsetX: 2 * SPACING_X, side: 'above', yStagger: 0 },
    ];
    const companionKeys = ROSTER.filter((c) => c.key !== pickedCharacter).slice(0, 4).map((c) => c.key);
    slots.forEach((slot, i) => {
      const companionRig = makeCharacterRig(companionKeys[i]);
      attachNameTag(companionRig, slot.label, pickedColorHex, { side: slot.side, isCurrent: () => true });
      testCompanions.push({ rig: companionRig, offsetX: slot.offsetX, yStagger: slot.yStagger });
    });
  }

  // ---------------------------------------------------------------- fall physics (Rapier)
  //
  // Used only for the wrong-turn consequence — the avatar drops off the path
  // under real gravity instead of just vanishing. No colliders exist for it to
  // land on; it free-falls until FALL_UI_DELAY shows the result, then keeps
  // falling for FALL_EXTRA_DURATION longer before actually freezing.
  //
  // "Wind" is faked rather than simulated: a true helical field would need a
  // force that keeps rotating around the fall for as long as it blows, which
  // is a lot of machinery for something on screen a couple of seconds. Instead
  // a single off-centre force is applied each physics step for a short window,
  // its magnitude decaying to zero and its horizontal direction slowly
  // rotating — a decaying, turning push reads as "caught by a gust and spun
  // around" close enough to a helix at this timescale, for a few lines of code
  // instead of a field simulation. See blow-trial.js for the fuller multi-puff
  // version of this idea if a later pass wants more chaos than one rotating
  // force gives.
  const fallWorld = new RAPIER.World({ x: 0, y: -9.82, z: 0 });
  const FALL_FIXED_DT = 1 / 60;
  fallWorld.timestep = FALL_FIXED_DT;

  const CARD_THICK = 0.05 * FIGURE_SCALE; // scales with the figure — it's the card's own depth, not a scene-relative distance
  // The "you fell" message/Again button and the card actually stopping are two
  // different clocks: the UI shows up at FALL_UI_DELAY, but the card keeps
  // tumbling in the background for FALL_EXTRA_DURATION more seconds after
  // that — the player reads the result while the fall is still visibly
  // happening, rather than staring at a frozen card the instant the message
  // appears.
  const FALL_UI_DELAY = 2.2; // seconds — when "you fell…" + Again appear
  const FALL_EXTRA_DURATION = 5; // seconds the card keeps falling after that, before it actually freezes
  const FALL_DISAPPEAR = 5; // seconds — the card itself vanishes (too far/small to read as falling any more), well before the freeze at FALL_UI_DELAY + FALL_EXTRA_DURATION

  const WIND_DURATION = 0.9; // seconds — how long the gust lasts before the card just free-falls
  const WIND_STRENGTH = 2.4; // peak sideways force (N-ish, tuned by eye against CARD mass below)
  const WIND_ANGULAR_SPEED = (280 * Math.PI) / 180; // rad/s the push direction sweeps around — the "helical" part
  const WIND_SPREAD_Y = FIGURE_H * 0.45; // how far off-centre (local, vertical) the push lands — generates tumble via r x F
  const CARD_MASS = 0.4;

  let fallBody = null;
  let falling = false;
  let fallAccumulator = 0;
  let fallElapsed = 0;
  let windAngle = 0; // current heading of the sweeping wind push, radians

  // The fall camera doesn't lean out from wherever it happened to be trailing
  // the walker — that's still CAM_BACK behind the edge, so tilting down from
  // there looks *through* the walkway itself rather than past it. Instead it
  // eases to a fixed point beside the edge (walker's position when the stub
  // ran out — see startFall), offset sideways so the walkway's own stones
  // aren't between the camera and the open air the figure is falling through.
  const fallCamAnchor = new THREE.Vector3(); // computed once in startFall(), held fixed for the whole fall
  const FALL_CAM_HEIGHT = 2.6; // above the edge — enough to look down and clear of the stones
  const FALL_CAM_SIDE = 2.8; // sideways offset from the walkway's centreline
  const FALL_CAM_FORWARD = 0.8; // small nudge out past the last stone
  const FALL_CAM_EASE = 3.2; // per-second ease rate toward the anchor

  function startFall() {
    figure.visible = true; // in case a previous fall hid it and something skipped the reset handler's restore
    if (fallBody) fallWorld.removeRigidBody(fallBody);

    fallBody = fallWorld.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(figure.position.x, figure.position.y, figure.position.z)
        .setRotation({ x: figure.quaternion.x, y: figure.quaternion.y, z: figure.quaternion.z, w: figure.quaternion.w })
        .setLinearDamping(0.05)
        .setAngularDamping(0.15)
        .setAdditionalMass(CARD_MASS)
    );
    fallWorld.createCollider(
      RAPIER.ColliderDesc.cuboid((FIGURE_H * FIGURE_ASPECT) / 2, FIGURE_H / 2, CARD_THICK / 2),
      fallBody
    );

    // One-off random stumble so every fall spins differently from the start —
    // the sweeping wind force (applied per-step below) takes over the ongoing
    // chaos a moment later.
    fallBody.setAngvel(
      { x: (Math.random() * 2 - 1) * 2.4, y: (Math.random() * 2 - 1) * 2.4, z: (Math.random() * 2 - 1) * 2.4 },
      true
    );
    fallBody.setLinvel(
      { x: (Math.random() * 2 - 1) * 0.6, y: 0.4, z: (Math.random() * 2 - 1) * 0.6 },
      true
    );

    windAngle = Math.random() * Math.PI * 2; // random starting heading so falls don't all spiral the same way

    falling = true;
    fallAccumulator = 0;
    fallElapsed = 0;

    // Anchor beside the edge (walker's position when the stub ran out), not
    // wherever the trailing camera happened to be — see comment above.
    // Lean in the direction of the falling path: left if they chose left, right if they chose right.
    const angleOffset = choiceSide === 'left' ? -Math.PI / 2 : Math.PI / 2;
    const side = forward(facing + angleOffset, FALL_CAM_SIDE);
    const ahead = forward(facing, FALL_CAM_FORWARD);
    fallCamAnchor.set(walker.x + side.x + ahead.x, FALL_CAM_HEIGHT, walker.z + side.z + ahead.z);

    cancelBirdsForFall();
  }

  /** Applies the decaying, rotating wind push for one physics step — call once
   * per fallWorld.step() while within WIND_DURATION of the fall starting. */
  function applyFallWind() {
    if (fallElapsed >= WIND_DURATION) return;
    const decay = 1 - fallElapsed / WIND_DURATION; // linear fade to zero
    windAngle += WIND_ANGULAR_SPEED * FALL_FIXED_DT;

    const mag = WIND_STRENGTH * decay * CARD_MASS * FALL_FIXED_DT; // force -> impulse over one step
    const dir = { x: Math.cos(windAngle), z: Math.sin(windAngle) };
    const impulse = { x: dir.x * mag, y: 0, z: dir.z * mag };

    const t = fallBody.translation();
    const worldPoint = { x: t.x, y: t.y + WIND_SPREAD_Y, z: t.z }; // off-centre vertically -> torque for free
    fallBody.applyImpulseAtPoint(impulse, worldPoint, true);
  }

  // figure.position/rotation are the *visual* transform, redrawn from these
  // every frame (see the step-bob block in tick()) — walker is the actual
  // logical path position everything else (movement, camera, fork/curtain
  // checks, key light) reads and writes. Splitting them is what lets the walk
  // bob nudge the mesh sideways and tilt it without that offset silently
  // feeding back into "how far has the avatar actually walked".
  const walker = new THREE.Vector3(0, 0, 0);

  // Guide-only overlay: which branch is safe, which is not, for the fork
  // currently being decided. Just one pair, repositioned onto whichever fork
  // that is, so old forks don't stay flagged behind the player.
  function makeMarker() {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(1.15, 1.15),
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, fog: false })
    );
    m.renderOrder = 10; // above the fog puffs (9), so a guide's markers are never veiled
    m.visible = false;
    scene.add(m);
    return m;
  }
  const markerPair = { left: makeMarker(), right: makeMarker() };

  function updateMarkers() {
    const sec = sections[forkIndex - 1];
    const showCurrent = !leg && !finished && !falling && role === 'guide' && sec;
    if (!showCurrent) {
      markerPair.left.visible = false;
      markerPair.right.visible = false;
      return;
    }
    const correct = sec.correct;
    const step = BRANCH_LEN / BRANCH_SEGMENTS;
    const leftAt = advance(sec.fork, sec.fork.heading - FORK_HALF_ANGLE, step);
    const rightAt = advance(sec.fork, sec.fork.heading + FORK_HALF_ANGLE, step);
    markerPair.left.position.set(leftAt.x, 1.5, leftAt.z);
    markerPair.right.position.set(rightAt.x, 1.5, rightAt.z);
    markerPair.left.material.map = correct === 'left' ? TEX.safe : TEX.hazard;
    markerPair.right.material.map = correct === 'right' ? TEX.safe : TEX.hazard;
    markerPair.left.material.needsUpdate = true;
    markerPair.right.material.needsUpdate = true;
    markerPair.left.visible = true;
    markerPair.right.visible = true;
  }

  // ---------------------------------------------------------------- state
  //
  // There is no manual "step" anymore. Choosing left/right triggers one
  // automatic walk that covers the branch and continues straight into the next
  // round's trunk, landing at the next fork. The figure's position never jumps
  // — it just keeps walking. sunP is driven by how far along that walk the
  // figure has travelled, so the sky changes continuously rather than snapping
  // at each fork. facing (below) drives the camera's heading the same way.

  // Raised 3.2 -> 4.0 alongside the character shrink (agreed 2026-08-27, see
  // TODO.md "World scale rework") — covering ground faster reads as part of
  // the same "the world is big" effect as a smaller figure, and it is the
  // agreed lever for pulling total walk time back down from the ~37s the
  // bigger islands now take at the old speed, if that turns out to drag.
  const WALK_SPEED = 4.0; // world units / second

  let forkIndex = 1; // 1..N_FORKS — the fork currently awaiting a decision
  let finished = false;
  let finishedSuccess = false;
  let correctCount = 0;
  // Role comes from the caller now, not from a URL parameter read by a
  // Supabase-importing sibling module. `soloRoleToggle` keeps the old
  // one-device convenience of previewing both perspectives, but only when
  // nobody else is depending on this device's role being fixed — i.e. when
  // there's no owner listening for choices.
  const soloRoleToggle = !onForkChoice;
  let role = initialRole;
  let sunP = timeOfDay(1);

  // leg: the walk currently in progress, or null while awaiting a decision.
  let leg = null;
  let choiceSide = null; // 'left' or 'right' — tracks which path was chosen, used for camera angle during fall

  function makeLeg(queue, realPoints, fromP, toP, arriveFork) {
    // `lastPoint` is where the walker stands *right now*, snapshotted as the
    // leg begins — always flat ground (an island deck, or spawn), never
    // mid-bridge, since a leg only ever starts where the previous one ended.
    // tick()'s walk loop advances this to each waypoint as it's reached, and
    // compares it against the upcoming one's `.bridge` tag to know whether the
    // *current segment* is a bridge crossing (see the `head.bridge` check
    // there) — untagged waypoints (islands, stone stretches) leave it null.
    return {
      queue,
      total: pathLength(realPoints),
      traveled: 0,
      fromP,
      toP,
      arriveFork,
      lastPoint: { x: walker.x, z: walker.z, bridge: null, bridgeT: 0 },
    };
  }

  function startJourney() {
    buildJourney();
    leg = makeLeg(
      introTrunkPts.slice(),
      [walker, ...introTrunkPts],
      timeOfDay(1),
      timeOfDay(1),
      1
    );
  }

  startJourney();

  // How far back the trailing camera sits, as a multiple of CAM_BACK. Only the
  // crowd harness moves it today; it exists as a dial because "the guide's
  // camera pulls back slightly to show the whole group" is the change this
  // harness is being used to size.
  let camPull = 1;

  const harness =
    crowd > 0
      ? attachCrowdHarness({
          count: crowd,
          scene,
          container,
          makeRig: makeCharacterRig,
          disposeRig,
          localToWorld,
          sections,
          getForkIndex: () => forkIndex,
          isWalking: () => !!leg,
          FIGURE_H,
          WALK_SPEED,
          ROSTER,
          placeStone,
          setCamPull: (v) => {
            camPull = v;
          },
        })
      : null;

  // Throwaway sky/sea slider panel — dev builds only, since it exists purely
  // to find numbers to bake back into the layer block above.
  // Gap sliders read as a denominator, not a magnitude: bigger means rarer.
  const oneIn = (n) => (n > 0 ? `1 in ${n}` : 'off');

  // The backdrop slider panel (sky/sea/clouds) is off by default now that
  // every value it was built to find has been baked in above. It is kept
  // wired rather than deleted, because the next art change will want it
  // again and rebuilding it costs more than carrying it: add `&tuneBg=1` to
  // the URL to bring it back. Anything adjusted here has to be copied back
  // into the constants by hand — the panel writes to the live objects, not
  // to the source.
  //
  // Deliberately its OWN flag, separate from the name-tag tuner's `?tune=1`
  // below (2026-08-30, Luke: "disable the other, older sliders... make them
  // invisible again... don't feel the need to re-integrate them without
  // being asked"). The two panels used to share `tune=1` since this one was
  // already wired that way when the name-tag tuner was added alongside it —
  // that accidentally brought this dormant, unrelated panel back on screen.
  // If a future task wants *this* panel again, that has to be an explicit
  // ask, not a side effect of some other tuner reusing the same flag.
  const bgTuner = import.meta.env.DEV && new URLSearchParams(location.search).has('tuneBg')
    ? attachBgTuner({
        container,
        panels: { sky, landSea },
        // Everything else that can paint into the horizon band, so a stray
        // layer can be identified by switching it off rather than guessed at.
        toggles: { landSea, cloudDense, cloudLight, peaks: peaksBand, horizonBank, deckDeep, deckHigh },
        extras: {
          'dense speed': { value: wind.dense, min: 0, max: 20, step: 0.1, set: (v) => (wind.dense = v) },
          'light speed': { value: wind.light, min: 0, max: 20, step: 0.1, set: (v) => (wind.light = v) },
          'dense Y': { value: cloudDense.y, min: -60, max: 0, step: 0.1, set: (v) => (cloudDense.y = v) },
          'light Y': { value: cloudLight.y, min: -60, max: 0, step: 0.1, set: (v) => (cloudLight.y = v) },
          'dense chaos': { value: cloudDense.chaos, min: 0, max: 1, step: 0.02, set: (v) => (cloudDense.chaos = v) },
          'light chaos': { value: cloudLight.chaos, min: 0, max: 1, step: 0.02, set: (v) => (cloudLight.chaos = v) },
          'dense gaps': { value: cloudDense.gaps, min: 0, max: 24, step: 1, set: (v) => (cloudDense.gaps = v), format: oneIn },
          'light gaps': { value: cloudLight.gaps, min: 0, max: 24, step: 1, set: (v) => (cloudLight.gaps = v), format: oneIn },
          'dense stagger': { value: cloudDense.stagger, min: 0, max: 0.5, step: 0.05, set: (v) => (cloudDense.stagger = v), format: (v) => v.toFixed(2) },
          // The island's shape (bump/taper/depth/size/grass) isn't tunable
          // here — that's what island-proto.html is for, since changing any
          // of those means rebuilding the mesh, not just repositioning it.
          // Y is cheap to leave live since it's a plain reposition.
          'island Y': {
            value: ISLAND_Y,
            min: -4,
            max: 4,
            step: 0.05,
            set: (v) => {
              ISLAND_Y = v;
              for (const g of islands) g.position.y = v;
            },
          },
          'light stagger': { value: cloudLight.stagger, min: 0, max: 0.5, step: 0.05, set: (v) => (cloudLight.stagger = v), format: (v) => v.toFixed(2) },
        },
      })
    : null;

  // The name-tag glow/gamma/contrast/saturation tuner (bottom-right,
  // ?tune=1) was removed 2026-08-31 once Luke settled on final numbers —
  // see TODO.md for the values and history. Unlike the backdrop tuner above
  // (kept behind ?tuneBg=1 for the *next* art pass), this one isn't being
  // kept dormant: name-tag color grading isn't expected to need re-tuning
  // the way backdrop placement periodically does, so it was deleted rather
  // than parked. If that assumption turns out wrong, rebuilding it is
  // cheap — this file's git history has the full working version.

  // ---------------------------------------------------------------- controls

  const els = {
    left: $('left'),
    right: $('right'),
    reset: $('reset'),
    role: $('role'),
    hint: $('hint'),
    hud: $('hud'),
    charSelect: $('charSelect'),
    charList: $('charList'),
    paletteList: $('paletteList'),
    nameInput: $('nameInput'),
    charStart: $('charStart'),
    nameTagLayer: $('nameTagLayer'),
  };

  // The role button always shows the current role. In a round it is assigned
  // by the session layer and the button is inert — disabled rather than
  // hidden, so it still reads as confirmation of which role this device has.
  els.role.dataset.role = role;
  els.role.textContent = role === 'guide' ? 'Guide view' : 'Player view';
  if (!soloRoleToggle) {
    els.role.disabled = true;
    els.role.title = 'Role is assigned by the lobby for this round';
  }

  // ---------------------------------------------------------------- character selection screen
  //
  // Shown once, after assets finish loading (see manager.onLoad below). The
  // game underneath is already ticking — the screen is a full-screen blocking
  // overlay rather than something that delays the walk itself, which is
  // simpler than gating startJourney() and looks identical to the player
  // either way, since they can't see or reach anything behind it.
  let pickedCharacter = ROSTER[0].key;
  let pickedColorHex = PALETTE[0].hex;
  // Randomised (was fixed at 0) per Luke's request 2026-08-30, so the
  // carousel doesn't always open on the same character.
  let charSelectIndex = Math.floor(Math.random() * ROSTER.length);

  function renderCharSelect() {
    // Carousel: show one character at a time with left/right navigation
    els.charList.innerHTML = '';
    const c = ROSTER[charSelectIndex];
    const btn = document.createElement('button');
    btn.className = 'charOption selected';
    btn.innerHTML = `<img src="textures/${c.tex}.${c.ext}" alt="" />`;
    btn.style.cursor = 'default';
    btn.style.pointerEvents = 'none';
    els.charList.appendChild(btn);

    els.paletteList.innerHTML = '';
    for (const p of PALETTE) {
      const btn = document.createElement('button');
      btn.className = 'swatch' + (p.hex === pickedColorHex ? ' selected' : '');
      btn.style.background = `#${p.hex.toString(16).padStart(6, '0')}`;
      btn.setAttribute('aria-label', p.label);
      // Re-enabled 2026-08-30: was inert (card-backing recolour never
      // shipped — see TODO.md), now drives the name-tag glow colour
      // instead. Secondary to getting the glow's position/look right, per
      // Luke — not the focus, just wired up since it was trivial once the
      // glow itself worked.
      btn.addEventListener('click', () => {
        pickedColorHex = p.hex;
        renderCharSelect();
      });
      els.paletteList.appendChild(btn);
    }

    pickedCharacter = c.key;
  }
  renderCharSelect();

  // Carousel navigation buttons
  function updateCarouselNav() {
    const charListParent = els.charList.parentElement;

    let navRow = $('charNavRow');
    if (!navRow) {
      navRow = document.createElement('div');
      navRow.id = 'charNavRow';
      navRow.style.cssText = 'display: flex; gap: 12px; justify-content: center; margin-top: 12px; align-items: center;';
      charListParent.insertBefore(navRow, els.charList.nextSibling);
    }

    // Update counter
    let counter = navRow.querySelector('span');
    if (!counter) {
      const leftBtn = document.createElement('button');
      leftBtn.id = 'charNavLeft';
      leftBtn.textContent = '‹';
      leftBtn.style.cssText = 'width: 40px; height: 40px; border: 0; border-radius: 8px; background: rgba(244, 247, 250, 0.14); color: #f4f7fa; font-size: 24px; cursor: pointer; display: flex; align-items: center; justify-content: center;';
      leftBtn.addEventListener('click', () => {
        charSelectIndex = (charSelectIndex - 1 + ROSTER.length) % ROSTER.length;
        renderCharSelect();
        updateCarouselNav();
      });

      counter = document.createElement('span');
      counter.style.cssText = 'color: #f4f7fa; font-size: 12px; opacity: 0.6; width: 30px; text-align: center;';

      const rightBtn = document.createElement('button');
      rightBtn.id = 'charNavRight';
      rightBtn.textContent = '›';
      rightBtn.style.cssText = 'width: 40px; height: 40px; border: 0; border-radius: 8px; background: rgba(244, 247, 250, 0.14); color: #f4f7fa; font-size: 24px; cursor: pointer; display: flex; align-items: center; justify-content: center;';
      rightBtn.addEventListener('click', () => {
        charSelectIndex = (charSelectIndex + 1) % ROSTER.length;
        renderCharSelect();
        updateCarouselNav();
      });

      navRow.appendChild(leftBtn);
      navRow.appendChild(counter);
      navRow.appendChild(rightBtn);
    }
    counter.textContent = `${charSelectIndex + 1}/${ROSTER.length}`;
  }
  updateCarouselNav();

  els.charStart.addEventListener('click', () => {
    setCharacter(pickedCharacter);
    // "Player One" default per Luke, 2026-08-30 — used whenever the name
    // field is left empty rather than shipping a blank/missing name tag.
    // Under TEST_TAGS the real player's own name is overridden to "Player
    // Three" so the five tags read as one consistent numbered sequence —
    // see the TEST_TAGS block above.
    const name = TEST_TAGS ? 'Player Three' : (normalizePlayerName(els.nameInput.value) || 'Player One');
    attachNameTag(rig, name, pickedColorHex);
    if (TEST_TAGS) spawnTestCompanions();
    els.charSelect.classList.remove('visible');
    setTimeout(() => els.charSelect.classList.remove('show'), 350);
  });

  function refreshUI() {
    updateMarkers();
    const walking = !!leg;
    // In a networked game only the guide's client acts on a fork — see
    // multiplayer.js's doc comment for why this is deliberately one-sided.
    // Who may press the buttons is now the caller's call, not a function of
    // role. The agreed model is the inverse of the first prototype: the guide
    // speaks the cue aloud and a *player* acts on it — see TODO.md.
    const cannotAct = !canAct;
    els.left.classList.toggle('hidden', walking || finished || falling || cannotAct);
    els.right.classList.toggle('hidden', walking || finished || falling || cannotAct);
    els.reset.classList.toggle('hidden', !finished);

    if (finished) {
      els.hint.textContent = finishedSuccess
        ? `You reached the temple — all ${N_FORKS} crossings were safe.`
        : `The path ran out — you fell at fork ${forkIndex} of ${N_FORKS}, after ${correctCount} safe crossing${correctCount === 1 ? '' : 's'}.`;
    } else if (falling) {
      els.hint.textContent = 'Falling…';
    } else if (walking) {
      els.hint.textContent = 'Walking to the next fork…';
    } else {
      const label = timeLabel(timeOfDay(forkIndex));
      els.hint.textContent =
        role === 'guide'
          ? `Fork ${forkIndex} of ${N_FORKS} (${label}) — you can see which way is safe.`
          : `Fork ${forkIndex} of ${N_FORKS} (${label}) — a junction. You cannot see which way is safe.`;
    }
  }

  /**
   * The round's one report upward. Deliberately a plain result — how many
   * points or which items that's worth is a session-layer decision, because
   * "a game mode never accumulates or reads a running total itself; it only
   * ever emits what happened this round" (handoff doc). Guarded so the two
   * end conditions (reached the temple / fell) can't both fire, and so a
   * frame boundary can't emit it twice.
   */
  let roundEndEmitted = false;
  function emitRoundEnd(success) {
    if (roundEndEmitted) return;
    roundEndEmitted = true;
    if (onRoundEnd) onRoundEnd({ success, forkIndex, correctCount, totalForks: N_FORKS });
  }

  // Only the current fork's own two branches exist when this runs (see the
  // journey section header). A correct pick therefore has to *build* what
  // follows — the next fork itself, already reachable directly since the
  // branch runs all the way to it — before it can queue the walk through it;
  // a wrong pick builds nothing, and walks the truncated branch until it
  // runs out of stones in mid-air, which ends the journey.
  function applyChoice(side) {
    if (leg || finished) return;
    const sec = sections[forkIndex - 1];
    if (!sec) return;

    choiceSide = side; // track which path was chosen for camera angle during fall
    const wasCorrect = side === sec.correct;
    const branchPts = sec.branch[side];
    const queue = branchPts.slice();
    const realPoints = [walker.clone(), ...branchPts];

    if (wasCorrect) {
      correctCount++;
      const isLastFork = forkIndex === N_FORKS;
      extendPastFork(forkIndex); // plants the next fork, or (last fork only) fills in sec.approach
      const continuation = sec.approach || [];
      queue.push(...continuation);
      realPoints.push(...continuation);
      const arriveFork = isLastFork ? null : forkIndex + 1;
      const toP = isLastFork ? timeOfDay(N_FORKS) : timeOfDay(forkIndex + 1);
      leg = makeLeg(queue, realPoints, timeOfDay(forkIndex), toP, arriveFork);
      leg.success = true;
    } else {
      leg = makeLeg(queue, realPoints, timeOfDay(forkIndex), timeOfDay(forkIndex), null);
      leg.success = false;
    }
    refreshUI();
  }
  /**
   * A tap is a *request*, not a decision. Nothing here changes state: the
   * owner is told, and it calls back into `applyChoice` (via the returned
   * handle) once the choice is settled. In solo play the owner settles it
   * immediately; in a room it goes out over the relay and comes back, so
   * every device applies the same choice in the same order even if several
   * players tap at once. Applying locally as well would be the one thing
   * that reintroduces divergence — see TODO.md.
   */
  function requestChoice(side) {
    if (leg || finished || falling || !canAct) return;
    if (onForkChoice) onForkChoice(forkIndex, side);
    else applyChoice(side); // no owner listening: solo play, decide it here
  }
  els.left.addEventListener('click', () => requestChoice('left'));
  els.right.addEventListener('click', () => requestChoice('right'));

  /**
   * Back to the start of a fresh journey. Exposed on the handle as well as
   * wired to the "Again" button, because in a room a restart is a decision
   * for the whole room, not for whichever device pressed the button — the
   * owner can call this on every device at once.
   */
  function restart() {
    roundEndEmitted = false;
    forkIndex = 1;
    finished = false;
    finishedSuccess = false;
    falling = false;
    correctCount = 0;
    choiceSide = null;
    walker.set(0, 0, 0);
    facing = 0;
    walkPhase = 0;
    // The fall leaves figure.quaternion tumbled on all three axes; the walk-bob
    // code only ever writes rotation.z back, so x/y would otherwise carry the
    // fall's tilt into the new walk. Clear the whole rotation explicitly.
    figure.rotation.set(0, 0, 0);
    figure.visible = true; // undo the FALL_DISAPPEAR hide, if the card vanished before this click
    startJourney();
    refreshUI();
  }
  els.reset.addEventListener('click', () => restart());

  els.role.addEventListener('click', () => {
    if (!soloRoleToggle) return; // assigned by the session layer; button is inert
    role = role === 'guide' ? 'player' : 'guide';
    els.role.dataset.role = role;
    els.role.textContent = role === 'guide' ? 'Guide view' : 'Player view';
    refreshUI(); // curtain opacity follows `role` in updateCurtains each frame
  });

  // Drag to look. This is the clearest demonstration of the multiplane effect on
  // a touch screen — the layers shift against each other by real parallax.
  const look = { x: 0, y: 0, tx: 0, ty: 0 };
  let dragging = null;

  // Look is a lateral *slide* of the camera, not a yaw: it keeps looking at a
  // point 4.6 ahead of the walker while sitting CAM_BACK behind it, so an
  // offset of L swings the view by atan(L / (CAM_BACK + 4.6)). At the old 2.2
  // that was only about 10 degrees each way. 6.9 buys roughly 30, which is what
  // the curved sky was widened to cover.
  const LOOK_X_LIMIT = 6.9;

  renderer.domElement.addEventListener('pointerdown', (e) => {
    dragging = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: look.tx, oy: look.ty };
    renderer.domElement.setPointerCapture(e.pointerId);
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (!dragging || dragging.id !== e.pointerId) return;
    const s = 6 / surfaceWidth();
    look.tx = THREE.MathUtils.clamp(dragging.ox + (e.clientX - dragging.x) * s, -LOOK_X_LIMIT, LOOK_X_LIMIT);
    look.ty = THREE.MathUtils.clamp(dragging.oy - (e.clientY - dragging.y) * s, -0.7, 1.3);
  });
  const endDrag = () => { dragging = null; };
  renderer.domElement.addEventListener('pointerup', endDrag);
  renderer.domElement.addEventListener('pointercancel', endDrag);

  // ---------------------------------------------------------------- loop

  let fps = 0;
  let frames = 0;
  let fpsClock = performance.now();
  let loadMs = null;

  manager.onLoad = () => {
    if (disposed) return; // see manager.onProgress above
    loadMs = Math.round(performance.now() - T_START);
    $('loader').classList.add('done');
    els.charSelect.classList.add('show');
    // Let 'show' (display) apply before the opacity transition starts.
    requestAnimationFrame(() => {
      if (!disposed) els.charSelect.classList.add('visible');
    });
    refreshUI();
  };

  const timer = new THREE.Timer();

  // facing: the camera's smoothed heading. It eases toward whatever direction
  // the avatar is currently walking, so a turn at a fork reads as the camera
  // gently swinging round rather than snapping — this is the whole
  // "camera turns slightly with you" effect, and it falls out of one lerp.
  let facing = 0;

  // Step bob: up-and-right-and-tilt, back down, then up-and-left-and-tilt, back
  // down — one lobe of walkPhase (0..PI) per half-step. Only advances while
  // walking; see the clamp-to-next-boundary logic in tick() for why a stop
  // never lands mid-lobe.
  const WALK_BOB_RATE = Math.PI / 0.35; // radians/sec — 0.35s per lobe; a cadence, not a length, so untouched by FIGURE_SCALE
  const WALK_BOB_HEIGHT = 0.09 * FIGURE_SCALE; // a distance the figure moves, so it scales with the figure
  const WALK_BOB_LATERAL = 0.07 * FIGURE_SCALE;
  const WALK_BOB_TILT = THREE.MathUtils.degToRad(9); // an angle, not a length — no scaling needed
  let walkPhase = 0;

  function tick() {
    if (disposed) return; // unmounted mid-frame: stop the loop rather than render into a dead canvas
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.05);
    const t = timer.getElapsed();
    bridgeWind.update(t); // one call moves the sway on every bridge in the scene

    // Set while walking a bridge segment (see makeLeg's lastPoint / the
    // `head.bridge` check below); read further down when placing the figure,
    // for the walker's own height and cosmetic sway to match the deck.
    let bridgeUnderfoot = null;
    let bridgeUnderfootT = 0;

    // avatar: walk the current leg's waypoint queue at a constant speed, never
    // jumping — each leg's waypoints continue straight into the next round's
    // trunk (see choose() above). sunP tracks how far through the leg we are,
    // so the sky changes smoothly as the figure walks rather than snapping.
    // `walking` is captured before this block can null out `leg`, so the frame
    // a leg completes on still counts as walking for the step-bob below — it
    // shouldn't cut off just because arrival and the last step land together.
    const walking = !!leg;
    if (leg) {
      const head = leg.queue[0];
      if (head) {
        const dx = head.x - walker.x;
        const dz = head.z - walker.z;
        const distToHead = Math.hypot(dx, dz);
        const moveAmount = Math.min(distToHead, WALK_SPEED * dt);
        if (distToHead > 1e-4) {
          walker.x += (dx / distToHead) * moveAmount;
          walker.z += (dz / distToHead) * moveAmount;
        }
        leg.traveled += moveAmount;

        // Bridge height: only while the segment we are *currently crossing*
        // (from leg.lastPoint to head) has both ends tagged with the same
        // bridge — every other segment (the short hop onto an island's own
        // deck, or a stone stretch) is flat, so walker.y stays 0 there, same
        // as it always implicitly was before bridges existed.
        if (head.bridge && leg.lastPoint.bridge === head.bridge) {
          const segLen = Math.hypot(head.x - leg.lastPoint.x, head.z - leg.lastPoint.z);
          const remaining = Math.max(0, distToHead - moveAmount);
          const frac = segLen > 1e-6 ? THREE.MathUtils.clamp(1 - remaining / segLen, 0, 1) : 1;
          bridgeUnderfootT = THREE.MathUtils.lerp(leg.lastPoint.bridgeT, head.bridgeT, frac);
          bridgeUnderfoot = head.bridge;
          walker.y = head.bridge.heightAt(bridgeUnderfootT);
        } else {
          walker.y = 0;
        }

        if (distToHead <= moveAmount + 1e-4) {
          walker.x = head.x;
          walker.z = head.z;
          leg.lastPoint = { x: head.x, z: head.z, bridge: head.bridge ?? null, bridgeT: head.bridgeT ?? 0 };
          leg.queue.shift();
        }
      }

      const p = leg.total > 0 ? THREE.MathUtils.clamp(leg.traveled / leg.total, 0, 1) : 1;
      sunP = THREE.MathUtils.lerp(leg.fromP, leg.toP, p);

      if (leg.queue.length === 0) {
        sunP = leg.toP;
        if (leg.arriveFork) {
          forkIndex = leg.arriveFork;
        } else if (leg.success) {
          finished = true;
          finishedSuccess = true;
          emitRoundEnd(true);
        } else {
          // The fall fires here, at the moment the stones run out, rather than
          // back when the button was pressed — the consequence should land when
          // the player walks off the edge. startFall() hands the figure off to
          // physics for the drop itself — `finished` doesn't flip true until
          // the fall resolves, below.
          startFall();
        }
        leg = null;
        refreshUI();
      }
    }

    // Step bob: only while walking, and it always finishes the lobe (one
    // up-then-down) it's in the middle of before settling flat — walkPhase is
    // clamped to the next multiple of PI rather than just stopped, so motion
    // never cuts off mid-rise or mid-fall. Each PI-wide lobe lifts and tilts
    // the figure one way; consecutive lobes alternate right/left via `side`.
    // Three states: falling (physics owns figure.position); just fell and
    // waiting on "Again" (frozen exactly where the fall left it — the bob code
    // would otherwise snap it back to standing the very next frame); or the
    // normal walking/idle/reached-the-temple case (bob code, as before).
    if (falling) {
      fallAccumulator += dt;
      let steps = 0;
      while (fallAccumulator >= FALL_FIXED_DT && steps < 5) {
        applyFallWind();
        fallWorld.step();
        fallAccumulator -= FALL_FIXED_DT;
        steps++;
      }
      fallElapsed += dt;
      const ft = fallBody.translation();
      const fr = fallBody.rotation();
      figure.position.set(ft.x, ft.y, ft.z);
      figure.quaternion.set(fr.x, fr.y, fr.z, fr.w);
      if (fallElapsed >= FALL_DISAPPEAR) figure.visible = false;

      // The message/Again button show up at FALL_UI_DELAY, but `falling` stays
      // true — and the physics keeps running, above — for FALL_EXTRA_DURATION
      // longer, so the card is still visibly tumbling behind the UI rather
      // than freezing the instant the result appears.
      if (!finished && fallElapsed >= FALL_UI_DELAY) {
        finished = true;
        finishedSuccess = false;
        emitRoundEnd(false);
        refreshUI();
      }
      if (fallElapsed >= FALL_UI_DELAY + FALL_EXTRA_DURATION) {
        falling = false;
      }
    } else if (!(finished && !finishedSuccess)) {
      if (walking) {
        walkPhase += dt * WALK_BOB_RATE;
      } else if (walkPhase > 0) {
        const nextBoundary = Math.ceil(walkPhase / Math.PI - 1e-6) * Math.PI;
        walkPhase = Math.min(walkPhase + dt * WALK_BOB_RATE, nextBoundary);
        if (walkPhase >= nextBoundary - 1e-6) walkPhase = 0;
      }
      const lobe = Math.floor(walkPhase / Math.PI);
      const within = walkPhase - lobe * Math.PI;
      const lift = Math.sin(within); // 0 -> 1 -> 0 across each lobe
      const side = lobe % 2 === 0 ? 1 : -1; // right lobe first, then left, alternating

      // Cosmetic-only wind sway while crossing a bridge: this is the JS twin
      // of the GLSL in bridgeWind.js applied to the *character*, not the
      // deck — evaluated fresh from walker.x/z each frame rather than folded
      // into walker itself, so the sway can never feed back into the
      // straight-line distance math the walk loop above uses to track real
      // progress along the queue. Without this the ropes/planks visibly sway
      // under a character standing perfectly rigid on them, which reads as
      // more obviously broken than no sway at all would have.
      const bridgeSway = bridgeUnderfoot
        ? bridgeWind.evaluate(walker.x, walker.z, bridgeUnderfootT)
        : null;

      figure.position.set(
        walker.x + side * lift * WALK_BOB_LATERAL + (bridgeSway ? bridgeSway.offset.x : 0),
        walker.y + FIGURE_H / 2 + lift * WALK_BOB_HEIGHT + (bridgeSway ? bridgeSway.offset.y : 0),
        walker.z + (bridgeSway ? bridgeSway.offset.z : 0)
      );
      figure.rotation.z = -side * lift * WALK_BOB_TILT + (bridgeSway ? bridgeSway.roll : 0);

      // TEST_TAGS companions: same bob/lateral formula as the real figure,
      // just offset in x (left/right slot) and y (the "stand a little
      // lower" stagger for below-tag players) — see the TEST_TAGS block.
      // Follow the walker's own height (so they don't float through a
      // bridge's sag if the test happens to run on one) but skip the wind
      // sway — a debug-only feature, not worth the extra complexity.
      for (const c of testCompanions) {
        c.rig.group.position.set(
          walker.x + c.offsetX + side * lift * WALK_BOB_LATERAL,
          walker.y + FIGURE_H / 2 + lift * WALK_BOB_HEIGHT + c.yStagger,
          walker.z
        );
        c.rig.group.rotation.z = -side * lift * WALK_BOB_TILT;
      }
    }

    updateNameTags();

    applySun(sunP);
    applyAtmosphere(sunP); // leaves the current tint in tintScratch for updateCurtains
    updateCurtains(dt, t);
    sky.material.map.offset.x = THREE.MathUtils.lerp(0, 2 / 3, sunP);

    // clouds drift, at speeds scaled by distance
    horizonBank.position.x = Math.sin(t * 0.011) * 7;
    deckDeep.material.map.offset.x = t * 0.0016;
    deckHigh.material.map.offset.x = t * 0.0045;

    // cloud rows: gentle sideways drift, then recycle any row that has fallen
    // behind the camera round to the far end of the queue. The +12 margin keeps
    // a row from being moved while it is still just in shot. Derived from the
    // figure rather than camera.position because the camera is not moved until
    // later in this same tick.
    const recycleBehind = walker.z + CAM_BACK + 12;
    for (let i = 0; i < cloudRows.length; i++) {
      const row = cloudRows[i];
      row.position.x = Math.sin(t * 0.05 + i * 1.7) * 2.5;
      while (row.position.z > recycleBehind) row.position.z -= CLOUD_SPAN;
    }

    // camera facing: ease toward the direction of travel (see comment above).
    if (leg && leg.queue[0]) {
      const head = leg.queue[0];
      const dx = head.x - walker.x;
      const dz = head.z - walker.z;
      if (Math.hypot(dx, dz) > 1e-3) {
        // The *last* waypoint of a branch that leads to a real next island is
        // always that island's own centre (genForkCurve's mirrored-arrival
        // case) — reached via one final straight hop in from the arrival
        // edge. That hop cuts laterally back to the centreline and so has a
        // much steeper heading than the approach as a whole (~30° at current
        // geometry, confirmed by tracing a live walk — see TODO.md, Luke
        // reported the camera still skewed after the at-rest fix below).
        // Chasing that literal direction for the final ~3.5 units genuinely
        // swings the camera hard right before arrival; the earlier fix only
        // straightened it back out *after* stopping, which is too late to
        // read as anything but a last-second snap-then-correct.
        //
        // Once this last waypoint is the only one left, steer toward the
        // *known* destination heading — sections[leg.arriveFork - 1].fork.heading,
        // already computed when that fork was built — instead of the literal
        // direction to it, so the camera straightens out gradually over the
        // whole final hop rather than swinging onto its steep heading and
        // then straight back off it once the walk stops. Falls back to the
        // literal direction when there's no known destination (a wrong
        // branch's truncated end, or the last fork's approach to the
        // temple — both already straight, so this never fires for them
        // anyway since neither has a sharp final hop to correct for).
        const dest = leg.queue.length === 1 && leg.arriveFork ? sections[leg.arriveFork - 1] : null;
        const targetHeading = dest ? dest.fork.heading : Math.atan2(dx, -dz);
        let delta = targetHeading - facing;
        delta = ((delta + Math.PI) % (Math.PI * 2)) - Math.PI; // shortest angular distance
        facing += delta * Math.min(1, dt * 2.5);
      }
    } else if (!falling && !finished) {
      // Arrival: the block above only runs while a leg is in progress, so the
      // instant the queue empties it stops updating `facing` at all — it was
      // left pointing wherever the branch's final waypoint happened to aim
      // (toward the mirrored arrival edge, post Step 4, rather than straight
      // ahead), and stayed there for as long as the player takes to choose.
      //
      // The target is the *fork's own heading* (sec.fork.heading — what
      // cursor.heading was when this fork's branches were built, ± only
      // FORK_HALF_ANGLE from either one), not templeHeading(walker) directly.
      // The first attempt used the raw temple bearing and Luke reported the
      // camera still looked skewed — because it is: fork.heading is only
      // HEADING_CORRECTION (0.7) of the way rebent toward the temple, by
      // design (see buildFork), so aiming dead at the temple swings the
      // camera off-axis from the two branches actually on screen, which is
      // what "skewed" was — not skewed relative to the temple, skewed
      // relative to the fork in front of you. templeHeading(walker) is kept
      // as a fallback for a section that doesn't exist for some reason;
      // in normal play sec is always defined here (leg only goes null at a
      // fork, or at the very end where `finished` is already true and this
      // branch doesn't run).
      //
      // Eased over ~0.2s (dt * 20 reaches the target in about four time
      // constants by then) rather than snapped, matching how the walking
      // case above eases rather than jumps.
      const sec = sections[forkIndex - 1];
      const targetHeading = sec ? sec.fork.heading : templeHeading(walker);
      let delta = targetHeading - facing;
      delta = ((delta + Math.PI) % (Math.PI * 2)) - Math.PI;
      facing += delta * Math.min(1, dt * 20);
    }

    // Recomputed fresh here rather than reusing a value from the block above —
    // that block can flip `falling`/`finished` mid-tick (the fall resolving
    // this exact frame), and the camera needs to see the up-to-date state,
    // not whatever was true at the top of tick().
    const justFell = finished && !finishedSuccess;
    if (falling) {
      // Eases to the fixed anchor beside the edge (see startFall) and pans
      // the look-at down to track the figure as it drops — a held position
      // with a moving gaze, not a scripted camera path.
      camera.position.lerp(fallCamAnchor, Math.min(1, dt * FALL_CAM_EASE));
      camera.lookAt(figure.position.x, figure.position.y, figure.position.z);
    } else if (!justFell) {
      // camera: trails the avatar along its facing direction, plus the drag offset, eased
      look.x += (look.tx - look.x) * Math.min(1, dt * 4);
      look.y += (look.ty - look.y) * Math.min(1, dt * 4);

      const behind = forward(facing, CAM_BACK * camPull);
      const ahead = forward(facing, 4.6);
      camera.position.set(
        walker.x - behind.x + look.x,
        CAM_HEIGHT * (1 + (camPull - 1) * 0.45) + look.y + Math.sin(t * 0.6) * 0.05,
        walker.z - behind.z
      );
      camera.lookAt(walker.x + ahead.x, CAM_LOOK_Y, walker.z + ahead.z);
    }
    // else: just fell — camera stays exactly where the fall left it, frozen
    // alongside the figure, until "Again" resets everything at once.

    // The land/sea/sky rig rides with the camera on the ground plane only —
    // no y, no rotation — so the horizon holds its height and the composition
    // stays exactly where it was tuned, however far the walker has travelled.
    backdropRig.position.set(camera.position.x, 0, camera.position.z);
    // Must run after the rig has been placed: the cloud UV offsets cancel the
    // rig's own following, so they need the camera position it was just given.
    updateWindClouds(dt);

    key.target.position.set(walker.x, 0, walker.z);

    harness?.update(dt);
    updateBirds(dt);

    renderer.render(scene, camera);

    frames++;
    const now = performance.now();
    if (now - fpsClock >= 500) {
      fps = Math.round((frames * 1000) / (now - fpsClock));
      frames = 0;
      fpsClock = now;
      els.hud.innerHTML =
        `<b>${fps}</b> fps · ${surfaceWidth()}×${surfaceHeight()} @${renderer.getPixelRatio().toFixed(1)}x` +
        (loadMs === null ? '' : ` · loaded <b>${loadMs}</b> ms`);
    }

    rafId = requestAnimationFrame(tick);
  }
  tick();

  // Debug hook: render and hand back a PNG, used to inspect the scene headlessly.
  // Dev only — stripped from the production bundle.
  if (import.meta.env.DEV) {
    window.__camera = camera;
    window.__temple = temple;
    window.__THREE = THREE;
    window.__capture = () => {
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL('image/png');
    };
    window.__tick = tick;
    window.__state = () => ({
      forkIndex,
      finished,
      finishedSuccess,
      walking: !!leg,
      sunP,
      correctCount,
      facing,
      fork: sections[forkIndex - 1] ? sections[forkIndex - 1].fork : null,
    });
    window.__curtains = () =>
      curtains.map((c) => ({
        z: +c.pos.z.toFixed(2),
        open: +c.open.toFixed(2),
        done: c.done,
        visible: c.group.visible,
        sheet: {
          uOpen: +c.sheet.material.uniforms.uOpen.value.toFixed(3),
          uAlpha: +c.sheet.material.uniforms.uAlpha.value.toFixed(3),
          y: +c.sheet.position.y.toFixed(3),
        },
        puffOpacity: +c.puffs.material.opacity.toFixed(3),
      }));
    window.__curtainObjs = () => curtains;
    window.__spawnBird = () => {
      birdTimer = 0;
      bird = null;
      maybeSpawnBird(0);
      return window.__bird();
    };
    window.__bird = () =>
      bird && {
        t: +bird.t.toFixed(2),
        side: bird.side,
        pos: bird.mesh.position.toArray().map((v) => +v.toFixed(2)),
        visible: bird.mesh.visible,
      };
    window.__birdMesh = () => bird && bird.mesh;
    window.__birdFreeze = (v) => {
      birdDebugFreeze = v;
    };
    window.__freezeBird = (t) => {
      if (!bird) return false;
      bird.t = t - 1e-4; // updateBirds adds dt below, land exactly on t
      updateBirds(1e-4);
      return window.__bird();
    };
    window.__sections = () =>
      sections.map((s) => ({
        correct: s.correct,
        forkZ: +s.fork.z.toFixed(2),
        leftPts: s.branch.left.length,
        rightPts: s.branch.right.length,
        extended: s.extended,
        hasApproach: !!s.approach,
      }));
    window.__figureZ = () => walker.z;
    window.__figurePose = () => ({
      walkPhase: +walkPhase.toFixed(3),
      pos: figure.position.toArray().map((v) => +v.toFixed(4)),
      rot: figure.rotation.toArray().slice(0, 3).map((v) => +v.toFixed(4)),
      walker: walker.toArray().map((v) => +v.toFixed(4)),
    });
    window.__fallDebug = () => ({
      falling,
      fallElapsed: +fallElapsed.toFixed(3),
      camPos: camera.position.toArray().map((v) => +v.toFixed(3)),
      figurePos: figure.position.toArray().map((v) => +v.toFixed(3)),
      figureVisible: figure.visible,
    });
    window.__rig = () => ({
      characterKey,
      frontMap: rig.frontMesh.material.map.source.data?.currentSrc || rig.frontMesh.material.map.name,
    });
    window.__testTags = () => testCompanions.map((c) => ({
      pos: c.rig.group.position.toArray().map((v) => +v.toFixed(3)),
      tagLocalY: c.rig.nameTag ? +c.rig.nameTag.localY.toFixed(3) : null,
      tagVisible: c.rig.nameTag ? c.rig.nameTag.el.style.display !== 'none' : null,
    }));
    window.__cloudRows = () => cloudRows.map((r) => +r.position.z.toFixed(2));
    window.__markers = () => ({ leftVisible: markerPair.left.visible, rightVisible: markerPair.right.visible });
    window.__stoneCounts = () => stoneMeshes.map((m) => m.count);
    window.__stoneMeshes = stoneMeshes;
    window.__islands = () => islands.map((g) => g.position.toArray().map((v) => +v.toFixed(2)));
    window.__atmos = () => ({
      skyTint: atmosphereMaterials[0].color.getHexString(),
      clear: renderer.getClearColor(new THREE.Color()).getHexString(),
      fog: scene.fog.color.getHexString(),
      fogNearFar: [scene.fog.near, scene.fog.far],
      keyColor: key.color.getHexString(),
      keyIntensity: key.intensity,
      keyPos: key.position.toArray(),
      skyOffsetX: sky.material.map.offset.x,
    });
  }

  // ---------------------------------------------------------------- resize
  //
  // A ResizeObserver on the container rather than a window 'resize' listener:
  // the game panel can now change size without the window doing so (a
  // results panel opening beside it, an orientation-independent layout
  // change), and — unlike a window listener — this is disconnected on
  // dispose, so an unmounted round leaves nothing behind.

  function resize() {
    const w = surfaceWidth();
    const h = surfaceHeight();
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);

  // ---------------------------------------------------------------- handle

  return {
    /**
     * Settle a fork. Called by the owner after it has decided — from its own
     * `onForkChoice` in solo play, or from the relay in a room. `forkIndex`
     * is checked so a late or duplicate message for a fork already walked
     * past is ignored rather than replayed, which is what makes several
     * players tapping at once safe: only the first message to come back
     * matches the fork still awaiting a decision.
     */
    applyChoice(atForkIndex, side) {
      if (atForkIndex !== forkIndex) return false;
      applyChoice(side);
      return true;
    },

    restart,

    /** Current role, for a caller that wants to render its own role badge. */
    get role() {
      return role;
    },

    /**
     * Tear down everything this mount created: the animation loop, the
     * observer, the WebGL context (browsers cap live contexts at ~8–16, so
     * leaking one per round would break a lesson after a handful of rounds),
     * and the injected chrome.
     */
    dispose() {
      if (disposed) return;
      disposed = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      harness?.dispose();
      bgTuner?.dispose();
      resizeObserver.disconnect();
      renderer.dispose();
      renderer.forceContextLoss();
      container.innerHTML = '';
    },
  };
}
