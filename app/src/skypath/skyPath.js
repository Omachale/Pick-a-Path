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
 * (the word signs, character select), injecting that markup
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
import { CHARACTERS, PALETTE as CHARACTER_PALETTE } from './characters.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { SKY_PATH_CHROME, SKY_PATH_CSS } from './chrome.js';
import { attachCrowdHarness } from './crowdHarness.js';
import { buildAbduction, buildWaitingGlow, buildRepelledShip, REPEL_SHIP_DEFAULTS } from './alienAbduction.js';
import { createResistWave, RESIST_WAVE_DEFAULTS } from './resistWave.js';
import { createAbductDefense, createAbductGuideView } from './abductDefense.js';
import { attachBgTuner } from './bgTuner.js';
import { buildArch, varyArch, buildSignFrame, ARCH_DEFAULTS, ARCH_PALETTES, ARCH_LIT_FILL } from './archGen.js';
import { buildArchTextures, buildGlyphTextures } from './archTextures.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buildIsland } from './islandGen.js';
import { buildNameTagCanvas, normalizePlayerName } from './nameTag.js';
import { buildBridge, disposeBridge, breakPlank, BRIDGE_DEFAULTS, BRIDGE_ANCHORS } from './bridgeGen.js';
import { createBridgeWind } from './bridgeWind.js';
import { loadWordPairs, assignForkWords } from './wordPairs.js';
import {
  PANEL_SRC as ABDUCT_PANEL_SRC,
  PANEL_SIZE as ABDUCT_PANEL_SIZE,
  PANEL_HOLES as ABDUCT_PANEL_HOLES,
  loadImage as loadAbductImage,
  drawPanel as drawAbductPanel,
} from '../cardboardPanel.js';
import {
  INTERFACE_SRC as ABDUCT_INTERFACE_SRC,
  finalRect as abductFinalRect,
  growthTimeline as abductGrowthTimeline,
  drawInterfaceGrowth,
} from '../alienInterfaceCore.js';

// Rapier ships as WASM and needs an async init before any RAPIER.* class can
// be used. Module-scope so it happens once per page load, not once per mount.
await RAPIER.init();

/**
 * @param {HTMLElement} container  sized by its own CSS; the canvas fills it
 * @param {object} options
 * @param {string|null} options.forks       'LRLLRR' — one L/R per fork; null = random
 * @param {Array<{left: string, right: string}>|null} options.words  one word
 *   pair per fork, already decided (by whoever started the round for the
 *   whole group — see TeacherDashboard.jsx's startGame()) so every device in
 *   the group shows the same words in the same left/right layout; null =
 *   pick locally at random (the `?solo=1` dev path, where there's no group
 *   to agree with).
 * @param {'guide'|'player'} options.role   which layer of information to show
 * @param {boolean} options.canAct          whether this device shows the fork buttons
 * @param {(forkIndex: number, side: 'left'|'right') => void} options.onForkChoice
 * @param {(result: {success: boolean, forkIndex: number, correctCount: number, totalForks: number, itemsCollected: number, resistCount: number, jetpackKeptAtFinish: boolean}) => void} options.onRoundEnd
 * @returns {{applyChoice: Function, reset: Function, dispose: Function}}
 */
export function mountSkyPath(container, options = {}) {
  const {
    forks: forksOverride = null,
    words: wordsOverride = null,
    role: initialRole = 'guide',
    canAct: initialCanAct = true,
    onForkChoice = null,
    onRoundEnd = null,
    crowd = 0,
    // Overrides the character-select screen's own free-text name input —
    // Luke, on team play: a player's displayed name is whatever they typed
    // into the LOBBY to join, not a second name typed again here. Left
    // undefined for solo/dev play, where that input is still the only
    // source of a name.
    displayName = null,
    // The character and colour this player already chose on the lobby's join
    // screen ({ characterKey, colorHex }), 2026-10-05: choosing moved from
    // round start to joining (Luke: players choose "as soon as they join").
    // Given this, the character-select screen is skipped, as it already is
    // for Watch mode. Left null for solo/dev play, which still uses the screen.
    presetLook = null,
    // Fired whenever this device's OWN resting position (which fork it's
    // standing at, having arrived and stopped) or look changes — the host
    // (GameRoom.jsx) relays this over the room channel so teammates' own
    // instances can call updateTeammate() below and show a real avatar
    // standing at the right island, not a placeholder. See the long design
    // note above updateTeammate() for why this fires on ARRIVAL, not
    // continuously while walking.
    onPlayerState = null,
    // Watch mode only (see App.jsx/RoundResults.jsx) — a fallen player's
    // Watch mode mounts a BRAND NEW SkyPath instance, whose guide-camera
    // state (see `guideIsland` below) would otherwise always start over at
    // fork 1 with no memory of how far the round had actually progressed.
    // Luke, 2026-09-13: "the dead player not following... their camera
    // appears to snap back to the FIRST island (now empty)" — that's
    // exactly this: not a bug in the tracking logic itself, but a fresh
    // instance genuinely starting from scratch. Seeded from the fallen
    // player's OWN last-known fork (`round.result.forkIndex` — the fork
    // they were AT when their own round ended) — the best available
    // starting point without a full roster/state broadcast (see the
    // guide's own already-documented "late arrival" gap elsewhere in this
    // file, which applies equally here): nobody else in the group can be
    // BEHIND this fork, since fork progress only ever moves forward.
    initialGuideIsland = null,
    // Fixed-seating redesign, 2026-09-13 — Luke: "each person will be
    // assigned a position, and that won't change through the round."
    // `roster` is the group's PLAYER tokens (guide excluded — see
    // TeacherDashboard's startGame(), which is the one place that already
    // knows who the guide is), in one fixed order shared by every device
    // via the same `game-started` broadcast that carries `forks`/`words`.
    // Every device builds the identical seat-offset table from it (see
    // `seatOffsets` below) purely by array index, so no further messages
    // are needed to agree on who stands where. `myToken` is this device's
    // own entry in that same array, so it can find its own seat.
    roster = [],
    myToken = null,
    // Which item sits on island 2 this round — 'jetpack' | 'abduction',
    // decided by whoever starts the round (TeacherDashboard's startGame(),
    // same as `words`) so the whole group sees the same thing; null = draw
    // it locally (the `?solo=1` dev path). See the "pickup" section.
    pickup: pickupOverride = null,
    // Relays a small in-round event (first arg: kind, second: data) to
    // everyone it concerns, this device included — see useLobby's
    // sendGameEvent for the routing. Null = solo: settle it locally.
    onGameEvent = null,
    // Who this device may aim an abduction at right now — see useLobby's
    // getAbductionTargets for the eligibility rules and the "abduction
    // targeting" section below for the menu it feeds. Null = solo: nobody.
    getAbductionTargets = null,
    // This team's guide, and a live token -> lobby-name lookup — for the
    // abduction-defence messages ("Listen to [Guide name]...", see the
    // "defence queue" section). Both null/absent in solo play.
    guideToken = null,
    getDisplayName = null,
    // The projector (lobby/Projector.jsx, 2026-10-07): one of these per
    // team on the teacher's PC, shown on the big screen. Mounted as
    // role 'watching' (Watch mode's follow-a-teammate camera, which is
    // exactly the shot wanted) with: none of the phone's buttons or panels;
    // no words on the bridge signs (the projector shows each pair itself,
    // stacked in a random order, so nothing ties a word to a bridge — Luke:
    // "without the viewer on this screen seeing which word was chosen, or
    // which is tied to which path"); who to follow chosen from outside
    // (handle.watch); and drawing paused while another team is on screen
    // (handle.setActive), while everything keeps updating.
    projector = false,
    // A renderer to draw with instead of making one, kept by the caller
    // across mounts (the projector: one per team slot, reused round after
    // round). Every mount making its own and throwing it away with
    // forceContextLoss() is fine for a phone's one game at a time, but the
    // projector does it for every team every round, and Chrome then blocks
    // WebGL for the page ("Web page caused context loss and was blocked"),
    // seen 2026-10-07. A provided renderer is left alive on dispose; the
    // scene's own GPU resources are freed instead (see dispose).
    renderer: providedRenderer = null,
  } = options;
  // Declared here, not down near soloRoleToggle where it originally lived —
  // setCharacter() (called during initial setup, long before that point)
  // now reads `role` too (see figure.visible there), so it has to exist
  // before anything else in this closure runs.
  let role = initialRole;
  // Mutable for the same reason `role` is — see becomeSpectator() further
  // down, which flips both in place without a remount.
  let canAct = initialCanAct;
  // 'watching' (added 2026-09-12 for Watch mode) shares the guide's camera
  // and has no avatar either — see the "guide camera" section further down
  // for the state machine both roles ride, and RoundResults/App.jsx for how
  // a fallen player ends up in this role instead of the plain results
  // screen. Kept as one helper rather than repeating the `=== 'guide' ||
  // === 'watching'` check at every call site.
  const isSpectatorRole = (r) => r === 'guide' || r === 'watching';

  container.classList.add('skypath-surface');
  if (projector) container.classList.add('skypath-projector');
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
  let drawing = true; // false while a projector world is off screen (see `projector` above)
  // The projector's cloud wipe between teams (handle.setLift): 0 = the
  // ordinary shot, 1 = risen CAM_LIFT_HEIGHT and tilted CAM_LIFT_PITCH up,
  // into the clouds. Applied around the render only, so it never feeds back
  // into the camera's own easing.
  let camLift = 0;
  const CAM_LIFT_HEIGHT = 9;
  const CAM_LIFT_PITCH = 0.55; // radians

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
  // 4.8: widened 20% from 4 (Luke, 2026-10-03, once the shrine arch was on the deck).
  const ISLAND_RADIUS = 4.8; // world units — was 6; shrunk by a third to 4, 2026-08-28. See FORK_HALF_ANGLE/FORK_PINCH_WIDTH above and below: both were re-tuned alongside this, since the gap they carve between the two branches at an island scales with ISLAND_RADIUS too and would otherwise have closed to overlapping.
  const ISLAND_PATH_GAP = 8; // visible gap between two islands' *edges* — the one real pacing knob
  const FORK_DISTANCE = 2 * ISLAND_RADIUS + ISLAND_PATH_GAP; // forward distance, fork centre to fork centre
  // bridgeGen's BRIDGE_ANCHORS were tuned against a radius-4 deck (forward =
  // 4·cos30°) and are shared with the lava cavern, so Sky Path scales its own
  // copy: the bridge must still leave from the deck's edge, not from inside it.
  const ISLAND_ANCHORS = {
    lateral: BRIDGE_ANCHORS.lateral,
    forward: (BRIDGE_ANCHORS.forward * ISLAND_RADIUS) / 4,
  };
  // How far each fork island's centre sits AHEAD of the fork point where the
  // players stand — i.e. the players stand 20% of a radius toward the back
  // of their island, leaving the front for the shrine arch (Luke, 2026-10-03).
  // Done by moving the island rather than the players because the fork point
  // (sec.fork / nextCursor) anchors the camera, seats, walk legs, jetpack and
  // abduction landings, and every one of those stays untouched this way. What
  // moves with the island instead: the island itself, its arch, both ends of
  // each bridge (the far end only between fork islands — the last bridge
  // still lands on the temple island's own edge), the fog curtain, and the
  // stone-suppression zone.
  const ISLAND_AHEAD = ISLAND_RADIUS * 0.2;
  /** Where the island under a fork point actually sits. */
  const islandCentre = (cursor) => localToWorld(cursor, 0, ISLAND_AHEAD);

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
  // one's. (This was originally a bowed/pinched curve, genForkCurve — see git
  // history around 2026-08-28. Every fork, including the last, now uses a
  // straight rope bridge instead — genBridgeRoute, below — but the shape's
  // still symmetric departure-to-arrival for the same reason.) There is no
  // separate "trunk" phase for forks any more (there also used to be one for
  // the very start of the round — the walk in from spawn to fork 1 — but
  // Luke, 2026-09-04, had the player spawn standing on fork 1's own island
  // instead; see buildJourney()).

  // Correct side is randomised per fork — including runs of the same side
  // (left,left,left,... etc). The heading-correction step above pulls the
  // world-absolute heading back toward 0 after every fork regardless of which
  // side was taken, so a same-direction streak damps out rather than
  // compounding; nothing here assumes an alternating pattern.
  //
  // For testing a specific pattern, append ?forks=LLLRRR to the URL — one
  // L/R per fork, case-insensitive, missing/extra forks fall back to random.
  // Example: index.html?forks=LLLLLL. Since 2026-09-13's per-player side
  // randomisation (see buildFork()), 'L'/'R' here no longer names a
  // physical bridge — it's a SHARED signal naming which member of the word
  // pair (`pair.a` for 'L', `pair.b` for 'R') is correct; which physical
  // side that word actually lands on is a separate, unforced, per-device
  // random draw, so this override can no longer pin down a specific
  // physical-side pattern for testing path visuals — only which word wins.
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
    renderer = providedRenderer ?? createRenderer();
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
  // The abduction beam's top is hidden with a material clipping plane (see the
  // hide-line note in alienAbduction.js). Without this flag THREE silently
  // ignores those planes and the beam pokes out above the saucer — no error,
  // just a wrong picture, which is exactly the kind of thing to state here
  // rather than leave as a mystery.
  renderer.localClippingEnabled = true;

  // The "aliens repelled" distortion — see resistWave.js. Owns the final
  // render call (a plain renderer.render outside a wave). Its params object
  // is live so the temporary tuning panel can write into it.
  const resistWaveParams = { ...RESIST_WAVE_DEFAULTS };
  const resistWave = createResistWave(renderer, resistWaveParams);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  // One mild atmospheric fog for both roles — purely for depth. Hiding the
  // path ahead is no longer this fog's job: that's the curtain props standing
  // at each junction (see makeCurtain), which is why there is no longer a
  // per-role near/far swap here.
  //
  // Temporarily disabled, per Luke, 2026-09-24: "let's disable the fog for
  // now." Still a real THREE.Fog object, not null — the day/night colour
  // cycle below (fogScratch) and a debug hook both read scene.fog.color/
  // near/far unconditionally — just pushed out past the camera's own
  // 5000-unit far plane (see its own comment below) so nothing ever renders
  // far enough to actually fog. Flip FOG_ENABLED back on to restore the real
  // near/far.
  const FOG_ENABLED = false;
  scene.fog = new THREE.Fog(0xbcd8ea, FOG_ENABLED ? 24 : 100000, FOG_ENABLED ? 260 : 100001);

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

  const sunOffset = new THREE.Vector3(); // key light position relative to its target — see applySun

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
    // An offset from key.target (the walker), not a world position. It used
    // to be absolute, which only matched at the start: as the walker moved
    // down -Z the light swung round to shine from behind, and past ~40 units
    // the shadow camera (far = 40) couldn't reach the walker at all. Nothing
    // showed it until the arches started casting shadows (2026-10-04).
    sunOffset.set(-Math.cos(angle) * R, BASE_Y + Math.sin(angle) * H, 6);
    key.position.copy(key.target.position).add(sunOffset);

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

  // Kicked off immediately, alongside every texture/model load below, so it
  // resolves in parallel rather than adding its own wait after everything
  // else is already ready. Not registered with `manager` (it's not a
  // THREE.Loader) — awaited directly in manager.onLoad instead, since that's
  // the one place that already knows every OTHER asset is in.
  const wordPairsPromise = loadWordPairs();

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
    fogNoise: tex('fog-noise', { linear: true, tile: true }),
    fogPuff: tex('fog-puff'),
    temple: tex('temple', { ext: 'webp' }),
    // The temple doors: laid over the temple photo's own baked-in doors as
    // separate overlay art (Luke, 2026-09-10) rather than patching the
    // temple texture itself — see doorTune below.
    doorFrame: tex('door-frame', { ext: 'jpg' }),
    doorLeft: tex('door-left'),
    doorRight: tex('door-right'),
    gull1: tex('gull-1', { ext: 'webp' }),
    gull2: tex('gull-2', { ext: 'webp' }),
    islandDeck1: tex('island-circle'),
    // Power-up cards (see equipPowerUp/ENGINE_FRAMES below) — jetpack is the
    // first; later ones are just another entry (or set of entries) here.
    // Loaded straight from the standalone flame-tuner's own asset folder
    // (app/public/textures/engine-frames/) rather than duplicated — that
    // tool and the game now read the exact same files.
    engine1: tex('engine-frames/engine1'),
    engine2: tex('engine-frames/engine2'),
    engine3: tex('engine-frames/engine3'),
    engine4: tex('engine-frames/engine4'),
    // Alien abduction event (see alienAbduction.js). Registered with `manager`
    // like everything else, so character select doesn't appear until they're
    // ready — the event can fire at any moment once play starts, and a half-
    // loaded saucer is worse than a slightly later Start button.
    spaceship: tex('spaceship'),
    spaceshipBeams: tex('spaceship-beams'),
    string: tex('string'),
    // The abduction trigger's own power-up card (see POWERUP_FRAMES) — Luke's
    // art, already composited onto the same oval cardboard the jetpack's
    // engine cards use (matched by eye against Assets/Engine/Engine1.png;
    // there's no separate blank-oval asset in the project to composite onto
    // programmatically, since every existing oval card image already has its
    // own art baked in — see TODO.md).
    abductDevice: tex('abduct-device'),
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
      let deckTop = -Infinity; // the paving's surface height, for the shadow catcher
      for (let i = 0; i < dPos.count; i++) {
        // Through the mesh's own transform: the deck has been a separately
        // translated child node in some exports and merged into the rock's
        // mesh in others, so its vertices are not always already in the
        // scene root's space.
        dVert.fromBufferAttribute(dPos, i).applyMatrix4(deckMesh.matrixWorld);
        deckRadius = Math.max(deckRadius, Math.hypot(dVert.x, dVert.z));
        deckTop = Math.max(deckTop, dVert.y);
      }
      // Rescale to the size the game is laid out around (ISLAND_TARGET_RADIUS
      // below) — this export's own scale depends on whatever the tuning
      // page's size slider happened to be at export time, and on the Blender
      // edit afterward, neither of which has any reason to already match.
      const scale = ISLAND_TARGET_RADIUS / deckRadius;
      const t = { scene: gltf.scene, scale, deckRadiusScaled: deckRadius * scale, deckRadius, deckTop };
      islandTemplates.push(t);
    });
  }

  // ---------------------------------------------------------------- character roster
  //
  // Each character loads a single texture (the front-facing art).
  // New characters just need an entry here — the selection screen and rig are
  // both built from this list, not hardcoded to any one character.
  // The character list now lives in characters.js, shared with the join
  // screen (lobby/PlayerJoin.jsx), where players choose since 2026-10-05.
  const ROSTER = CHARACTERS;
  const CHAR_TEX = {};
  for (const c of ROSTER) {
    CHAR_TEX[c.key] = { front: tex(c.tex, { ext: c.ext }) };
  }

  // The palette lives in characters.js too (see ROSTER above).
  const PALETTE = CHARACTER_PALETTE;

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

  // Temple doors: real overlay art laid on top of the temple photo's own
  // baked-in doors, rather than patching the temple texture itself — Luke,
  // 2026-09-10, after the texture-surgery route (crop the doors out, patch
  // in a dark archway, upscale losslessly, etc.) turned out to be more
  // process than the payoff justified: "this is getting too messy and
  // complicated... let's try just sticking the door image in front of the
  // temple png." Three separate pieces (frame + two independently-hinged
  // leaves, for the swing-open animation this is all in service of), each a
  // plain unit-quad plane sized/positioned from doorTuneState below — same
  // "unit geometry, size via mesh.scale" pattern as the word signs.
  //
  // Position/size baked into doorTuneState below from Luke's tuning pass —
  // the `?doorTune=1` panel that found them has since been removed.
  const DOOR_FRAME_ASPECT = 309 / 270; // height / width, from the source art
  const DOOR_LEFT_ASPECT = 821 / 301;
  const DOOR_RIGHT_ASPECT = 804 / 312;
  // Just in front of the temple plane (which sits at exactly -TEMPLE_DISTANCE)
  // rather than coplanar with it, and — critically — NOT all three at the
  // same z as each other either. The frame image and the two leaves overlap
  // over most of their area (the leaves sit inside the frame's own opening),
  // and three coplanar alphaTest planes fighting over the same z produced
  // exactly the shimmering, semi-transparent flicker Luke reported once this
  // was actually visible in-scene: the depth test has no clear winner per
  // pixel, so it dithers between whichever two surfaces are closest at that
  // point, frame to frame. Giving the leaves a small, fixed step in front of
  // the frame (0.15 world units — imperceptible as a depth gap at this
  // distance, plenty to resolve the z-test) removes the ambiguity outright.
  // The two leaves are then split by a further hair from each other for the
  // same reason: their closed positions overlap by ~0.1 world units down the
  // middle of the doorway, which at a shared z is another coplanar fight —
  // see DOOR_RIGHT_LEAF_Z.
  const DOOR_FRAME_Z = -TEMPLE_DISTANCE + 0.3;
  const DOOR_LEAF_Z = DOOR_FRAME_Z + 0.15;
  const DOOR_RIGHT_LEAF_Z = DOOR_LEAF_Z + 0.02;

  function makeDoorMesh(map, parent) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map, transparent: true, alphaTest: 0.45, side: THREE.DoubleSide, fog: false })
    );
    m.renderOrder = 5; // after the temple (4.5) — see its own comment above
    parent.add(m);
    return m;
  }
  const doorFrameMesh = makeDoorMesh(TEX.doorFrame, scene);

  // The frame stops WRITING depth (it still tests against it, so anything
  // genuinely nearer still hides it). Half of why the doors never looked
  // like they opened — Luke, 2026-09-12: "the doors aren't 'opening' at all:
  // they're just disappearing from the middle."
  //
  // The leaves really were hinged and rotating the whole time; the problem
  // was what they were rotating INTO. A leaf is ~1.95 world units wide, so
  // swinging it back by the full DOOR_OPEN_ANGLE sweeps its free edge about
  // 1.7 units behind the hinge — but the frame plane sits only 0.15 behind
  // the leaves and the temple billboard only 0.45 behind. Both are opaque
  // rectangles with the doorway *painted on* rather than actually cut out of
  // them, so past a few degrees of a 62 degree swing the depth buffer was
  // erasing each leaf against the wall it was swinging into, free edge
  // first. What survived on screen was the one thing not occluded: the
  // widening gap — i.e. exactly "disappearing from the middle".
  //
  // The frame is dealt with here; the temple is NOT. Clearing the temple's
  // depthWrite fixes the doors too, and was the first thing tried, but it
  // lets the horizon backdrop layers that draw after it (fog puffs, decks)
  // paint straight through the building — a bright band across the temple,
  // visible immediately. The temple keeps its depth, and the leaves are
  // given real room to swing in instead: see the pivot-z slide in
  // updateTempleEntry().
  doorFrameMesh.material.depthWrite = false;

  // Each leaf hangs off its own pivot rather than sitting straight in the
  // scene, so the opening animation (see startTempleEntry/updateTempleEntry
  // further down) can just rotate the pivot — the mesh itself never moves in
  // its own local space. Luke marked the hinge points on the reference image
  // as the OUTER edge of each door (by the frame), which is also just how
  // real double doors hinge, so each pivot sits at that leaf's outer edge —
  // world X = the leaf's centre X minus/plus half its own width — with the
  // mesh offset back out to its usual centre in the pivot's local space.
  // applyDoorTune() below recomputes both from doorTuneState every time, so
  // this holds even while the tuner sliders are still live.
  const doorLeftPivot = new THREE.Object3D();
  const doorRightPivot = new THREE.Object3D();
  scene.add(doorLeftPivot, doorRightPivot);
  const doorLeftMesh = makeDoorMesh(TEX.doorLeft, doorLeftPivot);
  const doorRightMesh = makeDoorMesh(TEX.doorRight, doorRightPivot);
  // Drawn after the frame (5), which no longer writes depth — so a leaf can
  // never be painted over by the very opening it sits in, at any angle.
  doorLeftMesh.renderOrder = 6;
  doorRightMesh.renderOrder = 6;

  // x/y are world-space offsets from the temple's own centre/ground line; y
  // is the piece's BOTTOM edge (matches cutout()'s convention elsewhere in
  // this file), not its centre, so the sliders read as "how far off the
  // ground" rather than requiring mental half-height math. `scale` is the
  // piece's own height in world units — width follows from it via the
  // fixed aspect ratios above, so resizing can never distort the art.
  // Baked in from Luke's tuning pass, 2026-09-11 — see the panel behind
  // `?doorTune=1` if these need revisiting (still wired, on Luke's request,
  // while the opening animation this feeds gets tuned too).
  const doorTuneState = {
    frame: { x: 0.65, y: 3.25, scale: 6.45 },
    left: { x: -0.2, y: 3.95, scale: 5.25 },
    right: { x: 1.65, y: 4.05, scale: 5.1 },
  };
  function applyDoorTune() {
    // Frame: a plain static plane, no pivot.
    const frameH = doorTuneState.frame.scale;
    const frameW = frameH / DOOR_FRAME_ASPECT;
    doorFrameMesh.scale.set(frameW, frameH, 1);
    doorFrameMesh.position.set(doorTuneState.frame.x, doorTuneState.frame.y + frameH / 2, DOOR_FRAME_Z);

    // Leaves: hinge (pivot) at the outer edge, mesh offset back to centre.
    // `hingeSign` is which side of the leaf's own centre its outer edge is
    // on: left's outer edge is to ITS left (-1), right's is to ITS right
    // (+1) — same sign convention startTempleEntry/updateTempleEntry use to
    // rotate them as a mirrored pair.
    const placeLeaf = (pivot, mesh, aspect, state, hingeSign, z) => {
      const h = state.scale;
      const w = h / aspect;
      const hingeX = state.x + hingeSign * (w / 2);
      pivot.position.set(hingeX, state.y + h / 2, z);
      mesh.scale.set(w, h, 1);
      mesh.position.set(state.x - hingeX, 0, 0);
    };
    placeLeaf(doorLeftPivot, doorLeftMesh, DOOR_LEFT_ASPECT, doorTuneState.left, -1, DOOR_LEAF_Z);
    placeLeaf(doorRightPivot, doorRightMesh, DOOR_RIGHT_ASPECT, doorTuneState.right, 1, DOOR_RIGHT_LEAF_Z);
  }
  applyDoorTune();

  // Temple island: a hand-modelled 3D island (Blender) sitting under the
  // temple — Luke, 2026-09-05: "put this island mesh into the game under the
  // Temple. Make it large enough to be about 1.5x the width of the temple."
  // Replaces the flat photo-plane "approach" ground that was tried here and
  // dropped (courtyardGen.js, removed — see git history around 2026-09-04/05:
  // "this isn't working well... we'll go with a 3D island instead"). The mesh
  // itself has already been swapped once since (2026-09-05, the multi-texture
  // version built with material slots for top/rim/underside) — the loader
  // below doesn't care which version of models/temple-island.glb it is.
  //
  // Purely decorative for now — unlike the fork islands (see spawnIsland()),
  // it isn't wired into ISLAND_MODELS/registerIsland/the walkable-radius
  // machinery, since the final approach is still a flat scripted walk
  // regardless of what's rendered underneath it.
  gltfLoader.load('models/temple-island.glb', (gltf) => {
    const templeIsland = gltf.scene;

    // Converted to unlit, matching every other prop in this game. An
    // untouched glTF import carries PBR materials that react to the scene's
    // real-time lights, which are only ever tuned for shadow-casting — the
    // exact mistake already made and fixed once for the fork islands (see
    // islandGen.js's "Unlit by design, not by accident" note): the first
    // in-game test of THAT model rendered almost pure black for this same
    // reason. Whatever base colour/map/vertex-colours Blender exported are
    // kept; only the lighting response changes. Iterates every sub-mesh
    // independently, so a multi-material object (several materials/textures
    // on one mesh, e.g. top/rim/underside) converts correctly — each
    // material slot exports as its own glTF primitive/Object3D under
    // `templeIsland`, and each keeps its own map here.
    templeIsland.traverse((o) => {
      if (!o.isMesh) return;
      const src = o.material;
      o.material = new THREE.MeshBasicMaterial({
        map: src.map ?? null,
        color: src.color ? src.color.clone() : undefined,
        vertexColors: src.vertexColors,
        side: src.side,
      });
    });

    // Scaled to 1.5x the temple's own (apparent, forced-perspective) width —
    // measured off the mesh's real geometry rather than assumed, since a
    // Blender export's scale has no relationship to this game's world units.
    // This is the BASE placement; the position/scale set below layers a
    // further baked offset on top of it (see that code's own comment).
    const box = new THREE.Box3().setFromObject(templeIsland);
    const islandWidth = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
    const templeWidth = TEMPLE_H * TEMPLE_ASPECT;
    const baseScale = (templeWidth * 1.5) / islandWidth;
    // Directly under the temple. y=0 assumes the model's exported origin
    // sits at its own deck/ground height, same convention ISLAND_Y=0 relies
    // on for the fork islands — a starting guess, easy to nudge if the model
    // turns out to float or sink relative to the temple's base.
    const basePos = { x: 0, y: 0, z: -TEMPLE_DISTANCE };
    scene.add(templeIsland);
    templeIslandRef = templeIsland; // read by templeIslandNearEdge() — see its own comment
    if (import.meta.env.DEV) window.__templeIsland = templeIsland;

    // Position/scale offset baked in from Luke's own in-game tuning,
    // 2026-09-05 — this used to be six live sliders (see git history around
    // that date for how they worked), removed once these settled. The Y/Z
    // scale (0.55/0.50) squash the model noticeably flatter and shallower
    // than its raw import; that's deliberate, not a placeholder.
    templeIsland.position.set(basePos.x, basePos.y, basePos.z - 3.0);
    templeIsland.scale.set(baseScale * 1.05, baseScale * 0.55, baseScale * 0.5);
  });

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

  // ------------------------------------------------------------------ shrine arch
  //
  // Every fork island gets a shrine arch (archGen.js) toward its front edge,
  // straddling both bridges, and the fork's word signs hang from its rope —
  // Luke, 2026-10-03, placement sketched in Blender: the player walks toward
  // and through it. ARCH is in world units, not the model's metres, because
  // what constrains it is world-side: the pillars must clear both bridges
  // (anchored at ±ISLAND_ANCHORS.lateral) and the five seated players, the
  // gap between them must take two hanging words side by side, and the rope
  // must be high enough that those words clear the crowd's name tags (the
  // job WORD_SIGN_Y = 3.6 used to do on its own). So the arch is built
  // wider-for-its-height than the stand-alone model, and ARCH.scale only sets
  // how big its carved detail (plinths, bands, brackets) reads.
  const ARCH = {
    scale: 3.6,
    forward: 1.7,       // island centre → arch, along the heading (Luke, tuned 2026-10-03). Bridges leave at ISLAND_ANCHORS.forward (4.16).
    span: 6.6,          // outer width across the pillars
    clearHeight: 4.4,   // deck → underside of the beam
    pillarRadius: 0.26,
    ropeHeight: 3.75,
    ropeSag: 0.25,
    ropeThickness: 0.55,
    signGap: 0.3,       // between the two hanging words
    signDrop: 0.18,     // cord length, rope → the sign frame's hanging rings
    // Lit by the game's own sun and sky lights (MeshStandardMaterial), rather
    // than the baked, unlit look the rest of the scene uses — Luke preferred
    // it in the preview (2026-10-04). Both switchable from the ?archTune=1
    // panel while that's being judged in place.
    lit: true,
    shadows: true,      // arches cast shadows, and the island decks receive them
  };
  // Painting the arch's textures costs a couple of seconds of main thread, so
  // it happens once per page and is shared by every arch and every rebuild.
  // Variety comes from elsewhere (Luke, 2026-10-04: "they all look the
  // same"): each island builds its own geometry through varyArch — small
  // seeded changes of proportion and ornament, never the span/clearance/rope
  // the word signs depend on — and gets its own colour scheme, applied as a
  // shader tint over the shared textures' lacquer masks. No extra downloads,
  // no extra texture painting; a build costs ~0.1-0.2 s of geometry each.
  let archTextures = null;
  const arches = []; // { group, built, cursor, seed, palette }
  // Colour scheme per island, in order (Luke, 2026-10-04): the first four
  // islands show each of the four schemes once, shuffled; after that, two
  // more picked at random — different from each other, and the first of them
  // different from the fourth island's, so neighbours never match.
  function makeArchPaletteOrder() {
    const n = ARCH_PALETTES.length;
    const rand = () => Math.floor(Math.random() * n);
    const order = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    let a, b;
    do a = rand(); while (a === order[n - 1]);
    do b = rand(); while (b === a);
    return [...order, a, b];
  }
  let archPaletteOrder = makeArchPaletteOrder();
  function archParams() {
    const s = ARCH.scale;
    const span = ARCH.span / s;
    const beamLength = span * 1.73; // the stand-alone model's beam:span ratio
    return {
      span,
      beamLength,
      capLength: beamLength + 0.18,
      clearHeight: ARCH.clearHeight / s,
      pillarRadius: ARCH.pillarRadius / s,
      pillarTopRadius: (ARCH.pillarRadius * 0.89) / s,
      ropeHeight: ARCH.ropeHeight / s,
      ropeSag: ARCH.ropeSag / s,
      ropeThickness: ARCH.ropeThickness,
      ropeCharms: false, // the word signs hang there instead
    };
  }
  const getArchTextures = () => (archTextures ??= buildArchTextures(ARCH_DEFAULTS.seed));
  const archMode = () => (ARCH.lit ? 'lit' : 'unlit');
  /**
   * Builds (or rebuilds) one arch's geometry from its seed and colour scheme.
   * Each arch also gets its own glyphs (talismans, plaque, plinth runes —
   * Luke, 2026-10-04): drawn over the shared, cached base paint, so only the
   * cheap stroke layer is per arch.
   */
  function buildArchFor(a) {
    if (a.built) {
      scene.remove(a.group);
      a.built.dispose(); // textures were passed in, so this leaves them alone
    }
    a.glyphs ??= buildGlyphTextures(ARCH_DEFAULTS.seed, a.seed);
    a.built = buildArch(varyArch(archParams(), a.seed), {
      textures: { ...getArchTextures(), ...a.glyphs },
      palette: a.palette,
      mode: archMode(),
    });
    a.group = a.built.group;
    placeArch(a);
    applyArchShadows(a);
    scene.add(a.group);
  }
  function applyArchShadows(a) {
    a.group.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = ARCH.shadows && o.name !== 'arch-runes'; // the glow is a transparent decal, not a solid
      o.receiveShadow = ARCH.shadows && ARCH.lit; // an unlit material can't show a shadow anyway
    });
  }
  /**
   * The deck is unlit (MeshBasicMaterial), and an unlit material can't show
   * a shadow — so each island gets a transparent ShadowMaterial disc laid a
   * hair above its paving, which draws nothing but the shadows that fall on
   * it. It also catches the cardboard figures' shadows (they have always
   * cast, onto nothing), so the switch hides it entirely: "off" is exactly
   * the old look. Child of the island group, so in its (unscaled) units.
   */
  const shadowCatcherGeometry = new THREE.CircleGeometry(1, 64).rotateX(-Math.PI / 2);
  // Opacity reads much weaker than it sounds: blending happens in linear
  // light, so 0.35 measured as barely visible (2026-10-04) and 0.6 comes out
  // around a third darker on screen.
  const shadowCatcherMaterial = new THREE.ShadowMaterial({ opacity: 0.6, depthWrite: false });
  function addShadowCatcher(group, t) {
    const m = new THREE.Mesh(shadowCatcherGeometry, shadowCatcherMaterial);
    m.scale.setScalar(t.deckRadius);
    m.position.y = t.deckTop + 0.01 / t.scale; // 1 cm of world above the paving
    m.receiveShadow = true;
    m.renderOrder = 1;
    m.userData.shadowCatcher = true;
    m.visible = ARCH.shadows;
    group.add(m);
  }
  function applyDeckShadows(group) {
    group.traverse((o) => {
      if (o.userData.shadowCatcher) o.visible = ARCH.shadows;
    });
  }
  function applyArchLighting() {
    for (const a of arches) {
      a.built.setMode(archMode());
      applyArchShadows(a);
    }
    for (const g of islands) applyDeckShadows(g);
  }
  function placeArch(a) {
    const p = localToWorld(a.cursor, 0, ISLAND_AHEAD + ARCH.forward);
    a.group.position.set(p.x, ISLAND_Y, p.z);
    a.group.rotation.y = -a.cursor.heading; // model faces +Z; heading 0 walks toward -Z
    a.group.scale.setScalar(ARCH.scale);
  }
  function spawnArch(cursor) {
    const a = {
      group: null,
      built: null,
      cursor: { ...cursor },
      seed: Math.floor(Math.random() * 1e6),
      palette: ARCH_PALETTES[archPaletteOrder[arches.length % archPaletteOrder.length]],
    };
    buildArchFor(a);
    arches.push(a);
  }
  function rebuildArches() {
    for (const a of arches) buildArchFor(a);
  }
  function disposeArches() {
    for (const a of arches) {
      scene.remove(a.group);
      a.built.dispose();
      for (const t of Object.values(a.glyphs)) t.dispose();
    }
    arches.length = 0;
  }
  /** The arch standing on the island of the fork at `cursor`. */
  const archAt = (cursor) => arches.find((a) => a.cursor.x === cursor.x && a.cursor.z === cursor.z);
  /** World height of an arch's rope at a lateral offset from its centre line. */
  function archRopeY(a, lateral) {
    const r = a.built.rope;
    const x = THREE.MathUtils.clamp(lateral / ARCH.scale, -r.half, r.half);
    return ISLAND_Y + r.y(x) * ARCH.scale;
  }
  const archRopeHalf = (a) => a.built.rope.half * ARCH.scale;

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

  // Set once the temple island's async gltf load finishes (see its own loader
  // above). By the time buildJourney() can possibly run, this is guaranteed
  // non-null: startJourney() (which calls it) only ever runs from
  // manager.onLoad, which by definition fires once every asset registered
  // with `manager` — including this one — has finished loading. No loading
  // race to guard against here as a result.
  let templeIslandRef = null;
  /**
   * The temple island's own edge nearest the fork islands (the +Z-ish side,
   * since the whole journey walks toward -Z and the temple sits at the far,
   * most-negative end) and its horizontal centre — measured off the mesh's
   * actual world-space bounds rather than assumed, since its position/scale
   * (and the model itself) are hand-set, not derived from anything this
   * function could otherwise compute directly.
   */
  function templeIslandNearEdge() {
    const box = new THREE.Box3().setFromObject(templeIslandRef);
    return { x: (box.min.x + box.max.x) / 2, z: box.max.z };
  }

  // ---------------------------------------------------------------- plank models
  //
  // Hand-modelled bridge planks (Blender, Luke's own meshes — 2026-09-03),
  // three variants so a 20-odd-plank bridge doesn't read as one block
  // stamped down repeatedly. Registered with the shared `manager` like the
  // island models (`gltfLoader` is the same loader instance those use), so
  // the journey (built from manager.onLoad — see the comment above
  // startJourney()'s definition) never gets built before these have arrived.
  const PLANK_MODELS = ['models/plank1.glb', 'models/plank2.glb', 'models/plank3.glb'];
  const plankVariants = []; // filled in as each model's onLoad fires — { geometry, material, halfThickness }

  for (const src of PLANK_MODELS) {
    gltfLoader.load(src, (gltf) => {
      // Each file is a single node carrying both the mesh and a Blender
      // Object-mode Scale that was never "Applied" before export — real
      // (two of the three planks are deliberately different sizes), but it
      // has to be baked into the geometry itself before this can go into an
      // InstancedMesh: instancing supplies its own per-instance matrix and
      // has no idea about a *source* mesh's separate local transform, so
      // skipping this would render every plank at its pre-scale size. Baked
      // from the accumulated matrixWorld (not just `.scale`) so this is
      // still correct if a later re-export adds a position/rotation on top,
      // or wraps the mesh in a parent node.
      gltf.scene.updateWorldMatrix(true, true);
      let mesh = null;
      gltf.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
      mesh.geometry.applyMatrix4(mesh.matrixWorld);
      mesh.geometry.computeBoundingBox();
      const halfThickness = (mesh.geometry.boundingBox.max.y - mesh.geometry.boundingBox.min.y) / 2;
      // Patched once here rather than per-bridge: every bridge that uses this
      // variant shares this exact material (see bridgeGen.js's plank
      // section), so the wind uniforms only need wiring in once, not
      // redundantly on every buildBridge() call.
      bridgeWind.patch(mesh.material, 'instanced');
      plankVariants.push({ geometry: mesh.geometry, material: mesh.material, halfThickness });
    });
  }

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
  // longer exists once the branch is straight) the wrong side's breakable
  // planks sit. 0.5 — the deck's lowest point (the catenary's midspan sag is
  // symmetric about t=0.5 regardless of sag/sagShape) — per Luke, 2026-09-04:
  // the break should happen in the middle, at the lowest point, not out past
  // the fog curtain the way the old static-gap placeholder was. The wrong
  // branch's walk queue is truncated at exactly this same fraction, so the
  // player walks right up to the pair of breakable planks and triggers both
  // breaks the instant they reach them (see the `breakablePlanks` handling
  // in tick()'s walk loop and triggerPlankBreak()), rather than falling at
  // some unrelated point on the deck.
  const BRIDGE_WRONG_GAP_T = 0.5;

  /**
   * The waypoints for one bridge branch: straight from `cursor`'s edge to
   * `target`'s edge (a rope bridge cannot bow — see bridgeGen.js's planBow
   * note), using ISLAND_ANCHORS for how far in from each island's centre the
   * anchors sit. Used for every fork, including the last (target there is the
   * temple island's own measured edge, not a registered fork island — see
   * buildFork). Always returns exactly [departEdge, arriveEdge, target-centre].
   */
  function genBridgeRoute(cursor, target, sideSign, targetIsFork) {
    const departEdge = localToWorld(cursor, sideSign * ISLAND_ANCHORS.lateral, ISLAND_AHEAD + ISLAND_ANCHORS.forward);
    const arriveAhead = targetIsFork ? ISLAND_AHEAD : 0; // the temple island doesn't shift
    const arriveEdge = localToWorld(target, sideSign * ISLAND_ANCHORS.lateral, arriveAhead - ISLAND_ANCHORS.forward);
    return [departEdge, arriveEdge, { x: target.x, z: target.z }];
  }

  /**
   * Marks where a fork will stand. Called *before* the run of stones leading
   * to it is laid, because placeStone needs to know to skip that area and the
   * trunk is scattered before the fork itself is built.
   */
  function registerIsland(pos) {
    const c = islandCentre(pos);
    islandSpots.push({ x: c.x, z: c.z });
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

  function spawnIsland(forkCursor) {
    const seed = Math.floor(Math.random() * 1e9);
    const group = new THREE.Group();
    if (islandTemplates.length) {
      // One of possibly several hand-modelled variants (see ISLAND_MODELS) —
      // picked at random per fork, same as the procedural version picked a
      // random seed, so no two forks need look alike.
      const t = islandTemplates[Math.floor(Math.random() * islandTemplates.length)];
      fillGroupFromTemplate(group, t);
      addShadowCatcher(group, t);
    } else {
      // Not a loading race — the journey is only ever built from
      // manager.onLoad (see startJourney()'s definition), which fires once
      // every registered load has already settled, success or failure. So
      // reaching this branch means the island model's fetch genuinely
      // failed; there is no "later" for it to arrive in, and nothing revisits
      // this island once built. A real network failure is rare enough, and
      // this fallback close enough, that shipping a procedural rock instead
      // of no island at all is the right trade rather than surfacing an error.
      for (const child of buildIsland({ seed, ...ISLAND_FALLBACK_PARAMS }).children) group.add(child);
    }
    const centre = islandCentre(forkCursor);
    group.position.set(centre.x, ISLAND_Y, centre.z);
    scene.add(group);
    islands.push(group);
    applyDeckShadows(group);
    spawnArch(forkCursor);
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
  // an unrelated path-length constant. (The wrong branch's own fall point used
  // to be tied to this the same way, as a fraction of the branch's own curve;
  // it's now wherever BRIDGE_WRONG_GAP_T puts the breakable planks — see
  // buildFork.)
  const CURTAIN_DIST = ISLAND_AHEAD + ISLAND_RADIUS + 1.5; // how far past the fork the curtain stands — must clear the deck's edge (the island sits ISLAND_AHEAD forward of the fork)
  const CURTAIN_OPEN_LEAD = 1.6; // starts dissolving this far before the avatar reaches it
  const CURTAIN_OPEN_TIME = 1.0; // seconds to fully dissolve
  const CURTAIN_GUIDE_OPACITY = 0.28; // guide sees through it — the cheap version of "the guide can see ahead"

  const curtains = [];
  // Hidden 2026-09-13 while the real-movement tracking rebuild was being
  // tested end to end (Luke: "go ahead and disable the fog altogether...
  // that way we can test that everyone else can see everything they
  // should"). Re-enabled 2026-09-14 once that rebuild was confirmed working
  // through every movement type and the guide's camera-follow behaviour —
  // see TODO.md's step-by-step entry. The curtains occlude real movement
  // now, same as any other piece of scenery, rather than replacing it with
  // a stand-in the way the old fog system used to.
  const FOG_CURTAINS_VISIBLE = true;

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

    // Luke, 2026-09-13: "go ahead and disable the fog altogether. Don't
    // delete it, just hide it. That way we can test that everyone else can
    // see everything they should." Everything else about a curtain still
    // builds and animates as before — flip this back on to restore it.
    group.visible = FOG_CURTAINS_VISIBLE;
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
    // `abduction` for the same reason as `falling` (see cancelBirdsForFall):
    // a gull drifting casually past while a flying saucer lifts the player
    // away undercuts the one moment the scene is asking to be looked at.
    if (bird || finished || falling || abduction) return;
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
  // The whole route — every fork's island, both its bridges, and the final
  // stretch to the temple — is built up front, in buildJourney(), before the
  // player has made a single choice. Luke, 2026-09-05: "you currently
  // generate each island only because in the old system paths moved in
  // different directions. There is no longer any reason for this."
  //
  // That's a real change, not just tidying: it used to be built **one fork at
  // a time** on purpose, as an anti-cheat measure — back when only the
  // *correct* branch of a fork fed the cursor the next fork was planted from,
  // a downstream fork's mere world-position would have encoded which side was
  // correct upstream of it, readable by a player who could see the whole
  // route's shape in advance. Building on demand meant that information
  // didn't exist yet to be read.
  //
  // The converging-branches rework (2026-08-27/28, see TODO.md) already
  // removed the premise this was protecting against — both branches of a fork
  // curve to the *same* next island now (see buildFork), so island position
  // has never depended on which side is correct, only correctness itself
  // does (CORRECT_BY_FORK, decided once, randomly, before any of this runs).
  // The lazy build just never got revisited once that stopped being true.
  // Nothing here hides which bridge is correct: both are visibly identical
  // rope bridges, one with a breakable plank invisible until walked onto (see
  // BRIDGE_WRONG_GAP_T) — the fog/curtains hide *distance*, not the answer.

  const sections = []; // one per fork: { fork, correct, branch:{left,right}, words:{left,right}, approach, curtain, nextCursor, endPhase }

  // The validated word-pairs.json data (see wordPairs.js) — set once, in
  // manager.onLoad, before startJourney() can possibly need it. `roundWords`
  // is the per-round draw from it: one `{left, right}` per fork, redrawn
  // fresh every buildJourney() call (so "Again" gets new words, not the same
  // ones repeated) — unlike CORRECT_BY_FORK just below, which is still only
  // decided once per page load. See buildJourney().
  let wordPairs = [];
  let roundWords = [];

  // Where the *next* fork will be planted, and the stone-row phase carried
  // along the route to it. Advanced directly by buildJourney()'s own loop now
  // (each buildFork(k) call updates it before the next) — these used to also
  // persist *between* calls spread across separate player choices, back when
  // the build was lazy; now the whole loop runs in one synchronous pass.
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
    disposeArches();
    archPaletteOrder = makeArchPaletteOrder();
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
    disposePickupMesh(); // the island-2 item is rebuilt by buildJourney() if still unclaimed — see the "pickup" section
    // Defensive rather than load-bearing since the whole journey builds in
    // one synchronous pass now (buildJourney()'s own loop always consumes
    // this flag the very next iteration, every time) — but cheap, and it
    // used to matter when forks were built one at a time across separate
    // player choices, where a fall could leave it stuck true against an
    // island that clearJourney had just disposed.
    nextIslandAlreadySpawned = false;
    // A previous round's broken plank pieces (see triggerPlankBreak) are
    // added straight to `scene`, not to any bridge group disposed above, so
    // they'd otherwise sit there forever across a restart — accumulating
    // further with every subsequent fall on this same mechanic, since
    // triggerPlankBreak's own clearBrokenPieces() call only ever fires again
    // if THIS bridge's plank breaks a second time.
    clearBrokenPieces();
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
   * Builds both of one fork's bridges — correct and wrong, identical except
   * for the wrong side's breakable plank — from `cursor`'s edge to
   * `target`'s. Both bridges are added to `scene` and pushed onto the shared
   * `bridges` array here (for clearJourney()'s generic disposal pass).
   *
   * Returns `branch`, a `{ left, right }` pair of waypoint arrays in the
   * shape buildFork's own `sec.branch` expects.
   */
  function buildForkBridges(cursor, target, correct, sagMultiplier, targetIsFork) {
    const branch = {};
    for (const side of ['left', 'right']) {
      const isCorrect = side === correct;
      const sideSign = side === 'right' ? 1 : -1;
      const [departEdge, arriveEdge, centreHop] = genBridgeRoute(cursor, target, sideSign, targetIsFork);
      const bridgeOptions = {
        sag: BRIDGE_DEFAULTS.sag * sagMultiplier,
        ...(isCorrect ? {} : { breakableT: BRIDGE_WRONG_GAP_T }),
      };
      const bridgeGroup = buildBridge(departEdge, arriveEdge, bridgeOptions, bridgeWind, plankVariants);
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
        // Walk up to the breakable planks, then fall — the walker's own
        // queue runs out at exactly the point they break under them (see
        // `breakablePlanks` below and tick()'s walk loop), rather than
        // the queue simply running dry for no visible reason.
        const fallPoint = {
          x: THREE.MathUtils.lerp(departEdge.x, arriveEdge.x, BRIDGE_WRONG_GAP_T),
          z: THREE.MathUtils.lerp(departEdge.z, arriveEdge.z, BRIDGE_WRONG_GAP_T),
          bridge: info,
          bridgeT: BRIDGE_WRONG_GAP_T,
          breakablePlanks: info.breakablePlanks,
        };
        branch[side] = [departEdge, fallPoint];
      }
    }
    return branch;
  }

  // Where the last fork's own pair of bridges lands on the temple island's
  // measured edge, and how much extra sag they hang with — both baked in
  // from Luke's own in-game tuning, 2026-09-05 (this used to be two live
  // sliders, #finalBridgeTune in chrome.js — see git history around that
  // date for how they worked). LAST_FORK_LANDING_OFFSET nudges the
  // temple-side landing point (see buildFork's isLastFork branch) beyond
  // what the measured edge alone gives.
  const LAST_FORK_LANDING_OFFSET = { x: -4.5, z: 0 };
  const LAST_FORK_SAG_MULTIPLIER = 1.3;

  /**
   * Plants fork `k` at the current journeyCursor: its island, both bridges,
   * and its curtain. Records the shared destination (nextCursor) so
   * buildJourney()'s own loop knows where to plant fork k+1 from.
   *
   * The destination is fixed *before* either branch is drawn, and both
   * bridges (see genBridgeRoute) are built to land on it — this is what
   * "converging branches" means: which side is correct no longer decides
   * where the next island sits, only whether the player's own branch
   * actually reaches it.
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
    // `CORRECT_BY_FORK[k-1]` is a SHARED signal (same on every device,
    // parsed from the group-wide `forks` string — see genCorrectSequence)
    // but no longer names a physical side: it names which member of the
    // word pair is correct, "left" meaning `pair.a`, "right" meaning
    // `pair.b`, purely as internal labels carried over from before this
    // was split. Which physical bridge each member actually sits on is a
    // separate, LOCAL coin flip below — see `aOnLeft`.
    const pair = roundWords[k - 1]; // { a, b } — shared pair, no side yet (see wordPairs.js's assignForkWords)
    const correctIsA = CORRECT_BY_FORK[k - 1] === 'left';
    // Per-player randomised side, 2026-09-13 — Luke: "the correct
    // side/bridge and the matching word needs to be randomised per
    // player... [to] prevent players from seeing which choice their
    // teammates made." Every device already builds this entire scene
    // independently from the same shared `pair`/`correctIsA` (buildFork
    // runs locally on each device, nothing about geometry is networked —
    // see the "single shared fact" reasoning in the seating section above
    // for the general pattern this follows), so this is simply a fresh
    // `Math.random()` per device, per fork: which pair member lands left
    // vs right differs device to device, while the WORD that's actually
    // correct — needed so everyone reacts to the same word the guide says
    // aloud — stays identical everywhere, since it's derived from the
    // shared `correctIsA` regardless of this device's own placement. The
    // two physical bridges are already visually identical either way (see
    // "Nothing here hides which bridge is correct" below), so this
    // introduces no new visual tell for a device that happens to see both.
    const aOnLeft = Math.random() < 0.5;
    const words = aOnLeft ? { left: pair.a, right: pair.b } : { left: pair.b, right: pair.a };
    const correct = correctIsA === aOnLeft ? 'left' : 'right'; // the PHYSICAL side holding the correct word, local to this device
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
    // This whole block is skipped for the last fork — its target isn't
    // FORK_DISTANCE further along the pacing curve at all, it's the temple
    // island's own measured edge (below). Using the generic formula there
    // was exactly what fell short: FORK_DISTANCE (16) undershoots the real
    // gap to the temple island's edge (~20) by several units, landing the
    // bridges' far end in open air short of any solid ground.
    let target;
    if (isLastFork) {
      const templeEdge = templeIslandNearEdge();
      const anchorRadius = Math.hypot(ISLAND_ANCHORS.lateral, ISLAND_ANCHORS.forward);
      const margin = ISLAND_RADIUS - anchorRadius; // same margin-from-edge every ordinary bridge anchors at
      target = {
        x: templeEdge.x + LAST_FORK_LANDING_OFFSET.x,
        z: templeEdge.z - margin - ISLAND_ANCHORS.forward + LAST_FORK_LANDING_OFFSET.z,
        heading: 0, // the temple sits dead ahead on the world's own centreline
      };
    } else {
      const straightEnd = advance(cursor, cursor.heading, FORK_DISTANCE);
      const targetHeading = THREE.MathUtils.lerp(cursor.heading, templeHeading(straightEnd), HEADING_CORRECTION);
      target = { ...advance(cursor, targetHeading, FORK_DISTANCE), heading: targetHeading };
    }
    const nextCursor = target;

    // Register the next island's stone-suppression zone before either branch
    // is built — whichever side turns out correct runs right up to that
    // island's edge, and placeStone has to already know to leave that patch
    // clear. Skipped for the last fork: `target` there is the temple
    // island's edge, not a fork island — it already exists, spawned by its
    // own loader, nothing to register or spawn here.
    if (!isLastFork) {
      registerIsland(target);
      spawnIsland(target);
      nextIslandAlreadySpawned = true;
    }

    const forkPhase = journeyPhase; // both branches leave the fork on the same row phase
    const endPhase = forkPhase; // no stones scattered on this stretch any more to carry a phase forward from

    // The last fork's pair hangs deeper — Luke, 2026-09-05: "~30% greater"
    // depth/steepness, on top of the longer span already asking for it.
    const sagMultiplier = isLastFork ? LAST_FORK_SAG_MULTIPLIER : 1;
    const branch = buildForkBridges(cursor, target, correct, sagMultiplier, !isLastFork);

    const sec = {
      fork: { ...cursor },
      correct,
      branch,
      words,
      approach: null,
      nextCursor,
      endPhase,
    };
    sec.curtain = makeCurtain(advance(sec.fork, sec.fork.heading, CURTAIN_DIST), sec.fork.heading);
    sections.push(sec);
    return sec;
  }

  /**
   * Fills in the walk from wherever the last fork's bridges land to the
   * temple's actual stop point (STOP_FRACTION of TEMPLE_DISTANCE) — the
   * stretch that used to be a fixed-length APPROACH_DISTANCE starting from a
   * virtual, off-island point (see git history before 2026-09-05). Now that
   * the last fork's target is the temple island's own real edge, the
   * remaining distance is whatever's actually left, not a constant — this
   * recomputes it from `nextCursor`'s real position, so it stays correct
   * however far along the edge that landed.
   */
  function buildFinalApproach(sec) {
    const stopZ = -STOP_FRACTION * TEMPLE_DISTANCE;
    const remaining = Math.max(0, sec.nextCursor.z - stopZ);
    sec.approach = genStraight(sec.nextCursor, sec.nextCursor.heading, remaining, 3);
  }

  /**
   * Starts a fresh route: clears whatever the last run built and plants fork
   * 1 directly at the spawn point. Nothing past fork 1 exists until it is
   * chosen.
   *
   * The player spawns standing ON this island now (Luke, 2026-09-04: "have
   * the players start on the island... delete the paths" — removing the
   * last of the decorative stone stretches, this one having carried the
   * walk in from spawn to fork 1). journeyCursor IS the spawn point, so
   * buildFork(1)'s own spawnIsland(cursor) call plants that first island
   * right at the origin — there is no walk to get there, so no leg is
   * created for it either; see startJourney().
   */
  function buildJourney() {
    clearJourney();
    // Redrawn every call, not just once at page load — so "Again" (restart())
    // deals a fresh round of pairs rather than repeating the last run's
    // words. See assignForkWords() in wordPairs.js for the actual selection
    // rules (no repeats within a round while pairs allow it).
    //
    // wordsOverride takes priority when given — Luke, after a multiplayer
    // test: "the words the guide sees are different from the words the
    // players in their teams [see]." Root cause: every device was calling
    // assignForkWords() independently, so each one drew its own random PAIR
    // — nothing about which words were even in play was ever actually
    // shared. Whoever starts the round for the whole group now decides the
    // pairs once (see TeacherDashboard.jsx's startGame()) and broadcasts
    // them alongside forks, so every device in the group renders the
    // identical `{a, b}` pairs here instead of drawing its own.
    //
    // Left/right PLACEMENT of each pair is deliberately NOT part of this
    // shared array any more (see wordPairs.js's own comment) — that's a
    // separate, per-device random draw done locally in buildFork(), added
    // 2026-09-13 specifically so a teammate's physical side conveys nothing
    // about which word they judged correct. Only the pair identity, and
    // which member of it is correct (CORRECT_BY_FORK, from the shared
    // `forks` string), need to match across the group; which one sits on
    // which bridge does not, and now never does.
    roundWords = wordsOverride ?? assignForkWords(wordPairs, N_FORKS);
    const origin = { x: 0, z: 0, heading: 0 };
    registerIsland(origin);
    journeyCursor = origin;
    // Every fork's island and both its bridges, all built here, up front —
    // see "the journey" section header above for why this is safe now (it
    // wasn't always). journeyCursor is advanced by hand between iterations
    // because buildFork() itself only ever reads it, never returns where it
    // moved to — same as it always has, just no longer spread across
    // separate calls waiting on player choices in between.
    for (let k = 1; k <= N_FORKS; k++) {
      const sec = buildFork(k);
      journeyCursor = { x: sec.nextCursor.x, z: sec.nextCursor.z, heading: sec.nextCursor.heading };
    }
    buildFinalApproach(sections[N_FORKS - 1]);
    // `sections` was just rebuilt from scratch — any teammate rig positioned
    // against the OLD array (from a previous round on this device) needs
    // re-anchoring against the new one, even though its own forkIndex value
    // hasn't changed. repositionAllTeammates is declared further down (see
    // "teammates" section) but hoists — same scope, this is safe.
    repositionAllTeammates();
    buildPickup(); // the island-2 item — see the "pickup" section; hoists the same way
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

  // Name tag: was sized off a fixed WIDTH (the figure's own width times
  // NAME_TAG_WIDTH_FACTOR), which — Luke, 2026-09-12, after seeing several
  // real names alternating on an island — reads "much too big" and blows up
  // badly for short names. Cause is the exact bug WORD_SIGN_HEIGHT below was
  // already written to avoid: buildNameTagCanvas keeps letters a fixed pixel
  // height regardless of word length, so its aspect (height/width) grows for
  // short words — forcing a short name like "Kahu" to the SAME WIDTH as a
  // long one then inflates its height to match, ballooning it well past
  // every other tag on screen. Fixed the same way as the word signs: size on
  // a fixed world HEIGHT instead, so every name's letters read the same size
  // and only the tag's width (how much a longer name needs) varies.
  // NAME_TAG_HEIGHT picked relative to WORD_SIGN_HEIGHT using the ratio the
  // 2026-09-06 comment on WORD_SIGN_HEIGHT already recorded between the two
  // ("sized 50% bigger than a name tag") — 0.9 / 1.5. Reduced 10% again,
  // 2026-09-15, Luke — the tag mesh's width is derived from this same
  // height (see attachNameTag's tagW), so its cardboard backing shrinks
  // proportionally with the letters, not just the letters alone.
  const NAME_TAG_HEIGHT = 0.6 * 0.9;
  const NAME_TAG_GAP = 0.12; // world units between the card's top edge and the tag's bottom edge

  /**
   * Local Y for a name tag, relative to the RIG GROUP'S OWN origin (which
   * sits at world Y = FIGURE_H/2, mid-body — see e.g. positionTeammateRig),
   * now that a tag is a real mesh parented to that group again (see the
   * "Name tags" section's header comment for why). "Above" clears past the
   * head (local +FIGURE_H/2) by GAP — straightforward, mirrors the old
   * screen-space version exactly. "Below" can NOT mirror that by simply
   * negating it (that's the exact bug that sank the original 2026-08-30
   * mesh attempt): negating lands at local -(FIGURE_H/2+GAP+tagH/2), which
   * is world Y = FIGURE_H/2 - (FIGURE_H/2+GAP+tagH/2) = -(GAP+tagH/2) — a
   * small NEGATIVE world Y, i.e. below the ground plane, invisible behind
   * solid terrain regardless of how small the magnitude is. A real mesh
   * can't clip through the ground the way the screen-space DOM version
   * could — so "below" sits with its own bottom edge right at the ground
   * (local -FIGURE_H/2, the group's own bottom edge, plus half its own
   * height) rather than hanging past it.
   */
  // NAME_TAG_BELOW_Y_OFFSET: nudge on top of the below-side formula below —
  // added 2026-09-14, Luke: the below tag read as "partially embedded in
  // the ground." Found live via the `?tagTune=1` panel and locked in
  // 2026-09-15; the panel itself is being kept live for now since resizing
  // the tag (NAME_TAG_HEIGHT below) may call for a further nudge here — see
  // that constant's own comment.
  let NAME_TAG_BELOW_Y_OFFSET = 0.21;
  function tagLocalY(side, tagH) {
    return side === 'below'
      ? tagH / 2 - FIGURE_H / 2 + NAME_TAG_BELOW_Y_OFFSET
      : FIGURE_H / 2 + NAME_TAG_GAP + tagH / 2;
  }

  // Luke, 2026-09-13, after seeing a "below" tag flickering and covering the
  // avatar's feet: a below-body tag sitting near ground level is, by
  // construction, at the same local Z as the character's own card mesh
  // (both default to 0) AND within its Y extent — two coplanar overlapping
  // planes, which is a textbook z-fight (the flicker) as well as the tag
  // visibly sitting ON TOP of the art instead of clear of it. Nudging it
  // forward (toward the camera, since the card's own "front" faces +Z — see
  // makeCharacterRig) by a real, visible amount puts it in the open ground
  // just in front of the character's feet instead, matching Luke's
  // reference screenshot: clearly separate from the card, not embedded in
  // it. "Above" needs no such push — nothing else occupies that space.
  // Found live via `?tagTune=1` alongside NAME_TAG_BELOW_Y_OFFSET above and
  // locked in 2026-09-15 — see that constant's own comment for why the
  // panel itself is being kept live a while longer.
  let NAME_TAG_BELOW_Z = 1.06;
  function tagLocalZ(side) {
    return side === 'below' ? NAME_TAG_BELOW_Z : 0;
  }

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
    disposePowerUp(r);
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
      // Luke, 2026-09-12: "the guide should not have a character card
      // visible while they are the guide — rather, they will see the
      // island with all the other players on it." The rig still exists
      // (character/colour are stored regardless, in case role ever
      // switches — see the dev role-toggle below), it's just never shown.
      figure.visible = !isSpectatorRole(role);
    }
  }

  // ---------------------------------------------------------------- power-ups
  //
  // A power-up is a second card — same "image on a cardboard backing"
  // construction as the player's own — clipped to the side of the player's
  // card with a small plastic connector, per the reference photos Luke
  // provided 2026-09-12. Every power-up shares the exact same clip and the
  // exact same card position/size; only the card's own texture and aspect
  // ratio change from one power-up to the next ("for later ones we'll just
  // swap out the card") — so POWERUP_TUNE/equipPowerUp below are written
  // generic over the texture, never jetpack-specific.
  //
  // Loaded once, up front, registered with `manager` like every other model
  // — so it's guaranteed ready by the time any button that could equip it is
  // even clickable (see manager.onLoad's own comment on why that ordering
  // is safe to rely on).
  let plasticClipTemplate = null;
  gltfLoader.load('models/plastic-clip.glb', (gltf) => {
    const clip = gltf.scene;
    // Converted to unlit, same reasoning as templeIsland's own conversion
    // above: an untouched glTF import carries PBR materials that read as
    // near-black with none of this scene's real-time lights on them.
    clip.traverse((o) => {
      if (!o.isMesh) return;
      const src = o.material;
      o.material = new THREE.MeshBasicMaterial({
        map: src.map ?? null,
        color: src.color ? src.color.clone() : undefined,
        vertexColors: src.vertexColors,
        side: src.side,
      });
    });
    plasticClipTemplate = clip;
  });

  // Card height is fixed and shared by every power-up ("they will all be the
  // same size" — POWERUP_TUNE.card.scale below). Unlike a one-image
  // power-up, though, the jetpack's own art is four differently-cropped
  // animation frames rather than one clean render (see ENGINE_FRAMES below)
  // — so width/height per frame come from that frame's own natural pixel
  // size, not one shared aspect ratio.

  // The jetpack's animation frames, and the per-frame correction found for
  // each one in engine-flame-tuner.html (2026-09-12) — that standalone tool
  // exists because Engine1–4.png were each cropped to a different canvas
  // size, so playing them back as-is made the cardboard card jump around
  // under a fixed flame. `x`/`y`/`scale` are in that tool's own working
  // pixel space (every frame normalised to a 480px-tall stage —
  // ENGINE_FRAME_TUNER_H below must match that tool's GHOST_H);
  // applyPowerUpTune converts them into this game's world units, scaled by
  // the card's OWN current size, so the correction stays correct even if
  // POWERUP_TUNE.card.scale is retuned later. `w`/`h` are each frame's raw
  // pixel dimensions (Engine1.png is 202x313, etc.) — needed here because
  // there's no <img> to read naturalWidth/Height off, the way the tuner has.
  //
  // Only frame 1 is used for now — Luke, 2026-09-12: "Engine1 can be the
  // default image for when the engine isn't activated" — frames 2-4 are the
  // firing animation, to be wired in once there's an actual trigger to play
  // them on. Engine5/Engine6 are dropped entirely: "1-4 will be enough."
  const ENGINE_FRAME_TUNER_H = 480;
  const ENGINE_FRAMES = [
    { tex: 'engine1', w: 202, h: 313, x: 2, y: -16, scale: 1.6409 },
    { tex: 'engine2', w: 208, h: 343, x: 0, y: 4, scale: 1.6513 },
    { tex: 'engine3', w: 214, h: 354, x: -3, y: 8, scale: 1.6407 },
    { tex: 'engine4', w: 201, h: 346, x: -1, y: 0, scale: 1.6647 },
  ];

  // The abduction trigger's own card — one static frame, no firing
  // animation. `scale` picked (not tuner-measured, since there's no
  // ?powerupTune=1 pass for this one yet) so its rendered HEIGHT matches
  // ENGINE_FRAMES[0]'s (313 * 1.6409 = 513.6, before worldPerTunerPx) —
  // Luke: "attach this as close as you possibly can to the way the jetpack
  // is attached," which this reads as "the same size on the card," not
  // literally the same pixel scale (the source art's own resolution
  // differs). x/y left at 0 (centred) — nothing to correct for yet, unlike
  // the jetpack frames' small per-frame nudges.
  const ABDUCT_DEVICE_FRAMES = [{ tex: 'abductDevice', w: 598, h: 841, x: 0, y: 0, scale: 0.611 }];

  // Which frame table equipPowerUp draws from for a given `kind` — see its
  // own header for why every power-up otherwise shares identical
  // clip/position/size handling.
  const POWERUP_FRAMES = { jetpack: ENGINE_FRAMES, abduction: ABDUCT_DEVICE_FRAMES };

  /** One frame's rendered world size, same maths applyPowerUpTune uses for the card mesh — factored out so buildPickup (the island-2 item) can match it exactly (see PICKUP_SCALE). */
  function frameWorldSize(frame) {
    const worldPerTunerPx = POWERUP_TUNE.card.scale / ENGINE_FRAME_TUNER_H;
    return { w: frame.w * frame.scale * worldPerTunerPx, h: frame.h * frame.scale * worldPerTunerPx };
  }

  // Position/scale, all in the rig group's own local space — the same space
  // the player's own frontMesh lives in (x/y/z around its centre, z=0 being
  // the card's own flat plane, matching the frontMesh's own depth). Baked in
  // from Luke's tuning pass, 2026-09-12 — see the panel behind
  // `?powerupTune=1` if these need revisiting.
  //
  // The clip's rotation is fixed rather than a slider — Luke only asked for
  // position (x/y/z) and size on both the card and the clip this time. 90
  // degrees around Y is what points the clip's long axis sideways to bridge
  // the gap between the two cards (checked against its measured world
  // bounding box when this was first built, not guessed).
  const CLIP_ROTATION_DEG = { x: 0, y: 90, z: 0 };
  const POWERUP_TUNE = {
    card: { x: -0.64, y: 0, z: 0, scale: 0.7 },
    clip: { x: -0.4, y: 0, z: 0.14, scale: 0.5 },
  };

  /**
   * Attaches one power-up (a card + the shared clip) to `rig`, as children
   * of a group parented directly under `rig.group` — so they move with the
   * rig for free every frame, unlike the screen-projected name tags, which
   * need their own per-frame projection because they're NOT real scene
   * children of anything. `rig.powerup` guards against equipping a second
   * one on top of the first; there's no stacking/replacing behaviour
   * designed yet (Luke: "don't worry about how they earn it for now").
   *
   * `kind` ('jetpack' | 'abduction') picks which POWERUP_FRAMES table
   * applyPowerUpTune draws from — everything else (the clip, the card's
   * position/size formula) is identical regardless of which item it is.
   */
  function equipPowerUp(rig, kind = 'jetpack') {
    if (rig.powerup || !plasticClipTemplate) return;
    const group = new THREE.Group();

    // Unit geometry, sized via mesh.scale — same pattern as the word signs
    // and the temple doors, so applyPowerUpTune can resize live without
    // rebuilding geometry. No map yet — applyPowerUpTune sets it from
    // whichever POWERUP_FRAMES[kind] entry is active.
    const cardMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.45, side: THREE.DoubleSide })
    );
    group.add(cardMesh);

    // A clone, not the template itself — the template is the one loaded
    // instance every equip reuses; cloning is what lets a future multi-
    // player build equip several without them fighting over one Object3D's
    // transform. clone() shares geometry/material by reference (see
    // disposeRig, which is careful never to dispose those).
    const clip = plasticClipTemplate.clone();
    clip.rotation.set(
      THREE.MathUtils.degToRad(CLIP_ROTATION_DEG.x),
      THREE.MathUtils.degToRad(CLIP_ROTATION_DEG.y),
      THREE.MathUtils.degToRad(CLIP_ROTATION_DEG.z)
    );
    group.add(clip);

    rig.group.add(group);
    rig.powerup = { group, cardMesh, clip, frameIndex: 0, kind };
    applyPowerUpTune(rig);
  }

  /**
   * Fully removes a rig's power-up — geometry/material disposal, whichever
   * parent it's currently under (normally `rig.group`, or `scene` directly
   * once mid-rescue detach has re-parented it — see updateRescue's own
   * `scene.attach` call). Safe to call on a rig with no power-up. Factored
   * out once a fourth call site (a teammate's power-up disappearing
   * remotely — see updateTeammate) would otherwise have repeated the same
   * four lines a fourth time.
   */
  function disposePowerUp(rig) {
    if (!rig.powerup) return;
    rig.powerup.group.removeFromParent();
    rig.powerup.cardMesh.geometry.dispose();
    rig.powerup.cardMesh.material.dispose();
    disposeEngineSmoke(rig.powerup);
    rig.powerup = null;
  }

  function applyPowerUpTune(rig) {
    if (!rig.powerup) return;
    const { cardMesh, clip, frameIndex, kind } = rig.powerup;
    const frame = POWERUP_FRAMES[kind][frameIndex] ?? POWERUP_FRAMES[kind][0];
    cardMesh.material.map = TEX[frame.tex];
    cardMesh.material.needsUpdate = true;

    // worldPerTunerPx converts a frame's tuner-space x/y/scale into this
    // scene's world units — see ENGINE_FRAMES' own comment (frameWorldSize
    // is the same w/h half of this maths, reused by buildPickup).
    const worldPerTunerPx = POWERUP_TUNE.card.scale / ENGINE_FRAME_TUNER_H;
    const { w, h } = frameWorldSize(frame);
    cardMesh.scale.set(w, h, 1);
    cardMesh.position.set(
      POWERUP_TUNE.card.x + frame.x * worldPerTunerPx,
      POWERUP_TUNE.card.y - frame.y * worldPerTunerPx, // tuner Y is CSS (down-positive); world Y is up-positive
      POWERUP_TUNE.card.z
    );

    clip.position.set(POWERUP_TUNE.clip.x, POWERUP_TUNE.clip.y, POWERUP_TUNE.clip.z);
    clip.scale.setScalar(POWERUP_TUNE.clip.scale);
  }

  // The jetpack firing animation: loops ENGINE_FRAMES[1..3] (Engine2-4 —
  // index 0/Engine1 is the idle default, never part of the loop) for as
  // long as `rig.powerup.flame` is set. No real trigger for this exists yet
  // ("don't worry about how they earn it for now" applies here too) — for
  // now it's wired to the `?powerupTune=1` panel's test button, since
  // there's already a real button for equipping the jetpack itself and this
  // one no longer needs to (Luke, 2026-09-12).
  const ENGINE_FLAME_FRAME_DURATION = 0.12; // seconds per frame (~8fps)
  const ENGINE_FLAME_LOOP = [1, 2, 3]; // ENGINE_FRAMES indices — Engine2, Engine3, Engine4

  function startEngineFlame(rig) {
    if (!rig.powerup) return;
    rig.powerup.flame = { t: 0 };
    if (!rig.powerup.smoke) {
      rig.powerup.smoke = makeEngineSmoke(rig);
      // Stagger every puff to a random point in its own lifecycle up front,
      // so the very first frame already reads as an established trail
      // instead of one puff appearing at a time.
      for (const p of rig.powerup.smoke.puffs) {
        respawnSmokePuff(rig, p);
        p.life = Math.random() * p.maxLife;
      }
    }
  }

  function stopEngineFlame(rig) {
    if (!rig.powerup) return;
    rig.powerup.flame = null;
    rig.powerup.frameIndex = 0; // back to Engine1, the idle default
    applyPowerUpTune(rig);
  }

  function updateEngineFlame(rig, dt) {
    if (!rig.powerup?.flame) return;
    rig.powerup.flame.t += dt;
    const step = Math.floor(rig.powerup.flame.t / ENGINE_FLAME_FRAME_DURATION) % ENGINE_FLAME_LOOP.length;
    const nextIndex = ENGINE_FLAME_LOOP[step];
    if (rig.powerup.frameIndex !== nextIndex) {
      rig.powerup.frameIndex = nextIndex;
      applyPowerUpTune(rig);
    }
  }

  // ---------------------------------------------------------------- engine smoke
  //
  // Luke, 2026-09-07: "add a slight smoke effect. When the engine turns on, I
  // want to see generated smoke coming out the bottom. This can actually be
  // quite similar to the fog effect that is already in the game, but a lot
  // smaller, moving in a 'downward' direction relative to the engine, and
  // darker, with flecks of black."
  //
  // Reuses the fog curtains' own soft round puff sprite (TEX.fogPuff) rather
  // than a new texture — just far fewer of them, much smaller, tinted dark,
  // and travelling straight down instead of drifting outward. "Relative to
  // the engine" falls out for free from the scene graph: each puff is
  // parented under rig.powerup.group, which rides the same quaternion as the
  // card itself (and, once detached mid-rescue, whatever fixed orientation it
  // had at that instant) — so local -Y always means "down" as drawn on the
  // card, through every twist the rescue's flight puts the player through.
  // Luke, 2026-09-07, second pass: "make the smoke more diffuse, over a
  // larger downward area, say 70% more, and move more slowly. And a little
  // less black." Size and spread are literally *1.7; the downward area a
  // puff covers (speed * life) is also *1.7, split between a slower speed
  // and a longer life rather than either alone, so it reads as "drifting",
  // not "fired further" — and the puff count is bumped up a little so that
  // bigger area doesn't come out looking sparse.
  const SMOKE_PUFF_COUNT = 14;
  const SMOKE_PUFF_SIZE = [0.238, 0.51]; // was [0.14, 0.3]
  const SMOKE_LIFE = [0.85, 1.5]; // was [0.5, 0.9] — seconds from spawn to fully faded
  const SMOKE_SPEED = [0.3, 0.55]; // was [0.5, 0.9] — local units/sec straight down
  const SMOKE_SPREAD = 0.085; // was 0.05 — sideways/depth jitter, so it isn't one thin string
  const SMOKE_GROWTH = 2.2; // size multiplier reached by the time a puff fades out
  const SMOKE_ALPHA = 0.35; // was 0.55 — Luke, third pass: "more cloud-like: less dense"
  // Shared unit geometry, same trick as the card mesh's own (see
  // makeCharacterRig/equipPowerUp) — every puff scales it individually via
  // mesh.scale, so this one geometry is never disposed per-rig, only the
  // puffs' own materials are (see disposeRig/resolveRescue/restart).
  const smokePuffGeometry = new THREE.PlaneGeometry(1, 1);

  function makeEngineSmoke(rig) {
    const puffs = [];
    for (let i = 0; i < SMOKE_PUFF_COUNT; i++) {
      // A small minority near-black — Luke: "only a little black" — the rest
      // a light, cloud-like grey-white, so the cluster reads as smoke/cloud
      // rather than soot. Was 0.2 near-black at 0.06-0.12, grey at 0.2-0.32.
      const dark = Math.random() < 0.08;
      const shade = dark ? 0.05 + Math.random() * 0.06 : 0.62 + Math.random() * 0.22;
      const mesh = new THREE.Mesh(
        smokePuffGeometry,
        new THREE.MeshBasicMaterial({
          map: TEX.fogPuff,
          color: new THREE.Color(shade, shade, shade),
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          opacity: 0,
          fog: false,
        })
      );
      mesh.visible = false;
      mesh.renderOrder = 11; // after the card/clip/flame
      rig.powerup.group.add(mesh);
      puffs.push({ mesh, life: 0, maxLife: 1, size: 0, speed: 0, jx: 0, jz: 0, originX: 0, originY: 0, originZ: 0 });
    }
    return { puffs };
  }

  function respawnSmokePuff(rig, p) {
    const { cardMesh } = rig.powerup;
    p.life = 0;
    p.maxLife = SMOKE_LIFE[0] + Math.random() * (SMOKE_LIFE[1] - SMOKE_LIFE[0]);
    p.size = SMOKE_PUFF_SIZE[0] + Math.random() * (SMOKE_PUFF_SIZE[1] - SMOKE_PUFF_SIZE[0]);
    p.speed = SMOKE_SPEED[0] + Math.random() * (SMOKE_SPEED[1] - SMOKE_SPEED[0]);
    p.jx = (Math.random() * 2 - 1) * SMOKE_SPREAD;
    p.jz = (Math.random() * 2 - 1) * SMOKE_SPREAD;
    // Bottom-centre of whatever engine frame is currently showing, read live
    // off the card mesh rather than baked in — a future retune of
    // POWERUP_TUNE/ENGINE_FRAMES can't quietly leave this spawning from the
    // wrong spot.
    p.originX = cardMesh.position.x;
    p.originY = cardMesh.position.y - cardMesh.scale.y / 2;
    p.originZ = cardMesh.position.z;
  }

  function updateEngineSmoke(rig, dt) {
    if (!rig.powerup?.smoke) return;
    const firing = !!rig.powerup.flame;
    for (const p of rig.powerup.smoke.puffs) {
      if (!firing) {
        p.mesh.visible = false;
        continue;
      }
      p.life += dt;
      if (p.life >= p.maxLife) respawnSmokePuff(rig, p);
      const u = p.life / p.maxLife;
      p.mesh.visible = true;
      p.mesh.position.set(p.originX + p.jx * u, p.originY - p.speed * p.life, p.originZ + p.jz * u);
      const scale = p.size * (1 + (SMOKE_GROWTH - 1) * u);
      p.mesh.scale.set(scale, scale, 1);
      // Fades in over the first fifth of its life, then out for the rest —
      // avoids a hard pop-in right at the exhaust.
      p.mesh.material.opacity = SMOKE_ALPHA * Math.min(1, u * 5) * (1 - u);
    }
  }

  /** Disposes only the smoke puffs' own per-puff materials — smokePuffGeometry
   * is shared across every rig's smoke and never disposed (see its own
   * comment). Safe to call whether or not the engine ever actually fired. */
  function disposeEngineSmoke(powerup) {
    if (!powerup?.smoke) return;
    for (const p of powerup.smoke.puffs) p.mesh.material.dispose();
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
   * Rewritten 2026-08-31 as a screen-space DOM overlay, then reverted back
   * to a mesh 2026-09-13 — Luke: "the names should be affixed to the
   * character card, so that they have the same facing and move with the
   * character at all times... the name tags have been applied in a
   * different way, and shift relative to the camera, turning to face it.
   * This should not happen." Right: a screen-space tag is by definition
   * always flat-on to the viewer, which reads exactly as "always turning to
   * face the camera" the moment the camera moves around at all. Checked git
   * history for the original mesh version this superseded — it was never
   * actually a shipped, working state (both the mesh attempt and the DOM
   * rewrite happened within developing this same original feature) — so
   * this isn't a revert to old committed code, it's a fresh build, but one
   * that now avoids the exact bug that sank the first attempt: see the
   * `localY` comment in attachNameTag below.
   *
   * A mesh parented directly under `targetRig.group` needs no per-frame
   * screen-projection at all — it inherits the rig's own position AND
   * rotation for free, which is exactly "moves and faces the same as the
   * character" — and this game already has a working precedent for a
   * non-billboarded text plane behaving correctly on screen: word signs
   * (makeWordSignMesh), which never billboard either and read fine because
   * the camera only ever views the scene from a consistent relative angle
   * (trailing the avatar, never free-look). The local player's own rig
   * never rotates in world space at all (the CAMERA orbits to stay behind
   * it, not the other way around — see tick()'s camera block), so its own
   * tag will always face correctly; a teammate's rig does rotate to face
   * its heading, and its tag rotates with it, which is the desired "you're
   * looking at a real object, not a HUD sticker" read a spectator gets too.
   *
   * `moving`/`alwaysVisible` visibility (Luke, 2026-08-31: hide while the
   * card is moving, show once it's standing still) is unaffected by any of
   * this — still a plain per-tag flag, just `mesh.visible` instead of a DOM
   * `display` toggle.
   */
  const nameTags = []; // { rig, mesh, alwaysVisible }

  // Temporary, 2026-09-14 — diagnosing "player 4's name shows above when it
  // should be below" (Luke: happening in PLAYERS' own views, sometimes even
  // on the first island, not tied to any particular fork transition — ruling
  // out both the seatOffsets table itself, which every console check so far
  // has shown is correctly computed, and any island/fork-transition-timing
  // theory). Records every point this device actually touches a tag's
  // above/below placement — a fresh attach (which always defaults to
  // 'above', corrected a moment later — see attachNameTag/setNameTagSide's
  // own comments) and every time setNameTagSide finds the mesh's current Y
  // doesn't match what it should be and changes it — plus tab visibility
  // changes, since backgrounded/throttled tabs (Luke: testing via many tabs
  // in one browser) are one live suspect. A no-op setNameTagSide call
  // (already correct) is NOT logged — only actual attaches and actual
  // corrections — so this stays small enough to read after the fact rather
  // than needing to be caught live. Dump with window.__tagDebugLog(). Delete
  // this whole block once the real bug is found.
  const tagDebugLog = [];
  function logTagEvent(event, extra) {
    tagDebugLog.push({ t: Date.now(), event, hidden: document.hidden, ...extra });
    if (tagDebugLog.length > 500) tagDebugLog.shift();
  }
  function tagOwnerLabel(targetRig) {
    if (targetRig === rig) return `me:${localDisplayName ?? '?'}`;
    for (const [tok, e] of teammates) {
      if (e.rig === targetRig) return `${e.displayName ?? '?'}:${tok}`;
    }
    return 'unknown-rig';
  }
  const onTagDebugVisibility = () => logTagEvent('visibilitychange', {});
  document.addEventListener('visibilitychange', onTagDebugVisibility);

  // Run every frame regardless of state (see tick()) — visibility itself is
  // state-dependent, so the check has to happen every frame, not just while
  // walking. `moving` covers falling and being abducted too: a tag riding a
  // card up into a flying saucer is exactly as nonsensical as a mid-walk one.
  function updateNameTags() {
    const moving = !!leg || falling || !!abduction || !!templeEntry || !!rescue;
    for (const t of nameTags) {
      // `moving` only ever reflects the LOCAL player's own state, so it says
      // nothing about a teammate's rig — added 2026-09-12 alongside the
      // teammate departure animation, which hides a rig directly
      // (rig.group.visible = false) once it reaches the fog. Without this
      // check the tag would keep rendering, attached to an invisible rig,
      // uselessly, since nothing else here ever notices the card underneath
      // it is gone.
      t.mesh.visible = (!moving || t.alwaysVisible) && t.rig.group.visible;
    }
  }

  function removeNameTag(targetRig) {
    if (!targetRig.nameTag) return;
    const idx = nameTags.indexOf(targetRig.nameTag);
    if (idx !== -1) nameTags.splice(idx, 1);
    const { mesh } = targetRig.nameTag;
    targetRig.group.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.map?.dispose();
    mesh.material.dispose();
    targetRig.nameTag = null;
  }

  /**
   * Builds the name-tag canvas (async — it loads the letter/background art
   * on demand) and attaches a mesh tag to the given rig once ready.
   * Fire-and-forget from the Start button: by the time it resolves the
   * player is already walking, and the tag just appears a beat later
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
    // `side` places the tag above the head or down near the feet.
    // `isCurrent` replaces the old hardcoded `rig === targetRig` guard
    // (which assumed the *only* rig in play was the player's own,
    // swappable one — not true once static companion rigs that never
    // change exist alongside it). `alwaysVisible` skips the
    // hide-while-moving rule entirely — unused today (every tag currently
    // follows the same rule, per Luke, 2026-08-31) but cheap to leave
    // wired in for whenever the player's own tag, say, needs to differ.
    // `yStagger` mirrors setNameTagSide's own param — the "below" seats'
    // small extra downward nudge (see ISLAND_TAG_STAGGER_Y) — so a caller
    // that already knows its final seat can bake the whole placement in up
    // front, rather than relying on a follow-up setNameTagSide call that
    // would race this function's own async canvas build (see the bug this
    // fixed, at this function's real-player call site).
    const { side = 'above', yStagger = 0, isCurrent = () => rig === targetRig, alwaysVisible = false } = opts;
    logTagEvent('attach-queued', { who: tagOwnerLabel(targetRig), name, side }); // see tagDebugLog's own comment
    const glowColor = `#${glowColorHex.toString(16).padStart(6, '0')}`;
    buildNameTagCanvas(name, { glowColor })
      .then(({ canvas, aspect }) => {
        logTagEvent('attach-resolved', { who: tagOwnerLabel(targetRig), name, side, aborted: disposed || !isCurrent() });
        if (disposed || !isCurrent()) return;
        removeNameTag(targetRig); // drop any previous tag for this rig first — avoids a leaked duplicate on re-attach
        // aspect is height/width (see buildNameTagCanvas) — height is fixed
        // (NAME_TAG_HEIGHT above), so width is derived from it, same
        // direction as setWordSign's own w = h / aspect and for the same
        // reason: fixing width instead let a short name's height balloon.
        const tagH = NAME_TAG_HEIGHT;
        const tagW = tagH / aspect;
        const localY = tagLocalY(side, tagH); // see tagLocalY's own comment for why "below" isn't a plain sign-flip of "above"
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        const mesh = new THREE.Mesh(
          new THREE.PlaneGeometry(1, 1),
          new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, fog: false })
        );
        mesh.renderOrder = 10; // same as word signs — draws above the fog puffs
        mesh.scale.set(tagW, tagH, 1);
        mesh.position.set(0, localY + yStagger, tagLocalZ(side));
        targetRig.group.add(mesh);
        const entry = { rig: targetRig, mesh, alwaysVisible };
        targetRig.nameTag = entry;
        nameTags.push(entry);
      })
      .catch((err) => console.error('[nameTag] failed to build', err));
  }
  setCharacter(ROSTER[0].key);

  // ---------------------------------------------------------------- teammates
  //
  // Luke, 2026-09-12: "players should also see other players from their
  // team on the same island when they are both there" — and separately,
  // the guide needs to see everyone waiting at a fork rather than just a
  // HUD. Each teammate is a REAL avatar (their own chosen character/colour,
  // reusing makeCharacterRig/attachNameTag exactly as the local player's
  // own rig does — not a placeholder marker), kept here in a map keyed by
  // network token.
  //
  // A teammate's own device decides WHEN to report a change — it calls
  // notifyPlayerState() on departure and arrival, not continuously — and
  // the host (GameRoom.jsx) relays that one small event to everyone else's
  // updateTeammate(), which is what actually moves the rig here. This
  // mirrors the "let the relay be the arbiter" pattern fork-choice
  // arbitration already uses: cheap on the network, and every device ends
  // up drawing from the same source of truth instead of guessing at
  // someone else's position.
  //
  // Four phases, every one an EXPLICIT report from the moving device — no
  // viewer ever infers anything from timing or silence (see below for why):
  //   'resting'   — standing at sections[forkIndex - 1].fork, at its own
  //                 fixed seat. Sent on arrival (a walk completing, or a
  //                 jetpack rescue landing) and after character select.
  //   'departing' — a fork has been chosen. Nothing visibly happens on
  //                 anyone else's screen for this alone: the rig simply
  //                 stays where it is until real positions arrive. Luke,
  //                 2026-09-13: "once they choose the path, they don't
  //                 move. They only move once they press the forward arrow."
  //   'moving'    — a throttled ping (MOVING_PING_INTERVAL) carrying the
  //                 sender's REAL current transform — `{x, z, heading}`
  //                 while walking, `{x, y, z, quat}` while falling, being
  //                 jetpack-rescued, or being abducted — sent for as long
  //                 as any of those is actually happening on that device.
  //                 Every viewer, whatever its role, just smooths its copy
  //                 of the rig toward the latest one. If pings stop (a
  //                 released forward button, a hiccup), the rig stops —
  //                 Luke: "if they stop moving... everyone else will see
  //                 them stop."
  //   'gone'      — the sender's own fall or abduction has fully played
  //                 out and its figure is hidden; hide this copy too.
  //
  // History, kept because the reasoning still matters: this used to be
  // built the other way round. A PLAYER viewer got a fixed "walk straight
  // forward into the fog and vanish" stand-in on 'departing' (to hide which
  // side a teammate chose — moot since 2026-09-13's per-player randomised
  // sides, see buildFork), and even a spectator's real tracking still
  // INFERRED a fall from pings going silent for LIVE_POS_STALE_MS, playing
  // a synthetic sink-and-tip. Both were sources of "they fell the instant
  // they chose, before moving at all" on other people's screens — the
  // stand-in by design (it started on 'departing'), the inference by
  // accident (silence right after choosing, before the player has pressed
  // forward, is indistinguishable from silence because they fell). Luke,
  // 2026-09-13, after a full session of this: "all character movements
  // (successfully crossing the bridge, falling, using the jetpack, being
  // abducted by aliens) should be in theory viewable by other players...
  // No one will see them fall until and unless they walk all the way to
  // the mid-point of the bridge, which triggers the fall." So: one code
  // path for every viewer, driven purely by what the sender explicitly
  // reports, and nothing synthetic left that could show an event that
  // hasn't happened. The fog curtains themselves still exist as scenery
  // (hidden for now — see FOG_CURTAINS_VISIBLE) and, when shown, occlude
  // this real movement naturally, as real meshes do.
  const teammates = new Map(); // token -> { rig, characterKey, forkIndex, displayName, colorHex, phase, livePos, pingCount, lastPingAt, seatOffsetX, seatTagSide, seatTagYStagger }

  function teammateWorldPos(forkIdx) {
    const sec = sections[forkIdx - 1];
    return sec ? sec.fork : { x: 0, z: 0, heading: 0 };
  }

  /** Snaps a resting teammate straight to ITS fixed seat (see seatOffsets), not the island's bare centre — used the moment a 'resting' report arrives, and after buildJourney() rebuilds `sections`, so a teammate is never seen at centre even for one frame before relayoutAllIslands next runs. */
  function positionTeammateRig(entry) {
    const p = teammateWorldPos(entry.forkIndex);
    const lateral = forward((p.heading ?? 0) + Math.PI / 2, entry.seatOffsetX ?? 0);
    entry.rig.group.position.set(p.x + lateral.x, FIGURE_H / 2, p.z + lateral.z);
    entry.rig.group.rotation.set(0, p.heading ?? 0, 0);
  }

  /** Re-anchors every RESTING teammate after buildJourney() rebuilds `sections` — see the call at the end of buildJourney(). A mid-departure teammate is left alone; updateTeammates() below re-derives its position from `sections` fresh every frame anyway. */
  function repositionAllTeammates() {
    for (const entry of teammates.values()) {
      if (entry.phase === 'resting') positionTeammateRig(entry);
    }
  }

  function ensureTeammateEntry(token, tCharacterKey, tName, colorHex) {
    let entry = teammates.get(token);
    if (!entry || entry.characterKey !== tCharacterKey) {
      if (entry) {
        disposeRig(entry.rig);
        entry.abduction?.dispose(); // a swapped/replaced rig mid-abduction — rare, but don't leak the saucer
        entry.waitGlow?.dispose();
      }
      const seat = seatOffsets.get(token) ?? { offsetX: 0, tagSide: 'above', tagYStagger: 0 };
      entry = {
        rig: makeCharacterRig(tCharacterKey ?? ROSTER[0].key),
        characterKey: tCharacterKey ?? ROSTER[0].key,
        forkIndex: 1,
        displayName: tName ?? null,
        colorHex: colorHex ?? PALETTE[0].hex,
        phase: 'resting',
        livePos: null,
        pingCount: 0, // diagnostics only — see the HUD line in tick()
        lastPingAt: 0,
        departStartedAt: 0, // set once this teammate's own engine detaches — see updateTeammate/updateTeammates
        departBaseY: 0,
        abduction: null, // a locally-built saucer instance while this teammate is being abducted — see updateTeammate's 'departing' handling
        fallCamAnchor: null, // set lazily by updateWatchingCamera the first time this teammate is seen falling/being rescued — see its own comment
        // Fixed for the whole round — see the "island layout" section's
        // `seatOffsets` above; a token not in `roster` (shouldn't happen for
        // a real player, but keeps a stray/late report harmless) just sits
        // at centre rather than throwing.
        seatOffsetX: seat.offsetX,
        seatTagSide: seat.tagSide,
        seatTagYStagger: seat.tagYStagger,
      };
      teammates.set(token, entry);
      if (entry.displayName) {
        attachNameTag(entry.rig, entry.displayName, entry.colorHex, { isCurrent: () => teammates.get(token)?.rig === entry.rig });
      }
    } else if (tName && tName !== entry.displayName) {
      entry.displayName = tName;
      entry.colorHex = colorHex ?? entry.colorHex;
      attachNameTag(entry.rig, entry.displayName, entry.colorHex, { isCurrent: () => teammates.get(token)?.rig === entry.rig });
    }
    return entry;
  }

  function updateTeammate(
    token,
    { phase: tPhase, forkIndex: tForkIndex, characterKey: tCharacterKey, displayName: tName, colorHex, livePos, powerupKind: tPowerupKind, firing, detached, abducting, defending }
  ) {
    if (token == null || tForkIndex == null) return;
    const entry = ensureTeammateEntry(token, tCharacterKey, tName, colorHex);
    entry.pingCount++;
    entry.lastPingAt = Date.now();
    // The green light a targeted teammate stands under while they wait for,
    // then do, their abduction defence — see buildWaitingGlow's own header.
    // Lit in the 'resting' branch below (a defender is always stopped, and
    // that's where the rig gets positioned). A 'departing'+abducting report
    // hands it over to the real sequence instead (the 'departing' branch),
    // so it's only released here when the defence ended in a resist.
    if (!defending && entry.waitGlow && !(tPhase === 'departing' && abducting)) {
      entry.waitGlow.release();
      // They repelled the aliens. The guide fires this itself once its own
      // defence panel has lifted (see finishGuideDefence) — here it would
      // play unseen behind that panel.
      if (role !== 'guide') playRepelSequence(entry.rig.group.position);
    }
    // Mirrors this teammate's own held power-up (jetpack OR abduction
    // device — the same single slot, see equipPowerUp's own header) plus
    // its flame/detach state onto their rig — see notifyPlayerState's own
    // comment for why this rides every report rather than needing its own
    // event. equipPowerUp/disposePowerUp/startEngineFlame/stopEngineFlame
    // all already take an arbitrary `rig` (never assume it's the local
    // player's own), so a teammate's rig works exactly the same way the
    // local one does — no separate remote implementation needed.
    const tKind = tPowerupKind ?? null;
    if ((entry.rig.powerup?.kind ?? null) !== tKind) {
      if (tKind) {
        equipPowerUp(entry.rig, tKind);
        entry.departStartedAt = 0;
      } else if (!entry.departStartedAt) {
        // Not currently mid-depart-animation (see updateTeammates) — a
        // legitimate immediate removal, e.g. this device only learned about
        // a whole rescue after the fact and never saw a `detached` report
        // at all. If a depart animation IS already running, let it finish
        // and dispose itself instead of cutting it short.
        disposePowerUp(entry.rig);
      }
    }
    if (entry.rig.powerup) {
      if (firing && !entry.rig.powerup.flame) startEngineFlame(entry.rig);
      else if (!firing && entry.rig.powerup.flame) stopEngineFlame(entry.rig);
      // The engine detaches from the character and flies off on its own —
      // see updateRescue's own `scene.attach` for the local original. Timed
      // from whenever THIS device first learns about it (there's no real
      // transform stream for the departing engine itself, just this one
      // trigger), not from the sender's own clock — see updateTeammates for
      // the per-frame animation this kicks off.
      if (detached && !entry.departStartedAt) {
        entry.departStartedAt = Date.now();
        scene.attach(entry.rig.powerup.group);
        entry.departBaseY = entry.rig.powerup.group.position.y;
      }
    }
    if (tPhase === 'moving') {
      // Only applied while this entry is actually departing from the SAME
      // fork the ping claims: guards against a stale/out-of-order message
      // (this entry object is reused across the whole game as the same
      // token progresses) ever repositioning something it no longer
      // describes. Doesn't touch `phase` — purely the latest real transform
      // for updateTeammates() to smooth toward.
      if (entry.phase === 'departing' && entry.forkIndex === tForkIndex && livePos) {
        entry.livePos = livePos;
      }
      return;
    }
    if (tPhase === 'departing') {
      entry.phase = 'departing';
      entry.forkIndex = tForkIndex; // the fork being LEFT
      entry.livePos = null; // clear any stale ping from a PREVIOUS departure — the rig holds where it is until a real one arrives
      entry.fallCamAnchor = null; // this departure hasn't necessarily fallen yet — see updateWatchingCamera, which (re)computes it lazily the moment a quat'd livePos actually arrives
      entry.rig.group.visible = true;
      // Keyed by the fork being LEFT, not a single shared variable — see the
      // "guide camera" section's own comment on guideLastDepartedTokenByFork
      // for why a global "whoever departed most recently, anywhere" broke
      // with two real people actually playing at their own pace.
      guideLastDepartedTokenByFork.set(tForkIndex, token);
      // Luke, 2026-09-14: "being abducted by aliens" needs to be visible
      // too — see notifyPlayerState's own comment for why this builds a
      // fresh LOCAL saucer instance from just this trigger, rather than
      // streaming a transform for it. `entry.rig.group.position` is still
      // wherever this teammate was actually seated (an abduction only ever
      // starts from rest, never mid-walk — see startAbduction's own guard),
      // so it's already the correct anchor with nothing extra to send.
      if (abducting && !entry.abduction) {
        const glowPreLit = !!entry.waitGlow;
        entry.waitGlow?.dispose();
        entry.waitGlow = null;
        entry.abduction = buildAbduction({
          scene,
          textures: { ship: TEX.spaceship, beams: TEX.spaceshipBeams, string: TEX.string },
        });
        entry.abduction.start({
          at: { x: entry.rig.group.position.x, y: 0, z: entry.rig.group.position.z },
          targetCard: entry.rig.group,
          cardHeight: FIGURE_H,
          cardWidth: FIGURE_H * FIGURE_ASPECT,
          glowPreLit,
        });
      }
    } else if (tPhase === 'gone') {
      entry.phase = 'gone';
      entry.livePos = null;
      entry.fallCamAnchor = null;
      entry.rig.group.visible = false;
      entry.abduction?.dispose(); // defensive — the per-frame check in updateTeammates normally disposes it first, once its own local playback finishes
      entry.abduction = null;
      entry.waitGlow?.dispose();
      entry.waitGlow = null;
    } else {
      entry.phase = 'resting';
      entry.forkIndex = tForkIndex;
      entry.livePos = null;
      entry.fallCamAnchor = null;
      entry.rig.group.visible = true;
      entry.abduction?.dispose(); // defensive — shouldn't still exist by the time a 'resting' report arrives, but a new round's fresh 'resting' must never inherit a stray saucer
      entry.abduction = null;
      positionTeammateRig(entry); // also resets rotation outright, so a previous rescue's tilt can't linger
      if (defending && !entry.waitGlow) {
        const pos = entry.rig.group.position;
        entry.waitGlow = buildWaitingGlow({
          scene,
          at: { x: pos.x, y: 0, z: pos.z },
          card: entry.rig.group,
          cardHeight: FIGURE_H,
          cardWidth: FIGURE_H * FIGURE_ASPECT,
        });
      }
    }
  }

  // ---------------------------------------------------------------- island layout
  //
  // Fixed seating, 2026-09-13 — Luke, after several bugs traced back to
  // layout being computed relative to whoever was looking ("each player
  // starts their movement from the central position of the island... other
  // players get shunted to the side"): "each person will be assigned a
  // position, and that won't change through the round." `seatOffsets`
  // below is that assignment — a lateral offset AND a fixed tag side per
  // token, built ONCE from `roster` (see mountSkyPath's options) by array
  // index, laid out left-to-right across five fixed slots (see the comment
  // on `seatOffsets` itself for why it's five fixed slots rather than
  // computed outward-from-centre ranks). Because every device in the group
  // receives the identical `roster` array over the wire, every device
  // computes the identical table with no further messages — the "single
  // shared fact" a fixed layout needs. A seat never moves once assigned,
  // including this device's own — self is just another entry in the same
  // table now, not a permanently-reserved centre slot, which is what also
  // retires the old guide-only "empty centre" special case entirely.
  const ISLAND_SPACING_X = FIGURE_H * FIGURE_ASPECT * 1.5; // same spacing spawnTestCompanions used
  const ISLAND_TAG_STAGGER_Y = FIGURE_H * 0.15;
  // How far from an island's centre a seat's lateral walk tapers to/from
  // zero at the start/end of a leg (see currentSeatLateral()) — tied to
  // ISLAND_RADIUS, the same "how big is this deck" constant CURTAIN_DIST
  // already keys off, so the taper always finishes comfortably before the
  // branch/bridge geometry (built far longer than one island's radius).
  const SEAT_TAPER_DIST = ISLAND_RADIUS;

  const seatOffsets = new Map(); // token -> { offsetX, tagSide, tagYStagger }
  {
    // Five fixed on-screen slots, 2026-09-14 — Luke, after the previous
    // by-offsetX sort-then-alternate assignment broke again ("we are once
    // again getting two players with names above next to each other"):
    // "have five positions fixed, and the position of the name tag when in
    // that position also fixed. So from left to right, Position 1 will be
    // name above, 2 below, 3 above, 4 below, five above." Above/below is
    // now a property of the SLOT (index 0-4 below, centre = 2), not
    // something re-derived from sorting each round — nothing left to get
    // out of sync. `windowStart` picks the middle `roster.length` slots out
    // of the five so a smaller group still gets the full alternation
    // instead of always starting from the left (5 players -> slots 0-4;
    // 4 -> 0-3, i.e. "1-4"; 3 -> 1-3 ("2-4"); 2 -> 1-2 ("2-3")). Roster
    // order maps directly to slot order left-to-right — every device
    // builds this from the same shared `roster` array, so it agrees with
    // no further messages, same as before.
    const windowStart = Math.floor((5 - roster.length) / 2);
    roster.forEach((tok, i) => {
      const slot = windowStart + i;
      const offsetX = (slot - 2) * ISLAND_SPACING_X;
      const tagSide = slot % 2 === 0 ? 'above' : 'below';
      seatOffsets.set(tok, { offsetX, tagSide, tagYStagger: tagSide === 'below' ? -ISLAND_TAG_STAGGER_Y : 0 });
    });
  }
  const mySeat = seatOffsets.get(myToken) ?? { offsetX: 0, tagSide: 'above', tagYStagger: 0 };
  const mySeatOffsetX = mySeat.offsetX;

  /** Repositions an existing tag in place (above/below Y + stagger, and the below-side forward Z push) without rebuilding its canvas — attachNameTag does that async reload, which nothing here needs since the text/colour aren't changing. */
  function setNameTagSide(targetRig, side, yStagger = 0) {
    const tag = targetRig.nameTag;
    if (!tag) {
      logTagEvent('setSide-no-tag', { who: tagOwnerLabel(targetRig), side }); // see tagDebugLog's own comment
      return;
    }
    const newY = tagLocalY(side, tag.mesh.scale.y) + yStagger;
    if (Math.abs(tag.mesh.position.y - newY) > 1e-4) {
      logTagEvent('setSide-change', {
        who: tagOwnerLabel(targetRig),
        side,
        fromY: +tag.mesh.position.y.toFixed(3),
        toY: +newY.toFixed(3),
      });
    }
    tag.mesh.position.y = newY;
    tag.mesh.position.z = tagLocalZ(side);
  }

  /** Places every teammate currently RESTING at one fork at ITS OWN fixed seat offset (departing ones are mid-walk and untouched — see updateTeammates). This device's own figure is never touched here — see currentSeatLateral(), which places it the same way every frame regardless of resting/walking. */
  function repositionIslandOccupants(forkIdx) {
    const sec = sections[forkIdx - 1];
    if (!sec) return;
    for (const entry of teammates.values()) {
      if (entry.phase !== 'resting' || entry.forkIndex !== forkIdx) continue;
      const lateral = forward(sec.fork.heading + Math.PI / 2, entry.seatOffsetX);
      entry.rig.group.position.set(sec.fork.x + lateral.x, FIGURE_H / 2, sec.fork.z + lateral.z);
      entry.rig.group.rotation.set(0, sec.fork.heading, 0);
      setNameTagSide(entry.rig, entry.seatTagSide, entry.seatTagYStagger);
    }
  }

  /** Re-lays-out every island that currently has any TEAMMATE resting on it. Called every frame from updateTeammates(); cheap at this scale (a handful of teammates, at most six forks). Doesn't need to consider this device's own fork any more — see repositionIslandOccupants(). */
  function relayoutAllIslands() {
    const forksWithOccupants = new Set();
    for (const entry of teammates.values()) {
      if (entry.phase === 'resting') forksWithOccupants.add(entry.forkIndex);
    }
    for (const forkIdx of forksWithOccupants) repositionIslandOccupants(forkIdx);
  }

  /**
   * This device's own current lateral offset from the centreline every
   * branch/bridge is actually built around — the seat walk itself. Full
   * seat offset while resting (so a player idles at their own fixed slot,
   * not centre); while a leg is under way, tapers from the departure
   * fork's full offset down to zero over the first SEAT_TAPER_DIST of
   * travel ("towards the centre when leaving an island"), then — only if
   * the leg actually has a next island (`leg.arriveFork`) — back up to the
   * SAME fixed offset over the last SEAT_TAPER_DIST ("away from the centre
   * when leaving the bridge to find their position on the next island").
   * A leg with no `arriveFork` (a wrong choice, or the final approach to
   * the temple) only ever tapers OUT and stays at the centreline for the
   * rest of it — those endings are scripted, centreline-only sequences
   * (the fall, the temple doors), not a seat to arrive at.
   */
  function currentSeatLateral() {
    if (!mySeatOffsetX) return { x: 0, z: 0 };
    if (!leg) {
      const sec = sections[forkIndex - 1];
      return sec ? forward(sec.fork.heading + Math.PI / 2, mySeatOffsetX) : { x: 0, z: 0 };
    }
    const taper = Math.min(SEAT_TAPER_DIST, leg.total / 2 || 0);
    if (taper <= 0) return { x: 0, z: 0 };
    let out = { x: 0, z: 0 };
    if (leg.traveled < taper) {
      const factor = 1 - leg.traveled / taper;
      const v = forward(leg.fromHeading + Math.PI / 2, mySeatOffsetX * factor);
      out = { x: out.x + v.x, z: out.z + v.z };
    }
    const remain = leg.total - leg.traveled;
    if (leg.arriveFork && remain < taper) {
      const factor = 1 - remain / taper;
      const v = forward(leg.toHeading + Math.PI / 2, mySeatOffsetX * factor);
      out = { x: out.x + v.x, z: out.z + v.z };
    }
    return out;
  }

  // Per-second smoothing rate for lerping a tracked teammate toward its
  // latest live report, rather than snapping straight to it — Luke,
  // 2026-09-13, explicitly fine with "a minor displacement" for a smoother
  // read; frame-rate independent via `Math.min(1, LIVE_POS_SMOOTH * dt)`.
  const LIVE_POS_SMOOTH = 10;

  /**
   * Smooths every currently-departing teammate toward the latest real
   * transform its own device reported — see the phase model in this
   * section's header. One code path for every viewer role: a player, the
   * guide and a fallen player's Watch mode all see exactly the same thing.
   * No timers, no inference: if no 'moving' ping has arrived yet for this
   * departure the rig simply stays put, and if pings stop it stops where
   * the last one left it — until an explicit 'resting' or 'gone' report
   * says otherwise (see updateTeammate). Called from tick() with its `dt`.
   */
  function updateTeammates(dt) {
    relayoutAllIslands();
    for (const entry of teammates.values()) {
      // Own frame-cycling animation, not networked frame-by-frame — same as
      // the local player's own engine (see tick()'s unconditional
      // updateEngineFlame/updateEngineSmoke calls). Both are no-ops on a rig
      // with no power-up or no active flame, so this is cheap to call for
      // every teammate regardless of phase.
      updateEngineFlame(entry.rig, dt);
      updateEngineSmoke(entry.rig, dt);

      // This teammate is waiting on / in an abduction defence — see
      // updateTeammate's `defending` handling.
      if (entry.waitGlow && !entry.waitGlow.update(dt)) {
        entry.waitGlow.dispose();
        entry.waitGlow = null;
      }

      // The detached engine flying off on its own — see updateTeammate's
      // own `detached` handling for how this starts. Runs regardless of
      // `entry.phase`: the sender's own phase can already have flipped to
      // 'resting' (the rescue's whole sequence finishing) before this
      // device's own copy of the fixed-duration depart animation is done,
      // since it's timed from whenever THIS device first saw `detached`,
      // not from the sender's clock. Disposes itself once finished, same
      // moment the local original's engine would have flown off screen.
      if (entry.departStartedAt) {
        const elapsed = (Date.now() - entry.departStartedAt) / 1000;
        if (entry.rig.powerup) {
          const ud = smoothstep(0, RESCUE_TUNE.departDuration, elapsed);
          entry.rig.powerup.group.position.y = entry.departBaseY + ud * ud * RESCUE_TUNE.departDistance;
        }
        if (elapsed >= RESCUE_TUNE.departDuration) {
          disposePowerUp(entry.rig);
          entry.departStartedAt = 0;
        }
      }

      // A locally-built saucer replica owns this teammate's whole transform
      // for as long as it's playing — see updateTeammate's 'departing'
      // handling for why this is a local replay rather than a streamed
      // transform. `facePoint` uses THIS device's own camera, same as the
      // local original does for whoever's actually watching it.
      if (entry.abduction) {
        entry.abduction.update(dt);
        entry.abduction.facePoint(camera.position);
        if (!entry.abduction.state.playing) {
          entry.abduction.dispose();
          entry.abduction = null;
        }
        continue; // apply() already set this rig's position/rotation directly — nothing left to lerp toward
      }

      if (entry.phase !== 'departing' || !entry.rig.group.visible || !entry.livePos) continue;
      const k = Math.min(1, LIVE_POS_SMOOTH * dt);
      if (entry.livePos.quat) {
        // A fall, jetpack rescue or abduction — full position and rotation.
        entry.rig.group.position.lerp(new THREE.Vector3(entry.livePos.x, entry.livePos.y, entry.livePos.z), k);
        entry.rig.group.quaternion.slerp(new THREE.Quaternion(...entry.livePos.quat), k);
      } else {
        // An ordinary walk — on its feet, facing its heading.
        entry.rig.group.position.lerp(new THREE.Vector3(entry.livePos.x, FIGURE_H / 2, entry.livePos.z), k);
        entry.rig.group.rotation.set(0, entry.livePos.heading ?? entry.rig.group.rotation.y, 0);
      }
    }
  }

  // ---------------------------------------------------------------- guide camera
  //
  // Luke, 2026-09-12: the guide has no avatar of its own (see figure.visible
  // in setCharacter above) — instead its camera parks at the current fork,
  // watching every teammate's rig standing there, and does not move until
  // the LAST player still resting there has departed. It then follows
  // whoever that was — reusing the exact same generic walk-to-the-fog
  // animation updateTeammates() is already driving for everyone else (see
  // that section's own design note for why the guide seeing the REAL
  // branch/outcome is a deliberately separate, later piece, not folded in
  // here) — until they vanish at the curtain, then hops on to the next fork
  // to do it again.
  //
  // "The last player still resting there" is derived purely from the
  // teammates map already being kept for rendering, not from an
  // authoritative roster count passed in from outside — simple, and
  // correct in the common case, but it has a real edge: a player still on
  // the character-select screen when everyone else at a fork has already
  // departed hasn't reported 'resting' yet, so the guide has no way to know
  // to wait for them and will move on without them. Late-joining a round
  // already in progress has the same shape of gap (a fresh mount's
  // `teammates` map starts empty, with no way to ask "catch me up" yet).
  // Both are real, both are follow-up work, not silently accepted forever.
  // Starts from initialGuideIsland when given (Watch mode resuming
  // mid-round — see that option's own comment above) and otherwise 1 (a
  // real guide, whose round always starts at the beginning). Clamped
  // defensively — a value outside 1..N_FORKS shouldn't be reachable from
  // App.jsx's own logic, but this is state a fresh mount seeds itself with
  // exactly once, not worth a crash if it ever is.
  let guideIsland =
    initialGuideIsland != null ? THREE.MathUtils.clamp(initialGuideIsland, 1, N_FORKS) : 1;
  let guideMode = 'parked'; // 'parked' | 'following'
  let guideFollowToken = null;
  // Was a single variable, overwritten on EVERY departure anywhere in the
  // game, not just at the fork the guide is currently parked at. Luke,
  // 2026-09-13, after a real two-device game (a phone and a browser tab
  // actually playing together, not the one-at-a-time-by-hand debug-hook
  // timing every previous "verification" used): the guide camera didn't
  // correctly follow the last player at a fork, for EITHER a fall or a
  // success. With two real people playing at their own pace rather than one
  // simulated departure carefully waited-out before the next, it's entirely
  // possible for a player already ahead at a LATER fork to depart while the
  // guide is still parked waiting at an EARLIER one — overwriting this
  // variable to a token the guide has no business following yet. Keyed by
  // fork now, so a departure elsewhere in the journey can't clobber which
  // token THIS fork's guide-follow logic cares about.
  const guideLastDepartedTokenByFork = new Map(); // forkIndex -> token
  // Fork indices where at least one teammate has actually been SEEN resting
  // — without this, "zero resting here right now" is trivially true for
  // every island nobody has reached yet, not just ones everyone has already
  // left. Confirmed directly: a single simulated departure from fork 1, with
  // no further data for fork 2 onward, raced the guide straight through
  // every remaining fork in one frame — "zero resting at 2" was read as
  // "everyone at 2 already left" instead of "no one's arrived at 2 yet".
  const guideSeenRestingIslands = new Set();

  function guideRestingCountAt(forkIdx) {
    let n = 0;
    for (const entry of teammates.values()) {
      if (entry.phase === 'resting' && entry.forkIndex === forkIdx) n++;
    }
    return n;
  }

  function resetGuideCamera() {
    guideIsland = 1;
    guideMode = 'parked';
    guideFollowToken = null;
    guideLastDepartedTokenByFork.clear();
    guideSeenRestingIslands.clear();
  }

  /**
   * Turns THIS ALREADY-RUNNING instance from a player who just fell into a
   * spectator, in place — no teardown, no remount, no fresh manager.onLoad.
   *
   * Luke, 2026-09-13: "a loading screen after the player falls suggests a
   * restart of some sort. In no way should the game be restarting... after
   * the player falls, what happens next should be something new, not a
   * return to something else." Exactly right — the previous design routed
   * a failed round to a brand-new `<GameRoom role="watching">`, and
   * SkyPath.jsx's mount effect treats `role` changing as "this is a
   * genuinely different game," tearing down the whole THREE.js scene and
   * rebuilding it from scratch (a real `manager.onLoad` loading screen,
   * not a UI illusion) — which is also why `initialGuideIsland` had to
   * exist at all, to reconstruct camera state a fresh mount has no memory
   * of. This sidesteps the whole problem: the SAME scene, SAME `sections`,
   * SAME `teammates` map (already tracking every other player exactly
   * where they are) just keeps running, with this device's own role
   * flipped from 'player' to 'watching'. `guideIsland` is seeded from
   * `forkIndex` — the CLOSURE'S OWN current value, not a value threaded in
   * from outside — so it's exactly right by construction, no guessing.
   * See GameRoom.jsx for the caller (an effect watching for this device's
   * own round having just failed).
   */
  function becomeSpectator() {
    if (isSpectatorRole(role)) return; // already there — e.g. a duplicate call
    role = 'watching';
    canAct = false;
    figure.visible = false;
    removeNameTag(rig);
    guideIsland = THREE.MathUtils.clamp(forkIndex, 1, N_FORKS);
    guideMode = 'parked';
    guideFollowToken = null;
    guideLastDepartedTokenByFork.clear();
    guideSeenRestingIslands.clear();
    els.role.dataset.role = role;
    els.role.textContent = 'Watching';
    initWatchPanel();
    refreshUI();
  }

  /** Called from tick() instead of the normal player camera branch — see the role check there. */
  function updateGuideCamera(dt) {
    if (guideMode === 'parked') {
      const restingHere = guideRestingCountAt(guideIsland);
      if (restingHere > 0) guideSeenRestingIslands.add(guideIsland);
      if (guideSeenRestingIslands.has(guideIsland) && restingHere === 0) {
        const lastToken = guideLastDepartedTokenByFork.get(guideIsland) ?? null;
        const last = lastToken ? teammates.get(lastToken) : null;
        if (last && last.phase === 'departing' && last.forkIndex === guideIsland && last.rig.group.visible) {
          guideMode = 'following';
          guideFollowToken = lastToken;
        } else {
          // Whoever was last is already gone (or never existed) — nothing
          // left to visibly follow, so just hop on to the next island.
          guideIsland = Math.min(guideIsland + 1, N_FORKS);
        }
      }
      const sec = sections[guideIsland - 1];
      if (!sec) return;
      // Pan offset folded into the LERP TARGET, not added to the result —
      // adding it after the lerp would fight the lerp's own pull back
      // toward the un-offset target every subsequent frame (each frame's
      // partial step toward `target` erodes most of a flat addition,
      // needing a much larger correction than dt*4 actually intends).
      // Targeting `trailingCamPos + look` instead means the lerp settles
      // exactly on the panned position, same as it already settles on
      // `trailingCamPos` alone with no pan. The look-AT point stays fixed
      // ahead, unshifted — same "slide the eye, not the gaze" parallax the
      // active player's own camera branch uses look.x/y for.
      const target = trailingCamPos(sec.fork.x, sec.fork.z, sec.fork.heading, CAM_BACK);
      target.x += look.x;
      target.y += look.y;
      camera.position.lerp(target, Math.min(1, dt * 4));
      camera.lookAt(trailingCamLookAt(sec.fork.x, sec.fork.z, sec.fork.heading));
    } else {
      const entry = teammates.get(guideFollowToken);
      if (!entry || entry.phase !== 'departing' || !entry.rig.group.visible) {
        // Reached the curtain and vanished (or something removed them) —
        // this island's business is done; move the guide's own reference
        // point on. The teacher's own dashboard is the source of truth for
        // whether the WHOLE group has finished — this only ever advances
        // this device's camera.
        guideMode = 'parked';
        guideIsland = Math.min(guideIsland + 1, N_FORKS);
        guideFollowToken = null;
        return;
      }
      const p = entry.rig.group.position;
      const heading = entry.rig.group.rotation.y;
      // Same target-side pan offset as the parked branch above — see its
      // comment for why it has to be folded in before the lerp, not after.
      const target = trailingCamPos(p.x, p.z, heading, CAM_BACK);
      target.x += look.x;
      target.y += look.y;
      camera.position.lerp(target, Math.min(1, dt * 4));
      camera.lookAt(trailingCamLookAt(p.x, p.z, heading));
    }
  }

  // ---------------------------------------------------------------- watch cycling
  //
  // Luke, 2026-09-24: "Rather than have an omniscient view, I want [a fallen
  // player] to cycle through the view of the other players, with a display
  // in the top left showing player avatars and name tags, and small arrows
  // to the left and right." Scoped to this device's own team only — cross-
  // team spectating would mean loading another team's whole island/fork
  // layout into this scene, which nothing here does today; see TODO.md.
  //
  // `watchToken` steps through `roster` in its own fixed order (this team's
  // token order, minus this device's own token — the same list seatOffsets
  // is built from, so the cycle order matches the left-to-right seating
  // everyone already reads), skipping anyone not currently viable — see
  // watchActiveCandidates(). A token, not an index: the viable set can
  // change shape frame to frame (someone finishes, someone else's first
  // report finally arrives), and an index into a resizing list would
  // silently start pointing at the wrong person.
  // The camera itself reuses trailingCamPos/trailingCamLookAt, the exact
  // maths the old auto-follow ("parked"/"following") branch above already
  // used — this is genuinely the same "look over this player's shoulder"
  // shot, just aimed by a manual choice instead of an automatic one.
  const WATCH_ADVANCE_DELAY_MS = 3000;
  let watchToken = null; // the actual teammate token currently shown — not an index, so a changing candidate list can't silently point it at someone else
  let watchFacing = 0; // this device's own eased copy of the watched teammate's heading — see its use below for why a raw rig rotation isn't good enough
  let watchFacingToken = null; // which token watchFacing is currently easing for — a switch snaps instead of spinning through the turn
  let watchAdvanceTimer = null;
  let watchAdvanceArmedFor = null; // token the pending auto-advance timer belongs to
  let watchPanelShownFor = null; // token + name currently painted into the DOM — see refreshWatchPanel()
  let watchPanelShownName = null;
  let watchNameRequestId = 0; // guards buildNameTagCanvas's async resolve against a stale paint — see refreshWatchPanel()

  function watchCandidates() {
    return roster.filter((tok) => tok !== myToken);
  }

  /** A candidate is "active" once there's real data for them and their own round hasn't ended. */
  function watchEntryActive(entry) {
    return !!entry && entry.phase !== 'gone' && entry.rig.group.visible;
  }

  /**
   * The teammates the ARROWS may step to — Luke, 2026-09-24: "non-viable
   * options [must be] removed and only the viable are cycled through; if
   * this means only one remaining, the arrows should do nothing." Someone
   * still on character-select (no entry yet) or already finished is never
   * a destination, though a just-finished person already ON screen stays
   * there through their own grace period — see updateWatchingCamera, which
   * reads `watchToken` directly rather than filtering through this list.
   */
  function watchActiveCandidates() {
    return watchCandidates().filter((tok) => watchEntryActive(teammates.get(tok)));
  }

  /**
   * The first active candidate strictly after `fromToken` in the fixed
   * roster order, wrapping, walking backwards for `dir` -1 — never
   * `fromToken` itself even if it's still active. Null if none are active.
   * Shared by the manual arrows and auto-advance so both land on the same
   * "next" person rather than two different ideas of it.
   */
  function nextActiveToken(fromToken, dir) {
    const all = watchCandidates();
    const active = watchActiveCandidates();
    if (all.length === 0 || active.length === 0) return null;
    const fromIdx = all.indexOf(fromToken); // -1 (not found) starts the search from the top of the list
    for (let step = 1; step <= all.length; step++) {
      const idx = (((fromIdx + dir * step) % all.length) + all.length) % all.length;
      if (active.includes(all[idx])) return all[idx];
    }
    return null;
  }

  function clearWatchAdvanceTimer() {
    clearTimeout(watchAdvanceTimer);
    watchAdvanceTimer = null;
    watchAdvanceArmedFor = null;
  }

  /** Shown once, from becomeSpectator() or a role:'watching' mount — picks a sensible starting player rather than whoever happens to be first in `roster`. */
  function initWatchPanel() {
    if (!els.watchPanel) return;
    els.watchPanel.classList.remove('hidden');
    watchToken = watchActiveCandidates()[0] ?? null;
    clearWatchAdvanceTimer();
    refreshWatchPanel();
  }

  /** Manual step — the arrow buttons. A no-op with one or zero viable candidates: nothing else to cycle to. */
  function stepWatch(dir) {
    if (watchActiveCandidates().length <= 1) return;
    const next = nextActiveToken(watchToken, dir);
    if (next === null || next === watchToken) return;
    watchToken = next;
    clearWatchAdvanceTimer(); // a manual choice always overrides whatever auto-advance was waiting on
    refreshWatchPanel();
  }

  /**
   * Per frame, only while role === 'watching' — see its call in tick().
   * `t` (the same elapsed-time clock tick() already has) is only for
   * matching the active player's own small camera bob below.
   */
  function updateWatchingCamera(dt, t) {
    // Nothing has ever been viable, or `watchToken` pointed at someone who
    // has since vanished outright (removeTeammate, not just finished) —
    // grab whatever's active now if anything is.
    if (watchToken === null || !teammates.has(watchToken)) {
      const active = watchActiveCandidates();
      if (active.length > 0) watchToken = active[0];
    }
    const token = watchToken;
    const entry = token ? teammates.get(token) : null;
    if (entry && entry.rig.group.visible && entry.livePos?.quat) {
      // Falling, or a jetpack rescue — a physics-driven, TUMBLING transform,
      // not a walk. Luke, 2026-09-24: "The camera should follow the player
      // as they fall, just as it does in that player's own view." The
      // trailing-shot branch below reads `entry.rig.group.rotation.y` as a
      // heading, which is exactly what broke this: a tumbling body's Euler-Y
      // component isn't a meaningful facing direction at all (it's coupled
      // to the X/Z tumble), so the trailing camera span wildly instead of
      // holding still. The active player's own fall camera (see `falling`
      // in tick()) never trails at all — it eases to a FIXED anchor beside
      // the edge they fell from, then just looks at the falling figure. This
      // reproduces that: `entry.fallCamAnchor` is computed once, lazily, the
      // first frame a quat'd livePos is seen for this teammate (using their
      // last known WALKING heading, `watchFacing`, since the real per-device
      // `choiceSide` lean isn't networked), then held fixed exactly like
      // `fallCamAnchor` is for the local player — see startFall's own
      // comment for the same FALL_CAM_* constants reused here.
      const p = entry.rig.group.position;
      if (!entry.fallCamAnchor) {
        const side = forward(watchFacing + Math.PI / 2, FALL_CAM_SIDE);
        const ahead = forward(watchFacing, FALL_CAM_FORWARD);
        entry.fallCamAnchor = new THREE.Vector3(p.x + side.x + ahead.x, FALL_CAM_HEIGHT, p.z + side.z + ahead.z);
      }
      camera.position.lerp(entry.fallCamAnchor, Math.min(1, dt * FALL_CAM_EASE));
      camera.lookAt(p.x, p.y, p.z);
    } else if (entry && entry.rig.group.visible) {
      // The SAME shot the active player's own camera uses (trailingCamPos/
      // trailingCamLookAt, a direct position `.set()`, no lerp) — Luke,
      // 2026-09-24: "It should be exactly the same as what the player being
      // watched sees." The one real gap: the active player's own camera
      // eases its heading (`facing`) toward their walking direction on its
      // own curve, at two speeds (fast while moving, slower once stopped)
      // — reproduced here as `watchFacing`, easing toward the teammate's
      // CURRENT rig heading, rather than reading that raw heading directly.
      // Skipping that was the actual bug behind "moves around in odd
      // ways": the rig's own heading is already a network-smoothed replica
      // (see updateTeammates' LIVE_POS_SMOOTH lerp), so easing camera
      // POSITION again on top of it (the old `camera.position.lerp` here)
      // was a second, redundant layer of lag stacked on the first, while
      // the actually-missing smoothing (heading) was skipped entirely.
      // Not reproduced: the walking case's special-cased straightening for
      // a branch's final hop into an island (see that code's own comment)
      // — it keys off the active player's own `leg` state, which isn't
      // networked and would need a new field just for this.
      const p = entry.rig.group.position;
      const rawHeading = entry.rig.group.rotation.y;
      if (watchFacingToken !== token) {
        watchFacing = rawHeading; // just switched onto them — snap, don't spin through the turn
        watchFacingToken = token;
      } else {
        let delta = rawHeading - watchFacing;
        delta = ((delta + Math.PI) % (Math.PI * 2)) - Math.PI; // shortest angular distance
        const ease = entry.phase === 'departing' ? 2.5 : 20; // same two speeds as the active player's own `facing`
        watchFacing += delta * Math.min(1, dt * ease);
      }
      const target = trailingCamPos(p.x, p.z, watchFacing, CAM_BACK);
      target.x += look.x;
      target.y += look.y;
      camera.position.set(target.x, target.y + Math.sin(t * 0.6) * 0.05, target.z);
      camera.lookAt(trailingCamLookAt(p.x, p.z, watchFacing));
    } else {
      // Nobody at all to show yet (e.g. solo dev testing with no real
      // teammates) — TEMPORARY fallback to the old auto-following camera
      // so this doesn't just show a frozen, aimless view. Luke, 2026-09-24:
      // "keep it for now in case this doesn't work, but mark it as ready
      // for deletion once this has been implemented" — delete this branch,
      // updateGuideCamera's own watching-era comments, and the role check
      // in tick() that still routes 'watching' here at all, once the cycle
      // above has been played with for real and holds up.
      updateGuideCamera(dt);
    }

    // Auto-advance once the currently-watched player's OWN round has
    // genuinely finished — "make sure the final action is fully finished,
    // and then add a delay of 3s" (Luke, 2026-09-24). `!entry.abduction`
    // is what "fully finished" means for an abduction specifically: the
    // local replica saucer (built in updateTeammate's 'departing' handling)
    // disposes itself once its OWN scripted animation ends, which in the
    // ordinary case happens before 'gone' ever arrives over the network —
    // see that dispose call's own comment. A fall/rescue has no equivalent
    // scripted tail: the last streamed transform is already where they
    // ended up by the time 'gone' arrives, nothing further to wait out.
    const justEnded = !!entry && entry.phase === 'gone' && !entry.abduction;
    if (justEnded) {
      if (watchAdvanceArmedFor !== token) {
        clearWatchAdvanceTimer();
        watchAdvanceArmedFor = token;
        watchAdvanceTimer = setTimeout(() => {
          watchAdvanceTimer = null;
          watchAdvanceArmedFor = null;
          const next = nextActiveToken(token, 1);
          if (next !== null) watchToken = next; // else: nobody left active — stays on the finished player, showing the fallback view above until someone else arrives
        }, WATCH_ADVANCE_DELAY_MS);
      }
    } else if (watchAdvanceArmedFor === token) {
      // They un-ended somehow (shouldn't happen — 'gone' is terminal — but
      // cheap to guard) or the slot moved on without us; don't fire stale.
      clearWatchAdvanceTimer();
    }

    refreshWatchPanel();
  }

  /**
   * Paints the top-left panel from the currently-selected watch candidate —
   * a no-op once it already shows the same token+name, so this is cheap to
   * call every frame. The name tag is the SAME cardboard-cutout canvas the
   * player's own in-world tag uses (buildNameTagCanvas, nameTag.js) — Luke,
   * 2026-09-24: "a real, cardboard nametag next to them, the same as they
   * do in the game. Not a name written in a font below them." Building one
   * is async (it loads letter images), so `watchNameRequestId` guards
   * against painting a stale result if the watcher cycles away before it
   * resolves — same idea as attachNameTag's own `isCurrent()` guard.
   */
  function refreshWatchPanel() {
    if (!els.watchPanel) return;
    const token = watchToken;
    const entry = token ? teammates.get(token) : null;
    const name = entry?.displayName ?? null;
    if (watchPanelShownFor === token && watchPanelShownName === name) return;
    watchPanelShownFor = token;
    watchPanelShownName = name;
    if (els.watchAvatar) els.watchAvatar.src = entry ? avatarSrcFor(entry.characterKey) : '';
    const requestId = ++watchNameRequestId;
    if (els.watchName) els.watchName.innerHTML = '';
    if (els.watchName && name && entry) {
      const glowColor = `#${(entry.colorHex ?? 0xffe9b8).toString(16).padStart(6, '0')}`;
      buildNameTagCanvas(name, { glowColor })
        .then(({ canvas }) => {
          if (requestId !== watchNameRequestId) return; // a later request already superseded this one
          els.watchName.innerHTML = '';
          els.watchName.appendChild(canvas);
        })
        .catch(() => {}); // same "never let a name-tag build fail loudly" stance as attachNameTag's own callers
    }
  }

  function removeTeammate(token) {
    const entry = teammates.get(token);
    if (!entry) return;
    disposeRig(entry.rig);
    teammates.delete(token);
  }

  // The name actually shown on this device's own tag and reported to
  // teammates — the `displayName` option (the name already typed into the
  // LOBBY to join) when this is a networked round, falling back to
  // whatever the character-select screen's own free-text input produces
  // for solo/dev play, where there is no lobby name to inherit.
  let localDisplayName = displayName;

  /**
   * Tells the host (see GameRoom.jsx) what THIS device's own player is
   * doing, for it to relay to teammates — see the four-phase model in the
   * "teammates" section header: 'resting' (default), 'departing',
   * 'moving' (with `livePos`: `{x, z, heading}` walking, `{x, y, z, quat}`
   * falling / rescued / abducted), or 'gone'. Nothing about the chosen
   * side or the outcome is ever sent ahead of time — a viewer only ever
   * learns what's happening from the transforms as they happen.
   *
   * `powerupKind`/`firing`/`detached` ride along on every call (not a
   * separate event) — Luke, 2026-09-14, after watching a real rescue
   * remotely: "there's no jetpack visible: only the moving avatar," and
   * then, once that was fixed, "we don't see the jetpack leaving the
   * screen... after the player lands, the jetpack simply disappears."
   * `powerupKind` (2026-09-15: generalised from a plain `hasJetpack` boolean
   * once the abduction device became a second thing that can occupy the
   * same `rig.powerup` slot) reads straight off `rig.powerup?.kind`, so a
   * teammate's own equip/unequip, ignite/extinguish, and detach are always
   * current on whatever's the next thing this device reports anyway — see
   * updateTeammate/updateTeammates for the receiving side, which replays
   * the same detach-and-fly-off animation updateRescue plays locally.
   *
   * `abducting` is only meaningful on the 'departing' report startAbduction
   * sends (see its own comment) — a spectator builds its OWN local saucer
   * instance from it (see updateTeammate), rather than this device
   * streaming its saucer's transform: unlike the jetpack's small attached
   * prop, the saucer/beam/card move as one scripted ensemble (see
   * alienAbduction.js's `apply()`), so a real position stream would fight a
   * receiver's own copy rather than usefully drive it.
   */
  function notifyPlayerState(phase = 'resting', livePos = null) {
    const powerupKind = rig.powerup?.kind ?? null; // 'jetpack' | 'abduction' | null — see equipPowerUp's own header
    const firing = !!rig.powerup?.flame;
    const detached = !!rescue?.detached;
    const abducting = !!abduction;
    // Targeted and waiting for (or in) the abduction defence — teammates
    // light the same green glow on this player's rig; see updateTeammate.
    // `abductPromptOpen` alone stays true through the whole close-and-repel
    // sequence (it also blocks movement — see requestChoice), but the light
    // itself has to go the instant the word is confirmed correct, well
    // before that — see `resistConfirmedEarly`'s own comment.
    const defending = abductPromptOpen && !resistConfirmedEarly;
    window.__lastPlayerState = { phase, livePos, powerupKind, firing, detached, abducting, defending, at: Date.now() }; // debug only — see e.g. window.__teammates for the receiving-side equivalent
    // DEV: recording real movement for the bots (src/dev/recordTracks.js),
    // which replay it so the projector has real walks, falls and rescues to
    // show without a class of phones. Only when a recorder has set the array.
    window.__stateLog?.push({ t: performance.now(), phase, forkIndex, livePos, powerupKind, firing, detached, abducting, defending });
    onPlayerState?.({
      phase,
      forkIndex,
      characterKey,
      displayName: localDisplayName,
      colorHex: pickedColorHex,
      livePos,
      powerupKind,
      firing,
      detached,
      abducting,
      defending,
    });
  }

  // One throttled 'moving' ping carrying the figure's full current
  // transform — shared by the fall, jetpack-rescue and abduction branches
  // in tick()/updateRescue, all of which write figure.position/quaternion
  // themselves. Same MOVING_PING_INTERVAL throttle (and the same
  // lastMovingPingAt clock) as the ordinary walking ping; the two can never
  // be active at the same time, so sharing the clock is safe.
  function pingFigureTransform() {
    const now = Date.now();
    if (now - lastMovingPingAt < MOVING_PING_INTERVAL) return;
    lastMovingPingAt = now;
    notifyPlayerState('moving', {
      x: figure.position.x,
      y: figure.position.y,
      z: figure.position.z,
      quat: figure.quaternion.toArray(),
    });
  }

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

  // `?debugAbduct=1` — Luke, 2026-09-19, checking the target-picker's own
  // legibility on his phone: solo play has no second device to target, so
  // `getAbductionTargets()` always comes back empty and the real item pickup
  // is a coin flip needing a walk to island 2 either way. This forces the
  // island-2 item to be the abduction device (see pickupKind below) AND
  // auto-claims it the instant character-select finishes (see
  // finishCharacterSelect's own DEBUG_ABDUCT block) — reachable by URL
  // alone, unlike window.__debugAbductTargets on its own, which still needed
  // a console to set it and force-click the disabled real button by hand.
  const DEBUG_ABDUCT = new URLSearchParams(location.search).has('debugAbduct');

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
  let fallGoneSent = false; // the one 'gone' report per fall — see tick()'s falling block
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
    fallGoneSent = false;

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

  // ---------------------------------------------------------------- broken plank pieces
  //
  // The wrong branch's designated planks (see BRIDGE_WRONG_GAP_T and
  // genBridgeRoute's fallPoint above — two of them, the one at the bridge's
  // low point and the one before it, per Luke 2026-09-04: "the middle plank
  // and the one before it") break into two each the instant the walker
  // reaches them — replacing the earlier static-gap placeholder with the
  // real "breaks under you" version. Reuses fallWorld rather than a second
  // physics world: it's already stepped every frame while `falling` is
  // true, so all the pieces and the player tumble on exactly the same clock
  // for free.
  const PLANK_PIECE_MASS = 0.15;
  let brokenPieces = []; // { mesh, body }

  /** Removes any pieces left over from a previous break. */
  function clearBrokenPieces() {
    for (const { mesh, body } of brokenPieces) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      fallWorld.removeRigidBody(body);
    }
    brokenPieces = [];
  }

  /**
   * Splits every plank in `breakablePlanks` (via bridgeGen.js's breakPlank())
   * and hands each resulting piece a dynamic Rapier body sized to its own
   * bounding box. Only one break event is ever relevant at a time — same
   * reasoning as startFall()'s `if (fallBody) fallWorld.removeRigidBody
   * (fallBody)` — so this clears whatever the previous attempt left behind
   * first, once, before breaking every plank in the new set.
   */
  function triggerPlankBreak(breakablePlanks) {
    clearBrokenPieces();
    for (const breakablePlank of breakablePlanks) breakOnePlank(breakablePlank);
  }

  function breakOnePlank(breakablePlank) {
    // breakPlank() returns the two pieces in a fixed [-1, +1] order (its own
    // sideSign, along the plank's local "across the deck" axis) — used here
    // rather than re-deriving a side from world position, since that axis is
    // whatever direction this particular bridge happens to run in, not
    // necessarily world X.
    breakPlank(breakablePlank).forEach(({ mesh, halfExtents }, i) => {
      const away = i === 0 ? -1 : 1;
      scene.add(mesh);
      const body = fallWorld.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(mesh.position.x, mesh.position.y, mesh.position.z)
          .setRotation({ x: mesh.quaternion.x, y: mesh.quaternion.y, z: mesh.quaternion.z, w: mesh.quaternion.w })
          .setLinearDamping(0.05)
          .setAngularDamping(0.15)
          .setAdditionalMass(PLANK_PIECE_MASS)
      );
      fallWorld.createCollider(RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z), body);
      // A small outward/downward kick, in the plank's own local "across the
      // deck" direction, so the two halves visibly separate from the first
      // instant rather than dropping as a still-touching pair.
      const kick = breakablePlank.side.clone().multiplyScalar(away * 0.6);
      body.setLinvel({ x: kick.x, y: -0.2, z: kick.z }, true);
      body.setAngvel(
        { x: (Math.random() * 2 - 1) * 3, y: (Math.random() * 2 - 1) * 3, z: (Math.random() * 2 - 1) * 3 },
        true
      );
      brokenPieces.push({ mesh, body });
    });
  }

  // ---------------------------------------------------------------- jetpack rescue
  //
  // A wrong pick still breaks the bridge and drops the player exactly as
  // before (see triggerPlankBreak/startFall above) — but if a jetpack is
  // equipped (see equipPowerUp/rig.powerup), the fall is intercepted a
  // moment later and turns into a rescue instead: the engine ignites, flies
  // the player up and over to exactly the spot they'd have landed at with
  // the correct pick, sets them down, then detaches and flies off. Luke,
  // 2026-09-13: "the engine will be a one-off spare life when the player
  // falls."
  //
  // Deliberately NOT built on the same Rapier physics as a real fall — this
  // was Luke's own suggestion once the "how do you smoothly take over from
  // an unpredictable mid-tumble physics orientation" problem came up. A
  // physics tumble ends wherever it ends; this whole sequence needs to
  // instead behave in an exact, repeatable, tunable way throughout. So the
  // "fall" here is its own small scripted tumble (a fixed random axis/speed
  // chosen once, integrated by hand, standing in for what Rapier would have
  // done) — everything from here on is a pure function of elapsed time,
  // same philosophy as updateTempleEntry.
  let rescue = null; // { t, sec, isLastFork, landing, startPos, startQuat, sideVec, ignited, detached, departBaseY, camPos, camLookAt } | null

  // Luke's own tuned values (2026-09-07), found via the `?rescueTune=1`
  // panel further down and baked in here as the new defaults. Reworked
  // 2026-09-14: Luke, having seen the loop live, "I'd like to remove the
  // loop the player does: have them fly straight to the point above the
  // next island and then descend." That collapsed the old three-phase
  // flight (a sideways ignition burst, then a looping arc back over to the
  // island) into one straight `flyDuration` leg — see rescuePosAt's own
  // comment for the shape. `flyOutDistance`/`flyOutRise`/`loopRadius`
  // (the sideways burst target and the loop's own radius) no longer mean
  // anything and were removed rather than left dead.
  const RESCUE_TUNE = {
    fallDuration: 2, // Luke: "they should fall for 1s, before the engine turns on" — retuned to 2s
    flyDuration: 3.4, // straight flight, fall's end to directly above the landing spot — first-pass number, not yet Luke-tuned; was ~4.7s (flyOut 1.9 + arc 2.8) before the loop was removed, shortened per "this should slightly reduce the total time of the animation as well"
    descendDuration: 3.05,
    // How long before touchdown the body has already finished rolling
    // upright, so the last stretch comes straight down with no more turning
    // — Luke, 2026-09-07, after the "finished turning too late" pass: "I'd
    // prefer they complete their orientation earlier/higher, and come down
    // straight for the last second." Clamped against descendDuration itself
    // in updateRescue, so this can never ask for more upright-time than the
    // descend actually has.
    uprightHoldDuration: 1.0,
    holdDuration: 0.8, // Luke: "the engine will remain firing and attached for 0.5s" — retuned to 0.8s
    departDuration: 1.7, // Luke: "leaving the screen in perhaps 1.5s" — retuned to 1.7s
    apexHeight: 20, // height of "the point above the next island" the straight flight aims for
    departDistance: 30,
    cameraTravelDuration: 1.2,
    cameraZoomDuration: 2.95,
    cameraPullback: 8.4,
  };
  const RESCUE_GRAVITY = 9.82; // matches fallWorld's own gravity, for the scripted phase-A drop
  // "Ground" for the figure's CARD (its centre, which is what figure.position
  // actually is) is not world-Y 0 — the normal step-bob code stands it at
  // walker.y + FIGURE_H/2 (see tick()'s own bob block), so its bottom edge,
  // not its centre, is what sits on the deck. Landing at plain Y 0 put the
  // card's centre at ground level, i.e. buried to the waist — Luke,
  // 2026-09-13: "the player is landing much too low, inside the island."
  const RESCUE_GROUND_Y = FIGURE_H / 2;
  const RESCUE_IDENTITY_QUAT = new THREE.Quaternion();
  // A tiny forward look, used to sample the flight path's own instantaneous
  // direction of travel (see rescuePosAt/computeRescueQuat below) rather than
  // hand-picking an orientation per phase.
  const RESCUE_VEL_EPS = 0.02;
  // The one baked-in lean during the pre-ignition fall — see its own use in
  // updateRescue for why this is fixed rather than random.
  const FALL_TUMBLE_ANGLE = THREE.MathUtils.degToRad(35);

  /**
   * Luke, 2026-09-07, after seeing the first pass: "the card is often at an
   * angle that make them thin to the camera. I want to have the card always
   * flat to camera, and the engine facing away from the centre and the
   * camera... fly 'up' relative to the camera's view... before curving
   * vertically upward and towards the next island. Again, it may be easiest
   * to make this a standard procedure, mirrored for left/right, rather than
   * try to figure out how to make it work with random falling physics."
   *
   * So the card's orientation while flying is no longer picked per phase —
   * it's rebuilt every frame from two things that are already known exactly:
   * where the card actually is (from rescuePosAt) and which way it's
   * actually moving (the finite-difference velocity below). The card's local
   * +Z (its front, and the side the jetpack's flame is NOT on — see
   * makeCharacterRig) is pointed straight at the camera, so it can never go
   * edge-on; the card's local +Y (head-to-feet) is pointed along whatever's
   * left of the travel direction once the camera-facing component is
   * removed, which is exactly "flat to camera, but leaning the way it's
   * actually flying" — lying near-horizontal during the sideways flyout,
   * tipping upright again as the arc curves back up toward the island. This
   * also mirrors left/right for free: sideVec (below) already flips sign
   * with choiceSide, and everything here is just derived from position, so
   * there's nothing left to mirror by hand.
   */
  function computeRescueQuat(pos, velocityDir, camPos) {
    const toCam = camPos.clone().sub(pos);
    if (toCam.lengthSq() < 1e-6) toCam.set(0, 0, 1);
    toCam.normalize();

    let up = velocityDir.clone().sub(toCam.clone().multiplyScalar(velocityDir.dot(toCam)));
    if (up.lengthSq() < 1e-6) {
      // Travelling straight along the camera axis (or not moving at all) —
      // no usable direction to lean toward, so fall back to world-up
      // flattened the same way.
      up = new THREE.Vector3(0, 1, 0).sub(toCam.clone().multiplyScalar(toCam.y));
    }
    up.normalize();

    const right = new THREE.Vector3().crossVectors(up, toCam).normalize();
    up.crossVectors(toCam, right).normalize(); // re-orthogonalize, cheap insurance

    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, toCam));
  }

  /** Same trailing-camera formula tick()'s normal camera branch uses (see
   * `else if (!justFell)` there), factored out here so the rescue's own
   * camera phases (in updateRescue below) can aim at a fork/landing spot
   * that isn't `walker`/`facing` yet — those don't update until the very
   * end (see resolveRescue). */
  function trailingCamPos(x, z, heading, back) {
    const behind = forward(heading, back);
    return new THREE.Vector3(x - behind.x, CAM_HEIGHT, z - behind.z);
  }
  function trailingCamLookAt(x, z, heading) {
    const ahead = forward(heading, 4.6);
    return new THREE.Vector3(x + ahead.x, CAM_LOOK_Y, z + ahead.z);
  }

  /**
   * Starts the rescue in place of startFall() — called from the same
   * walk-loop completion site, only when `rig.powerup` is equipped.
   * `choiceSide`/`facing`/`walker` are all still whatever they were the
   * instant the wrong branch ran out, exactly as startFall() also relies on.
   */
  function startRescue() {
    figure.visible = true;
    cancelBirdsForFall();

    const sec = sections[forkIndex - 1];
    const angleOffset = choiceSide === 'left' ? -Math.PI / 2 : Math.PI / 2;
    const sideVec = forward(facing + angleOffset, 1);
    const isLastFork = forkIndex === N_FORKS;
    // Luke, 2026-09-14: "the player currently comes to land in the centre
    // of the island, then suddenly jumps to their position after the
    // animation is complete. They need to land in their correct position."
    // Right — `sec.nextCursor` is the fork's bare CENTRE, no seat offset;
    // the whole animation used to fly to and land at that centre, and only
    // the NEXT frame's ordinary resting render (see currentSeatLateral's
    // `!leg` branch) actually applies this player's fixed seat, snapping
    // them sideways the instant the sequence ended. Baking the seat offset
    // into `landing` itself fixes it at the source — every phase of the
    // flight (the climb, the descent, the touchdown) already aims at
    // wherever `landing` points, so there's nothing else to change. Not
    // applied for the last fork: that landing is the temple's own edge, a
    // single-file approach with no seating concept at all (same reason
    // currentSeatLateral() never tapers back in for a leg with no
    // `arriveFork`).
    const seatAtLanding = isLastFork
      ? { x: 0, z: 0 }
      : forward(sec.nextCursor.heading + Math.PI / 2, mySeatOffsetX);

    rescue = {
      t: 0,
      sec,
      isLastFork,
      // The exact spot (and heading) the correct branch's own last waypoint
      // would have landed them at — genBridgeRoute's centreHop for a normal
      // fork, or the temple island's own edge for the last one (see
      // buildFork's isLastFork branch) — plus this player's own fixed seat
      // offset at that fork (see seatAtLanding above).
      landing: {
        x: sec.nextCursor.x + seatAtLanding.x,
        z: sec.nextCursor.z + seatAtLanding.z,
        heading: sec.nextCursor.heading,
      },
      startPos: figure.position.clone(),
      startQuat: figure.quaternion.clone(),
      sideVec,
      ignited: false,
      detached: false,
      departBaseY: 0,
      camPos: null,
      camLookAt: null,
    };

    // Same anchor a normal fall uses (see startFall) — the first second of a
    // rescue looks exactly like a real fall on purpose, camera included, so
    // nobody watching can tell it's a rescue until the engine actually fires.
    const side = forward(facing + angleOffset, FALL_CAM_SIDE);
    const ahead = forward(facing, FALL_CAM_FORWARD);
    fallCamAnchor.set(walker.x + side.x + ahead.x, FALL_CAM_HEIGHT, walker.z + side.z + ahead.z);
  }

  /**
   * Position only, as a pure function of an arbitrary t — called twice per
   * frame from updateRescue (once at rescue.t, once RESCUE_VEL_EPS later) so
   * the card's actual instantaneous direction of travel can be read straight
   * off the path instead of guessed at per phase — see computeRescueQuat's
   * own header for why that matters now.
   *
   * Reworked 2026-09-14 — Luke, after watching the sideways-burst-then-loop
   * version live: "I'd like to remove the loop the player does: have them
   * fly straight to the point above the next island and then descend."
   * Three phases now, not five: fall, one straight flight leg from wherever
   * the fall ended to directly above `landing` (which already carries this
   * player's own seat offset — see startRescue), then straight down.
   */
  function rescuePosAt(rescue, t) {
    const R = RESCUE_TUNE;
    const t1 = R.fallDuration;
    const t2 = t1 + R.flyDuration;
    const t3 = t2 + R.descendDuration;
    const { startPos, landing } = rescue;
    const fallEndY = startPos.y - 0.5 * RESCUE_GRAVITY * t1 * t1;
    const above = new THREE.Vector3(landing.x, R.apexHeight, landing.z);
    const pos = new THREE.Vector3();

    if (t < t1) {
      // Phase A: straight fall — Luke, 2026-09-07: "if it turns out it would
      // be easier to have one single pre-made procedure... go ahead and do
      // that" — no more random tumble here at all, just a drop, so there's
      // nothing left to blend out of once the engine ignites.
      pos.set(startPos.x, startPos.y - 0.5 * RESCUE_GRAVITY * t * t, startPos.z);
    } else if (t < t2) {
      // Phase B: the engine ignites and flies straight to the point directly
      // above the landing spot — ease-in (a burst, not a drift) via the
      // squared smoothstep, same shape the old ignition sub-phase used.
      const eased = smoothstep(t1, t2, t) ** 2;
      pos.lerpVectors(new THREE.Vector3(startPos.x, fallEndY, startPos.z), above, eased);
    } else if (t < t3) {
      // Phase C: straight down onto the exact spot the correct branch would
      // have landed them at, easing out into a controlled touchdown rather
      // than free-falling into it.
      const u = smoothstep(t2, t3, t);
      const eased = 1 - (1 - u) * (1 - u);
      pos.set(landing.x, THREE.MathUtils.lerp(R.apexHeight, RESCUE_GROUND_Y, eased), landing.z);
    } else {
      // Phases D/E: landed — the card itself just sits at the landing spot;
      // only the engine moves, once detached (handled in updateRescue, not
      // here, since that's a one-off side effect, not a pure function of t).
      pos.set(landing.x, RESCUE_GROUND_Y, landing.z);
    }
    return pos;
  }

  /**
   * Pure function of `rescue.t` for everything except the one-off ignite/
   * detach side effects (each flagged so it fires exactly once) and the
   * final resolveRescue() call once the whole sequence has played out.
   * Called from tick()'s step-bob section, ahead of the camera section
   * further down — this sets rescue.camPos/camLookAt, already fully eased,
   * for that section to apply directly (no further lerping needed there).
   */
  function updateRescue(dt) {
    rescue.t += dt;
    const t = rescue.t;
    const R = RESCUE_TUNE;
    const t1 = R.fallDuration;
    const t2 = t1 + R.flyDuration;
    const t3 = t2 + R.descendDuration;
    const t4 = t3 + R.holdDuration;
    const t5 = t4 + R.departDuration;
    // Clamped so a small descendDuration can never push this before t2 —
    // see uprightHoldDuration's own comment.
    const orientEnd = t3 - Math.min(R.uprightHoldDuration, R.descendDuration);
    // How long of the flight is spent blending OUT of the pre-ignition lean
    // and INTO the velocity-aligned flight orientation (see flightQuatAt
    // below) — a fixed short fraction of the flight, not the whole thing,
    // so the card settles into "flying" quickly rather than still visibly
    // untwisting right up to the point it starts descending. First-pass
    // number, not yet Luke-tuned.
    const igniteBlendEnd = t1 + Math.min(0.5, R.flyDuration * 0.25);

    if (!rescue.ignited && t >= t1) {
      rescue.ignited = true;
      startEngineFlame(rig);
    }

    const { landing } = rescue;
    const pos = rescuePosAt(rescue, t);

    // Velocity-aligned orientation only covers the flight itself (t1..t2) —
    // see computeRescueQuat's header. The descend phase (t2..t3) is
    // deliberately NOT more of the same: the actual velocity there points
    // straight down onto the landing spot, and aligning the body's up-axis
    // with "straight down" is exactly what put the player in head-first —
    // Luke, 2026-09-07: "the player is landing upside-down, head first."
    // A standing figure doesn't orient itself to match its fall speed on the
    // way down, so instead this eases from whatever it was flying at the end
    // of the flight back to upright, landing right-side-up by construction.
    function flightQuatAt(sampleT) {
      const p = rescuePosAt(rescue, sampleT);
      const velocityDir = rescuePosAt(rescue, sampleT + RESCUE_VEL_EPS).sub(p);
      if (velocityDir.lengthSq() < 1e-6) velocityDir.set(0, 1, 0);
      velocityDir.normalize();
      return computeRescueQuat(p, velocityDir, camera.position);
    }

    // Small fixed lean while falling, before the engine catches them — Luke,
    // 2026-09-07: "it still needs to have at least a small turn before the
    // jetpack kicks in... it's fine to bake in one set rotation." Deliberately
    // NOT a random axis (that's exactly what made the card go edge-on before
    // — see computeRescueQuat's header) — rotating around sideVec's own
    // direction (the axis the old sideways burst used to travel along, still
    // mirrored by choiceSide) keeps the tumble happening *in* the
    // camera-facing plane instead of tipping the card away from it. Scoped
    // tightly to phase A only, and the ignite blend below blends out of this
    // instead of out of the bare startQuat — everything from ignition on is
    // untouched.
    //
    // sideVec itself is the plain {x, z} shape forward() returns everywhere
    // else in this file (no y) — fine for the position math above, but
    // setFromAxisAngle needs a real 3D vector. Passing sideVec straight in
    // silently read its missing y as undefined, which turned the whole
    // rotation (and everything slerped from it) into NaN — the card wasn't
    // "falling out of view", it was being handed an invalid transform and
    // never drawn at all, only recovering once the ignition blend reached
    // its endpoint exactly and could just copy the (valid) target quaternion
    // instead of interpolating through the broken one.
    const fallTiltAxis = new THREE.Vector3(rescue.sideVec.x, 0, rescue.sideVec.z);
    const fallTiltQuat = rescue.startQuat.clone().multiply(new THREE.Quaternion().setFromAxisAngle(fallTiltAxis, FALL_TUMBLE_ANGLE));

    let quat;
    if (t < t1) {
      quat = rescue.startQuat.clone().slerp(fallTiltQuat, smoothstep(0, t1, t));
    } else if (t < igniteBlendEnd) {
      // Ignition: blends from the fall's own ending lean into the flight
      // orientation over a short fixed window, not the whole flight.
      quat = fallTiltQuat.slerp(flightQuatAt(t), smoothstep(t1, igniteBlendEnd, t));
    } else if (t < t2) {
      quat = flightQuatAt(t);
    } else if (t < orientEnd) {
      // Descend, still turning: eases from the flight's own final
      // orientation (sampled once, at t2, not re-derived from the downward
      // fall velocity — see the header above) back to upright. Finishes at
      // orientEnd, not t3 — see uprightHoldDuration's own comment.
      quat = flightQuatAt(t2).slerp(RESCUE_IDENTITY_QUAT, smoothstep(t2, orientEnd, t));
    } else if (t < t3) {
      // Descend, done turning: already upright, comes down straight for
      // whatever's left of the descent.
      quat = RESCUE_IDENTITY_QUAT;
    } else {
      // Landed: back on its feet, same standing pose walking uses.
      quat = RESCUE_IDENTITY_QUAT;
    }

    if (t >= t3) {
      if (!rescue.detached && t >= t4) {
        rescue.detached = true;
        // scene.attach() (not scene.add()) preserves the group's current
        // WORLD transform as its new local one — it keeps riding exactly
        // where it was clipped on the card for this one frame, and only
        // starts actually moving on its own from the next frame on.
        if (rig.powerup) {
          scene.attach(rig.powerup.group);
          rescue.departBaseY = rig.powerup.group.position.y;
        }
      }
      if (rescue.detached && rig.powerup) {
        const ud = smoothstep(t4, t5, t);
        rig.powerup.group.position.y = rescue.departBaseY + ud * ud * R.departDistance;
      }
    }

    figure.position.copy(pos);
    figure.quaternion.copy(quat);
    // Luke, 2026-09-13: "when a player uses the jetpack, I want that to be
    // visible for everyone" — see the "teammates" section's phase model. A
    // rescue ends with an explicit 'resting' report (resolveRescue), so
    // these pings simply stop the same instant that fires.
    pingFigureTransform();

    // ---- camera --------------------------------------------------------
    // Holds at the fall anchor (tracking the figure, exactly like a real
    // fall) until the fall is done — Luke: "the camera will wait for the
    // falling character to leave the screen" — then pans to a pulled-back
    // shot of the landing spot, then eases in to the normal trailing framing
    // as the player descends (Luke: "arrive at the island pulled back...
    // slowly zooming in"). All computed here as an exact function of t (see
    // this function's own header); the camera section in tick() just
    // applies rescue.camPos/camLookAt directly.
    const camTravelStart = t1;
    const camTravelEnd = t1 + R.cameraTravelDuration;
    const camZoomStart = t2;
    const camZoomEnd = t2 + R.cameraZoomDuration;
    const widePos = trailingCamPos(landing.x, landing.z, landing.heading, CAM_BACK + R.cameraPullback);
    const normalPos = trailingCamPos(landing.x, landing.z, landing.heading, CAM_BACK);
    const lookAtTarget = trailingCamLookAt(landing.x, landing.z, landing.heading);
    // Fixed reference point for the travel pan's look-at, matching where the
    // fall ends / the flight begins — the flight itself no longer has a
    // separate "sideways burst" endpoint to aim at instead.
    const flightStart = new THREE.Vector3(
      rescue.startPos.x,
      rescue.startPos.y - 0.5 * RESCUE_GRAVITY * t1 * t1,
      rescue.startPos.z
    );

    if (t < camTravelStart) {
      rescue.camPos = fallCamAnchor.clone();
      rescue.camLookAt = pos.clone();
    } else if (t < camTravelEnd) {
      const u = smoothstep(camTravelStart, camTravelEnd, t);
      rescue.camPos = fallCamAnchor.clone().lerp(widePos, u);
      rescue.camLookAt = flightStart.clone().lerp(lookAtTarget, u);
    } else if (t < camZoomStart) {
      rescue.camPos = widePos;
      rescue.camLookAt = lookAtTarget;
    } else if (t < camZoomEnd) {
      const u = smoothstep(camZoomStart, camZoomEnd, t);
      rescue.camPos = widePos.clone().lerp(normalPos, u);
      rescue.camLookAt = lookAtTarget;
    } else {
      rescue.camPos = normalPos;
      rescue.camLookAt = lookAtTarget;
    }

    if (t >= t5) resolveRescue();
  }

  /**
   * Hands control back to normal play once the engine has fully departed —
   * Luke: control doesn't return "until the engine is fully gone". Mirrors
   * what a real arrival does (see the `leg.arriveFork`/`leg.success` cases
   * in tick()'s own walk-loop completion), since as far as the rest of the
   * game is concerned this IS an arrival, just one that skipped the walk.
   * The jetpack itself is spent — Luke never described stacking/refuelling,
   * so `rig.powerup` is simply gone after this, same as any other one-shot.
   */
  function resolveRescue() {
    const { sec, isLastFork, landing } = rescue;
    disposePowerUp(rig);
    // `walker` (the pure-centreline simulation position — see
    // currentSeatLateral's own header for why it must never carry a seat
    // offset) is NOT the same thing as `landing`, which carries this
    // player's own seat offset for the animation itself (see startRescue).
    // The last fork's `landing` has no seat offset to begin with (no
    // seating concept at the temple approach), so it's already centreline
    // and safe to use directly there.
    const centreline = isLastFork ? landing : sec.nextCursor;
    walker.set(centreline.x, 0, centreline.z);
    facing = landing.heading;
    if (isLastFork) {
      // Same continuation a normal correct pick plays at the last fork (see
      // applyChoice) — the walk from here to the temple's own stop point,
      // already precomputed as sec.approach.
      const continuation = sec.approach || [];
      leg = makeLeg(continuation, [walker.clone(), ...continuation], sunP, timeOfDay(N_FORKS), null, landing.heading, landing.heading);
      leg.success = true;
    } else {
      forkIndex += 1;
      sunP = timeOfDay(forkIndex);
      // Luke, 2026-09-13: "the guide and dead player have their view broken
      // when the watched player uses a jetpack to save themselves... no
      // player visible." Cause: unlike every other arrival, a mid-round
      // rescue never runs a `leg` at all (it teleports straight to the new
      // fork, no walk to animate) — so it never reached tick()'s
      // `leg.arriveFork` branch, the ONLY place that reports "I'm here,
      // resting" to teammates. Nothing ever told anyone else this player
      // arrived; their entry sat wherever the pre-rescue fall/departure
      // tracking last left it (invisible, mid fall-standin). Reporting it
      // explicitly here, exactly as that branch does, is the fix.
      notifyPlayerState();
    }
    rescue = null;
    refreshUI();
  }

  // ---------------------------------------------------------------- alien abduction
  //
  // A flying saucer drops in, beams the player up and carries them off (see
  // alienAbduction.js for the event itself, and app/alien-tuner.html for where
  // its numbers were found).
  //
  // TEMPORARY TRIGGER. Luke, 2026-09-02: "the alien abduction will be
  // triggered by a certain action I haven't told you about yet. For the
  // moment, just have it activated by a button push." So the only thing that
  // fires this today is the 👽 button in the corner (see chrome.js) — when the
  // real trigger arrives it calls startAbduction() and that button goes away.
  // Nothing else here should need to change for that.
  //
  // The event OWNS the figure while it runs: it writes figure.position and
  // figure.rotation.z directly, which is why tick()'s step-bob block has to
  // stand down for the duration (see the `abduction` branch there). It also
  // asks for a camera pitch rather than moving the camera itself, so the
  // game's own trailing camera stays the single thing positioning the view.
  let abduction = null;
  // Kept separate from `abduction` because the rig outlives the sequence: once
  // the saucer has gone it is parked far above the camera doing nothing, and
  // is only torn down on restart. This flag is what the end-of-round message
  // reads to say "taken by aliens" rather than the fall's "the path ran out".
  let abductedThisRound = false;

  /** Frees the rig and hands the figure back to the normal bob code. */
  function clearAbduction() {
    if (!abduction) return;
    abduction.dispose();
    abduction = null;
  }

  /**
   * Starts the event on the local player, where they stand.
   *
   * Only while they are STOPPED — standing on an island between forks, not
   * part-way across a bridge (Luke, 2026-09-02). Refusing rather than
   * cancelling the walk is the whole point: the beam has to hang over a
   * stationary target for its two-and-a-bit seconds, and a card that was
   * mid-stride would either have to teleport to a standstill or be lifted
   * while still sliding along its waypoints. It also keeps the saucer off
   * the bridges, where it would foul the ropes and posts.
   */
  function startAbduction() {
    if (abduction || falling || finished || leg) return;
    abductedThisRound = true;
    abduction = buildAbduction({
      scene,
      textures: { ship: TEX.spaceship, beams: TEX.spaceshipBeams, string: TEX.string },
    });
    // `walker` is deliberately always the bare centreline (see
    // currentSeatLateral's own header) — never where the card is actually
    // drawn once seating is involved. Luke, 2026-09-14, from his own POV
    // mid-abduction while seated off-centre: "the green light and the ship
    // come down to the central position even if the player is to the
    // side... they are not actually within the rings or the ship." Exactly
    // that: the ship/beam/glow anchored on bare `walker`, while the card
    // itself (targetCard: figure) is positioned by tick()'s own bob code
    // from `walker + currentSeatLateral()` — the two silently disagreed.
    // Adding the same seat lateral here is the fix; a spectator's own local
    // replica (see updateTeammate) never had this bug, since it already
    // anchors on the teammate's real RENDERED position.
    const seatNow = currentSeatLateral();
    // Lost the defence: the green light they've been standing under becomes
    // the sequence's own, with no dip — see buildWaitingGlow.
    const glowPreLit = !!localWaitGlow;
    localWaitGlow?.dispose();
    localWaitGlow = null;
    abduction.start({
      at: { x: walker.x + seatNow.x, y: walker.y, z: walker.z + seatNow.z },
      targetCard: figure,
      cardHeight: FIGURE_H,
      cardWidth: FIGURE_H * FIGURE_ASPECT,
      glowPreLit,
    });
    // Luke, 2026-09-13: "being abducted by aliens" is one of the movements
    // everyone else should be able to see. An abduction starts from rest,
    // not from a fork choice, so it's the one case that has to announce
    // 'departing' itself — viewers only apply 'moving' pings to a departing
    // rig (see updateTeammate); the pings themselves follow from tick()'s
    // abduction branch, and 'gone' once the saucer has carried them off.
    notifyPlayerState('departing');
    refreshUI();
  }

  // ---------------------------------------------------------------- pickup
  //
  // The island-2 item, 2026-09-15 — Luke: "just add a very simple icon on
  // the second island, which will be picked up by the first player to reach
  // the island. It will have a 50% chance of being the jetpack, and 50%
  // chance of being the abduction trigger... When the player reaches it it
  // will be transferred to their character." The first real way of earning
  // either; the two test buttons (#addJetpack/#abduct) stay alongside it.
  //
  // Which item it is (`pickupKind`) is a shared fact decided by whoever
  // starts the round, exactly like `words` — never drawn locally except on
  // the solo dev path. WHO gets it is settled the same way a fork choice is
  // ("let the relay be the arbiter", TODO.md): arriving on island 2 sends a
  // `pickup-claim`, and every device — the claimant included, via
  // broadcast self:true — grants it to the FIRST claim the relay hands
  // back, ignoring any later one. Two players stepping off their bridges in
  // the same instant therefore never disagree about who won: the relay's
  // delivery order is the same for everyone. Nothing is ever granted from a
  // device's own local knowledge of who arrived first.
  const PICKUP_FORK = 2;
  const PICKUP_KINDS = ['jetpack', 'abduction'];
  // Luke, 2026-09-15: the island's floating icon should be "the same images
  // used when they are attached to players... 80% of the size... spin about
  // their vertical central axis, revealing their backs which look the same
  // but reversed. Period of 360 degree rotation, 2s." Reuses each kind's own
  // idle frame (POWERUP_FRAMES[kind][0] — Engine1 for the jetpack, the only
  // frame the abduction device has) and frameWorldSize's own maths, scaled
  // by PICKUP_SCALE, so it's never a separate guess at size — a future
  // retune of either card automatically resizes its island icon too. The
  // "reversed back" is free: a plain double-sided plane shows its front
  // texture mirrored when seen from behind, which for a front-to-back
  // symmetric card (an oval with centred art) reads exactly as its own
  // backside.
  const PICKUP_SCALE = 0.8;
  const PICKUP_SPIN_PERIOD = 2; // seconds per full 360°
  const PICKUP_AHEAD = 2.4; // world units forward of the island's centre, so it sits clear of the seated row
  const PICKUP_HOVER_Y = FIGURE_H * 0.9;
  const PICKUP_BOB = 0.12;
  const pickupKind = DEBUG_ABDUCT
    ? 'abduction' // see DEBUG_ABDUCT's own header — forced, not left to pickupOverride/chance
    : PICKUP_KINDS.includes(pickupOverride)
    ? pickupOverride
    : PICKUP_KINDS[Math.random() < 0.5 ? 0 : 1];
  let pickupClaimedBy = null; // token of the winner, once the relay has settled it
  let pickupMesh = null;

  /** Plants the item on island 2 — called from buildJourney() once `sections` exists; a no-op once already claimed this round. */
  function buildPickup() {
    disposePickupMesh();
    if (pickupClaimedBy) return;
    const sec = sections[PICKUP_FORK - 1];
    if (!sec) return;
    const at = advance(sec.fork, sec.fork.heading, PICKUP_AHEAD);
    const frame = POWERUP_FRAMES[pickupKind][0];
    const { w, h } = frameWorldSize(frame);
    pickupMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: TEX[frame.tex], transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, fog: false })
    );
    pickupMesh.scale.set(w * PICKUP_SCALE, h * PICKUP_SCALE, 1);
    pickupMesh.position.set(at.x, PICKUP_HOVER_Y, at.z);
    pickupMesh.userData.baseHeading = sec.fork.heading; // the spin (see updatePickup) is added on top of this, not a replacement for it
    pickupMesh.renderOrder = 5;
    scene.add(pickupMesh);
  }

  function disposePickupMesh() {
    if (!pickupMesh) return;
    scene.remove(pickupMesh);
    pickupMesh.geometry.dispose();
    pickupMesh.material.dispose();
    pickupMesh = null;
  }

  function updatePickup(t) {
    if (!pickupMesh) return;
    pickupMesh.position.y = PICKUP_HOVER_Y + Math.sin(t * 2.2) * PICKUP_BOB;
    pickupMesh.rotation.y = pickupMesh.userData.baseHeading + t * ((2 * Math.PI) / PICKUP_SPIN_PERIOD);
  }

  /** This device just came to rest on a fork (see tick()'s arrival branch) — the one moment a pickup can be claimed, and when an armed abduction fires. */
  function onArrivedAtFork() {
    if (isSpectatorRole(role)) return;
    if (forkIndex === PICKUP_FORK && !pickupClaimedBy) {
      if (onGameEvent) onGameEvent('pickup-claim', {});
      else resolvePickupClaim(myToken ?? 'me'); // solo: no relay, nobody to race
    }
    triggerPendingAbduction(); // see the "abduction targeting" section
  }

  /** The relay's answer to a claim — first one in wins, everywhere; later ones are the losers of a genuine tie and are simply dropped. */
  function resolvePickupClaim(token) {
    if (pickupClaimedBy) return;
    pickupClaimedBy = token;
    disposePickupMesh();
    const mine = token === (myToken ?? 'me');
    if (mine) {
      itemsCollected++; // points system: 0.5 for obtaining either item — see emitRoundEnd
      equipPowerUp(rig, pickupKind);
      // Teammates learn about the new item from this report's own
      // powerupKind flag — same route the test #addJetpack button uses.
      if (!isSpectatorRole(role)) notifyPlayerState();
    }
    refreshUI();
  }

  /** Relayed in-round events, handed in by GameRoom.jsx — see useLobby's `game-event` handler for what reaches here and from whom. */
  function applyGameEvent(kind, payload) {
    if (kind === 'pickup-claim') resolvePickupClaim(payload.token);
    else if (kind === 'abduct-target') receiveAbductionTarget(payload);
    else if (kind === 'abduct-result') receiveAbductionResult(payload);
    else if (kind === 'defence-request') receiveDefenceRequest(payload);
    else if (kind === 'defence-start') receiveDefenceStart(payload);
    else if (kind === 'defence-end') receiveDefenceEnd(payload);
  }

  // ---------------------------------------------------------------- abduction targeting
  //
  // Luke, 2026-09-15: "The alien abduction trigger will target a player in
  // another team: when the player chooses to use it, it will bring down a
  // menu from which they can choose the name of a player on another team.
  // Guides will be excluded. This list will show which island the player is
  // currently on, updating only once they have fully reached the island...
  // When a player is targeted for abduction, nothing will happen until they
  // reach their next island. At this point the abduction will trigger and
  // try to take them away... give them an option: Resist or Go."
  //
  // Three relayed events (see useLobby's `game-event` routing):
  //   'abduct-target' {targetToken, byName} — attacker → the one target;
  //   'abduct-result' {toToken, outcome}    — target's device → attacker,
  //     outcome 'abducted' | 'resisted' | 'fizzled'.
  // The TARGET's own device runs the abduction (its own startAbduction(),
  // so its teammates/guide see it through the existing `abducting`
  // networking) — the attacker's screen shows nothing of it beyond a
  // notice, since the two teams are never on the same islands. Eligibility
  // (other teams, no guides, nobody already out) is useLobby's — the one
  // rule kept here is the "fizzle": a target already on the LAST island has
  // no next island to arrive on, so they're not offered at all, and a
  // target that somehow can't be abducted when the request lands reports
  // 'fizzled' straight back rather than silently swallowing it.
  let pendingAbduction = null; // { byToken, byName } — armed on this device until its next arrival
  let abductPromptOpen = false; // targeted and in the defence (waiting for the guide, or the screen is up) — nothing else may move this player
  // True from the instant a resist is confirmed correct until this defence
  // fully ends — Luke, 2026-09-23: the green light "should be removed as
  // soon as the defender successfully puts in the word", not once the
  // whole close-and-repel sequence has played out. `abductPromptOpen`
  // itself has to stay true that whole time (it's also the movement lock),
  // so this is a second flag purely for notifyPlayerState()'s `defending`
  // — see its own comment.
  let resistConfirmedEarly = false;
  let abductDefense = null; // created once `els.abductDefenseStage` exists — see the els block below
  let abductGuideView = null; // the guide's mirror of it — created once `els.abductGuideStage` exists, same spot
  let noticeTimer = null;

  /** `ms = null` keeps it up until hideNotice(). */
  function showNotice(text, ms = 4000) {
    if (!els.notice) return;
    els.notice.textContent = text;
    els.notice.classList.remove('hidden');
    clearTimeout(noticeTimer);
    if (ms != null) noticeTimer = setTimeout(() => els.notice?.classList.add('hidden'), ms);
  }

  function hideNotice() {
    clearTimeout(noticeTimer);
    els.notice?.classList.add('hidden');
  }

  // The hand-held paper message (Luke, 2026-09-23) — the abduction-defence
  // messages only; everything else still uses #notice. Lowers from the top
  // of the screen (PAPER_SLIDE_MS, matching chrome.js's transition), stays
  // for `ms` once fully down (null = until hidePaperMessage()), then lifts.
  const PAPER_SLIDE_MS = 600;
  const PAPER_FONT_MAX = 0.085; // × the paper's width — shrunk from here until the text fits
  let paperTimer = null;

  function fitPaperMessageText() {
    const box = els.paperMessageText;
    const w = els.paperMessage.clientWidth;
    if (!w) return;
    let size = w * PAPER_FONT_MAX;
    box.style.fontSize = `${size}px`;
    while ((box.scrollHeight > box.clientHeight || box.scrollWidth > box.clientWidth) && size > 8) {
      size *= 0.92;
      box.style.fontSize = `${size}px`;
    }
  }

  function showPaperMessage(text, ms = null) {
    if (!els.paperMessage) return;
    els.paperMessageText.textContent = text;
    fitPaperMessageText();
    // font-display: swap — the first message can arrive before the font has,
    // and fallback cursive measures differently; refit once it's in.
    document.fonts?.load("16px 'Sue Ellen Francisco'").then(fitPaperMessageText, () => {});
    els.paperMessage.classList.add('shown');
    clearTimeout(paperTimer);
    if (ms != null) paperTimer = setTimeout(hidePaperMessage, PAPER_SLIDE_MS + ms);
  }

  function hidePaperMessage() {
    clearTimeout(paperTimer);
    els.paperMessage?.classList.remove('shown');
  }

  // The role note (Luke, 2026-10-07): basic instructions at the start of a
  // round, on a cardboard note that slides in from the right and leaves when
  // tapped. Shown once per round, a moment after the scene appears (or the
  // character screen closes), so it doesn't arrive hidden behind either.
  // A player whose guide's name isn't known (a solo test) gets a version
  // without it.
  const ROLE_NOTE_DELAY_MS = 900;
  const ROLE_NOTE_FONT_MAX = 0.1; // × the note's width — shrunk from here until the text fits
  let roleNoteTimer = null;

  function fitRoleNoteText() {
    const box = els.roleNoteText;
    const w = els.roleNote.clientWidth;
    if (!w) return;
    let size = w * ROLE_NOTE_FONT_MAX;
    box.style.fontSize = `${size}px`;
    while ((box.scrollHeight > box.clientHeight || box.scrollWidth > box.clientWidth) && size > 8) {
      size *= 0.92;
      box.style.fontSize = `${size}px`;
    }
  }

  function showRoleNote() {
    if (!els.roleNote || role === 'watching') return; // a fallen player already knows
    const guideName = guideToken && getDisplayName?.(guideToken);
    els.roleNoteText.textContent =
      role === 'guide'
        ? 'You are the guide. Read the word to your team to guide them to safety.'
        : guideName
          ? `${guideName} is the guide. Listen to them and choose the path with the correct word.`
          : 'Listen to your guide and choose the path with the correct word.';
    clearTimeout(roleNoteTimer);
    roleNoteTimer = setTimeout(() => {
      if (disposed) return;
      els.roleNote.classList.add('shown');
      fitRoleNoteText();
      // As for the paper message: the font can arrive after the first fit.
      document.fonts?.load("16px 'Sue Ellen Francisco'").then(fitRoleNoteText, () => {});
    }, ROLE_NOTE_DELAY_MS);
  }

  function hideRoleNote() {
    clearTimeout(roleNoteTimer);
    els.roleNote?.classList.remove('shown');
  }

  // ---------------------------------------------------------------- abduction cardboard UI
  //
  // The picker surface openAbductMenu()/chooseAbductTarget() actually show
  // — Luke, 2026-09-18: "It's time to insert this into the game as the
  // interface when a player activates the alien abduction device. Include
  // a placeholder team choice window and the arrows to choose the target
  // member, and a confirmation button. The whole process doesn't have to
  // be complete at this stage." Built across several standalone prototypes
  // first (dialProto.js's own header has the full cardboard-UI design
  // history; TODO.md points at each one) — this wires those same ideas to
  // REAL data as a 2D canvas overlay laid over the game inside #abductStage
  // (a plain DOM element the WebGL canvas knows nothing about, exactly like
  // the rest of the HUD).
  //
  // A target's avatar/name-tag glow show their REAL character/colour, from
  // `getAbductionTargets()`'s characterKey/colorHex (useLobby.js now records
  // every player-state ping session-wide, not just same-group ones — see
  // that file's charByTokenRef, added 2026-09-19 to close the gap this
  // comment used to describe). The 'ghost'/gold pairing lives on only as
  // the fallback for a target whose characterKey is still null — this
  // device hasn't received a ping from them yet this round, a brief window
  // right at round start, not a permanent unknown.
  //
  // THE SEQUENCE: the panel lowers on strings from off-screen (same maths
  // as alien-lower.html's prototype — a long fixed string length is
  // provably enough to stay off-screen at any panel size, never a tracked
  // anchor point), the alien screen grows open (the two-step widen-then-
  // open alien-interface.html settled on), then the first target's avatar
  // plays the glitch-slice reveal Luke picked (variant 2 of six, 0.30s),
  // after which it spins continuously about its own vertical axis (never
  // the name tag) until the arrows change it. An arrow press ALWAYS
  // restarts the reveal from t=0 for the newly-selected target, even
  // mid-reveal — Luke: "if the player presses the button before the
  // animation is complete, interrupt and move to the next player" — so
  // there is deliberately no "ignore while animating" guard here, unlike
  // the dial's own turn.
  const ABDUCT_STRING_SRC = 'textures/hanging-string.png';
  const ABDUCT_STRING_TILE = { w: 67, h: 526 };
  const ABDUCT_STRING_CENTER_X = 35; // the rope's own opaque centre within that 67px-wide tile — see alienLowerProto.js
  const ABDUCT_STRING_LEN = 2400; // canvas-space px; see this section's header
  const ABDUCT_ARROW_LEFT_SRC = 'textures/alien-arrow-left.png';
  const ABDUCT_ARROW_RIGHT_SRC = 'textures/alien-arrow-right.png';
  const ABDUCT_EARTH_SRC = 'textures/earth.png';
  const ABDUCT_TAG_GLOW = '#ffe9b8'; // fallback glow, for a target with no colorHex yet — see this section's header

  const ABDUCT_AVATAR = { height: 224, centerY: 343 };
  const ABDUCT_TAG = { height: 49, centerY: 189 };
  const ABDUCT_ARROW = { size: 114, centerY: 350, inset: 267 };
  // The team-name label — Luke, 2026-09-20: "increase the size of the text
  // by 100%... it needs arrows on either side for cycling through teams.
  // Move the team name to the right a bit and put a smaller version (30%
  // size) of the arrows... either side of it." Sizes are panel-local px,
  // same space as everything else here; ABDUCT_TEAM_ARROW_SCALE is applied
  // to ABDUCT_ARROW's own size, not a separate guess, so "30% of the
  // [avatar] arrows" stays true even if those are ever retuned.
  const ABDUCT_TEAM_FONT_SIZE = 30; // was 15 — "100%" bigger
  const ABDUCT_TEAM_BOX_HEIGHT = 70; // was 50 — grown to comfortably fit the bigger text
  const ABDUCT_TEAM_TEXT_OFFSET_X = 30; // "move the team name to the right a bit"
  const ABDUCT_TEAM_ARROW_SCALE = 0.3;
  const ABDUCT_TEAM_ARROW_GAP = 10; // between an arrow and the team text
  // Target cluster group offset — Luke, 2026-09-19, next step toward the
  // ship-formation animation: "moving the avatar and arrows left and down
  // to make room for the Earth on the bottom right," from a mockup showing
  // the whole target cluster (avatar, name tag, both arrows) sliding as one
  // unit from dead centre to a bottom-left box. Applied uniformly to
  // ABDUCT_AVATAR/ABDUCT_TAG/ABDUCT_ARROW's centres in abductAvatarRect/
  // abductArrowRects/abductDraw's own tag placement, rather than moving
  // each of those constants individually, so the cluster's own internal
  // spacing (avatar-to-tag, avatar-to-arrows) stays exactly what it already
  // was — only WHERE the whole group sits changes. Baked from the
  // `?abductTune=1` panel's logged values (now removed).
  const ABDUCT_TARGET_OFFSET = { x: -183, y: 52 };
  // Earth — Luke, 2026-09-19: static for now, bottom-right of the interface,
  // sized/positioned to fit the room the target-cluster move above frees up.
  // The small formation of ships descending toward it (from his second
  // reference image) is explicitly NOT this step: "Don't try to add the
  // ship yet, we'll do that next." Baked from the `?abductTune=1` panel's
  // logged values (now removed) — deliberately sized/placed so the
  // interface's own bottom edge clips it (see abductDraw's clip around the
  // earth draw): "I want the border to cut the Earth, so that the bottom
  // of the Earth is missing," not the other way around (Earth overlapping
  // and visually cutting across the border, which is what an earlier,
  // unclipped draw did).
  const ABDUCT_EARTH = { width: 220, centerX: 801, centerY: 462 };
  // Luke, 2026-09-19: "the same shimmer used to make the avatars appear...
  // but this shimmer should go top to bottom, and should begin 0.3s after
  // the rest of the interface is loaded." Same ABDUCT_GLITCH_DURATION as
  // the avatar's own reveal (just mirrored — see abductDrawEarthGlitch),
  // offset by this delay from the SAME anchor instant as the avatar's own
  // clock (see abductEarthRevealStartedAt) — not from each arrow press,
  // since the Earth isn't per-target and has nothing to restart for.
  const ABDUCT_EARTH_REVEAL_DELAY = 0.3;
  const ABDUCT_GLITCH_DURATION = 0.3; // Luke, 2026-09-18: "0.30s animation duration for the player avatar wipe"
  const ABDUCT_SPIN_PERIOD = 9; // Luke, 2026-09-19: slow to ~33% of the original speed (was 3)
  const ABDUCT_LOWER_DURATION = 0.9;
  const ABDUCT_FILL_FRACTION = 0.92;
  const ABDUCT_TOP_MARGIN = 0.05;

  // ---- confirmation dynamic (2026-09-19) ----
  // Luke: "when a player clicks on a player's avatar, both the avatar and
  // the Earth will be bordered in a new green border. At the same time, the
  // new animation will begin, with the small spaceships seeming to leave
  // the Earth via a curved path... clicking the avatar again will deselect.
  // Clicking an arrow to move to the next target will also deselect." A
  // real confirm button comes later ("don't worry about that yet") — this
  // step is only the selection toggle, the highlight, and the ship
  // animation. See abductToggleSelect (click handling), ABDUCT_SELECT_*
  // (the bracket-image highlight, replacing an earlier 6-drawn-style
  // exploration Luke didn't want — "I don't like the border options...
  // add these images as brackets around the player" instead), and
  // ABDUCT_SHIP_POSITIONS below.
  //
  // Second pass, same day: no aura ("I don't like the aura that's been
  // added around the ship. Remove it"), no per-position growth/brightening
  // either ("Forget about changing brightness and size: have it at full
  // size for all instances") — both were Claude's own embellishment on top
  // of "a crude animation... shown in only five positions," not something
  // Luke asked for the first time round. The ship art itself was also
  // swapped for a version with the cardboard backing stripped out (same
  // filename, replaced on disk — re-copied over the old one).
  const ABDUCT_SHIP_SRC = 'textures/abduct-ship-small.png';
  // Five fixed stops along the "curved path," baked from the numbers Luke
  // logged against the live tuner (position/gap duration, and an offset+
  // scale nudge applied uniformly to all five — see ABDUCT_SHIP_PATH_ADJUST
  // below for why a per-stop `scale` is gone; the same nudge maths still
  // applies at draw time in abductDrawShip, just baked to fixed values now
  // instead of a slider). These five are now KEYPOINTS a curve is fitted
  // through, not the drawn positions themselves — see ABDUCT_SHIP_POSITIONS
  // just below, 2026-09-20: "double the number of instances in the
  // animation, and make it look like a curved path."
  const ABDUCT_SHIP_KEYPOINTS = [
    { x: 847, y: 297 },
    { x: 885, y: 242 },
    { x: 842, y: 186 },
    { x: 743, y: 143 },
    { x: 629, y: 100 },
  ];
  /** Catmull-Rom spline through `pts`, at global parameter t∈[0,1] across the WHOLE path (not one segment) — interpolates smoothly through every keypoint, unlike a single Bezier which would only pass through its own two endpoints. Clamps the neighbour lookups at the ends so the curve still reaches pts[0]/pts[last] exactly rather than needing phantom points past them. */
  function abductCatmullRom(pts, t) {
    const n = pts.length;
    const scaled = t * (n - 1);
    const seg = Math.min(n - 2, Math.floor(scaled));
    const lt = scaled - seg;
    const p0 = pts[Math.max(0, seg - 1)];
    const p1 = pts[seg];
    const p2 = pts[seg + 1];
    const p3 = pts[Math.min(n - 1, seg + 2)];
    const lt2 = lt * lt;
    const lt3 = lt2 * lt;
    const axis = (a, b, c, d) => 0.5 * (2 * b + (c - a) * lt + (2 * a - 5 * b + 4 * c - d) * lt2 + (3 * b - a - 3 * c + d) * lt3);
    return { x: axis(p0.x, p1.x, p2.x, p3.x), y: axis(p0.y, p1.y, p2.y, p3.y) };
  }
  // "Double the number of instances" (was 5) — sampled evenly along the
  // Catmull-Rom curve above, so doubling the count alone is what makes the
  // path read as smoothly curved rather than a jagged 5-point hop: the
  // JUMP-CUT style itself is unchanged (still no tweening BETWEEN whichever
  // two of these are current — "a crude animation... shown in only five
  // [now ten] positions" still holds), just twice as many, twice as close
  // together, and lying on an actual curve instead of eyeballed points.
  const ABDUCT_SHIP_POSITION_COUNT = 10;
  const ABDUCT_SHIP_POSITIONS = Array.from({ length: ABDUCT_SHIP_POSITION_COUNT }, (_, i) =>
    abductCatmullRom(ABDUCT_SHIP_KEYPOINTS, i / (ABDUCT_SHIP_POSITION_COUNT - 1))
  );
  const ABDUCT_SHIP_WIDTH = 90; // same size at every stop — no per-position `scale`
  // Luke's logged values, replacing the `?abductTune=1` sliders that found them.
  const ABDUCT_SHIP_PATH_ADJUST = { offsetX: 21, offsetY: -1, scale: 0.87 };
  // Halved from the original 0.13s — Luke asked to double the instance
  // count, not double how long the whole sweep takes to play out, so the
  // per-instance duration is halved to keep the total sweep time
  // (instances × duration) the same as before (~0.65s) rather than silently
  // doubling it as a side effect of just adding more steps. Flagging this
  // as a judgment call rather than something he asked for directly.
  const ABDUCT_SHIP_POSITION_DURATION = 0.065;
  const ABDUCT_SHIP_GAP_DURATION = 0.25;
  // The new avatar-highlight brackets — Luke: "I've decided to skip the
  // border around the planet, and add these images as brackets around the
  // player." He supplied one image per side, but Luke, having seen the two
  // drawn at their own (slightly different, 105×282 vs 118×305) sizes: "the
  // left and right borders are not the same size. Choose one and duplicate
  // and turn it, as I suggested" (his own original suggestion: "If it's
  // easier to use one and then flip it 180 degrees for the other side, do
  // that"). Only the left image is loaded now — see abductDrawSelectBrackets
  // for the horizontal mirror that draws the right side from it, which is
  // what actually reproduces a matching pair (the two source files ARE
  // horizontal mirrors of each other, not 180°-rotations — a true 180°
  // turn would also flip the gear-notch bump vertically, landing it upside
  // down relative to the source art). Position/size baked from the
  // `?abductTune=1` panel's logged values (now removed) — a negative `gap`
  // means the bracket's inner edge overlaps INTO the avatar's own edge by
  // that many px, not a gap outward.
  const ABDUCT_SELECT_SRC = 'textures/abduct-select-left.png';
  const ABDUCT_SELECT_BRACKET = { height: 230, gap: -40 };

  // The rune circle — Luke, 2026-09-20: "Time for the confirm button.
  // Remove the existing confirm button. Add these icons in the place noted
  // by the circle in the image provided... Ignore the colours (red and
  // white) of the circle; put the runes onto the background without adding
  // anything behind them." Position/size baked from the `?abductTune=1`
  // panel's logged values (now removed).
  const ABDUCT_RUNES_SRC = 'textures/abduct-runes.png';
  const ABDUCT_RUNES = { centerX: 558, centerY: 274, size: 118 };
  // "Add a thin green ring around them with two gaps in it, with those gaps
  // at 135 degrees and 315 degrees, and short lines perpendicular to
  // circumference of the circle... The ring should be quite close to the
  // runes but should not touch any of them." Also baked from the tuner —
  // `angleOffset` (-90°, i.e. the whole ring rotated a quarter-turn from
  // plain canvas 135°/315°) is what actually matched Luke's own mental
  // picture of where the two gaps should sit; see the ring-drawing
  // function for the plain-canvas-angle convention this offset is applied
  // on top of. "The rings should only appear when there is a selection" —
  // 2026-09-20, correcting the first pass, which drew the ring always and
  // only gated its SPIN on selection; now the whole ring (arcs + ticks) is
  // skipped entirely while unselected, only the runes stay always-visible.
  const ABDUCT_RUNE_RING = { radius: 76, lineWidth: 4, gapDeg: 15, tickLen: 12, angleOffset: (-90 * Math.PI) / 180 };
  // "When the target is selected, this ring should start to rotate
  // anti-clockwise at a rate of 2 revolutions per second" — then, 2026-09-20:
  // "I was wrong about the speed, it's much too fast: reduce it to one third
  // of what it is now" (2 -> 2/3). Negative because canvas angles increase
  // clockwise, so a NEGATIVE rotation is what reads as anti-clockwise on screen.
  const ABDUCT_RING_SPIN_RATE = -2 / 3; // revolutions/second
  // "Could you also make both the runes and the Earth 'glow' subtly?" —
  // then, on being asked to clarify: "the glow effect should only be
  // active when a target is selected." A soft shadowBlur halo in the same
  // established green (matches the glitch-slice tint/ship glow elsewhere in
  // this section) rather than a second drawn layer — cheap, and reads as
  // "glowing" without needing its own asset.
  const ABDUCT_GLOW_COLOR = 'rgba(120, 255, 160, 0.9)';
  const ABDUCT_GLOW_BLUR = 16;
  // "Increase the brightness of the runes when there is a selection? Not
  // the background but the runes themselves?" — distinct from the glow
  // above (which halos the OUTSIDE of the shape): a canvas `filter`
  // (same CSS filter syntax as an element's own `filter` style) applied
  // just to a drawImage call brightens the actual pixels of that art, not
  // anything around it. Standard Canvas2D API, well supported — nothing
  // hacky about it. Also applied to Earth's own draw call, same day —
  // Luke: "make the colour and brightness of the glow around the Earth
  // [match] the selected runes" (the halo colour was already shared via
  // ABDUCT_GLOW_COLOR; the runes' own pixel-brightness boost wasn't, which
  // is what was actually reading as a mismatch between the two).
  const ABDUCT_SELECTED_BRIGHTNESS = 'brightness(1.6)';

  // Every ROSTER character, not just 'ghost' — a target's real card art
  // (see the header above) needs the whole set on hand, keyed the same way
  // CHAR_TEX already is. 'ghost' is still IN this set (ROSTER carries it),
  // so it doubles as the fallback lookup with no separate load of its own.
  let abductImgs = null;
  const abductImgsPromise = Promise.all([
    loadAbductImage(ABDUCT_PANEL_SRC),
    loadAbductImage(ABDUCT_INTERFACE_SRC),
    loadAbductImage(ABDUCT_STRING_SRC),
    loadAbductImage(ABDUCT_ARROW_LEFT_SRC),
    loadAbductImage(ABDUCT_ARROW_RIGHT_SRC),
    loadAbductImage(ABDUCT_EARTH_SRC),
    loadAbductImage(ABDUCT_SHIP_SRC),
    loadAbductImage(ABDUCT_SELECT_SRC),
    loadAbductImage(ABDUCT_RUNES_SRC),
    Promise.all(ROSTER.map((c) => loadAbductImage(`textures/${c.tex}.${c.ext}`).then((img) => [c.key, img]))),
  ])
    .then(([panel, iface, string, arrowLeft, arrowRight, earth, ship, select, runes, charPairs]) => {
      abductImgs = { panel, iface, string, arrowLeft, arrowRight, earth, ship, select, runes, chars: new Map(charPairs) };
    })
    .catch((err) => console.error('[abductUI] asset load failed', err));

  /** The image to draw for a target: their real character if known, else the 'ghost' fallback — see this section's header. */
  function abductAvatarImg(target) {
    return (target?.characterKey && abductImgs.chars.get(target.characterKey)) || abductImgs.chars.get('ghost');
  }

  let abductCtx = null;
  let abductTargets = [];
  let abductIndex = 0;
  let abductRevealStartedAt = 0; // avatar glitch-reveal clock — reset on every arrow press, even mid-reveal
  let abductEarthRevealStartedAt = 0; // Earth's own shimmer clock — set ONCE, at the same instant as abductRevealStartedAt's first value, and never reset by arrow presses (the Earth isn't per-target)
  let abductAnim = null; // { phase: 'lowering' | 'growing' | 'interactive', startedAt, growStartedAt }
  let abductRafId = null;
  const abductTagCache = new Map(); // token -> { canvas, aspect } — built once per target seen, kept for the round
  // Confirmation-dynamic state (see this section's "confirmation dynamic"
  // header) — abductSelected toggles on an avatar click and off on either a
  // second click or any arrow press (abductStep clears it); abductShipCycleStartedAt
  // is the ship animation's own clock, restarted fresh each time selection
  // turns ON (not shared with the avatar/Earth reveal clocks — those play
  // once per target, this loops for as long as the target stays selected).
  let abductSelected = false;
  let abductShipCycleStartedAt = 0;

  function abductAvatarRect(img) {
    const iface = abductFinalRect();
    const aspect = img.naturalWidth / img.naturalHeight;
    const w = ABDUCT_AVATAR.height * aspect;
    const cx = iface.x + iface.w / 2 + ABDUCT_TARGET_OFFSET.x;
    const cy = ABDUCT_AVATAR.centerY + ABDUCT_TARGET_OFFSET.y;
    return { x: cx - w / 2, y: cy - ABDUCT_AVATAR.height / 2, w, h: ABDUCT_AVATAR.height, cx, cy };
  }

  function abductArrowRects() {
    const iface = abductFinalRect();
    const half = ABDUCT_ARROW.size / 2;
    const leftX = iface.x + ABDUCT_ARROW.inset + ABDUCT_TARGET_OFFSET.x;
    const rightX = iface.x + iface.w - ABDUCT_ARROW.inset + ABDUCT_TARGET_OFFSET.x;
    const centerY = ABDUCT_ARROW.centerY + ABDUCT_TARGET_OFFSET.y;
    return {
      left: { x: leftX - half, y: centerY - half, w: ABDUCT_ARROW.size, h: ABDUCT_ARROW.size },
      right: { x: rightX - half, y: centerY - half, w: ABDUCT_ARROW.size, h: ABDUCT_ARROW.size },
    };
  }

  /** The Earth's rect at its currently-tuned size/position — see ABDUCT_EARTH. */
  function abductEarthRect() {
    const aspect = abductImgs.earth.naturalWidth / abductImgs.earth.naturalHeight;
    const w = ABDUCT_EARTH.width;
    const h = w / aspect;
    return { x: ABDUCT_EARTH.centerX - w / 2, y: ABDUCT_EARTH.centerY - h / 2, w, h };
  }

  function abductPointInRect(x, y, r) {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  /** Async name-tag build, cached per token — real cardboard lettering, the actual in-game renderer (see nameTag.js), same one attachNameTag uses. Returns null (draw nothing this frame) until the build resolves. */
  function abductGetTag(target) {
    const cached = abductTagCache.get(target.token);
    if (cached) return cached;
    if (cached === null) return null; // build already in flight
    abductTagCache.set(target.token, null);
    buildNameTagCanvas(target.displayName ?? target.token, { glowColor: target.colorHex ?? ABDUCT_TAG_GLOW })
      .then(({ canvas, aspect }) => abductTagCache.set(target.token, { canvas, aspect }))
      .catch((err) => console.error('[abductUI] name tag build failed', err));
    return null;
  }

  /** Glitch-slice avatar reveal — Luke's pick, variant 2 of six built in alienFizzleProto.js (see that file's own effect2 for the original this mirrors). Bottom-up, green-tinted, sideways-shifted slices near the still-hidden edge. */
  function abductDrawAvatarGlitch(ctx, img, r, p) {
    const revealY = r.y + r.h * (1 - p);
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, revealY, r.w, r.y + r.h - revealY);
    ctx.clip();
    ctx.drawImage(img, r.x, r.y, r.w, r.h);
    ctx.restore();
    if (p <= 0 || p >= 1) return;
    const glitchH = 46;
    const top = Math.max(r.y, revealY - glitchH);
    const sliceH = 4;
    for (let y = top; y < revealY; y += sliceH) {
      if (Math.random() < 0.35) continue;
      const offset = (Math.random() - 0.5) * 26;
      const srcY = ((y - r.y) / r.h) * img.naturalHeight;
      const srcH = (sliceH / r.h) * img.naturalHeight;
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, y, r.w, sliceH);
      ctx.clip();
      ctx.drawImage(img, 0, srcY, img.naturalWidth, srcH, r.x + offset, y, r.w, sliceH);
      ctx.fillStyle = 'rgba(120, 255, 160, 0.32)';
      ctx.fillRect(r.x, y, r.w, sliceH);
      ctx.restore();
    }
  }

  /**
   * Same glitch-slice shimmer as abductDrawAvatarGlitch, mirrored top-to-
   * bottom for the Earth's own reveal — Luke, 2026-09-19: "the same shimmer
   * used to make the avatars appear... but this shimmer should go top to
   * bottom." The growing edge (where the glitch band rides) is therefore the
   * BOTTOM of the revealed region here, not the top.
   */
  function abductDrawEarthGlitch(ctx, img, r, p) {
    const revealBottom = r.y + r.h * p;
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, revealBottom - r.y);
    ctx.clip();
    ctx.drawImage(img, r.x, r.y, r.w, r.h);
    ctx.restore();
    if (p <= 0 || p >= 1) return;
    const glitchH = 46;
    const bottom = Math.min(r.y + r.h, revealBottom + glitchH);
    const sliceH = 4;
    for (let y = revealBottom; y < bottom; y += sliceH) {
      if (Math.random() < 0.35) continue;
      const offset = (Math.random() - 0.5) * 26;
      const srcY = ((y - r.y) / r.h) * img.naturalHeight;
      const srcH = (sliceH / r.h) * img.naturalHeight;
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, y, r.w, sliceH);
      ctx.clip();
      ctx.drawImage(img, 0, srcY, img.naturalWidth, srcH, r.x + offset, y, r.w, sliceH);
      ctx.fillStyle = 'rgba(120, 255, 160, 0.32)';
      ctx.fillRect(r.x, y, r.w, sliceH);
      ctx.restore();
    }
  }

  /**
   * The "leaving Earth" ship loop — Luke, 2026-09-19: "a crude animation
   * with a small version of the alien spaceship shown in only five
   * positions." Deliberately a jump-cut between ABDUCT_SHIP_POSITIONS, not
   * a tween — "crude" and "only five positions" both say so. `elapsed` is
   * seconds since abductShipCycleStartedAt; the cycle is the 5 positions at
   * ABDUCT_SHIP_POSITION_DURATION each, then a silent gap of
   * ABDUCT_SHIP_GAP_DURATION before it restarts from position 1 — draws
   * nothing during that gap. Same full size/opacity at every stop — an
   * earlier pass grew/brightened the ship across the 5 stops and added a
   * green "materialising" glow behind it; Luke, same day: "I don't like the
   * aura that's been added around the ship. Remove it" and "forget about
   * changing brightness and size: have it at full size for all instances."
   */
  function abductDrawShip(ctx, img, elapsed) {
    const n = ABDUCT_SHIP_POSITIONS.length;
    const cycleLen = ABDUCT_SHIP_POSITION_DURATION * n + ABDUCT_SHIP_GAP_DURATION;
    const t = elapsed % cycleLen;
    if (t >= ABDUCT_SHIP_POSITION_DURATION * n) return; // in the gap — nothing to draw
    const stepIndex = Math.min(n - 1, Math.floor(t / ABDUCT_SHIP_POSITION_DURATION));
    const raw = ABDUCT_SHIP_POSITIONS[stepIndex];
    // See ABDUCT_SHIP_PATH_ADJUST's own header — pivots the scale on Earth's
    // own centre so "scale" reads as "how far out the path reaches," not an
    // arbitrary stretch from the canvas origin.
    const x = ABDUCT_EARTH.centerX + (raw.x - ABDUCT_EARTH.centerX) * ABDUCT_SHIP_PATH_ADJUST.scale + ABDUCT_SHIP_PATH_ADJUST.offsetX;
    const y = ABDUCT_EARTH.centerY + (raw.y - ABDUCT_EARTH.centerY) * ABDUCT_SHIP_PATH_ADJUST.scale + ABDUCT_SHIP_PATH_ADJUST.offsetY;
    const w = ABDUCT_SHIP_WIDTH;
    const h = w * (img.naturalHeight / img.naturalWidth);
    ctx.drawImage(img, x - w / 2, y - h / 2, w, h);
  }

  /**
   * The avatar-selection highlight — Luke, 2026-09-19, second pass: "I
   * don't like the border options. I've decided to skip the border around
   * the planet, and add these images as brackets around the player." One
   * real art asset (see ABDUCT_SELECT_SRC's own header for why only one,
   * not two), drawn once normally for the left side and once horizontally
   * mirrored for the right — the source art's own left/right pair were
   * mirrors of each other, so this reproduces the same look from a single
   * file with no distortion.
   */
  function abductDrawSelectBrackets(ctx, avatarRect, img) {
    const h = ABDUCT_SELECT_BRACKET.height;
    const w = h * (img.naturalWidth / img.naturalHeight);
    const y = avatarRect.cy - h / 2;

    const leftX = avatarRect.x - ABDUCT_SELECT_BRACKET.gap - w;
    ctx.drawImage(img, leftX, y, w, h);

    const rightX = avatarRect.x + avatarRect.w + ABDUCT_SELECT_BRACKET.gap;
    ctx.save();
    ctx.translate(rightX + w, 0); // horizontal mirror, pivoting on the drawn rect's own right edge
    ctx.scale(-1, 1);
    ctx.drawImage(img, 0, y, w, h);
    ctx.restore();
  }

  /**
   * The rune circle — see ABDUCT_RUNES/ABDUCT_RUNE_RING/ABDUCT_RING_SPIN_RATE/
   * ABDUCT_SELECTED_BRIGHTNESS's own headers for the full ask. Runes are drawn
   * plain (no backing shape — Luke: "put the runes onto the background
   * without adding anything behind them"), always visible once interactive;
   * the ring — two arcs with a gap centred on each of ABDUCT_RUNE_RING's two
   * angles, plus four short radial tick marks at the gap edges, all rotated
   * together as one unit — is drawn ONLY while `selected` ("the rings should
   * only appear when there is a selection"). `selected` also gates the glow
   * and brightness boost on the runes — Earth's own glow is applied at its
   * own draw call, not here.
   */
  function abductDrawRunesAndRing(ctx, runesImg, selectedElapsed, selected) {
    const { centerX: cx, centerY: cy, size } = ABDUCT_RUNES;

    ctx.save();
    if (selected) {
      ctx.shadowColor = ABDUCT_GLOW_COLOR;
      ctx.shadowBlur = ABDUCT_GLOW_BLUR;
      ctx.filter = ABDUCT_SELECTED_BRIGHTNESS; // brightens the runes' OWN pixels — see that constant's header for why this is separate from the halo above
    }
    ctx.drawImage(runesImg, cx - size / 2, cy - size / 2, size, size);
    ctx.restore();

    if (!selected) return;

    const spinAngle = selectedElapsed * ABDUCT_RING_SPIN_RATE * 2 * Math.PI;
    const gapHalf = ((ABDUCT_RUNE_RING.gapDeg / 2) * Math.PI) / 180;
    const gA = (135 * Math.PI) / 180 + ABDUCT_RUNE_RING.angleOffset;
    const gB = (315 * Math.PI) / 180 + ABDUCT_RUNE_RING.angleOffset;
    const r = ABDUCT_RUNE_RING.radius;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(spinAngle);
    ctx.strokeStyle = '#33ff66';
    ctx.lineWidth = ABDUCT_RUNE_RING.lineWidth;
    ctx.beginPath();
    ctx.arc(0, 0, r, gA + gapHalf, gB - gapHalf);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, r, gB + gapHalf, gA + 2 * Math.PI - gapHalf);
    ctx.stroke();
    const half = ABDUCT_RUNE_RING.tickLen / 2;
    for (const ang of [gA - gapHalf, gA + gapHalf, gB - gapHalf, gB + gapHalf]) {
      const cos = Math.cos(ang);
      const sin = Math.sin(ang);
      ctx.beginPath();
      ctx.moveTo(cos * (r - half), sin * (r - half));
      ctx.lineTo(cos * (r + half), sin * (r + half));
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Sizes/positions the (taller-than-its-viewport) canvas for the current window size — see this section's header for why the string is just a long fixed length. Cheap; called every frame rather than wired to a separate resize listener. */
  function abductLayout() {
    const vw = els.abductStage.clientWidth;
    const vh = els.abductStage.clientHeight;
    const scale = Math.min((vw * ABDUCT_FILL_FRACTION) / ABDUCT_PANEL_SIZE.w, (vh * ABDUCT_FILL_FRACTION) / ABDUCT_PANEL_SIZE.h);
    const cssW = ABDUCT_PANEL_SIZE.w * scale;
    const cssH = (ABDUCT_STRING_LEN + ABDUCT_PANEL_SIZE.h) * scale;
    els.abductCanvas.style.width = `${cssW}px`;
    els.abductCanvas.style.height = `${cssH}px`;
    const cssLeft = (vw - cssW) / 2;
    els.abductCanvas.style.left = `${cssLeft}px`;
    const restingPanelTop = vh * ABDUCT_TOP_MARGIN;
    const restY = restingPanelTop - ABDUCT_STRING_LEN * scale;
    const startY = -cssH;
    return { scale, cssLeft, startY, restY };
  }

  /** Positions the team name + its two cycling arrows in real pixels — computed once the panel is at rest, from the same scale/offset abductLayout() just used, converting fixed panel-space rects into screen space. Percentages of #abductStage would drift while the canvas is mid-descent; see chrome.js's own comment. */
  function abductPositionOverlayButtons(scale, cssLeft, restY) {
    const iface = abductFinalRect();
    const toScreen = (localX, localY) => ({
      x: cssLeft + localX * scale,
      y: restY + (ABDUCT_STRING_LEN + localY) * scale,
    });
    const teamX = iface.x + 40 + ABDUCT_TEAM_TEXT_OFFSET_X;
    const teamY = iface.y + 25;
    const team = toScreen(teamX, teamY);
    els.abductTeamBox.style.left = `${team.x}px`;
    els.abductTeamBox.style.top = `${team.y}px`;
    els.abductTeamBox.style.height = `${ABDUCT_TEAM_BOX_HEIGHT * scale}px`;
    els.abductTeamBox.style.fontSize = `${ABDUCT_TEAM_FONT_SIZE * scale}px`;

    const arrowSizeLocal = ABDUCT_ARROW.size * ABDUCT_TEAM_ARROW_SCALE;
    const arrowSizePx = arrowSizeLocal * scale;
    const arrowYLocal = teamY + (ABDUCT_TEAM_BOX_HEIGHT - arrowSizeLocal) / 2;
    const leftXLocal = teamX - ABDUCT_TEAM_ARROW_GAP - arrowSizeLocal;
    const left = toScreen(leftXLocal, arrowYLocal);
    els.abductTeamLeft.style.left = `${left.x}px`;
    els.abductTeamLeft.style.top = `${left.y}px`;
    els.abductTeamLeft.style.width = `${arrowSizePx}px`;
    els.abductTeamLeft.style.height = `${arrowSizePx}px`;

    // The right arrow sits just after the team name's own REAL rendered
    // width, measured from the DOM rather than guessed — "Team 12" and
    // "Team 2" are different widths in a variable-width font, and the box
    // itself is sized to its own text (no fixed width any more), so this
    // is the only way the arrow actually sits right next to the text
    // rather than at some average guessed offset.
    const boxRect = els.abductTeamBox.getBoundingClientRect();
    const gapPx = ABDUCT_TEAM_ARROW_GAP * scale;
    els.abductTeamRight.style.left = `${boxRect.right + gapPx}px`;
    els.abductTeamRight.style.top = `${team.y + (boxRect.height - arrowSizePx) / 2}px`;
    els.abductTeamRight.style.width = `${arrowSizePx}px`;
    els.abductTeamRight.style.height = `${arrowSizePx}px`;
  }

  function abductUpdateTeamBox() {
    const t = abductTargets[abductIndex];
    if (t && els.abductTeamBox) els.abductTeamBox.textContent = `Team ${t.groupId}`;
  }

  /** Draws one frame: strings (static art, always the same length/position) + panel + growing interface + (once fully open) avatar/name-tag/arrows. `growthElapsed` is null while the panel is still lowering — the interface hasn't started growing yet, so nothing of it is drawn at all (see abductTick's 'lowering' branch). `revealNow` is null before the interface has finished growing — nothing to show yet. */
  function abductDraw(growthElapsed, revealNow) {
    abductCtx.clearRect(0, 0, els.abductCanvas.width, els.abductCanvas.height);
    for (const hole of ABDUCT_PANEL_HOLES) {
      const x = hole.x - ABDUCT_STRING_CENTER_X;
      for (let y = ABDUCT_STRING_LEN; y > 0; y -= ABDUCT_STRING_TILE.h) {
        abductCtx.drawImage(abductImgs.string, x, y - ABDUCT_STRING_TILE.h, ABDUCT_STRING_TILE.w, ABDUCT_STRING_TILE.h);
      }
    }
    abductCtx.save();
    abductCtx.translate(0, ABDUCT_STRING_LEN); // panel-local (0,0) is now at canvas (0, ABDUCT_STRING_LEN)
    drawAbductPanel(abductCtx, abductImgs.panel);
    // Luke, 2026-09-19: "When the cardboard backing is lowered from the top,
    // it already has the thin rectangle that will grow into the green UI
    // background. Please remove this thin rectangle, and only have it
    // appear when the animation starts." drawInterfaceGrowth(elapsed=0)
    // draws the interface at its own startWidth/startHeight — a real sliver,
    // not nothing — which is exactly that thin rectangle; skipping the call
    // entirely while still lowering is what actually hides it, since 0 is a
    // valid elapsed value to that function, not an "off" signal.
    if (growthElapsed !== null) drawInterfaceGrowth(abductCtx, abductImgs.iface, growthElapsed);

    if (revealNow !== null) {
      // Static for now — see ABDUCT_EARTH's own header. Drawn before the
      // target cluster so it always sits "behind" in draw order. Clipped to
      // the interface's own rect — Luke: "I want the border to cut the
      // Earth, so that the bottom of the Earth is missing," the opposite of
      // an earlier unclipped draw where Earth spilled past the border and
      // visually cut across IT instead.
      const iface = abductFinalRect();
      const er = abductEarthRect();
      const earthElapsed = (revealNow - abductEarthRevealStartedAt) / 1000 - ABDUCT_EARTH_REVEAL_DELAY;
      const earthP = Math.max(0, Math.min(1, earthElapsed / ABDUCT_GLITCH_DURATION));
      abductCtx.save();
      abductCtx.beginPath();
      abductCtx.rect(iface.x, iface.y, iface.w, iface.h);
      abductCtx.clip();
      // Earth's own half of "make both the runes and the Earth glow subtly
      // [only] when a target is selected" — the brightness boost the runes
      // get too (see ABDUCT_SELECTED_BRIGHTNESS's header).
      if (abductSelected) {
        abductCtx.filter = ABDUCT_SELECTED_BRIGHTNESS;
      }
      abductDrawEarthGlitch(abductCtx, abductImgs.earth, er, earthP);
      abductCtx.restore();

      // Luke, 2026-09-20: "It should look the same colour and brightness as
      // the rotating rings, but it's a lot dimmer." A shadowBlur cast FROM
      // the earth image (the first attempt at this) is only ever as bright
      // as the image's OWN edge pixels allow it to be, which is nothing
      // like the ring's fully-opaque solid stroke — no amount of shadow
      // alpha fixes that, since the shadow's source colour is the image,
      // not a flat green. Matching "same colour and brightness" means
      // literally reusing the ring's own stroke treatment — a solid
      // ABDUCT_RUNE_RING-style glowing ring drawn along Earth's own visible
      // edge — rather than trying to brighten a shadow that was never
      // going to get there.
      if (abductSelected) {
        abductCtx.save();
        abductCtx.beginPath();
        abductCtx.rect(iface.x, iface.y, iface.w, iface.h); // same clip as Earth itself — cut by the border the same way
        abductCtx.clip();
        abductCtx.strokeStyle = '#33ff66';
        abductCtx.lineWidth = ABDUCT_RUNE_RING.lineWidth + 1;
        abductCtx.shadowColor = '#33ff66';
        abductCtx.shadowBlur = ABDUCT_GLOW_BLUR;
        abductCtx.beginPath();
        abductCtx.arc(er.x + er.w / 2, er.y + er.h / 2, er.w / 2, 0, Math.PI * 2);
        abductCtx.stroke();
        abductCtx.restore();
      }

      const target = abductTargets[abductIndex];
      let avatarRect = null; // hoisted so the selection-border block below (drawn on top of everything) can still reach it
      if (target) {
        const avatarImg = abductAvatarImg(target);
        const r = abductAvatarRect(avatarImg);
        avatarRect = r;
        const revealElapsed = (revealNow - abductRevealStartedAt) / 1000;
        const p = Math.min(1, revealElapsed / ABDUCT_GLITCH_DURATION);
        if (p < 1) {
          abductDrawAvatarGlitch(abductCtx, avatarImg, r, p);
        } else {
          // Settled: continuous spin about the avatar's own vertical axis
          // — never the name tag. Same 2D stand-in for a real Y-rotation
          // the dial's turn already relies on: a double-sided plane's back
          // is its own mirrored front, which ctx.scale(cos,1) reproduces
          // for free past 90°/270°.
          const spinT = revealElapsed - ABDUCT_GLITCH_DURATION;
          const spinAngle = ((spinT / ABDUCT_SPIN_PERIOD) % 1) * Math.PI * 2;
          abductCtx.save();
          abductCtx.translate(r.cx, r.cy);
          abductCtx.scale(Math.cos(spinAngle), 1);
          abductCtx.drawImage(avatarImg, -r.w / 2, -r.h / 2, r.w, r.h);
          abductCtx.restore();
        }

        const tag = abductGetTag(target);
        if (tag) {
          const iface = abductFinalRect();
          const tagW = ABDUCT_TAG.height / tag.aspect;
          abductCtx.drawImage(
            tag.canvas,
            iface.x + iface.w / 2 + ABDUCT_TARGET_OFFSET.x - tagW / 2,
            ABDUCT_TAG.centerY + ABDUCT_TARGET_OFFSET.y - ABDUCT_TAG.height / 2,
            tagW,
            ABDUCT_TAG.height
          );
        }
      }
      const { left, right } = abductArrowRects();
      abductCtx.drawImage(abductImgs.arrowLeft, left.x, left.y, left.w, left.h);
      abductCtx.drawImage(abductImgs.arrowRight, right.x, right.y, right.w, right.h);

      // The rune circle — always visible once interactive (unlike the
      // brackets/ship below, which only show once a target is selected).
      // Spin and glow are gated on selection inside the function itself.
      const ringElapsed = (revealNow - abductShipCycleStartedAt) / 1000;
      abductDrawRunesAndRing(abductCtx, abductImgs.runes, ringElapsed, abductSelected);

      // Confirmation-dynamic highlight + ship loop — see this section's
      // "confirmation dynamic" header. Drawn last so both sit on top of the
      // avatar/arrows already drawn this frame, not under them.
      if (abductSelected && avatarRect) {
        abductDrawSelectBrackets(abductCtx, avatarRect, abductImgs.select);
        const shipElapsed = (revealNow - abductShipCycleStartedAt) / 1000;
        abductDrawShip(abductCtx, abductImgs.ship, shipElapsed);
      }
    }
    abductCtx.restore();
  }

  function abductTick() {
    if (!abductAnim) return; // closed mid-frame
    if (!abductImgs) {
      abductRafId = requestAnimationFrame(abductTick);
      return;
    }
    const now = performance.now();
    const { scale, cssLeft, startY, restY } = abductLayout();

    if (abductAnim.phase === 'lowering') {
      const t = Math.min(1, (now - abductAnim.startedAt) / (ABDUCT_LOWER_DURATION * 1000));
      const eased = 1 - (1 - t) * (1 - t) * (1 - t); // ease-out: never overshoots restY — see this section's header on why that's what keeps the string safely off-screen throughout
      els.abductCanvas.style.transform = `translateY(${startY + (restY - startY) * eased}px)`;
      abductDraw(null, null); // still lowering — see abductDraw's own header for why null, not 0
      if (t >= 1) {
        abductAnim.phase = 'growing';
        abductAnim.growStartedAt = now;
      }
    } else {
      els.abductCanvas.style.transform = `translateY(${restY}px)`;
      if (abductAnim.phase === 'growing') {
        const ge = (now - abductAnim.growStartedAt) / 1000;
        abductDraw(ge, null);
        if (ge >= abductGrowthTimeline().total) {
          abductAnim.phase = 'interactive';
          abductRevealStartedAt = now;
          abductEarthRevealStartedAt = now; // see its own declaration — set once here, never reset by arrow presses
          els.abductTeamBox.style.visibility = 'visible';
          els.abductTeamLeft.style.visibility = 'visible';
          els.abductTeamRight.style.visibility = 'visible';
        }
      } else {
        abductDraw(abductGrowthTimeline().total, now);
        // Re-laid-out every frame, not just once on the growing->interactive
        // transition — a window resize while the picker sits open (found
        // live: the canvas itself already rescaled every frame, but the
        // two DOM overlay buttons hadn't, so they drifted off the panel
        // entirely at a resized viewport) needs these to track it too.
        abductPositionOverlayButtons(scale, cssLeft, restY);
      }
    }
    abductRafId = requestAnimationFrame(abductTick);
  }

  function abductStep(dir) {
    if (!abductAnim || abductAnim.phase !== 'interactive' || abductTargets.length === 0) return;
    abductIndex = (abductIndex + dir + abductTargets.length) % abductTargets.length;
    abductRevealStartedAt = performance.now(); // always restarts, interrupting any reveal in progress — see this section's header
    abductSelected = false; // Luke: "Clicking an arrow to move to the next target will also deselect."
    abductUpdateTeamBox();
  }

  /**
   * The team-name arrows — Luke, 2026-09-20: "it needs arrows on either
   * side for cycling through teams." Cycles to the first target belonging
   * to the NEXT (or previous) distinct team present in `abductTargets`
   * (teams ordered by first appearance — there's no other natural order,
   * since a team is just whatever `groupId`s happen to be in the list),
   * rather than a separate "current team" concept of its own — there's
   * only ever one real notion of "current" here, the target the avatar/tag/
   * arrows are already showing. Same reset-on-change behaviour as
   * abductStep, since this changes the current target exactly the same way.
   * A no-op if every target is already on the same team — nothing to
   * cycle to.
   */
  function abductStepTeam(dir) {
    if (!abductAnim || abductAnim.phase !== 'interactive' || abductTargets.length === 0) return;
    const teams = [...new Set(abductTargets.map((t) => t.groupId))];
    if (teams.length <= 1) return;
    const curTeamIdx = teams.indexOf(abductTargets[abductIndex].groupId);
    const nextTeam = teams[(curTeamIdx + dir + teams.length) % teams.length];
    abductIndex = abductTargets.findIndex((t) => t.groupId === nextTeam);
    abductRevealStartedAt = performance.now();
    abductSelected = false;
    abductUpdateTeamBox();
  }

  /** Toggles the confirmation-dynamic selection for the CURRENT target — see this section's "confirmation dynamic" header. Only live once the picker is fully open. */
  function abductToggleSelect() {
    if (!abductAnim || abductAnim.phase !== 'interactive') return;
    abductSelected = !abductSelected;
    if (abductSelected) abductShipCycleStartedAt = performance.now(); // fresh loop each time selection turns on
  }

  function openAbductMenu() {
    if (rig.powerup?.kind !== 'abduction' || !els.abductMenu) return;
    // window.__debugAbductTargets: real cross-team targeting has no solo
    // equivalent to test against (getAbductionTargets is only ever wired
    // up by the real networked lobby) — this override lets a console
    // session fake the list without a second real device. Harmless to
    // leave: only ever read here, never written except by hand.
    const targets = (window.__debugAbductTargets ?? getAbductionTargets?.() ?? []).filter((t) => t.island < N_FORKS);
    if (targets.length === 0) {
      showNotice('Nobody can be targeted right now.');
      return;
    }
    abductTargets = targets;
    abductIndex = 0;
    abductSelected = false;
    els.abductTeamBox.style.visibility = 'hidden';
    els.abductTeamLeft.style.visibility = 'hidden';
    els.abductTeamRight.style.visibility = 'hidden';
    abductUpdateTeamBox();
    els.abductCanvas.width = ABDUCT_PANEL_SIZE.w;
    els.abductCanvas.height = ABDUCT_STRING_LEN + ABDUCT_PANEL_SIZE.h;
    abductCtx = els.abductCanvas.getContext('2d');
    els.abductMenu.classList.remove('hidden');
    const { startY } = abductLayout();
    els.abductCanvas.style.transform = `translateY(${startY}px)`;
    if (abductRafId !== null) cancelAnimationFrame(abductRafId);
    abductAnim = { phase: 'lowering', startedAt: performance.now() };
    abductImgsPromise.then(() => {
      if (abductAnim) abductRafId = requestAnimationFrame(abductTick);
    });
  }

  function closeAbductMenu() {
    if (abductRafId !== null) cancelAnimationFrame(abductRafId);
    abductRafId = null;
    abductAnim = null;
    els.abductMenu?.classList.add('hidden');
  }

  function chooseAbductTarget(t) {
    closeAbductMenu();
    if (rig.powerup?.kind !== 'abduction') return;
    // One use — the item is spent the moment the aliens are sent, whatever
    // happens at the other end.
    disposePowerUp(rig);
    if (!isSpectatorRole(role)) notifyPlayerState(); // teammates lose the card too
    onGameEvent?.('abduct-target', { targetToken: t.token, byName: localDisplayName ?? 'Someone' });
    showNotice(`The aliens are on their way to ${t.displayName ?? 'your target'}…`);
    refreshUI();
  }

  /** 'abduct-target' landed on THIS device — arm it for the next arrival, or say why it can't be. */
  function receiveAbductionTarget(payload) {
    const reply = (outcome) => onGameEvent?.('abduct-result', { toToken: payload.token, outcome, targetName: localDisplayName });
    // Already out, spectating, already on the last island (no next island
    // to arrive on), or already spoken for by an earlier attacker: fizzle.
    if (isSpectatorRole(role) || finished || falling || abduction || forkIndex >= N_FORKS || pendingAbduction) {
      reply('fizzled');
      return;
    }
    pendingAbduction = { byToken: payload.token, byName: payload.byName ?? 'Someone' };
  }

  // ---------------------------------------------------------------- defence queue
  //
  // Luke, 2026-09-23: the defence is a guide + defender job now. The moment
  // a targeted player reaches their next island they're frozen there (no
  // moving on) under the green light, told "Aliens are coming for you!
  // Listen to [Guide] to resist them.", and ask their guide for help. The
  // guide — for whom this "takes priority over everything" — gets "[Player]
  // is being abducted by aliens! Help them resist.", and shortly after
  // (MESSAGE_DISPLAY_MS reading it, STAGE_GAP_MS paused, below) both panels
  // drop together. If the guide is already busy with a teammate, the
  // new defender simply keeps their message up until it's their turn ("they
  // will wait their turn" — no queue messaging, it's expected to be rare).
  // Everyone else on the team sees "[Guide] is helping [Defender] resist
  // alien abduction." All of these are shown on the hand-held paper graphic
  // (showPaperMessage — Luke, 2026-09-23), lowered from the top of the screen.
  //
  // Three team-scoped relayed events (see useLobby's `game-event` routing):
  //   'defence-request' {targetName, characterKey} — defender → team; the
  //     guide queues it (sender = the `token` every relayed event carries).
  //   'defence-start'   {targetToken, targetName, guideName} — guide → team,
  //     when it's that defender's turn.
  //   'defence-end'     {targetToken, targetName, outcome} — defender → team,
  //     'resisted' | 'abducted'. The DEFENDER's device decides the outcome
  //     (it has the keyboard); the guide's panel mirrors, and closes on this.
  //
  // Solo play has no relay and no guide: the defender's own device runs the
  // same intro and drops its panel by itself.
  // "Display for 2s" — how long the intro message itself stays down before
  // it retracts, on its own clock (unrelated to STAGE_GAP_MS below).
  const MESSAGE_DISPLAY_MS = 2000;
  // Every distinct beat of the sequence is separated by a pause on its own
  // — Luke, 2026-09-23/24, after the first pass had each beat start the
  // instant the previous one's ANIMATION began rather than once it had
  // actually finished and been seen: "I want a delay between each stage...
  // they seem very short" (raised from an initial 0.5s to 1s). Used for:
  // message-retracted → UI-drops-down, UI-retracted → ship-starts, and
  // wave-hits → result-message-drops. Deliberately NOT inserted between the
  // ship arriving and the wave firing — those are meant to read as the same
  // instant, the wave hitting the ship, not two separate beats.
  const STAGE_GAP_MS = 1000;
  const DEFENCE_RESULT_MS = 2000;
  // A result message's full round trip (down, read, back up) — the guide
  // waits this out before lowering the next queued defender's message.
  const DEFENCE_RESULT_TOTAL_MS = PAPER_SLIDE_MS * 2 + DEFENCE_RESULT_MS;
  let defenceResultTimer = null;

  // A ship prop per in-flight repel sequence (below), not a single shared
  // one — two different teammates could conceivably resist within moments
  // of each other, each on their own island, and each needs its own ship.
  // Pruned as each finishes playing; see tick()'s own update loop.
  const activeRepelShips = [];
  // playRepelSequence's own two setTimeouts (ship-start, then wave-trigger)
  // — tracked so resetDefenceState() can cancel a still-pending one on a
  // restart/dispose that happens to land inside that delay, same as every
  // other defence timer here.
  const pendingRepelTimers = [];

  /**
   * "After the cardboard UI goes back up, I want the ship to be lowered
   * quickly towards player and then blown away with the repulsion wave" —
   * Luke, 2026-09-23. `pos` is the player's rig/figure centre. The ship
   * (buildRepelledShip, alienAbduction.js) starts its own descend
   * STAGE_GAP_MS after this is called; the wave fires
   * REPEL_SHIP_DEFAULTS.descendDur after THAT, timed to land the instant
   * the ship arrives, so the knockback reads as the wave actually hitting
   * it rather than two unrelated animations. `onWaveTrigger`, if given,
   * fires at that same moment — callers hang their own post-wave delay
   * (e.g. before the "resisted" message) off it rather than guessing at
   * the ship's timing themselves.
   */
  function playRepelSequence(pos, onWaveTrigger) {
    const startTimer = setTimeout(() => {
      const ship = buildRepelledShip({ scene, textures: { ship: TEX.spaceship } });
      ship.start(pos);
      activeRepelShips.push(ship);
      const waveTimer = setTimeout(() => {
        resistWave.trigger(pos);
        onWaveTrigger?.();
      }, REPEL_SHIP_DEFAULTS.descendDur * 1000);
      pendingRepelTimers.push(waveTimer);
    }, STAGE_GAP_MS);
    pendingRepelTimers.push(startTimer);
  }

  // Guide-side safety net only: if a defender's device vanishes mid-defence
  // (closed tab, dead battery) its 'defence-end' never comes, and the rest
  // of the queue would wait forever. Comfortably longer than intro + ship.
  const DEFENCE_STALL_MS = 45000;

  let localWaitGlow = null; // this device's own green light while targeted — see buildWaitingGlow
  let defenceIntroTimer = null; // defender side: the 2s between 'defence-start' and the panel dropping
  let helpingNoticeFor = null; // teammate side: whose "[Guide] is helping…" message is up
  const guideDefenceQueue = []; // guide side: [{ token, name, characterKey }] waiting their turn
  let guideActiveDefence = null; // guide side: the one being worked on, + its timers

  function defenceGuideName() {
    return (guideToken && getDisplayName?.(guideToken)) || 'your guide';
  }

  function avatarSrcFor(key) {
    const entry = ROSTER.find((c) => c.key === key) ?? ROSTER[0];
    return `/textures/${entry.tex}.${entry.ext}`;
  }

  /** Called from onArrivedAtFork(): the armed abduction fires now — freeze here, light up, ask the guide for help. */
  function triggerPendingAbduction() {
    if (!pendingAbduction || abductPromptOpen || !els.abductDefenseStage) return;
    abductPromptOpen = true; // blocks moving on from here — see requestChoice's own guard
    resistConfirmedEarly = false;
    closeAbductMenu();
    const seatNow = currentSeatLateral();
    localWaitGlow = buildWaitingGlow({
      scene,
      at: { x: walker.x + seatNow.x, y: walker.y, z: walker.z + seatNow.z },
      card: figure,
      cardHeight: FIGURE_H,
      cardWidth: FIGURE_H * FIGURE_ASPECT,
    });
    notifyPlayerState(); // teammates light the same glow on this rig
    helpingNoticeFor = null; // this message replaces any teammate's "helping" one
    showPaperMessage(`Aliens are coming for you! Listen to ${defenceGuideName()} to resist them.`);
    if (onGameEvent) onGameEvent('defence-request', { targetName: localDisplayName, characterKey });
    else beginDefenceIntro(); // solo — no guide to wait for
    refreshUI();
  }

  /** It's this device's turn: hold the message MESSAGE_DISPLAY_MS, retract it, pause STAGE_GAP_MS, then drop the panel. */
  function beginDefenceIntro() {
    if (!abductPromptOpen || defenceIntroTimer) return;
    defenceIntroTimer = setTimeout(() => {
      if (!abductPromptOpen) {
        defenceIntroTimer = null;
        return;
      }
      hidePaperMessage();
      defenceIntroTimer = setTimeout(() => {
        defenceIntroTimer = null;
        if (!abductPromptOpen) return;
        abductDefense.open({
          avatarSrc: avatarSrcFor(characterKey),
          // For the projector's overlay (Luke, 2026-10-07: show the typing
          // progress): the ship's countdown starting, then each change to
          // the typed text. Another kind phones never act on.
          onCountdownStart: (durationMs) => onGameEvent?.('defence-progress', { countdownMs: durationMs, typed: '' }),
          onTextChange: (typed) => onGameEvent?.('defence-progress', { typed }),
          onResist: () => resolveAbductPrompt('resist'),
          onTimeout: () => resolveAbductPrompt('go'),
          onWordMatched: () => {
            resistConfirmedEarly = true;
            localWaitGlow?.release(); // fades out, then updateLocalWaitGlow disposes it
            notifyPlayerState(); // defending: false — teammates fade theirs too, right now, not once the panel finishes lifting
          },
        });
      }, PAPER_SLIDE_MS + STAGE_GAP_MS);
    }, MESSAGE_DISPLAY_MS);
  }

  function resolveAbductPrompt(choice) {
    if (!abductPromptOpen || !pendingAbduction) return;
    const { byToken } = pendingAbduction;
    pendingAbduction = null;
    abductPromptOpen = false;
    const outcome = choice === 'go' ? 'abducted' : 'resisted';
    onGameEvent?.('defence-end', { targetToken: myToken, targetName: localDisplayName, outcome });
    if (choice === 'go') {
      startAbduction(); // the existing sequence, networked to teammates via `abducting` — takes over localWaitGlow itself
    } else {
      // Resist — the defence screen already confirmed the typed word
      // matched before calling this, and already released the green light
      // and told teammates (onWordMatched, above — see resistConfirmedEarly's
      // own comment for why that couldn't just reuse abductPromptOpen).
      // Nothing left to do here but the repel itself.
      resistCount++; // points system: 0.5 per successful resist — see emitRoundEnd
      playRepelSequence(figure.getWorldPosition(new THREE.Vector3()), () => {
        defenceResultTimer = setTimeout(() => showPaperMessage('You resisted the aliens!', DEFENCE_RESULT_MS), STAGE_GAP_MS);
      });
    }
    onGameEvent?.('abduct-result', { toToken: byToken, outcome, targetName: localDisplayName });
    refreshUI();
  }

  /** Per frame, from tick(). */
  function updateLocalWaitGlow(dt) {
    if (localWaitGlow && !localWaitGlow.update(dt)) {
      localWaitGlow.dispose();
      localWaitGlow = null;
    }
  }

  // ---- guide side

  function receiveDefenceRequest(payload) {
    if (role !== 'guide') return; // 'watching' is a fallen player, not the guide
    const token = payload.token;
    if (guideActiveDefence?.token === token || guideDefenceQueue.some((q) => q.token === token)) return;
    guideDefenceQueue.push({ token, name: payload.targetName ?? 'Your teammate', characterKey: payload.characterKey });
    if (!guideActiveDefence) startNextGuideDefence();
  }

  function startNextGuideDefence() {
    const next = guideDefenceQueue.shift();
    if (!next) return;
    closeAbductMenu(); // "priority over everything"
    guideActiveDefence = { ...next, introTimer: null, stallTimer: null };
    onGameEvent?.('defence-start', { targetToken: next.token, targetName: next.name, guideName: localDisplayName });
    showPaperMessage(`${next.name} is being abducted by aliens! Help them resist.`);
    guideActiveDefence.introTimer = setTimeout(() => {
      hidePaperMessage();
      guideActiveDefence.introTimer = setTimeout(() => {
        abductGuideView?.open({ avatarSrc: avatarSrcFor(next.characterKey) });
      }, PAPER_SLIDE_MS + STAGE_GAP_MS);
    }, MESSAGE_DISPLAY_MS);
    guideActiveDefence.stallTimer = setTimeout(() => finishGuideDefence(next.token, 'abducted'), DEFENCE_STALL_MS);
  }

  function finishGuideDefence(token, outcome) {
    const active = guideActiveDefence;
    if (!active || active.token !== token) return;
    clearTimeout(active.introTimer);
    clearTimeout(active.stallTimer);
    guideActiveDefence = null;
    hidePaperMessage(); // in case it ended before the intro did
    abductGuideView?.close(() => {
      if (outcome === 'resisted') {
        // On 'abducted' the panel just lifts and the guide watches it
        // happen (Luke, 2026-09-23).
        const showResultMessage = () => {
          defenceResultTimer = setTimeout(() => {
            showPaperMessage(`${active.name} resisted the aliens!`, DEFENCE_RESULT_MS);
            defenceResultTimer = setTimeout(() => {
              defenceResultTimer = null;
              if (!guideActiveDefence) startNextGuideDefence();
            }, DEFENCE_RESULT_TOTAL_MS);
          }, STAGE_GAP_MS);
        };
        const rigEntry = teammates.get(token);
        // No rig entry (shouldn't happen for a real teammate, but keeps a
        // stray/late report harmless): nothing to play the ship/wave
        // against, so just show the message on its own delay.
        if (rigEntry) playRepelSequence(rigEntry.rig.group.position, showResultMessage);
        else showResultMessage();
      } else {
        startNextGuideDefence();
      }
    });
  }

  // ---- routing, every role

  function receiveDefenceStart(payload) {
    if (payload.targetToken === myToken) {
      beginDefenceIntro();
      return;
    }
    // A teammate's turn. Not shown to the guide (they have their own
    // message) or to anyone waiting on their own defence (theirs stays up).
    if (role === 'guide' || abductPromptOpen) return;
    helpingNoticeFor = payload.targetToken;
    showPaperMessage(`${payload.guideName ?? 'Your guide'} is helping ${payload.targetName ?? 'a teammate'} resist alien abduction.`);
  }

  function receiveDefenceEnd(payload) {
    if (role === 'guide') {
      finishGuideDefence(payload.token, payload.outcome);
      return;
    }
    if (helpingNoticeFor && helpingNoticeFor === payload.token) {
      helpingNoticeFor = null;
      hidePaperMessage();
    }
  }

  /** Restart/dispose: drop every defence timer and light, on every side. */
  function resetDefenceState() {
    clearTimeout(paperTimer);
    clearTimeout(defenceResultTimer);
    defenceResultTimer = null;
    clearTimeout(defenceIntroTimer);
    defenceIntroTimer = null;
    localWaitGlow?.dispose();
    localWaitGlow = null;
    resistConfirmedEarly = false;
    helpingNoticeFor = null;
    guideDefenceQueue.length = 0;
    if (guideActiveDefence) {
      clearTimeout(guideActiveDefence.introTimer);
      clearTimeout(guideActiveDefence.stallTimer);
      guideActiveDefence = null;
    }
    abductGuideView?.forceClose();
    for (const s of activeRepelShips.splice(0)) s.dispose();
    for (const timer of pendingRepelTimers.splice(0)) clearTimeout(timer);
  }

  /** 'abduct-result' — THIS device sent the aliens; here's what happened. */
  function receiveAbductionResult(payload) {
    const who = payload.targetName ?? 'Your target';
    if (payload.outcome === 'abducted') showNotice(`${who} was taken by the aliens!`);
    else if (payload.outcome === 'resisted') showNotice(`${who} resisted the aliens!`);
    else showNotice(`The aliens couldn't reach ${who}.`);
  }

  // figure.position/rotation are the *visual* transform, redrawn from these
  // every frame (see the step-bob block in tick()) — walker is the actual
  // logical path position everything else (movement, camera, fork/curtain
  // checks, key light) reads and writes. Splitting them is what lets the walk
  // bob nudge the mesh sideways and tilt it without that offset silently
  // feeding back into "how far has the avatar actually walked".
  const walker = new THREE.Vector3(0, 0, 0);

  // In-world word signs, cardboard-lettering cutouts (same art/build path as
  // player name tags — see nameTag.js) planted at the fork currently being
  // decided. Luke, 2026-09-06/07: the two words move off the flat HUD
  // buttons and onto real signs "above and to the left/right of the bridge
  // that the player is choosing" — sized 50% bigger than a name tag. Real
  // THREE.Mesh planes rather than nameTags.js's screen-projected <div>s: a
  // fixed world anchor (unlike a name tag's moving rig) needs no per-frame
  // projection math at all — the ordinary WebGL camera already draws these
  // in correct perspective, same as markerPair used to.
  //
  // Which signs are actually visible is a role split, not a per-sign
  // property: the player sees both `left`/`right` (which word is on which
  // side, not which is correct) while the guide sees only `correct` (which
  // word is correct, not which side it's on) — floated centred above the
  // fork, deliberately not aligned with either bridge, so reading it can't
  // leak the side. Luke, 2026-09-07: "the guide doesn't actually know if the
  // correct answer is left or right; it requires the guide and the player
  // working together." See updateWordSigns() for how the two are told apart.
  // Fixed world HEIGHT, not width. buildNameTagCanvas always draws letters
  // at the same pixel size regardless of the word — only the canvas WIDTH
  // grows with more letters (see its own totalW/totalH), so sizing every
  // sign to the same world WIDTH (the first version of this, sized off
  // NAME_TAG_WIDTH_FACTOR) stretched short words like "Hit" to fill the same
  // board as long ones like "World", shrinking World's letters and blowing
  // Hit's up to match — the exact "one word noticeably bigger than the
  // other" Luke flagged 2026-09-08. Fixing the HEIGHT instead makes every
  // sign's letters the same world size no matter the word; only the board's
  // width (how much a longer word needs) varies, same as real signage.
  // Value picked to land close to where the old width-based sizing put a
  // typical pair (e.g. "Sheep"/"Ship", already reviewed and approved) —
  // derived from name-tag letter height (FIGURE_H * FIGURE_ASPECT *
  // NAME_TAG_WIDTH_FACTOR, scaled by a representative aspect) times 1.5.
  // Bumped 20% (0.9 -> 1.08) 2026-09-12 — Luke, after approving the raised/
  // widened position: "make the words about 20% larger, to make them more
  // distinct from the player's names" (name tags are NAME_TAG_HEIGHT=0.6, so
  // this also widens the gap between the two sizes, not just the position).
  const WORD_SIGN_HEIGHT = 1.08;
  // Where the signs go: hung from the fork island's shrine arch rope (Luke,
  // 2026-10-03), the two player words side by side, the guide's single word
  // centred. This replaced free-floating signs at a fixed WORD_SIGN_Y = 3.6,
  // pushed out sideways by an extra ISLAND_RADIUS * 0.4 — the height and
  // spread that kept a crowd of five from hiding either word (2026-09-12).
  // That job now belongs to the arch's own ARCH.ropeHeight and pillar span,
  // which were sized against it. A word too wide for its half of the rope
  // shrinks to fit rather than overlapping its partner or a pillar, so its
  // letters can come out slightly smaller than WORD_SIGN_HEIGHT for long words.
  // Clearance kept each side of a sign within its slot. The rail frame
  // (WORD_SIGN_FRAME) adds only 0.02 × height per side, well inside this.
  const WORD_SIGN_MARGIN = 0.1;

  function makeWordSignMesh() {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, fog: false })
    );
    m.renderOrder = 10; // above the fog puffs (9), so a sign is never veiled
    m.visible = false;
    // Two hanging cords, as children so they show/hide with the sign. The
    // sign is scaled non-uniformly (w, h), so layoutWordSign counter-scales them.
    m.userData.cords = [-1, 1].map(() => {
      const c = new THREE.Mesh(wordCordGeometry, wordCordMaterial);
      m.add(c);
      return c;
    });
    scene.add(m);
    return m;
  }
  const wordCordGeometry = new THREE.CylinderGeometry(0.014, 0.014, 1, 5);
  const wordCordMaterial = new THREE.MeshBasicMaterial({ color: 0x6b5233, fog: false });
  const wordSigns = { left: makeWordSignMesh(), right: makeWordSignMesh(), correct: makeWordSignMesh() };

  // word text -> THREE.CanvasTexture, keyed by the word itself: word pairs
  // repeat across forks and across replays, and rebuilding the same cardboard
  // canvas from scratch (loading every letter glyph, redrawing the glow) each
  // time would be wasted work and a visible pop when a sign wants to change
  // this same frame. buildNameTagCanvas has its own glyph-image cache
  // underneath this one, but caching the finished, already-composited canvas
  // here skips redoing the drawing/glow/postFX work too.
  const wordTextureCache = new Map(); // word -> Promise<{ texture, aspect }>
  function getWordTexture(word) {
    let entry = wordTextureCache.get(word);
    if (!entry) {
      // Explicit glowColor, not buildNameTagCanvas's own default: that
      // default is presently a dangling reference to a constant nameTag.js
      // never defines (GLOW_COLOR_DEFAULT), and every existing caller
      // (attachNameTag) already always passes its own colour instead of
      // relying on it — this call would otherwise be the first to actually
      // hit that bug. `#ffe9b8` is this game's existing "guide/signage"
      // colour (already used on the guide-view button and loading bar), used
      // here rather than any one player's palette colour since a word sign
      // isn't tied to a player.
      entry = buildNameTagCanvas(word, { glowColor: '#ffe9b8' }).then(({ canvas, aspect }) => {
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        return { texture, aspect };
      });
      wordTextureCache.set(word, entry);
    }
    return entry;
  }

  // Applies `word` to one sign mesh. `hang` = { lateral, forward, maxW, cursor, arch }
  // places it under the arch rope of the fork at `cursor`. Async (texture
  // build is), so it guards against the sign having moved on to a different
  // word — or the round having moved past this fork entirely — by the time
  // the promise resolves, same pattern as attachNameTag.
  function setWordSign(mesh, word, hang) {
    mesh.userData.hang = hang;
    if (mesh.userData.word === word) {
      if (mesh.userData.aspect) layoutWordSign(mesh);
      return;
    }
    mesh.userData.word = word;
    mesh.userData.aspect = null;
    getWordTexture(word).then(({ texture, aspect }) => {
      if (disposed || mesh.userData.word !== word) return;
      mesh.material.map = texture;
      mesh.material.needsUpdate = true;
      mesh.userData.aspect = aspect;
      layoutWordSign(mesh);
    });
  }

  function layoutWordSign(mesh) {
    const { lateral, forward: fwd, maxW, cursor, arch } = mesh.userData.hang;
    const aspect = mesh.userData.aspect; // height/width (see buildNameTagCanvas)
    // Height is fixed, width derived from it (see WORD_SIGN_HEIGHT for why
    // that direction matters) — unless that would overrun the slot.
    let h = WORD_SIGN_HEIGHT;
    let w = h / aspect;
    if (w > maxW) {
      w = maxW;
      h = w * aspect;
    }
    const frame = signFrameFor(mesh, w, h);
    // The cords keep their tuned length (signDrop) down to the frame's
    // hanging rings; the card sits `frame.above` below those.
    const attach = archRopeY(arch, lateral) - ARCH.signDrop;
    const top = attach - frame.above;
    const p = localToWorld(cursor, lateral, fwd);
    mesh.scale.set(w, h, 1);
    mesh.position.set(p.x, top - h / 2, p.z);
    mesh.rotation.y = -cursor.heading;
    mesh.userData.cords.forEach((c, i) => {
      const cx = frame.cordX[i];
      const len = Math.max(0.01, archRopeY(arch, lateral + cx) - attach);
      c.position.set(cx / w, 0.5 + frame.above / h + len / h / 2, 0);
      c.scale.set(1 / w, len / h, 1);
    });
    mesh.visible = true;
  }

  // A slim wooden frame around each sign (Luke, 2026-10-04 — chose 'rail' of
  // the three in arch-preview.html; see SIGN_FRAMES in archGen.js). Built in
  // world units for the sign's current size, and rebuilt only when that size
  // changes (a different word). It's a child of the sign so it shows and
  // hides with it, counter-scaled against the sign's own (w, h) scale.
  const WORD_SIGN_FRAME = 'rail';
  function signFrameFor(mesh, w, h) {
    const key = `${w.toFixed(4)}x${h.toFixed(4)}`;
    if (mesh.userData.frameKey !== key) {
      const old = mesh.userData.frame;
      if (old) {
        mesh.remove(old.group);
        old.dispose();
      }
      const f = buildSignFrame(WORD_SIGN_FRAME, w, h, getArchTextures());
      f.group.scale.set(1 / w, 1 / h, 1);
      mesh.add(f.group);
      mesh.userData.frame = f;
      mesh.userData.frameKey = key;
    }
    return mesh.userData.frame;
  }

  function updateWordSigns() {
    // A guide has no walker of its own any more since fork-choice broadcasts
    // were scoped to the chooser alone (2026-09-12): `forkIndex` never
    // advances for it, so the word signs would otherwise stay frozen on
    // fork 1 forever. `guideIsland` — the guide camera's own reference
    // point — is what actually tracks progress for that role.
    //
    // A fallen player in Watch mode (2026-09-24) is its OWN case, not just
    // "shares the guide's camera" any more, now that watching cycles
    // through teammates one at a time instead of riding guideIsland — see
    // updateWatchingCamera. Luke: "I'd like watching players to see the two
    // words at each island... a watching player should still see the same
    // order they would have seen if they were alive." That's true for
    // free: each device rolls its own left/right placement once, for every
    // fork, when it first builds its OWN journey (see buildFork's
    // `aOnLeft`) — `sections` is never rebuilt just because role flips to
    // 'watching' (becomeSpectator changes nothing about the running scene),
    // so this device's own `sections[k].words` is still sitting there
    // exactly as it was while this device was still playing. Showing the
    // CURRENTLY-WATCHED teammate's fork's words from THIS device's own
    // `sections` is therefore already "the order they'd have seen alive" —
    // nothing has to be re-decided or synchronised for that to be true.
    // Gated on `entry.phase === 'resting'`, the same "awaiting a decision"
    // idea `!leg` captures for an actual active player — `finished`/
    // `falling`/etc. all describe THIS device's OWN (long since ended)
    // round, not the teammate being watched, so they don't apply here.
    let sec;
    let showCurrent;
    if (projector) {
      sec = null; // the projector shows the words itself — see `projector` above
      showCurrent = false;
    } else if (role === 'watching') {
      const entry = watchToken ? teammates.get(watchToken) : null;
      sec = entry ? sections[entry.forkIndex - 1] : null;
      showCurrent = !!entry && entry.phase === 'resting' && !!sec?.words;
    } else {
      sec = isSpectatorRole(role) ? sections[guideIsland - 1] : sections[forkIndex - 1];
      showCurrent = !leg && !finished && !falling && !abduction && !templeEntry && !rescue && sec?.words;
    }
    if (!showCurrent) {
      wordSigns.left.visible = false;
      wordSigns.right.visible = false;
      wordSigns.correct.visible = false;
      wordSigns.left.userData.word = null;
      wordSigns.right.userData.word = null;
      wordSigns.correct.userData.word = null;
      return;
    }
    // Signs sit just in front of the rope (toward the approaching player).
    const fwd = ISLAND_AHEAD + ARCH.forward - 0.06;
    const arch = archAt(sec.fork);
    const half = archRopeHalf(arch);
    if (role === 'guide') {
      wordSigns.left.visible = false;
      wordSigns.right.visible = false;
      const correctWord = sec.words[sec.correct];
      setWordSign(wordSigns.correct, correctWord, { lateral: 0, forward: fwd, maxW: half * 1.2, cursor: sec.fork, arch });
    } else {
      wordSigns.correct.visible = false;
      const slot = half - ARCH.signGap / 2;
      const centre = ARCH.signGap / 2 + slot / 2;
      const maxW = slot - 2 * WORD_SIGN_MARGIN;
      setWordSign(wordSigns.left, sec.words.left, { lateral: -centre, forward: fwd, maxW, cursor: sec.fork, arch });
      setWordSign(wordSigns.right, sec.words.right, { lateral: centre, forward: fwd, maxW, cursor: sec.fork, arch });
    }
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
  // Raw per-round facts for the points system — see emitRoundEnd's own
  // comment for why these are reported as-is rather than converted to a
  // score here: "a game mode never accumulates or reads a running total
  // itself; it only ever emits what happened this round" (handoff doc).
  let itemsCollected = 0; // pickups this device actually claimed (jetpack OR abduction device — see resolvePickupClaim)
  let resistCount = 0; // successful abduction resists this round — see resolveAbductPrompt
  // Role comes from the caller now, not from a URL parameter read by a
  // Supabase-importing sibling module. `soloRoleToggle` keeps the old
  // one-device convenience of previewing both perspectives, but only when
  // nobody else is depending on this device's role being fixed — i.e. when
  // there's no owner listening for choices.
  const soloRoleToggle = !onForkChoice;
  let sunP = timeOfDay(1);

  // leg: the walk currently in progress, or null while awaiting a decision.
  let leg = null;
  let choiceSide = null; // 'left' or 'right' — tracks which path was chosen, used for camera angle during fall

  // Luke, 2026-09-13: "the guide is still seeing a stand-in in place of the
  // player's actual movement... it would be good if we could see the
  // players progressing rather than using a stand-in" — explicitly fine
  // with "a short delay and/or a minor displacement." So while a leg is in
  // progress, this device periodically reports its OWN real position — see
  // the `notifyPlayerState('moving', …)` call in tick()'s walk block —
  // letting a spectator role track the real thing instead of a simulated
  // guess (see updateTeammates' own design note on why a player's own view
  // still never uses this). Throttled, not sent every frame: a classroom
  // group is at most a handful of people, so ~6-7 messages/second per
  // walker is negligible traffic, but there's no reason to send more often
  // than a viewer could visually tell the difference.
  const MOVING_PING_INTERVAL = 150; // ms
  let lastMovingPingAt = 0;

  // True only while the player is actively pressing/holding the #advance
  // button — see its pointerdown/up wiring below. A leg can be committed
  // (choiceSide set, leg built) well before this is true: clicking a word
  // locks in the path but does NOT start walking on its own (Luke,
  // 2026-09-06: "they will also have to move their card forward by holding
  // a small forward arrow"). tick()'s walk step reads this directly instead
  // of inferring "walking" from `leg` alone.
  let holdingForward = false;

  // Non-null while the "step through the temple doors" ending cutscene is
  // playing — see startTempleEntry/updateTempleEntry. Just an elapsed timer;
  // door rotation, the walker's final approach, and the fade-to-black are
  // all pure functions of it, computed fresh each frame rather than tweened
  // independently, so nothing here can drift out of sync with anything else.
  let templeEntry = null; // { t, startX } | null
  // Doors and fade run as two independent timers, both starting the instant
  // the sequence does (Luke, 2026-09-11: "as soon as the animation starts,
  // have both the fade and the doors opening start") — not staged one after
  // another the way the first version had it. The sequence as a whole lasts
  // as long as the slower of the two, so nothing gets cut off early.
  //
  // Doubled from 1.0/1.2s, 2026-09-11 — Luke: "still too fast." Also swapped
  // the door's easing from ease-out-cubic to smoothstep at the same time:
  // ease-out-cubic front-loads almost all of its visible motion into roughly
  // the first third of its duration (at 30% elapsed it's already ~66% open,
  // at 50% elapsed ~88% open) and barely creeps for the rest — which reads
  // as "finished" long before the timer actually says so, and is almost
  // certainly what Luke was seeing as "closing faster than 1s, more like
  // 0.2-0.3s" even before this slowdown (the DURATION was 1s the whole time;
  // the CURVE just spent it somewhere other than where the eye was looking).
  // Smoothstep (3pΒ²-2pΒ³) is still eased — slow-fast-slow, not linear/robotic
  // — but symmetric, so the motion reads as spread across the whole
  // duration instead of front-loaded into it.
  const DOOR_OPEN_DURATION = 2.0; // seconds
  const FADE_DURATION = 2.4; // seconds
  const TEMPLE_ENTRY_DURATION = Math.max(DOOR_OPEN_DURATION, FADE_DURATION);
  const DOOR_OPEN_ANGLE = THREE.MathUtils.degToRad(62); // partial — "don't have to open all the way... edges can still be slightly visible"
  // Luke, 2026-09-07, after watching the card visibly pass through the door
  // image before the fade finished covering it: "make the player move a bit
  // more slowly, so that the animation has a chance to fade to black before
  // they reach the image." Read as: over the whole entry, cover this many
  // fewer seconds' worth of ground at the old (flat *1.8) speed. First pass
  // was 0.2s — Luke, 2026-09-07 again, after that still wasn't enough:
  // "The same issue is still there... slower, so that we don't see that."
  // Bumped to 0.6s total.
  const TEMPLE_ENTRY_SLOWDOWN = 0.6; // was 0.2
  const TEMPLE_ENTRY_WALK_SPEED = WALK_SPEED * 1.8 * ((TEMPLE_ENTRY_DURATION - TEMPLE_ENTRY_SLOWDOWN) / TEMPLE_ENTRY_DURATION);
  // "Have the player card move a little bit upward as well as forward, so it
  // looks like they're heading for the door" — the door image sits above
  // ground level, so a purely flat approach was reading as walking *at* the
  // base of it rather than *into* it. Eased over the same span as the
  // sideways drift onto the doorway's centre (xP, below), so it arrives
  // fully risen exactly when it arrives centred. First pass was 1.4 — Luke,
  // 2026-09-07, after that still wasn't enough: "They need to be higher."
  const TEMPLE_ENTRY_RISE = 3.0; // was 1.4

  function startTempleEntry() {
    templeEntry = { t: 0, startX: walker.x };
  }

  /**
   * Drives the whole ending in one pass, called from tick() while
   * `templeEntry` is set (see its own declaration above for why timing is
   * centralised here rather than three separate tweens). The walker keeps
   * moving forward the entire time using the SAME trailing camera as every
   * other stretch of the walk (no scripted camera path needed — it already
   * dollies toward whatever `walker` is doing); it just never actually
   * reaches the doors, because the fade covers the remaining gap on purpose
   * (Luke: "the image will fade to black before they reach it").
   *
   * `finished`/`finishedSuccess`/emitRoundEnd() only fire once this reaches
   * the end of TEMPLE_ENTRY_DURATION — see the doc comment where this
   * replaced the old immediate version, at the leg-completion site in
   * tick()'s walk step.
   */
  function updateTempleEntry(dt) {
    templeEntry.t += dt;
    const t = templeEntry.t;

    const eased = smoothstep(0, DOOR_OPEN_DURATION, t);
    const angle = DOOR_OPEN_ANGLE * eased;
    doorLeftPivot.rotation.y = angle;
    doorRightPivot.rotation.y = -angle;

    // Slide each hinge forward by exactly the depth its own free edge sinks
    // (width * sin(angle)), so the far edge of a swinging leaf lands back on
    // the plane it started from instead of ploughing through the temple
    // billboard 0.45 behind it. Without this the outer part of each leaf is
    // depth-culled by the temple the moment it swings past — see the door
    // depth note where doorFrameMesh's depthWrite is cleared.
    //
    // The alternative (clearing the temple's depthWrite too) breaks the
    // backdrop, and simply moving the doors forward permanently would undo
    // the placement Luke tuned by eye. This costs nothing at rest — at angle
    // 0 the offset is 0, so the closed doors sit exactly where they were
    // tuned — and what it adds while opening is a hinge drifting a world
    // unit or so toward the camera, which at this distance is a few pixels,
    // under a swing, under a fade.
    const leftW = doorTuneState.left.scale / DOOR_LEFT_ASPECT;
    const rightW = doorTuneState.right.scale / DOOR_RIGHT_ASPECT;
    const sink = Math.sin(angle);
    doorLeftPivot.position.z = DOOR_LEAF_Z + leftW * sink;
    doorRightPivot.position.z = DOOR_RIGHT_LEAF_Z + rightW * sink;
    // Fake the shading the rest of this scene deliberately doesn't have.
    // Everything here is unlit MeshBasicMaterial (see CLAUDE.md), so a plane
    // turning away from the camera has no light falloff to give the rotation
    // away — it just gets narrower, which reads as shrinking rather than
    // swinging. Dimming each leaf as it turns supplies that missing cue, and
    // doubles as the obvious physical one: these doors are swinging back
    // into an unlit interior. `color` multiplies the texture on a
    // MeshBasicMaterial, so this needs no extra material or light.
    const leafShade = 1 - 0.5 * eased;
    doorLeftMesh.material.color.setScalar(leafShade);
    doorRightMesh.material.color.setScalar(leafShade);

    walker.z -= TEMPLE_ENTRY_WALK_SPEED * dt;
    // Eases sideways onto the doorway's own centre (the frame's tuned X, not
    // necessarily 0) over the whole sequence — Luke, 2026-09-11: "the player
    // isn't quite moving to the centre of the doors. They're a little to the
    // left." Wherever the walker's X happened to be the instant this
    // started (real gameplay's final approach, or the tuner's "Play temple
    // entry" button) drifts toward doorTuneState.frame.x, rather than
    // assuming it was already 0.
    const xP = smoothstep(0, TEMPLE_ENTRY_DURATION, t);
    walker.x = THREE.MathUtils.lerp(templeEntry.startX, doorTuneState.frame.x, xP);
    walker.y = TEMPLE_ENTRY_RISE * xP;

    const fadeP = Math.min(1, t / FADE_DURATION);
    if (els.templeFade) els.templeFade.style.opacity = String(fadeP);

    if (t >= TEMPLE_ENTRY_DURATION) {
      // No results screen exists yet to hand off to — Luke, 2026-09-11:
      // "After fade to black, for now just reset." emitRoundEnd(true) still
      // fires first, so whatever DOES eventually sit above this component
      // still hears that the round was won; restart() then immediately
      // takes the local game back to fork 1 (screen is fully black at this
      // point, so the cut is invisible — restart() puts the fade back to 0
      // as part of its own reset, same moment fork 1 reappears).
      templeEntry = null;
      emitRoundEnd(true);
      restart();
    }
  }

  function makeLeg(queue, realPoints, fromP, toP, arriveFork, fromHeading, toHeading) {
    // `lastPoint` is where the walker stands *right now*, snapshotted as the
    // leg begins — always flat ground (an island deck, or spawn), never
    // mid-bridge, since a leg only ever starts where the previous one ended.
    // tick()'s walk loop advances this to each waypoint as it's reached, and
    // compares it against the upcoming one's `.bridge` tag to know whether the
    // *current segment* is a bridge crossing (see the `head.bridge` check
    // there) — untagged waypoints (islands, stone stretches) leave it null.
    //
    // `fromHeading`/`toHeading` — the departure/arrival fork's own heading,
    // for currentSeatLateral()'s taper (see the "island layout" section) —
    // are carried on the leg rather than re-derived from `forkIndex` there,
    // since `forkIndex` itself flips to the arrival fork partway through the
    // leg's own lifetime (see the `leg.arriveFork` branch below).
    return {
      queue,
      total: pathLength(realPoints),
      traveled: 0,
      fromP,
      toP,
      arriveFork,
      fromHeading,
      toHeading,
      lastPoint: { x: walker.x, z: walker.z, bridge: null, bridgeT: 0 },
    };
  }

  function startJourney() {
    buildJourney();
    // No leg: the player spawns standing still, already on fork 1's own
    // island (see buildJourney()) — there is no walk-in to animate, so this
    // explicitly clears whatever leg a previous round left behind rather
    // than relying on one being overwritten here as it used to be.
    leg = null;
  }

  // Deliberately NOT called here. It used to be — this is mount-time,
  // synchronous code, running before a single network fetch can possibly
  // have resolved, so calling it here always built fork 1 (and every
  // pre-spawned island/bridge past it) from whatever fallback each generator
  // falls back to, "correct" geometry arriving only later via an
  // upgrade-in-place patch. Luke, 2026-09-03: asked why not just wait and
  // build it right the first time — there wasn't a real reason, once
  // checked. It's called once, below, from manager.onLoad instead: that
  // callback only fires once every registered asset (island model, plank
  // models, textures) has already loaded, which is also the moment the
  // loading spinner clears and character-select appears — so by the time
  // this game logic exists, it's already built from the right assets, and
  // no player ever sees the fallback, because there wasn't a delay to hide:
  // the render loop below runs the whole time regardless (there is plenty to
  // draw before a journey exists — sky, sun, temple), and it was rendering
  // behind a fully opaque loading cover anyway.

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
              for (const a of arches) a.group.position.y = v;
            },
          },
          'light stagger': { value: cloudLight.stagger, min: 0, max: 0.5, step: 0.05, set: (v) => (cloudLight.stagger = v), format: (v) => v.toFixed(2) },
        },
      })
    : null;

  // The temple-door tuner (position/size sliders, the "show doors" toggle,
  // "Focus door view", "Play temple entry") was removed 2026-09-12 once Luke
  // confirmed the opening animation itself looked right — see git history
  // (bgTuner.js's id/title/position/extrasTitle/actions generalisation) if a
  // future door-art pass wants it back.

  // The power-up card/clip placement tuner (`?powerupTune=1` — card/clip
  // X/Y/Z/size, and the "Play flame (test)" button) was removed 2026-09-13
  // once Luke baked in final numbers for both. See POWERUP_TUNE/
  // CLIP_ROTATION_DEG for where those live now, and git history for the
  // panel if a future power-up card ever needs it again.

  // Jetpack-rescue tuner (left side, `?rescueTune=1`) — every duration and
  // distance in RESCUE_TUNE, plus a "Test Reset" button (see its own comment
  // below) that gets back to "standing on island 1 with a jetpack" in one
  // click, so the actual sequence — triggered the real way, by failing a
  // bridge — can be watched again and again without a page reload, which
  // would otherwise throw away whatever had just been tuned above.
  const rescueSlider = (key, min, max, step) => ({
    value: RESCUE_TUNE[key],
    min,
    max,
    step: step ?? 0.05,
    set: (v) => {
      RESCUE_TUNE[key] = v;
    },
  });
  const rescueTuner = import.meta.env.DEV && new URLSearchParams(location.search).has('rescueTune')
    ? attachBgTuner({
        container,
        id: 'rescueTuner',
        title: 'jetpack rescue',
        position: 'left',
        panels: {},
        extrasTitle: 'TIMING',
        extras: {
          'fall s': rescueSlider('fallDuration', 0.1, 3),
          'fly s': rescueSlider('flyDuration', 0.2, 6),
          'descend s': rescueSlider('descendDuration', 0.1, 4),
          'upright hold s': rescueSlider('uprightHoldDuration', 0, 4),
          'hold s': rescueSlider('holdDuration', 0, 3),
          'depart s': rescueSlider('departDuration', 0.2, 4),
          'cam travel s': rescueSlider('cameraTravelDuration', 0.1, 4),
          'cam zoom s': rescueSlider('cameraZoomDuration', 0.1, 4),
          'apex height': rescueSlider('apexHeight', 1, 20),
          'depart dist': rescueSlider('departDistance', 1, 30),
          'cam pullback': rescueSlider('cameraPullback', 0, 20),
        },
        actions: [
          {
            // Luke, 2026-09-13: watching the rescue play out once used to
            // mean reloading the page — which also threw away whatever had
            // just been tuned above. restart() + a fresh equip gets back to
            // "standing on island 1 with a jetpack" without touching
            // RESCUE_TUNE at all, so the same numbers are still live for the
            // next attempt at failing a bridge.
            label: 'Test Reset',
            onClick: () => {
              restart();
              equipPowerUp(rig);
            },
          },
        ],
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

  // Below-name-tag PLACEMENT tuner (`?tagTune=1`), 2026-09-14 — Luke: the
  // below-seated tags are "partially embedded in the ground." Two sliders,
  // vertical (NAME_TAG_BELOW_Y_OFFSET, added on top of tagLocalY's own
  // below-side formula) and depth-toward-the-temple (NAME_TAG_BELOW_Z, the
  // existing forward push already used to keep a below tag off the
  // character card — see tagLocalY/tagLocalZ). refreshBelowTagPlacement()
  // re-applies immediately on every drag: a teammate's tag would pick up
  // the new constant on its own next frame anyway (relayoutAllIslands
  // re-checks it continuously), but this device's OWN tag is only
  // positioned once at creation (see the race that was just fixed at its
  // attachNameTag call site), so without this the slider would look like
  // it does nothing for your own name until the next full reload.
  function refreshBelowTagPlacement() {
    if (rig.nameTag && mySeat.tagSide === 'below') setNameTagSide(rig, mySeat.tagSide, mySeat.tagYStagger);
    for (const entry of teammates.values()) {
      if (entry.seatTagSide === 'below') setNameTagSide(entry.rig, entry.seatTagSide, entry.seatTagYStagger);
    }
  }
  const tagTuner = import.meta.env.DEV && new URLSearchParams(location.search).has('tagTune')
    ? attachBgTuner({
        container,
        id: 'tagTuner',
        title: 'below name tag',
        position: 'left',
        panels: {},
        extrasTitle: 'PLACEMENT',
        extras: {
          vertical: {
            value: NAME_TAG_BELOW_Y_OFFSET,
            min: -0.5,
            max: 1.5,
            step: 0.01,
            set: (v) => {
              NAME_TAG_BELOW_Y_OFFSET = v;
              refreshBelowTagPlacement();
            },
          },
          'depth (toward temple)': {
            value: NAME_TAG_BELOW_Z,
            min: -1,
            max: 3,
            step: 0.01,
            set: (v) => {
              NAME_TAG_BELOW_Z = v;
              refreshBelowTagPlacement();
            },
          },
        },
      })
    : null;

  // TEMPORARY — shrine arch placement/size tuner (`?archTune=1`), 2026-10-03.
  // Delete once Luke settles the numbers and they're baked into ARCH above.
  // Shape sliders rebuild the shared arch geometry (debounced, a few hundred
  // ms each); placement and sign sliders just re-place things.
  let archRebuildTimer = null;
  const archShape = () => {
    clearTimeout(archRebuildTimer);
    archRebuildTimer = setTimeout(() => {
      rebuildArches();
      refreshUI();
    }, 150);
  };
  const archPlace = () => {
    for (const a of arches) placeArch(a);
    refreshUI();
  };
  const archSlider = (key, min, max, step, after) => ({
    value: ARCH[key],
    min,
    max,
    step,
    set: (v) => {
      ARCH[key] = v;
      after();
    },
  });
  function archLightingLabel() {
    return ARCH.lit ? 'lighting: lit by the sun (tap for baked)' : 'lighting: baked (tap for lit)';
  }
  function archShadowsLabel() {
    return ARCH.shadows ? 'shadows: on (tap to turn off)' : 'shadows: off (tap to turn on)';
  }
  const archTuner = import.meta.env.DEV && new URLSearchParams(location.search).has('archTune')
    ? attachBgTuner({
        container,
        id: 'archTuner',
        title: 'shrine arch',
        position: 'left',
        panels: {},
        extrasTitle: 'ARCH (world units)',
        extras: {
          'forward (from island centre)': archSlider('forward', -2, 3.6, 0.05, archPlace),
          'span (outer, pillars)': archSlider('span', 3.5, 9, 0.05, archShape),
          'beam clearance': archSlider('clearHeight', 2.5, 7, 0.05, archShape),
          'pillar radius': archSlider('pillarRadius', 0.12, 0.45, 0.01, archShape),
          'rope height': archSlider('ropeHeight', 2, 6.5, 0.05, archShape),
          'rope sag': archSlider('ropeSag', 0, 1, 0.01, archShape),
          'rope thickness': archSlider('ropeThickness', 0.2, 1.5, 0.05, archShape),
          'detail scale': archSlider('scale', 2, 6, 0.05, archShape),
          'sign gap': archSlider('signGap', 0, 1.5, 0.05, archPlace),
          'sign cord length': archSlider('signDrop', 0, 1, 0.02, archPlace),
          'shadow strength': {
            value: shadowCatcherMaterial.opacity,
            min: 0,
            max: 1,
            step: 0.05,
            set: (v) => (shadowCatcherMaterial.opacity = v), // one shared material for every island
          },
          'lit fill (brightness floor)': {
            value: ARCH_LIT_FILL.value,
            min: 0,
            max: 1.5,
            step: 0.05,
            set: (v) => (ARCH_LIT_FILL.value = v), // shared uniform: every lit arch updates live
          },
        },
        actions: [
          {
            label: archLightingLabel(),
            onClick: (button) => {
              ARCH.lit = !ARCH.lit;
              applyArchLighting();
              button.textContent = archLightingLabel();
            },
          },
          {
            label: archShadowsLabel(),
            onClick: (button) => {
              ARCH.shadows = !ARCH.shadows;
              applyArchLighting();
              button.textContent = archShadowsLabel();
            },
          },
        ],
      })
    : null;

  // Four generations of `?abductTune=1` panel have now been through this
  // same cycle and been removed once Luke logged final numbers: the
  // target-cluster/Earth placement tuner (see ABDUCT_TARGET_OFFSET/
  // ABDUCT_EARTH), the confirmation-dynamic's ship timing/path tuner (see
  // ABDUCT_SHIP_POSITION_DURATION/ABDUCT_SHIP_GAP_DURATION/
  // ABDUCT_SHIP_PATH_ADJUST), the select-bracket size/gap tuner (see
  // ABDUCT_SELECT_BRACKET), and the rune circle's own position/size/ring
  // geometry tuner (see ABDUCT_RUNES/ABDUCT_RUNE_RING). The flag is free
  // for a fifth if a future abduction-UI pass needs one.

  // ---------------------------------------------------------------- controls

  const els = {
    advance: $('advance'),
    reset: $('reset'),
    role: $('role'),
    charSelect: $('charSelect'),
    charList: $('charList'),
    paletteList: $('paletteList'),
    nameInput: $('nameInput'),
    charStart: $('charStart'),
    abduct: $('abduct'), // temporary test trigger — see startAbduction()
    addJetpack: $('addJetpack'), // temporary test trigger — see equipPowerUp()
    useAbduct: $('useAbduct'), // the real abduction control — see the "pickup" section
    // Abduction targeting overlays — see the "abduction targeting" section.
    abductMenu: $('abductMenu'),
    abductStage: $('abductStage'),
    abductCanvas: $('abductCanvas'),
    abductTeamBox: $('abductTeamBox'),
    abductTeamLeft: $('abductTeamLeft'),
    abductTeamRight: $('abductTeamRight'),
    abductCancel: $('abductCancel'),
    abductDefenseStage: $('abductDefenseStage'),
    abductGuideStage: $('abductGuideStage'),
    paperMessage: $('paperMessage'),
    paperMessageText: $('paperMessageText'),
    roleNote: $('roleNote'),
    roleNoteText: $('roleNoteText'),
    // Watch mode's own top-left cycle panel — see the "watch cycling" section.
    watchPanel: $('watchPanel'),
    watchAvatar: $('watchAvatar'),
    watchName: $('watchName'),
    watchLeft: $('watchLeft'),
    watchRight: $('watchRight'),
    notice: $('notice'),
    templeFade: $('templeFade'), // opacity driven by updateTempleEntry()
  };

  if (els.abductDefenseStage) abductDefense = createAbductDefense(els.abductDefenseStage);
  if (els.abductGuideStage) abductGuideView = createAbductGuideView(els.abductGuideStage);

  // The role button always shows the current role. In a round it is assigned
  // by the session layer and the button is inert — disabled rather than
  // hidden, so it still reads as confirmation of which role this device has.
  els.role.dataset.role = role;
  els.role.textContent = role === 'guide' ? 'Guide view' : role === 'watching' ? 'Watching' : 'Player view';
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

  /** Everything "Start" on the character-select screen does, minus actually hiding that screen — factored out so a spectator role (see below) can skip the screen but still reach the same end state. */
  function finishCharacterSelect() {
    setCharacter(pickedCharacter);
    // "Player One" default per Luke, 2026-08-30 — used whenever the name
    // field is left empty rather than shipping a blank/missing name tag.
    // Under TEST_TAGS the real player's own name is overridden to "Player
    // Three" so the five tags read as one consistent numbered sequence —
    // see the TEST_TAGS block above. `displayName` (the lobby name) wins
    // over all of that when this is a real networked round — see
    // localDisplayName's own comment.
    const name =
      localDisplayName ?? (TEST_TAGS ? 'Player Three' : normalizePlayerName(els.nameInput.value) || 'Player One');
    localDisplayName = name;
    // No tag for a spectator role — its own rig is permanently invisible
    // (see figure.visible in setCharacter), so a tag could never be seen
    // either; building one anyway is wasted work, and was observed to
    // sometimes race the word signs' own concurrent glyph-texture loading
    // for a harmless console error (nameTag.js's glyph cache, shared with
    // getWordTexture, isn't obviously safe under concurrent first-use of
    // the same letter from two callers at once — a separate, pre-existing
    // issue, not chased down here since skipping the call sidesteps it
    // entirely for a rig nothing will ever show a tag on anyway).
    if (!isSpectatorRole(role)) {
      // Bug found 2026-09-14 via tagDebugLog (see attachNameTag/setNameTagSide's
      // own comments): this used to call attachNameTag with no `side`
      // (defaulting to 'above') and immediately follow up with
      // setNameTagSide(mySeat.tagSide) to fix it — but attachNameTag's canvas
      // build is ASYNC, so that follow-up ran before the tag mesh existed and
      // silently no-opped. A TEAMMATE's tag recovers from this because
      // relayoutAllIslands re-checks it every frame; a device's OWN tag has no
      // such recheck, so once the async build finally resolved (always at the
      // 'above' default baked into the closure), nothing ever corrected it —
      // permanently wrong for the whole round, exactly matching Luke's report
      // of it being wrong from character-select, only on the affected
      // player's own screen. Fix: give attachNameTag the real side/stagger
      // up front so the tag is right the instant it's created.
      attachNameTag(rig, name, pickedColorHex, { side: mySeat.tagSide, yStagger: mySeat.tagYStagger });
    }
    if (TEST_TAGS) spawnTestCompanions();
    if (DEBUG_ABDUCT) {
      // Two varied fake targets (different character/colour each) so the
      // arrows have something real to cycle between, not just a single
      // fixed card — see DEBUG_ABDUCT's own header. Auto-claimed here
      // rather than waiting for a walk to island 2: resolvePickupClaim
      // equips rig.powerup and calls refreshUI() itself, which is what
      // un-disables the real 🛸 button — nothing else to do by hand.
      window.__debugAbductTargets = [
        { token: 'debug-1', displayName: 'Zara', groupId: 2, island: 3, characterKey: 'robot', colorHex: '#2ecc71' },
        { token: 'debug-2', displayName: 'Milo', groupId: 2, island: 4, characterKey: 'monkey', colorHex: '#e74c3c' },
      ];
      resolvePickupClaim(myToken ?? 'me');
      // Fires the defence screen directly on THIS device, standing in for
      // the real flow (another team's attacker targets this player, who
      // then reaches their next island) — solo play has no second device
      // to be the attacker. Console-only, same spirit as
      // window.__debugAbductTargets above.
      window.__debugTriggerDefense = () => {
        pendingAbduction = { byToken: 'debug-attacker', byName: 'A debug attacker' };
        triggerPendingAbduction();
      };
      // Same idea, for the guide's own mirror screen (createAbductGuideView,
      // abductDefense.js) — not yet wired to a real cross-device trigger (see
      // TODO.md's "Guide's abduction-defence view" entry), so this is the
      // only way to see it today. Console-only.
      window.__debugTriggerGuideView = () => {
        if (!abductGuideView) return;
        const rosterEntry = ROSTER.find((c) => c.key === characterKey) ?? ROSTER[0];
        abductGuideView.open({ avatarSrc: `/textures/${rosterEntry.tex}.${rosterEntry.ext}` });
      };
    }
    // Luke, 2026-09-13: "the guide should have no physical presence in the
    // game at any point... with one guide and three players [every device]
    // should in display purposes be treated as three players." Root cause
    // of the guide's avatar sometimes showing up on a PLAYER's own screen:
    // this call reports "I'm here" to every teammate's `updateTeammate()`,
    // exactly like a real player — nothing before this point distinguished
    // a spectator's report from a real one. A guide's `forkIndex` also never
    // advances (see updateWordSigns' own comment on why), so once added, it
    // would sit there forever as a phantom occupant of fork 1 on every
    // player's screen. Watch mode is excluded for the same reason: a fallen
    // player has no more position to report either.
    if (!isSpectatorRole(role)) notifyPlayerState();
    // Luke, 2026-09-25: "the guide chooses an avatar. This avatar is not
    // displayed in the round that they are guiding, but is chosen and
    // retained. It should be displayed on this [victory] screen." Can't
    // reuse notifyPlayerState for this — that's exactly the call the
    // comment just above this exists to withhold from the guide, since it's
    // what used to leak a phantom guide rig into a live player's own game.
    // This is a separate, narrower event: useLobby.js stores it straight
    // into its own session-wide character table without ever reaching
    // updateTeammate(), so it can't cause that bug to come back.
    if (role === 'guide') onGameEvent?.('guide-character', { characterKey: pickedCharacter, colorHex: pickedColorHex });
    showRoleNote();
  }
  els.roleNote?.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation(); // a tap on the note isn't a tap on the game
    hideRoleNote();
  });
  els.charStart.addEventListener('click', () => {
    finishCharacterSelect();
    els.charSelect.classList.remove('visible');
    setTimeout(() => els.charSelect.classList.remove('show'), 350);
  });

  function refreshUI() {
    updateWordSigns();
    const walking = !!leg;
    // In a networked game only the guide's client acts on a fork — see
    // multiplayer.js's doc comment for why this is deliberately one-sided.
    // Who may press the buttons is now the caller's call, not a function of
    // role. The agreed model is the inverse of the first prototype: the guide
    // speaks the cue aloud and a *player* acts on it — see TODO.md.
    const cannotAct = !canAct;
    // No on-screen left/right buttons any more — Luke, 2026-09-08: "I want
    // students to click on these cardboard words themselves to make their
    // decision, rather than have extra words in white at the bottom." The
    // word signs placed by updateWordSigns() above are the tap targets now
    // (see the pointerup handler near the drag-to-look code, which raycasts
    // against wordSigns.left/right); this function no longer has a button
    // pair to show, hide, or label.
    // Shown exactly opposite the (now-3D) word signs: once a word is picked
    // but the round isn't over, the player's job switches from choosing to
    // holding this to actually move — see the tick() gate on holdingForward.
    if (els.advance) {
      els.advance.classList.toggle('hidden', !walking || finished || falling || !!abduction || cannotAct);
    }
    // Luke, 2026-09-13: "the falling player is briefly seeing the 'again?'
    // button, which they don't have a chance to press (and this button
    // shouldn't be there anyway)." Real, and separate from the Watch-mode
    // camera fix alongside it — this is `finished` flipping true the moment
    // a fall's UI delay elapses (see emitRoundEnd's own call site), which
    // has always shown this button regardless of context. Restarting is now
    // the teacher's call for a real round (this same button already goes
    // inert on click when `!soloRoleToggle` — see requestChoice's own early
    // return) — hiding it here too means a networked player never sees a
    // dead-end control flash up right before this whole component unmounts
    // for Watch mode/results.
    els.reset.classList.toggle('hidden', !finished || !soloRoleToggle);
    // Temporary test control (see startAbduction) — inert once the round is
    // over, while something else already owns the figure, or mid-walk, since
    // the event only runs on a player standing still.
    if (els.abduct) els.abduct.disabled = !!abduction || falling || finished || walking || !!templeEntry || !!rescue;
    // The real abduction control — Luke, 2026-09-15: "greyed out when a
    // player doesn't have the trigger item." Same "not while something else
    // owns the figure" guards as the test button, on top of actually
    // holding the item (see the "pickup" section).
    if (els.useAbduct) {
      els.useAbduct.disabled =
        rig.powerup?.kind !== 'abduction' || !!abduction || falling || finished || walking || !!templeEntry || !!rescue || !canAct || abductPromptOpen;
    }
    // No more status line at the bottom of the screen — Luke, 2026-09-09:
    // "remove the small text at the bottom... I don't want any of those
    // messages." (fork progress, "Falling…", the hold-to-walk prompt, etc.)
    // The signs/buttons still visible are the only cues left: whether the
    // word signs are up, whether #advance is showing, whether #reset is.
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
    // Luke, 2026-09-25: "1 bonus point if they reach the final island with a
    // jetpack still on" — only meaningful on the SUCCESS path (a fall/
    // abduction never reaches the final island at all), and reads the
    // jetpack as of right now rather than some earlier moment: one rescue
    // already consumes it (see resolveRescue), so this is naturally false
    // for anyone who used it to survive a wrong answer earlier in the round.
    const jetpackKeptAtFinish = success && rig.powerup?.kind === 'jetpack';
    if (onRoundEnd) onRoundEnd({ success, forkIndex, correctCount, totalForks: N_FORKS, itemsCollected, resistCount, jetpackKeptAtFinish });
  }

  // The whole journey — every fork's islands and both its bridges — is
  // already built by buildJourney() before any choice is possible (see "the
  // journey" section header for why eager generation is safe now). This just
  // picks which of the two already-built branches to queue as the walk: a
  // correct pick queues the branch plus whatever continues past it (the next
  // fork's own approach, already filled in); a wrong pick queues only the
  // truncated branch, which runs out of stones in mid-air and ends the
  // journey. Note that queuing the leg here does not itself start walking —
  // that only happens while holdingForward is true, so the choice is locked
  // in immediately but travel waits on the player (see tick()'s walk step).
  function applyChoice(side) {
    if (leg || finished) return;
    const sec = sections[forkIndex - 1];
    if (!sec) return;

    const wasCorrect = side === sec.correct;
    notifyPlayerState('departing'); // before forkIndex moves on — real position pings follow while walking, see tick(); the outcome is deliberately NOT sent ahead
    // ...except to the projector (Luke, 2026-10-07: the public view should
    // be there for falls and jetpack rescues, so it has to know one is
    // coming while the player is still walking out to it). A separate
    // `game-event` kind that phones never act on (useLobby.js drops kinds it
    // doesn't route), so nothing on any phone can show the outcome early:
    // the rule above still holds for every player's screen. Sent with the
    // power-up held, since a wrong choice with a jetpack is a rescue, not a
    // fall.
    onGameEvent?.('choice-outcome', { forkIndex, correct: wasCorrect, powerupKind: rig.powerup?.kind ?? null });
    choiceSide = side; // track which path was chosen for camera angle during fall
    const branchPts = sec.branch[side];
    const queue = branchPts.slice();
    const realPoints = [walker.clone(), ...branchPts];

    if (wasCorrect) {
      correctCount++;
      const isLastFork = forkIndex === N_FORKS;
      // sec.approach is already filled in — the whole journey, this fork's
      // island included, was built up front in buildJourney(). Only the
      // last section ever has one; `|| []` is what makes every other fork's
      // continuation correctly empty (walk onto the new island, then wait).
      const continuation = sec.approach || [];
      queue.push(...continuation);
      realPoints.push(...continuation);
      const arriveFork = isLastFork ? null : forkIndex + 1;
      const toP = isLastFork ? timeOfDay(N_FORKS) : timeOfDay(forkIndex + 1);
      const toHeading = arriveFork ? sections[arriveFork - 1].fork.heading : sec.fork.heading;
      leg = makeLeg(queue, realPoints, timeOfDay(forkIndex), toP, arriveFork, sec.fork.heading, toHeading);
      leg.success = true;
    } else {
      leg = makeLeg(queue, realPoints, timeOfDay(forkIndex), timeOfDay(forkIndex), null, sec.fork.heading, sec.fork.heading);
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
    if (leg || finished || falling || !canAct || abductPromptOpen) return; // frozen from the moment they're targeted, through any wait for the guide, until the defence ends — see the "defence queue" section
    if (onForkChoice) onForkChoice(forkIndex, side);
    else applyChoice(side); // no owner listening: solo play, decide it here
  }
  // Tapped/clicked directly on the world-space word signs now, not on a
  // flat button — see the pointerup handler near the drag-to-look code
  // below, which raycasts against wordSigns.left/right and calls this same
  // requestChoice().

  /**
   * Back to the start of a fresh journey. Exposed on the handle as well as
   * wired to the "Again" button, because in a room a restart is a decision
   * for the whole room, not for whichever device pressed the button — the
   * owner can call this on every device at once.
   */
  function restart() {
    roundEndEmitted = false;
    forkIndex = 1;
    resetGuideCamera();
    finished = false;
    finishedSuccess = false;
    falling = false;
    correctCount = 0;
    itemsCollected = 0;
    resistCount = 0;
    choiceSide = null;
    holdingForward = false;
    templeEntry = null;
    // Unconditional, not just "if mid-rescue": a fresh round starts with
    // empty hands regardless of what's currently equipped (jetpack OR the
    // abduction device — see equipPowerUp's single `rig.powerup` slot).
    // disposePowerUp() is a no-op with nothing equipped, and handles
    // whichever parent the group is currently under (rig.group, or `scene`
    // directly if a jetpack detach — see updateRescue — had already
    // happened) either way.
    disposePowerUp(rig);
    rescue = null;
    doorLeftPivot.rotation.y = 0;
    doorRightPivot.rotation.y = 0;
    doorLeftPivot.position.z = DOOR_LEAF_Z; // undo the swing's forward hinge slide
    doorRightPivot.position.z = DOOR_RIGHT_LEAF_Z;
    doorLeftMesh.material.color.setScalar(1); // undo updateTempleEntry's swing shading
    doorRightMesh.material.color.setScalar(1);
    if (els.templeFade) els.templeFade.style.opacity = '0';
    walker.set(0, 0, 0);
    facing = 0;
    walkPhase = 0;
    // The fall leaves figure.quaternion tumbled on all three axes; the walk-bob
    // code only ever writes rotation.z back, so x/y would otherwise carry the
    // fall's tilt into the new walk. Clear the whole rotation explicitly.
    figure.rotation.set(0, 0, 0);
    figure.visible = true; // undo the FALL_DISAPPEAR hide, if the card vanished before this click
    // The saucer is parked far above the camera once its sequence ends (see
    // abductedThisRound) — tear it down here, or a second abduction would add
    // a second rig and leak the first.
    clearAbduction();
    abductedThisRound = false;
    // A fresh round puts the island-2 item back and empties everyone's
    // hands — startJourney()'s buildJourney() replants it once this is
    // cleared. (Solo/dev restart only; a real new round remounts entirely.)
    pickupClaimedBy = null;
    pendingAbduction = null;
    abductPromptOpen = false;
    abductDefense?.forceClose();
    resetDefenceState();
    hideNotice();
    hidePaperMessage();
    closeAbductMenu();
    startJourney();
    refreshUI();
  }
  els.reset.addEventListener('click', () => restart());
  // Temporary manual trigger — see startAbduction()'s header.
  els.abduct?.addEventListener('click', () => startAbduction());
  // Temporary manual trigger — Luke, 2026-09-12: "don't worry about how they
  // earn it for now, just add it as a button." Disabled once used since
  // there's no stacking/replacing behaviour yet (see equipPowerUp).
  els.addJetpack?.addEventListener('click', () => {
    equipPowerUp(rig);
    els.addJetpack.disabled = true;
    // Nudges teammates right away rather than waiting for the next
    // resting/departing/moving report — equipping usually happens while
    // just standing around, which wouldn't otherwise send anything for a
    // while. Harmless to send a 'resting' report here: this device's own
    // forkIndex hasn't changed, so it's a no-op for everyone's position,
    // just carries the updated powerupKind flag (see notifyPlayerState).
    if (!isSpectatorRole(role)) notifyPlayerState();
  });
  // The real abduction control (enabled only while holding the island-2
  // trigger — see refreshUI) and its overlays — see the "abduction
  // targeting" section.
  els.useAbduct?.addEventListener('click', () => openAbductMenu());
  els.abductCancel?.addEventListener('click', () => closeAbductMenu());
  // The picker itself — arrows are drawn ON the canvas (real hit-testing
  // against their own rects, converted from screen space into the tall
  // canvas's own internal pixel space); the team box is a plain DOM element
  // laid over it — see abductPositionOverlayButtons().
  els.abductCanvas?.addEventListener('click', (e) => {
    const rect = els.abductCanvas.getBoundingClientRect();
    const scaleX = els.abductCanvas.width / rect.width;
    const scaleY = els.abductCanvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY - ABDUCT_STRING_LEN; // back into panel-local space
    const { left, right } = abductArrowRects();
    if (abductPointInRect(x, y, left)) { abductStep(-1); return; }
    if (abductPointInRect(x, y, right)) { abductStep(1); return; }
    // Tapping the avatar itself toggles the confirmation-dynamic selection
    // — see abductToggleSelect. Needs the target's own image for its real
    // aspect (same rect abductDraw itself uses), so it's a no-op before
    // abductImgs/the target have actually loaded.
    const target = abductTargets[abductIndex];
    if (target && abductImgs) {
      const avatarImg = abductAvatarImg(target);
      if (abductPointInRect(x, y, abductAvatarRect(avatarImg))) {
        abductToggleSelect();
        return;
      }
    }
    // The rune circle IS the confirm button now — Luke, 2026-09-20: "Wire
    // the runes up as the actual confirm button," replacing the old plain
    // placeholder #abductConfirmBtn (removed earlier the same day). Only
    // live while abductSelected — the ring/glow that make the circle look
    // "armed" only show while selected too (see abductDrawRunesAndRing), so
    // this only accepts a click exactly when it visually invites one.
    // Hit region is a plain circle at the runes' own centre, out to the
    // ring's own radius — everything the ring visually encloses.
    if (abductSelected && target) {
      const dx = x - ABDUCT_RUNES.centerX;
      const dy = y - ABDUCT_RUNES.centerY;
      if (Math.hypot(dx, dy) <= ABDUCT_RUNE_RING.radius) chooseAbductTarget(target);
    }
  });
  // Switching teams — Luke originally floated "Switch Team can be simply
  // clicking on the team name window, for now," but then asked for actual
  // arrows either side of the name instead (2026-09-20); those are the
  // real control now (see abductStepTeam), so the name itself stays a
  // plain, non-interactive label rather than also doing the same thing a
  // second way.
  els.abductTeamLeft?.addEventListener('click', () => abductStepTeam(-1));
  els.abductTeamRight?.addEventListener('click', () => abductStepTeam(1));

  els.watchLeft?.addEventListener('click', () => stepWatch(-1));
  els.watchRight?.addEventListener('click', () => stepWatch(1));

  // Hold-to-advance: hold #advance to walk, release to freeze in place —
  // Luke, 2026-09-06: "they will also have to move their card forward by
  // holding a small forward arrow at the base of the screen." Mirrors the
  // pointerdown/setPointerCapture/pointerup pattern used for drag-to-look
  // below, so a finger or mouse that slides off the button while held still
  // releases cleanly via pointercancel rather than getting stuck "on".
  els.advance?.addEventListener('pointerdown', (e) => {
    holdingForward = true;
    // Guarded: nothing else here depends on capture actually succeeding —
    // it's just what makes a finger sliding off the button while held still
    // deliver the pointerup/cancel that ends the hold, rather than losing it
    // to whatever element it slid onto.
    try {
      els.advance.setPointerCapture(e.pointerId);
    } catch {}
    refreshUI();
  });
  const endAdvance = () => {
    if (!holdingForward) return;
    holdingForward = false;
    refreshUI();
  };
  els.advance?.addEventListener('pointerup', endAdvance);
  els.advance?.addEventListener('pointercancel', endAdvance);

  els.role.addEventListener('click', () => {
    if (!soloRoleToggle) return; // assigned by the session layer; button is inert
    role = role === 'guide' ? 'player' : 'guide';
    // The guide camera normally advances by watching teammates rest and
    // depart (updateGuideCamera), but solo has no teammates — the only
    // walker is this device's own, so the guide never left island 1. Here
    // the guide simply joins the fork that walker has reached.
    if (role === 'guide') {
      guideIsland = THREE.MathUtils.clamp(forkIndex, 1, N_FORKS);
      guideMode = 'parked';
      guideFollowToken = null;
    }
    els.role.dataset.role = role;
    els.role.textContent = role === 'guide' ? 'Guide view' : 'Player view';
    figure.visible = role !== 'guide';
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

  // Tap-to-choose: clicking/tapping directly on a word sign (see
  // updateWordSigns) IS the choice now — Luke, 2026-09-08: "I want students
  // to click on these cardboard words themselves to make their decision,
  // rather than have extra words in white at the bottom." Reuses the same
  // pointerdown/pointerup pair as drag-to-look above rather than a separate
  // 'click' listener, since a real click event doesn't exist on every touch
  // browser the same way; distinguishing a tap from a drag is just "did the
  // pointer move much between down and up" — same threshold-by-distance
  // approach as everywhere else pointer gestures are told apart in this file.
  const TAP_MOVE_THRESHOLD = 8; // px
  const wordRaycaster = new THREE.Raycaster();
  function pointerToNDC(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((e.clientY - rect.top) / rect.height) * 2 + 1,
    };
  }
  function tryWordSignTap(e) {
    // Only ever the two side-by-side signs — the guide's centred `correct`
    // sign is intentionally not a tap target: the guide isn't the one
    // choosing (see requestChoice's doc comment), and it wouldn't have a
    // side to choose even if tapped.
    const targets = [wordSigns.left, wordSigns.right].filter((m) => m.visible);
    if (targets.length === 0) return;
    wordRaycaster.setFromCamera(pointerToNDC(e), camera);
    const hit = wordRaycaster.intersectObjects(targets, false)[0];
    if (hit) requestChoice(hit.object === wordSigns.left ? 'left' : 'right');
  }
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (dragging && dragging.id === e.pointerId) {
      const moved = Math.hypot(e.clientX - dragging.x, e.clientY - dragging.y);
      if (moved < TAP_MOVE_THRESHOLD) tryWordSignTap(e);
    }
    dragging = null;
  });
  renderer.domElement.addEventListener('pointercancel', () => { dragging = null; });

  // ---------------------------------------------------------------- loop


  manager.onLoad = async () => {
    if (disposed) return; // see manager.onProgress above
    // word-pairs.json isn't registered with `manager` (it's not a THREE
    // texture/model load), so it's not otherwise covered by "every asset has
    // finished loading" below — awaited explicitly here instead, before
    // buildJourney() can possibly need it. A malformed file throws a specific
    // error (see wordPairs.js) rather than crashing somewhere less obvious
    // later; caught here the same way an unusable WebGL context is above —
    // a clear message in place of the spinner, not an infinite "Loading…".
    try {
      wordPairs = await wordPairsPromise;
    } catch (err) {
      const loaderEl = $('loader');
      if (loaderEl) {
        loaderEl.innerHTML =
          '<div style="max-width: 320px; text-align: center; line-height: 1.5;">' +
          "This game's word list couldn't be loaded, so it can't start.<br><br>" +
          'See the browser console for exactly what\'s wrong with word-pairs.json.' +
          '</div>';
      }
      console.error(err);
      return;
    }
    if (disposed) return; // could have been unmounted during the await above
    // Built here, not at mount — see the comment above startJourney()'s
    // definition. Every asset buildFork()/spawnIsland() can reach for
    // (island model, plank models, textures, and now the word list above)
    // has finished loading by the time this callback fires, by construction
    // of what manager.onLoad means.
    startJourney();
    $('loader').classList.add('done');
    if (presetLook && role !== 'watching') {
      // Chosen on the join screen already (see presetLook above): same end
      // state as pressing Start, without the screen. The guide included, so
      // its choice is still stored for its turns as a player (see below).
      if (ROSTER.some((c) => c.key === presetLook.characterKey)) pickedCharacter = presetLook.characterKey;
      if (PALETTE.some((p) => p.hex === presetLook.colorHex)) pickedColorHex = presetLook.colorHex;
      finishCharacterSelect();
    } else if (role === 'watching') {
      // A fallen player's Watch mode already picked a character/colour
      // earlier in this same round, back when it was still playing — asking
      // again would be a confusing, meaningless extra step, so skip straight
      // past the screen to the same end state Start would have reached.
      finishCharacterSelect();
      initWatchPanel();
    } else {
      // The guide goes through the exact same screen as a normal player —
      // Luke, 2026-09-13: "we should in fact have the guide pick an avatar,
      // like the other players, because in the next stage of the game,
      // players will take turns as the guide" (so whoever guides needs a
      // real, stored choice ready for whenever they next play as a normal
      // player instead) — "but for now, in no way should it become
      // visible." Only what happens AFTER this screen differs for a guide
      // (see figure.visible in setCharacter, and the isSpectatorRole guard
      // in finishCharacterSelect below): nothing ever shows the guide's own
      // figure, and nothing broadcasts this choice to anyone else. Do not
      // go back to skipping this screen for the guide without re-reading
      // this — the choice is deliberately kept even though it's currently
      // unused for anything but storage.
      els.charSelect.classList.add('show');
      // Let 'show' (display) apply before the opacity transition starts.
      requestAnimationFrame(() => {
        if (!disposed) els.charSelect.classList.add('visible');
      });
    }
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
        // The choice is locked in the moment leg is built (applyChoice), but
        // actually covering ground waits on the player holding #advance —
        // Luke, 2026-09-06. Releasing simply stops advancing wherever the
        // walker currently stands, mid-bridge included; nothing else in this
        // block (bridge height, arrival checks) needs to change, since they
        // all key off distToHead/moveAmount, which is just 0 while released.
        const moveAmount = holdingForward ? Math.min(distToHead, WALK_SPEED * dt) : 0;
        if (distToHead > 1e-4) {
          walker.x += (dx / distToHead) * moveAmount;
          walker.z += (dz / distToHead) * moveAmount;
        }
        leg.traveled += moveAmount;

        // Real-time position ping for everyone else watching this device —
        // see MOVING_PING_INTERVAL's own comment. Sent regardless of whether
        // moveAmount is currently 0 (forward released, i.e. genuinely
        // paused): a viewer just keeps smoothing toward the same spot, which
        // reads as "stopped" — Luke: "if they stop moving, by taking their
        // finger off the move forward button, everyone else will see them
        // stop."
        const now = Date.now();
        if (now - lastMovingPingAt >= MOVING_PING_INTERVAL) {
          lastMovingPingAt = now;
          const heading = distToHead > 1e-4 ? Math.atan2(dx, -dz) : undefined;
          // Broadcasts the SEAT-WALK position, not the bare centreline — so
          // a viewer sees the real diagonal walk toward/away from a fixed
          // seat with no extra work on the receiving end.
          const seatNow = currentSeatLateral();
          notifyPlayerState('moving', { x: walker.x + seatNow.x, z: walker.z + seatNow.z, heading });
        }

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
          leg.lastPoint = {
            x: head.x,
            z: head.z,
            bridge: head.bridge ?? null,
            bridgeT: head.bridgeT ?? 0,
            breakablePlanks: head.breakablePlanks ?? null,
          };
          leg.queue.shift();
        }
      }

      const p = leg.total > 0 ? THREE.MathUtils.clamp(leg.traveled / leg.total, 0, 1) : 1;
      sunP = THREE.MathUtils.lerp(leg.fromP, leg.toP, p);

      if (leg.queue.length === 0) {
        sunP = leg.toP;
        if (leg.arriveFork) {
          forkIndex = leg.arriveFork;
          notifyPlayerState();
          onArrivedAtFork(); // the island-2 pickup claim — see the "pickup" section
        } else if (leg.success) {
          // `finished`/`finishedSuccess`/emitRoundEnd() are deliberately NOT
          // set here any more — that used to end the round the instant the
          // last stone was reached. Now it hands off to the door-opening
          // sequence instead (see startTempleEntry/updateTempleEntry), and
          // those three only fire once THAT finishes, right before the
          // screen goes black. Firing emitRoundEnd early would tell the
          // session layer the round is over while the animation is still
          // playing, which risks it unmounting this component (or showing
          // results) out from under the cutscene.
          startTempleEntry();
        } else {
          // The fall fires here, at the moment the stones run out (or, on a
          // bridge, the breakable plank is reached), rather than back when
          // the button was pressed — the consequence should land when the
          // player walks off the edge. startFall() hands the figure off to
          // physics for the drop itself — `finished` doesn't flip true until
          // the fall resolves, below. A jetpack (see equipPowerUp) turns
          // this same moment into a rescue instead — see startRescue's own
          // header for why that's a separate, non-physics path rather than
          // a branch inside startFall().
          if (leg.lastPoint.breakablePlanks?.length) triggerPlankBreak(leg.lastPoint.breakablePlanks);
          // Only a JETPACK turns a fall into a rescue — holding the
          // abduction device (the same `rig.powerup` slot, see
          // equipPowerUp's own header) is not a "spare life."
          if (rig.powerup?.kind === 'jetpack') startRescue();
          else startFall();
        }
        leg = null;
        refreshUI();
      }
    }

    // This device's own seat walk (see currentSeatLateral()) — evaluated
    // once per frame, after the leg-processing block above (so it reflects
    // this frame's just-updated `leg.traveled`/`forkIndex`, including an
    // arrival that just happened this very frame) and reused everywhere the
    // rendered figure's position matters: the figure itself, the trailing
    // camera, and the light target. Deliberately NOT applied to `walker`
    // itself, nor to the fall/rescue/abduction branches below (all three
    // already own figure.position outright, and all three are scripted,
    // centreline-only sequences — see currentSeatLateral()'s own comment).
    const seatLateral = currentSeatLateral();

    // Drives the door-opening ending on its own timer, independent of the
    // (now-null) `leg` — see its own doc comment. Runs before the step-bob/
    // camera code below so both see this frame's already-updated walker.z.
    if (templeEntry) updateTempleEntry(dt);
    updateEngineFlame(rig, dt); // no-op unless a jetpack is equipped and firing
    updateEngineSmoke(rig, dt); // no-op unless the engine has ever fired

    // Step bob: only while walking, and it always finishes the lobe (one
    // up-then-down) it's in the middle of before settling flat — walkPhase is
    // clamped to the next multiple of PI rather than just stopped, so motion
    // never cuts off mid-rise or mid-fall. Each PI-wide lobe lifts and tilts
    // the figure one way; consecutive lobes alternate right/left via `side`.
    // Four states now: a jetpack rescue (updateRescue owns figure.position/
    // quaternion entirely, same reasoning as falling below); falling
    // (physics owns figure.position); just fell and waiting on "Again"
    // (frozen exactly where the fall left it — the bob code would otherwise
    // snap it back to standing the very next frame); or the normal walking/
    // idle/reached-the-temple case (bob code, as before).
    if (rescue) {
      updateRescue(dt);
    } else if (falling) {
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
      // Luke, 2026-09-13: "when a player falls, I want that to be visible
      // on everyone's screen... they should see the proper falling
      // animation" — the real physics transform, streamed for as long as
      // the local figure is still visibly tumbling; see the "teammates"
      // section's phase model. Once the local card has disappeared there's
      // nothing left to mirror, so report 'gone' exactly once and stop.
      if (fallElapsed < FALL_DISAPPEAR) {
        pingFigureTransform();
      } else if (!fallGoneSent) {
        fallGoneSent = true;
        notifyPlayerState('gone');
      }

      // Broken plank pieces (if this fall came from one — see
      // triggerPlankBreak) ride the same fallWorld.step() calls above; just
      // read their transforms back, same as the card's own.
      for (const { mesh, body } of brokenPieces) {
        const pt = body.translation();
        const pr = body.rotation();
        mesh.position.set(pt.x, pt.y, pt.z);
        mesh.quaternion.set(pr.x, pr.y, pr.z, pr.w);
      }
      if (fallElapsed >= FALL_DISAPPEAR) for (const { mesh } of brokenPieces) mesh.visible = false;

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
    } else if (abduction) {
      // The event writes figure.position/rotation.z itself, so this branch
      // deliberately runs INSTEAD of the step-bob below rather than alongside
      // it — the bob would otherwise snap the card back to standing height on
      // the very same frame the beam is lifting it.
      abduction.update(dt);
      // Billboard the rig at the live camera. Yaw only, which is what keeps
      // the beam's horizontal hide-line valid — see alienAbduction.js.
      abduction.facePoint(camera.position);
      // Everyone else sees the card lifted away too — see startAbduction.
      // (The yaw billboarding above is baked into the quaternion sent, so a
      // viewer sees the card facing THIS camera, not theirs — a small
      // oddity accepted for now over building a second facing rule.)
      if (abduction.state.playing) pingFigureTransform();

      // Carried off = round over, and lost. Resolved the moment the sequence
      // ends rather than on a separate timer: unlike a fall (where the card
      // keeps tumbling behind the result for FALL_EXTRA_DURATION), there is
      // nothing left on screen to watch once the saucer has gone.
      if (!abduction.state.playing && !finished) {
        finished = true;
        finishedSuccess = false;
        notifyPlayerState('gone');
        emitRoundEnd(false);
        refreshUI();
      }
    } else if (!(finished && !finishedSuccess)) {
      // `templeEntry` keeps the card visibly walking (bob animating) even
      // though `leg` is null and nothing is holding #advance any more — the
      // final approach to the doors is scripted, not player-held.
      if ((walking && holdingForward) || templeEntry) {
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
        walker.x + seatLateral.x + side * lift * WALK_BOB_LATERAL + (bridgeSway ? bridgeSway.offset.x : 0),
        walker.y + FIGURE_H / 2 + lift * WALK_BOB_HEIGHT + (bridgeSway ? bridgeSway.offset.y : 0),
        walker.z + seatLateral.z + (bridgeSway ? bridgeSway.offset.z : 0)
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

    updateTeammates(dt);
    updateLocalWaitGlow(dt);
    for (let i = activeRepelShips.length - 1; i >= 0; i--) {
      const s = activeRepelShips[i];
      s.update(dt);
      s.facePoint(camera.position);
      if (!s.playing) {
        s.dispose();
        activeRepelShips.splice(i, 1);
      }
    }
    updateNameTags();
    updatePickup(t);

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
        // always that island's own centre (genBridgeRoute's own centreHop) —
        // reached via one final straight hop in from the arrival edge. That
        // hop cuts laterally back to the centreline and so has a
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
    } else if (!falling && !finished && !rescue) {
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
    // Eased here, once, regardless of which camera branch below actually
    // reads it — a guide/watcher has no walker of their own to trail (see
    // isSpectatorRole below), but the SAME drag-to-look pointer handlers are
    // registered unconditionally, so look.tx/ty update no matter whose
    // camera is live. Used to only ease inside the active-player branch,
    // which is why a guide/watcher's drag never went anywhere — dragging
    // moved look.tx/ty just fine, nothing ever eased look.x/y toward them,
    // and nothing in updateGuideCamera read them at all. Fixed 2026-09-19
    // (Luke: "guides and watchers... don't have the ability to pan their
    // view in the same way that active players do").
    look.x += (look.tx - look.x) * Math.min(1, dt * 4);
    look.y += (look.ty - look.y) * Math.min(1, dt * 4);
    if (role === 'watching') {
      // A fallen player's Watch mode (2026-09-24) — cycles through this
      // team's own other players one at a time, rather than sharing the
      // guide's own auto-following camera. See the "watch cycling" section,
      // up near the teammates code, for the full design (and its TEMPORARY
      // fallback onto updateGuideCamera, still marked for deletion there).
      updateWatchingCamera(dt, t);
    } else if (isSpectatorRole(role)) {
      // The guide has no walker/figure of its own to trail (see
      // figure.visible in setCharacter) — an entirely separate camera
      // state machine owns its view instead. See the "guide camera"
      // section, up near the teammates code, for the full design.
      updateGuideCamera(dt);
    } else if (rescue) {
      // Already fully eased inside updateRescue (see its own "camera"
      // section) — applied directly here, not lerped again, so the
      // cameraTravelDuration/cameraZoomDuration sliders land exactly where
      // tuned rather than approaching them asymptotically.
      camera.position.copy(rescue.camPos);
      camera.lookAt(rescue.camLookAt);
    } else if (falling) {
      // Eases to the fixed anchor beside the edge (see startFall) and pans
      // the look-at down to track the figure as it drops — a held position
      // with a moving gaze, not a scripted camera path.
      camera.position.lerp(fallCamAnchor, Math.min(1, dt * FALL_CAM_EASE));
      camera.lookAt(figure.position.x, figure.position.y, figure.position.z);
    } else if (!justFell) {
      // camera: trails the avatar along its facing direction, plus the drag offset (eased above)

      // An abduction dollies the camera back on top of whatever pull is
      // already set (the crowd harness owns the base value) — multiplied, not
      // assigned, so the two compose instead of one clobbering the other.
      const pull = camPull * (abduction ? abduction.state.cameraPull : 1);
      const behind = forward(facing, CAM_BACK * pull);
      const ahead = forward(facing, 4.6);
      camera.position.set(
        walker.x + seatLateral.x - behind.x + look.x,
        CAM_HEIGHT * (1 + (pull - 1) * 0.45) + look.y + Math.sin(t * 0.6) * 0.05,
        walker.z + seatLateral.z - behind.z
      );
      // During an abduction the camera tilts up to follow the saucer away.
      // Done as a rotation of the LOOK-AT point about the camera, not a move
      // of the camera itself — that's what a tripod head does, and it keeps
      // the trailing position above as the one thing placing the view. The
      // event only supplies the angle; it never touches the camera.
      const pitch = abduction ? abduction.state.cameraPitch : 0;
      if (pitch > 0) {
        const reach = CAM_BACK * pull + 4.6;
        camera.lookAt(
          walker.x + seatLateral.x + ahead.x,
          CAM_LOOK_Y + Math.sin(pitch) * reach,
          walker.z + seatLateral.z + ahead.z * Math.cos(pitch)
        );
      } else {
        camera.lookAt(walker.x + seatLateral.x + ahead.x, CAM_LOOK_Y, walker.z + seatLateral.z + ahead.z);
      }
    }
    // else: the round ended badly — camera stays exactly where the fall (or
    // the departing saucer) left it, frozen, until "Again" resets everything
    // at once. For an abduction that means holding the final tilted-up framing
    // on the empty sky, which is the right last image for it.

    // The land/sea/sky rig rides with the camera on the ground plane only —
    // no y, no rotation — so the horizon holds its height and the composition
    // stays exactly where it was tuned, however far the walker has travelled.
    backdropRig.position.set(camera.position.x, 0, camera.position.z);
    // Must run after the rig has been placed: the cloud UV offsets cancel the
    // rig's own following, so they need the camera position it was just given.
    updateWindClouds(dt);

    key.target.position.set(walker.x + seatLateral.x, 0, walker.z + seatLateral.z);
    key.position.copy(key.target.position).add(sunOffset);

    harness?.update(dt);
    updateBirds(dt);

    // Was only called from refreshUI(), fired on discrete events (a choice
    // made, an arrival, character-select finishing) — every one of them
    // something that only ever happens to the LOCAL PLAYER's own state, so
    // it happened to track forkIndex correctly for a playing device. The
    // guide has none of those events: `guideIsland` advances silently, frame
    // by frame, inside updateGuideCamera() above. Luke, 2026-09-12: after
    // the guide's camera correctly moved to the second island, "the guide
    // can't see the correct word (or the word pair)" — found live by
    // reproducing with two simulated teammates: the correct-word sign stayed
    // stuck on fork 1's word the whole time, since nothing ever told it
    // guideIsland had changed. Called unconditionally every frame now
    // instead, cheap at this scale, so it can never again go stale for a
    // role that has no discrete refresh trigger of its own.
    updateWordSigns();

    if (drawing && camLift > 0) {
      const pos = camera.position.clone();
      const quat = camera.quaternion.clone();
      const e = camLift * camLift * (3 - 2 * camLift); // smoothstep
      camera.position.y += e * CAM_LIFT_HEIGHT;
      camera.rotateX(e * CAM_LIFT_PITCH);
      resistWave.render(scene, camera);
      camera.position.copy(pos);
      camera.quaternion.copy(quat);
    } else if (drawing) resistWave.render(scene, camera);

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
    // Steps one frame by hand. Cancels the pending animation frame first, as
    // tick() books the next one itself: called repeatedly (src/dev/
    // recordTracks.js pumps it on a timer when the window is covered and the
    // browser has slowed animation frames to a crawl), it would otherwise
    // start a new loop each time.
    window.__tick = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      tick();
    };
    window.__state = () => ({
      forkIndex,
      finished,
      finishedSuccess,
      walking: !!leg,
      sunP,
      correctCount,
      facing,
      walkerZ: walker.z,
      templeEntry: templeEntry ? { t: +templeEntry.t.toFixed(3) } : null,
      fork: sections[forkIndex - 1] ? sections[forkIndex - 1].fork : null,
      abduction: abduction
        ? {
            time: +abduction.state.time.toFixed(2),
            duration: +abduction.duration.toFixed(2),
            playing: abduction.state.playing,
            entryAngle: +abduction.state.entryAngle.toFixed(1),
            exitAngle: +abduction.state.exitAngle.toFixed(1),
            camPitch: +THREE.MathUtils.radToDeg(abduction.state.cameraPitch).toFixed(1),
            camPull: +abduction.state.cameraPull.toFixed(2),
            rigY: +abduction.rig.position.y.toFixed(2),
          }
        : null,
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
        fork: { x: s.fork.x, z: s.fork.z, heading: s.fork.heading }, // the fork island's frame, for re-placing recorded movement (src/dev/recordTracks.js)
        leftPts: s.branch.left.length,
        rightPts: s.branch.right.length,
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
      tagLocalY: c.rig.nameTag ? +c.rig.nameTag.mesh.position.y.toFixed(3) : null,
      tagVisible: c.rig.nameTag ? c.rig.nameTag.mesh.visible : null,
    }));
    window.__cloudRows = () => cloudRows.map((r) => +r.position.z.toFixed(2));
    window.__forceChoice = (side) => requestChoice(side);
    // Testing convenience: holding the real #advance button requires a
    // genuine pointerdown/up from a real input device, awkward to automate
    // reliably. This just flips the same `holdingForward` flag tick() reads.
    // Each call replaces the last one's release timer: a long-running driver
    // (src/dev/recordTracks.js) holds repeatedly, and an earlier hold's timer
    // going off mid-walk stopped the walker short.
    let debugHoldTimer = null;
    window.__debugHold = (ms = 4000) => {
      clearTimeout(debugHoldTimer);
      holdingForward = true;
      debugHoldTimer = setTimeout(() => {
        holdingForward = false;
      }, ms);
    };
    window.__wordSigns = () => ({
      leftVisible: wordSigns.left.visible,
      rightVisible: wordSigns.right.visible,
      correctVisible: wordSigns.correct.visible,
      leftWord: wordSigns.left.userData.word,
      rightWord: wordSigns.right.userData.word,
      correctWord: wordSigns.correct.userData.word,
      leftPos: wordSigns.left.position.toArray(),
      rightPos: wordSigns.right.position.toArray(),
      camPos: camera.position.toArray(),
    });
    // Simulates a relayed player-state broadcast, for testing without a
    // second real device — exactly what GameRoom.jsx's onPlayerStateReceived
    // handler calls in the real multiplayer path.
    window.__testUpdateTeammate = (token, state) => updateTeammate(token, state);
    window.__guideCam = () => ({
      role,
      guideIsland,
      guideMode,
      guideFollowToken,
      lastDepartedAtCurrentFork: guideLastDepartedTokenByFork.get(guideIsland) ?? null,
    });
    window.__teammates = () => ({
      myForkIndex: forkIndex,
      myDisplayName: localDisplayName,
      teammates: Array.from(teammates.entries()).map(([tok, e]) => ({
        token: tok,
        displayName: e.displayName,
        characterKey: e.characterKey,
        forkIndex: e.forkIndex,
        pos: e.rig.group.position.toArray().map((v) => +v.toFixed(2)),
        tagLocalY: e.rig.nameTag ? +e.rig.nameTag.mesh.position.y.toFixed(3) : null,
        seatOffsetX: e.seatOffsetX,
        seatTagSide: e.seatTagSide,
      })),
    });
    // Temporary, 2026-09-14 — diagnosing "position 4 and 5 both show
    // above" report: dumps the raw `roster` array this device received and
    // the seatOffsets table it built from it, so we can see whether the
    // real broadcast roster matches what's assumed, without guessing.
    // Delete once that's resolved.
    window.__seatOffsets = () => ({
      roster,
      myToken,
      seats: roster.map((tok) => ({ token: tok, ...seatOffsets.get(tok) })),
    });
    // See tagDebugLog's own comment above nameTags — dump with
    // window.__tagDebugLog(), or JSON.stringify(window.__tagDebugLog(), null, 2)
    // to copy as plain text. window.__tagDebugClear() empties it, useful for
    // isolating just what happens around one specific arrival.
    window.__pickup = () => ({
      kind: pickupKind,
      claimedBy: pickupClaimedBy,
      heldKind: rig.powerup?.kind ?? null,
      meshOnIsland: !!pickupMesh,
      meshPos: pickupMesh ? pickupMesh.position.toArray().map((v) => +v.toFixed(2)) : null,
      pendingAbduction,
      abductPromptOpen,
    });
    // Simulates a relayed game event (a pickup claim, an incoming abduction
    // target, a result) without a second device — same as
    // __testUpdateTeammate for player-state.
    window.__testGameEvent = (kind, payload) => applyGameEvent(kind, payload);
    window.__repelState = () => ({
      waveActive: resistWave.active,
      localWaitGlowExists: !!localWaitGlow,
      ships: activeRepelShips.map((s) => ({
        phase: s.phase,
        pos: s.ship.position.toArray().map((v) => +v.toFixed(2)),
        opacity: +s.ship.material.opacity.toFixed(2),
        visible: s.ship.visible,
      })),
      figurePos: figure.getWorldPosition(new THREE.Vector3()).toArray().map((v) => +v.toFixed(2)),
      camPos: camera.position.toArray().map((v) => +v.toFixed(2)),
    });
    window.__abductUIState = () => ({
      phase: abductAnim?.phase ?? 'closed',
      index: abductIndex,
      targets: abductTargets.map((t) => t.displayName),
      current: abductTargets[abductIndex]?.displayName ?? null,
      revealElapsed: abductAnim ? (performance.now() - abductRevealStartedAt) / 1000 : null,
    });
    window.__tagDebugLog = () => tagDebugLog.slice();
    window.__tagDebugClear = () => {
      tagDebugLog.length = 0;
    };
    window.__doorTune = () => ({
      state: doorTuneState,
      frame: { pos: doorFrameMesh.position.toArray(), scale: doorFrameMesh.scale.toArray() },
      left: { pos: doorLeftMesh.position.toArray(), scale: doorLeftMesh.scale.toArray(), visible: doorLeftMesh.visible },
      right: { pos: doorRightMesh.position.toArray(), scale: doorRightMesh.scale.toArray(), visible: doorRightMesh.visible },
    });
    window.__powerup = () => ({
      state: POWERUP_TUNE,
      equipped: !!rig.powerup,
      clipLoaded: !!plasticClipTemplate,
      card: rig.powerup
        ? {
            pos: rig.powerup.cardMesh.position.toArray(),
            scale: rig.powerup.cardMesh.scale.toArray(),
            kind: rig.powerup.kind,
            frameIndex: rig.powerup.frameIndex,
            frameTex: POWERUP_FRAMES[rig.powerup.kind][rig.powerup.frameIndex].tex,
          }
        : null,
      clip: rig.powerup
        ? {
            pos: rig.powerup.clip.position.toArray(),
            rotDeg: rig.powerup.clip.rotation.toArray().slice(0, 3).map((r) => +THREE.MathUtils.radToDeg(r).toFixed(1)),
            scale: rig.powerup.clip.scale.toArray(),
          }
        : null,
    });
    window.__rescue = () => ({
      active: !!rescue,
      t: rescue ? +rescue.t.toFixed(3) : null,
      isLastFork: rescue?.isLastFork ?? null,
      landing: rescue?.landing ?? null,
      ignited: rescue?.ignited ?? null,
      detached: rescue?.detached ?? null,
      figurePos: figure.position.toArray().map((v) => +v.toFixed(3)),
      camPos: rescue?.camPos ? rescue.camPos.toArray().map((v) => +v.toFixed(3)) : null,
    });
    window.__stoneCounts = () => stoneMeshes.map((m) => m.count);
    window.__stoneMeshes = stoneMeshes;
    window.__islands = () => islands.map((g) => g.position.toArray().map((v) => +v.toFixed(2)));
    window.__brokenPieces = () =>
      brokenPieces.map((b) => ({
        pos: b.mesh.position.toArray().map((v) => +v.toFixed(3)),
        visible: b.mesh.visible,
        inScene: !!b.mesh.parent,
      }));
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
    resistWave.setSize();
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

    /** Called by GameRoom.jsx when a teammate's own device reports (or updates) where it's resting — see the "teammates" section above. */
    updateTeammate,
    /** Called by GameRoom.jsx when a teammate leaves the room. */
    removeTeammate,
    /** Called by GameRoom.jsx with a relayed in-round event (a pickup claim, etc.) — see the "pickup" section and useLobby's `game-event` handler. */
    applyGameEvent,

    restart,

    /** Turns this device from a player into a spectator, in place, once its own round has ended in a fall — see becomeSpectator's own header comment for why this replaces the old remount-into-role="watching" design. */
    becomeSpectator,

    /**
     * Sends this device's state again (the projector asks when it opens or
     * reloads mid-round, see useLobby.js's `report-state`): a player's
     * position as it stands. Nothing while moving, falling, rescued or
     * abducted, since pings are already flowing; 'gone' once a fall has
     * played out. Spectators (the guide, Watch mode) have no position.
     */
    reportState() {
      if (isSpectatorRole(role)) return;
      if (leg || falling || abduction || rescue) return;
      notifyPlayerState(finished && !finishedSuccess ? 'gone' : 'resting');
    },

    /** Projector: follow this player (a roster token), or null to let the camera choose. */
    watch(token) {
      watchToken = token;
      clearWatchAdvanceTimer();
    },

    /** DEV: run one frame now (as window.__tick does), for driving a world whose window gets no animation frames. */
    step() {
      if (rafId !== null) cancelAnimationFrame(rafId);
      tick();
    },

    /** DEV: draw a frame now and return it as a PNG data URL (the projector's window.__projectorCapture). */
    capture() {
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL('image/png');
    },

    /** Projector: how far the camera has risen into the clouds for a wipe, 0-1 (see camLift). */
    setLift(v) {
      camLift = Math.max(0, Math.min(1, v));
    },

    /** Projector: draw frames (this team is on screen) or not (it isn't; it still updates). */
    setActive(on) {
      drawing = !!on;
    },

    /**
     * Projector: who is followed, and each runner as this world has them:
     * [{ token, displayName, forkIndex, phase, visible, falling, abducted }].
     */
    snapshot() {
      return {
        watching: watchToken,
        loaded: !!sections.length,
        players: [...teammates.entries()].map(([token, e]) => ({
          token,
          displayName: e.displayName,
          forkIndex: e.forkIndex,
          phase: e.phase,
          visible: e.rig.group.visible,
          airborne: !!e.livePos?.quat, // falling, rescued or carried off
          firing: !!e.rig.powerup?.flame, // a jetpack rescue under way
          abducted: !!e.abduction,
        })),
      };
    },

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
      document.removeEventListener('visibilitychange', onTagDebugVisibility); // temporary — see tagDebugLog's own comment
      clearTimeout(noticeTimer);
      clearWatchAdvanceTimer();
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (abductRafId !== null) cancelAnimationFrame(abductRafId);
      resetDefenceState();
      resistWave.dispose();
      abductDefense?.dispose();
      abductGuideView?.dispose();
      harness?.dispose();
      bgTuner?.dispose();
      rescueTuner?.dispose();
      tagTuner?.dispose();
      archTuner?.dispose();
      clearTimeout(archRebuildTimer);
      disposeArches();
      for (const m of Object.values(wordSigns)) m.userData.frame?.dispose();
      shadowCatcherGeometry.dispose();
      shadowCatcherMaterial.dispose();
      if (archTextures) for (const t of Object.values(archTextures)) t.dispose();
      resizeObserver.disconnect();
      if (providedRenderer) {
        // The caller's renderer lives on (see `renderer` above): free what
        // this scene put on the GPU instead. A texture or geometry another
        // mount still uses just uploads again the next time it's drawn.
        scene.traverse((obj) => {
          obj.geometry?.dispose();
          for (const m of [obj.material].flat()) {
            if (!m) continue;
            for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
            m.dispose();
          }
        });
        renderer.renderLists.dispose();
      } else {
        renderer.dispose();
        renderer.forceContextLoss();
      }
      container.innerHTML = '';
    },
  };
}
