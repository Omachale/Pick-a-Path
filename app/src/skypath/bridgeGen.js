/**
 * Builds one rope bridge as real geometry, following a straight span between
 * two anchor points (an island edge to the next island's edge).
 *
 * Replaces the scattered stone pavers as the thing that carries the player
 * between islands (Luke, 2026-08-31). See TODO.md, "Rope bridges replace path
 * stones" for the full reasoning; the short version of the two decisions that
 * shape this file:
 *
 *  - **The hanging shape is maths, not physics.** A rope under its own weight
 *    settles into a catenary (`y = a·cosh(x/a)`), and a plank deck slung from
 *    two ropes settles into very nearly the same curve. Simulating that with
 *    Rapier would spend a lot of CPU converging on a shape that is one line to
 *    write down — and it would then sit perfectly still forever, because the
 *    walker is pure waypoint interpolation and never physically touches the
 *    world (the existing Rapier world has no colliders in it at all; it exists
 *    only to tumble the card on a fall). Physics buys *reaction*, not *shape*.
 *    Sway is deliberately deferred (Luke: "leave sway until we've got the
 *    bridge") and, when it comes, wants to be a cheap decaying step-response
 *    on top of this curve rather than a joint chain.
 *  - **Instanced, not one mesh per part.** A full round is ~350 planks and
 *    ~50 posts across six forks. As individual meshes that is ~400 draw calls
 *    on a target phone; as two InstancedMeshes plus one merged rope geometry
 *    it is three. This mirrors what `stoneMeshes` already does in skyPath.js
 *    and is the reason the "make the whole bridge one object in Blender"
 *    option was passed over: the route is generated at runtime and every span
 *    differs slightly (island headings are corrected per fork), so a baked
 *    fixed-length bridge would need stretching to fit. Posts and planks are
 *    the atoms; a hand-modelled .glb can replace either one later exactly the
 *    way `island-basic-v2.glb` replaced `buildIsland()` — one function
 *    changes, nothing else.
 *
 * Parameters were settled on the standalone tuning page (app/bridge-tuner.html
 * → src/bridgeProto.js) against real island spacing and a real character for
 * scale. Re-open that page rather than guessing new numbers here.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Every dimension is in world units, the same units FIGURE_H (1.27) and
 * ISLAND_RADIUS (4) are in — a bridge spans ~9 units, so roughly seven
 * character-heights. Sizes a person interacts with (deck width, plank
 * spacing, handrail height) are stride/reach questions first and scenery
 * second, the same rule STONE_SIZE follows in skyPath.js.
 */
/**
 * FINAL — agreed with Luke 2026-09-01 on the tuning page (app/bridge-tuner.html,
 * whose slider interface is now parked; see the header comment there for how to
 * bring it back). These are settled numbers, not starting guesses: re-open that
 * page rather than editing them by eye here.
 */
export const BRIDGE_DEFAULTS = {
  deckWidth: 0.85,       // gap between the two deck ropes = plank length.
  sag: 1.07,             // vertical drop at midspan, below the deck ropes' anchor height.
  sagShape: 0.2,         // catenary tightness `k` — low is parabola-ish, high hangs sharply near the anchors.
  planBow: 0,            // sideways bow at midspan. 0 = dead straight, which is what a rope under tension actually does; see the note in bridgeCentreline().
  // How high the deck ropes are tied on the posts, above the island's deck
  // surface. Raising this is what stops the sagging deck cutting through the
  // island rim: at 0 the rope leaves the anchor at exactly deck level and is
  // already below it a fraction of a step later, while still horizontally
  // over the island's rock. Lift it and the rope stays clear until it is out
  // over open air. See also plankEdgeSkip, which attacks the same problem
  // from the other side.
  deckHeight: 0.17,
  plankSpacing: 0.47,    // centre-to-centre along the span.
  plankWidth: 0.26,      // plank size along the direction of travel; the difference from plankSpacing is the gap you see through.
  plankThickness: 0.04,
  // Planks left off at *each* end, leaving bare rope running on to the posts.
  // Lets the plank run start out over open air rather than where the deck
  // would otherwise be buried in the island's edge — the ropes still reach
  // the posts, so the bridge stays visually continuous.
  plankEdgeSkip: 1,
  handrailHeight: 0.7,   // upper ropes above the deck ropes — hand height, not shoulder.
  postHeight: 1.13,      // posts stand proud of the handrail so the ropes read as tied off below the top.
  postSize: 0.08,        // square cross-section.
  postEmbed: 0.5,        // how far each post sinks below deck level, so it reads as planted rather than resting.
  ropeRadius: 0.03,
  // Missing planks — the wrong branch's gap (phase 2). A contiguous run of
  // this many planks is left out, centred on `gapCenterT`, rather than every
  // plank past some point vanishing: the player is meant to reach a couple of
  // planks that break and drop (Luke, 2026-08-31), so the deck has to
  // continue on the far side of the hole. 0 = a complete bridge. Both of these
  // are route-specific runtime state, not tuned "look" constants — skyPath.js
  // sets them per branch (see BRIDGE_WRONG_GAP_T/BRIDGE_WRONG_MISSING), and
  // the tuning page exposes only `missingPlanks` for a quick visual check.
  missingPlanks: 0,
  gapCenterT: 0.5,
};

/**
 * Where a bridge meets an island, in that island's own local frame — the same
 * role EDGE_LATERAL / EDGE_FORWARD play in skyPath.js, settled on the tuning
 * page alongside BRIDGE_DEFAULTS (Luke, 2026-09-01).
 *
 * **`lateral` is a real change from the stone path**, and the port needs to
 * know it: skyPath.js derives EDGE_LATERAL as `ISLAND_RADIUS * sin(30°)` = 2.0,
 * whereas bridges want **0.8**. Two consequences worth being deliberate about
 * rather than surprised by:
 *  - The gap between the two routes at an island narrows from 4.0 to 1.6.
 *  - Read back through that same formula, 0.8 implies a fork half-angle of
 *    ~11.5°, not 30°. Bridges are straight and parallel (see planBow), so the
 *    fork's "angle" is no longer really an angle — which is why this is stated
 *    as a flat distance here rather than left derived from FORK_HALF_ANGLE.
 *
 * `forward` is unchanged from the value skyPath.js already derives
 * (ISLAND_RADIUS * cos(30°)); at lateral 0.8 the anchor lands 3.56 from the
 * island centre, comfortably inside the deck's radius of 4.
 */
export const BRIDGE_ANCHORS = {
  lateral: 0.8,
  forward: 3.464,
};

const COLORS = {
  rope: 0x8a6b47,
  plank: 0x9b7346,
  post: 0x6f5436,
};

const ROPE_SAMPLES = 48;   // points sampled along a rope before it becomes a tube
const ROPE_RADIAL = 5;     // sides on the tube — ropes are thin enough that 5 reads as round

/**
 * Vertical offset of a hanging rope at `u` ∈ [-1, 1], normalised so it is 0
 * at both anchors and exactly -`sag` at the midpoint. This is a true catenary
 * rather than the parabola it is often approximated by; both are one line, so
 * there is no reason to take the approximation.
 */
function catenaryY(u, sag, k) {
  const ck = Math.cosh(k);
  return -sag * ((ck - Math.cosh(k * u)) / (ck - 1));
}

/**
 * The bridge's centreline: position and local frame at `t` ∈ [0, 1] along the
 * span, in world space.
 *
 * A note on `planBow`, because it is a real change from how the stone path
 * behaved: the stone branches bow *sideways* by FORK_PINCH_WIDTH, pinching
 * toward each other at the midpoint to make the two routes read as an
 * hourglass rather than two parallel lines. A rope bridge physically cannot
 * do that — tension pulls it straight between its anchors — so the default
 * here is 0 and the two bridges leaving a fork end up parallel. The parameter
 * exists so that look can still be dialled back in if the parallel version
 * turns out to read worse; it is a deliberate choice, not an oversight.
 */
function bridgeCentreline(from, to, p) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const span = Math.hypot(dx, dz);
  const ux = dx / span;
  const uz = dz / span;
  // Horizontal perpendicular, used for both the sideways bow and for
  // offsetting the two deck ropes either side of the centre.
  const nx = -uz;
  const nz = ux;

  return {
    span,
    side: new THREE.Vector3(nx, 0, nz),
    at(t) {
      const bow = p.planBow * Math.sin(Math.PI * t);
      return new THREE.Vector3(
        from.x + dx * t + nx * bow,
        // Deck ropes hang from `deckHeight` up the posts, not from deck level
        // itself — see BRIDGE_DEFAULTS.deckHeight. The posts stay planted at
        // the island's own deck level regardless (they set their own Y).
        p.deckHeight + catenaryY(2 * t - 1, p.sag, p.sagShape),
        from.z + dz * t + nz * bow
      );
    },
  };
}

/** Samples a curve into points plus their cumulative arc length. */
function sampleCurve(centre, count) {
  const points = [];
  const lengths = [0];
  for (let i = 0; i <= count; i++) {
    const pt = centre.at(i / count);
    points.push(pt);
    if (i > 0) lengths.push(lengths[i - 1] + pt.distanceTo(points[i - 1]));
  }
  return { points, lengths, total: lengths[lengths.length - 1] };
}

/**
 * Position and orientation at arc length `s` along a sampled curve. Planks are
 * spaced by *arc length* rather than by `t` so their spacing stays even as the
 * deck dips — spacing is a stride quantity, and a stride does not get longer
 * because the ground tilted.
 */
function frameAtLength(sampled, s) {
  const { points, lengths } = sampled;
  let i = 1;
  while (i < lengths.length - 1 && lengths[i] < s) i++;
  const segLen = lengths[i] - lengths[i - 1];
  const f = segLen > 1e-9 ? (s - lengths[i - 1]) / segLen : 0;
  const position = points[i - 1].clone().lerp(points[i], f);
  const tangent = points[i].clone().sub(points[i - 1]).normalize();
  const side = new THREE.Vector3(0, 1, 0).cross(tangent).normalize();
  const up = tangent.clone().cross(side).normalize();
  return { position, tangent, side, up, t: (i - 1 + f) / (points.length - 1) };
}

function ropeTube(points, radius) {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const geo = new THREE.TubeGeometry(curve, ROPE_SAMPLES, radius, ROPE_RADIAL, false);
  // Where each vertex sits along the span, 0..1 — the wind shader needs it for
  // the amplitude envelope that pins the rope to its anchors. TubeGeometry
  // emits vertices ring by ring along the curve, (tubular+1) rings of
  // (radial+1) vertices, so the ring index recovers it exactly rather than
  // having to be inferred from position.
  const ring = ROPE_RADIAL + 1;
  const spanT = new Float32Array(geo.attributes.position.count);
  for (let i = 0; i < spanT.length; i++) spanT[i] = Math.floor(i / ring) / ROPE_SAMPLES;
  geo.setAttribute('aSpanT', new THREE.BufferAttribute(spanT, 1));
  return geo;
}

/**
 * Builds one bridge from `from` to `to` (both `{x, z}`, at deck level y=0).
 * Returns a Group of three objects — ropes, planks, posts — so the caller can
 * position/dispose it as a unit. Options are merged over BRIDGE_DEFAULTS.
 */
export function buildBridge(from, to, options = {}, wind = null) {
  const p = { ...BRIDGE_DEFAULTS, ...options };
  const group = new THREE.Group();
  // Ropes and planks must be patched by the SAME wind instance — they share
  // uniforms, and a deck swaying on a different clock from the ropes holding
  // it up tears apart visibly. Posts are deliberately never patched: they are
  // planted in rock.
  const applyWind = (mat, mode) => (wind ? wind.patch(mat, mode) : mat);

  // The anchors are used exactly as given. An earlier version pulled both
  // ends *inward along the span* here, meaning to stand the posts on the deck
  // rather than the rim — it did the opposite. The route's edge point already
  // sits at radius 4.0 from the island centre (√(2.0² + 3.464²)), precisely on
  // a deck of radius 4, so moving along the span pushed it to 4.44 and left
  // the outer posts hanging in mid air. Standing a post further onto the deck
  // is a *radial* move toward the island's centre, not a move along the span,
  // and it belongs with the anchor points themselves — see bridgeAnchors() in
  // bridgeProto.js, where both that depth and the two bridges' lateral
  // spacing are chosen.
  const a = { x: from.x, z: from.z };
  const b = { x: to.x, z: to.z };

  const centre = bridgeCentreline(a, b, p);
  const sampled = sampleCurve(centre, ROPE_SAMPLES);
  const halfW = p.deckWidth / 2;

  // -------------------------------------------------------------- ropes
  // Four: two at deck level carrying the planks, two at hand height. The
  // handrails are the deck curve lifted straight up, which keeps them
  // parallel to the deck the whole way — see BRIDGE_DEFAULTS.handrailHeight.
  const ropeGeoms = [];
  for (const s of [1, -1]) {
    const offset = centre.side.clone().multiplyScalar(s * halfW);
    const deckPts = sampled.points.map((pt) => pt.clone().add(offset));
    const railPts = deckPts.map((pt) => pt.clone().setY(pt.y + p.handrailHeight));
    ropeGeoms.push(ropeTube(deckPts, p.ropeRadius));
    ropeGeoms.push(ropeTube(railPts, p.ropeRadius));
  }
  const ropes = new THREE.Mesh(
    mergeGeometries(ropeGeoms, false),
    applyWind(new THREE.MeshLambertMaterial({ color: COLORS.rope }), 'vertex')
  );
  ropes.castShadow = true;
  for (const g of ropeGeoms) g.dispose();
  group.add(ropes);

  // -------------------------------------------------------------- planks
  // Laid across the two deck ropes, resting on top of them, tilted to follow
  // the local slope. One InstancedMesh however many there are.
  const plankCount = Math.max(1, Math.floor(sampled.total / p.plankSpacing));
  const planks = new THREE.InstancedMesh(
    new THREE.BoxGeometry(p.deckWidth, p.plankThickness, p.plankWidth),
    applyWind(new THREE.MeshLambertMaterial({ color: COLORS.plank }), 'instanced'),
    plankCount
  );
  planks.castShadow = true;
  planks.receiveShadow = true;

  // The missing run, centred on `gapCenterT` and growing outward from there:
  // 1 takes the single nearest plank, 2 takes the nearest pair, and so on.
  const missing = Math.max(0, Math.min(Math.round(p.missingPlanks), plankCount));
  const centreIdx = Math.round(THREE.MathUtils.clamp(p.gapCenterT, 0, 1) * (plankCount - 1));
  const missingStart = Math.max(0, Math.min(plankCount - missing, centreIdx - Math.floor(missing / 2)));
  const missingEnd = missingStart + missing; // exclusive

  // Bare rope at both ends. Clamped so a large skip on a short span can never
  // remove the whole deck — at least one plank always survives.
  const edgeSkip = Math.max(0, Math.min(Math.round(p.plankEdgeSkip), Math.floor((plankCount - 1) / 2)));

  const m = new THREE.Matrix4();
  const lift = p.ropeRadius + p.plankThickness / 2; // sit on the ropes, not through them
  const missingCentres = []; // world positions of the removed planks, for the fall animation later
  // Per-instance position along the span, for the wind envelope. Filled in
  // step with `placed`, not with `i` — skipped planks must not leave a stale
  // value behind that some later plank then reads.
  const plankSpanT = new Float32Array(plankCount);
  let placed = 0;
  for (let i = 0; i < plankCount; i++) {
    if (i < edgeSkip || i >= plankCount - edgeSkip) continue; // bare rope running on to the post
    // Half-spacing at each end keeps the run centred rather than crowding one anchor.
    const s = (i + 0.5) * (sampled.total / plankCount);
    const f = frameAtLength(sampled, s);
    const seat = f.position.clone().addScaledVector(f.up, lift);
    if (i >= missingStart && i < missingEnd) {
      missingCentres.push(seat);
      continue;
    }
    m.makeBasis(f.side, f.up, f.tangent);
    m.setPosition(seat);
    planks.setMatrixAt(placed, m);
    plankSpanT[placed] = f.t;
    placed++;
  }
  planks.count = placed;
  planks.instanceMatrix.needsUpdate = true;
  planks.geometry.setAttribute('aSpanT', new THREE.InstancedBufferAttribute(plankSpanT, 1));
  group.add(planks);

  // -------------------------------------------------------------- posts
  // Two at each end, one per deck rope, planted through the deck.
  const postH = p.postHeight + p.postEmbed;
  const posts = new THREE.InstancedMesh(
    new THREE.BoxGeometry(p.postSize, postH, p.postSize),
    new THREE.MeshLambertMaterial({ color: COLORS.post }),
    4
  );
  posts.castShadow = true;
  const endFrames = [frameAtLength(sampled, 0), frameAtLength(sampled, sampled.total)];
  let postIdx = 0;
  for (const f of endFrames) {
    // Yaw only — a post is vertical however the deck is sloping away from it.
    const flatTangent = new THREE.Vector3(f.tangent.x, 0, f.tangent.z).normalize();
    const flatSide = new THREE.Vector3(0, 1, 0).cross(flatTangent).normalize();
    for (const s of [1, -1]) {
      m.makeBasis(flatSide, new THREE.Vector3(0, 1, 0), flatTangent);
      m.setPosition(
        f.position.clone()
          .addScaledVector(centre.side, s * halfW)
          .setY(p.postHeight / 2 - p.postEmbed / 2)
      );
      posts.setMatrixAt(postIdx, m);
      postIdx++;
    }
  }
  posts.instanceMatrix.needsUpdate = true;
  group.add(posts);

  // Everything the caller (or the walker) needs to know about the finished
  // span without re-deriving it: notably `heightAt`, since the deck dips and
  // the figure has to dip with it — the walker is (x, z) only today and will
  // otherwise float above the middle of every bridge.
  group.userData.bridge = {
    span: centre.span,
    length: sampled.total,
    anchors: { from: a, to: b },
    plankCount,
    // Where the missing planks would have sat. Phase 2 needs these to drop a
    // real plank at the right place rather than just never drawing one — the
    // existing card-fall Rapier world is the obvious thing to reuse.
    missingCentres,
    /** Deck-surface height at `t` ∈ [0, 1] along the span, relative to the island's deck level. */
    heightAt: (t) =>
      p.deckHeight + catenaryY(2 * THREE.MathUtils.clamp(t, 0, 1) - 1, p.sag, p.sagShape) + lift,
    /**
     * How far along the span (in world units from the near post) the deck rope
     * first drops below the island's own deck level — i.e. the point past
     * which it can no longer be cutting into the island's rim. Infinity if it
     * never does. This is the diagnostic for the rope-through-the-island
     * problem that `deckHeight` exists to solve.
     */
    clearsAt: (() => {
      for (let i = 1; i <= ROPE_SAMPLES; i++) {
        const t = i / ROPE_SAMPLES;
        if (p.deckHeight + catenaryY(2 * t - 1, p.sag, p.sagShape) < 0) return t * centre.span;
      }
      return Infinity;
    })(),
  };
  return group;
}

/** Frees a bridge group's geometry/materials. Mirrors clearJourney()'s handling of islands. */
export function disposeBridge(group) {
  for (const child of group.children) {
    child.geometry?.dispose();
    child.material?.dispose();
  }
}
