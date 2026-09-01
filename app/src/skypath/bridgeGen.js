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
  // The plank(s) that break under the player instead of simply being absent
  // (Luke, 2026-09-04 — the real version of the "one or two planks break and
  // fall" ask; missingPlanks/gapCenterT above were the placeholder for it).
  // A bridgeT (0..1) value; whichever plank slot's own centre lands closest
  // to it, AND the slot immediately before it (Luke, 2026-09-04: "the middle
  // plank and the one before it"), are pulled out of the normal instanced
  // batch and built as their own standalone meshes instead (see the plank
  // section below and breakPlank()), so each can be swapped for two broken
  // halves later without touching every other plank's instance data.
  // null = no plank is singled out.
  breakableT: null,
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
export function buildBridge(from, to, options = {}, wind = null, plankVariants = null) {
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
  ropes.name = 'ropes'; // find-by-name, not position — see the plank section below for why child *count* can no longer be assumed fixed
  ropes.castShadow = true;
  for (const g of ropeGeoms) g.dispose();
  group.add(ropes);

  // -------------------------------------------------------------- planks
  // Laid across the two deck ropes, resting on top of them, tilted to follow
  // the local slope.
  //
  // Hand-modelled variants (Luke, 2026-09-03 — three plank meshes, see
  // PLANK_MODELS in skyPath.js) replace the plain box once loaded. Three
  // distinct meshes can't share one InstancedMesh (each needs its own
  // geometry), so this is genuinely three draw calls for planks now rather
  // than one — still cheap at the instance counts here (well under 30 planks
  // a bridge). Falls back to the original single procedural box — one
  // InstancedMesh, one draw call — only if the plank models' fetch genuinely
  // failed (see PLANK_MODELS's own comment); a bridge is never actually
  // *built* before they've had the chance to load.
  const plankCount = Math.max(1, Math.floor(sampled.total / p.plankSpacing));
  // Used only by heightAt()/clearsAt() below, as the walker's single "deck
  // surface" height regardless of which specific plank variant happens to be
  // underfoot at a given point — the ~0.02-unit difference between variants'
  // real thicknesses is not worth tracking per-point for a height the walker
  // only ever needs approximately right.
  const referenceLift = p.ropeRadius + p.plankThickness / 2;
  const usingVariants = !!(plankVariants && plankVariants.length);
  // Each bridge needs its OWN copy of a variant's geometry, even though the
  // shape is shared: `aSpanT` (the wind envelope, below) is an *instanced*
  // attribute, which THREE stores on the geometry object itself — sharing
  // the geometry across bridges would mean every bridge's wind phase
  // silently clobbers every other bridge's the moment a later one is built.
  // The material has no such per-instance state, so it's fine — and
  // preferable — to share it as-is (already wind-patched once, at load
  // time, in skyPath.js).
  const plankVariantDefs = usingVariants
    ? plankVariants.map((v) => ({
        geometry: v.geometry.clone(),
        material: v.material,
        lift: p.ropeRadius + v.halfThickness,
      }))
    : [
        {
          geometry: new THREE.BoxGeometry(p.deckWidth, p.plankThickness, p.plankWidth),
          material: applyWind(new THREE.MeshLambertMaterial({ color: COLORS.plank }), 'instanced'),
          lift: p.ropeRadius + p.plankThickness / 2,
        },
      ];
  const plankMeshes = plankVariantDefs.map(({ geometry, material }) => {
    const mesh = new THREE.InstancedMesh(geometry, material, plankCount);
    mesh.name = 'plank'; // one to three of these now — find by name, not a fixed children[1]
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.sharedMaterial = usingVariants; // see disposeBridge()
    return mesh;
  });
  const plankSpanTs = plankVariantDefs.map(() => new Float32Array(plankCount));
  const placedPerVariant = plankVariantDefs.map(() => 0);

  // The missing run, centred on `gapCenterT` and growing outward from there:
  // 1 takes the single nearest plank, 2 takes the nearest pair, and so on.
  const missing = Math.max(0, Math.min(Math.round(p.missingPlanks), plankCount));
  const centreIdx = Math.round(THREE.MathUtils.clamp(p.gapCenterT, 0, 1) * (plankCount - 1));
  const missingStart = Math.max(0, Math.min(plankCount - missing, centreIdx - Math.floor(missing / 2)));
  const missingEnd = missingStart + missing; // exclusive

  // Bare rope at both ends. Clamped so a large skip on a short span can never
  // remove the whole deck — at least one plank always survives.
  const edgeSkip = Math.max(0, Math.min(Math.round(p.plankEdgeSkip), Math.floor((plankCount - 1) / 2)));

  // Which slot (if any) is the breakable one — found by a quick pre-pass
  // rather than inline in the main loop below, since "closest to a target t"
  // needs every candidate's distance compared, not just a running one. The
  // slot immediately before it breaks too (index increases with t, i.e. with
  // the direction of travel, so "before" is simply index - 1) — both planks
  // give way together at the low point rather than just the one underfoot.
  let breakableIndex = -1;
  if (p.breakableT != null) {
    let bestDist = Infinity;
    for (let i = 0; i < plankCount; i++) {
      if (i < edgeSkip || i >= plankCount - edgeSkip) continue;
      if (i >= missingStart && i < missingEnd) continue;
      const s = (i + 0.5) * (sampled.total / plankCount);
      const dist = Math.abs(frameAtLength(sampled, s).t - p.breakableT);
      if (dist < bestDist) {
        bestDist = dist;
        breakableIndex = i;
      }
    }
  }
  const breakableIndices = new Set(
    [breakableIndex, breakableIndex - 1].filter(
      (i) => i >= edgeSkip && i < plankCount - edgeSkip && !(i >= missingStart && i < missingEnd)
    )
  );
  const breakablePlanks = []; // filled in below as breakableIndices are reached

  // Random appearance per plank — which variant, and whether it's flipped
  // 180° about one local axis — with the one rule Luke asked for: never let
  // two *adjacent* planks come out identical (same model AND same flip).
  // Checking only the immediately previous plank (not every plank so far) is
  // deliberate and sufficient — "identical" was scoped to neighbours, and a
  // global uniqueness rule would run out of the 3-variants × 4-flips = 12
  // combinations well before a long bridge's plank count did.
  const FLIP_AXES = [null, 'x', 'y', 'z']; // null = no flip
  const flipQuat = new THREE.Quaternion();
  const flipMat = new THREE.Matrix4();
  function randomAppearance(prev) {
    if (plankVariantDefs.length === 1 && FLIP_AXES.length <= 1) return { variant: 0, flip: null };
    let choice;
    do {
      choice = {
        variant: Math.floor(Math.random() * plankVariantDefs.length),
        flip: FLIP_AXES[Math.floor(Math.random() * FLIP_AXES.length)],
      };
    } while (prev && choice.variant === prev.variant && choice.flip === prev.flip);
    return choice;
  }

  const m = new THREE.Matrix4();
  const missingCentres = []; // world positions of the removed planks, for the fall animation later
  let prevAppearance = null;
  for (let i = 0; i < plankCount; i++) {
    if (i < edgeSkip || i >= plankCount - edgeSkip) continue; // bare rope running on to the post
    // Half-spacing at each end keeps the run centred rather than crowding one anchor.
    const s = (i + 0.5) * (sampled.total / plankCount);
    const f = frameAtLength(sampled, s);
    if (i >= missingStart && i < missingEnd) {
      const variantLift = plankVariantDefs[0].lift; // any variant's own lift is a fine estimate for a gap marker
      missingCentres.push(f.position.clone().addScaledVector(f.up, variantLift));
      prevAppearance = null; // a gap breaks adjacency — nothing to compare the next real plank against
      continue;
    }
    const appearance = randomAppearance(prevAppearance);
    prevAppearance = appearance;
    const { lift } = plankVariantDefs[appearance.variant];
    const seat = f.position.clone().addScaledVector(f.up, lift);

    m.makeBasis(f.side, f.up, f.tangent);
    if (appearance.flip) {
      // Rotating 180° about the plank's *local* X/Y/Z is the same rotation as
      // rotating about that same axis expressed in world space — i.e. about
      // f.side/f.up/f.tangent themselves, since those world vectors are
      // exactly what local X/Y/Z map to through the basis above. That
      // equivalence (Rot(Bv,θ)·B = B·Rot(v,θ) for any rotation B) is what
      // lets this reuse f.side/f.up/f.tangent directly instead of rotating
      // in a separate local frame — but it also means the flip has to be
      // premultiplied (applied after the basis, in world space), not
      // multiplied (applied before it, in local space); the two are only
      // interchangeable together, never mixed.
      const axis = appearance.flip === 'x' ? f.side : appearance.flip === 'y' ? f.up : f.tangent;
      flipQuat.setFromAxisAngle(axis, Math.PI);
      flipMat.makeRotationFromQuaternion(flipQuat);
      m.premultiply(flipMat);
    }
    m.setPosition(seat);

    if (breakableIndices.has(i)) {
      // Own mesh, own (unpatched) material clone — this plank needs to be
      // independently removable later, which an instanced slot can't do
      // without disturbing every other plank sharing that InstancedMesh.
      // Not wind-patched: it's about to be swept away the moment it's
      // reached, so a beat of visible sway before that isn't worth the
      // shader complexity of hooking a lone non-instanced mesh into the
      // instanced-only injection in bridgeWind.js.
      const variant = plankVariantDefs[appearance.variant];
      const geometry = variant.geometry.clone();
      const material = variant.material.clone(); // Material.clone() does NOT copy onBeforeCompile — this is a plain, wind-free material
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = 'plank';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.applyMatrix4(m);
      group.add(mesh);
      breakablePlanks.push({
        mesh,
        position: seat.clone(),
        side: f.side.clone(),
        up: f.up.clone(),
        tangent: f.tangent.clone(),
        halfWidth: p.deckWidth / 2,
        halfThickness: variant.halfThickness ?? p.plankThickness / 2,
        halfDepth: p.plankWidth / 2,
      });
      continue;
    }

    const slot = placedPerVariant[appearance.variant]++;
    plankMeshes[appearance.variant].setMatrixAt(slot, m);
    plankSpanTs[appearance.variant][slot] = f.t;
  }
  plankMeshes.forEach((mesh, i) => {
    mesh.count = placedPerVariant[i];
    mesh.instanceMatrix.needsUpdate = true;
    mesh.geometry.setAttribute('aSpanT', new THREE.InstancedBufferAttribute(plankSpanTs[i], 1));
    group.add(mesh);
  });

  // -------------------------------------------------------------- posts
  // Two at each end, one per deck rope, planted through the deck.
  const postH = p.postHeight + p.postEmbed;
  const posts = new THREE.InstancedMesh(
    new THREE.BoxGeometry(p.postSize, postH, p.postSize),
    new THREE.MeshLambertMaterial({ color: COLORS.post }),
    4
  );
  posts.name = 'post';
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
    // Where the missing planks would have sat — the older, now-unused-by-
    // skyPath.js static-gap approach; left in for the tuning page's own
    // missingPlanks slider. Null unless that option was actually used.
    missingCentres,
    // The plank(s) singled out to break (see BRIDGE_DEFAULTS.breakableT) —
    // empty if none was requested / none of the candidate slots survived
    // edgeSkip/missingPlanks. Hand each entry to breakPlank() at the moment
    // the walker reaches them.
    breakablePlanks,
    /** Deck-surface height at `t` ∈ [0, 1] along the span, relative to the island's deck level. */
    heightAt: (t) =>
      p.deckHeight + catenaryY(2 * THREE.MathUtils.clamp(t, 0, 1) - 1, p.sag, p.sagShape) + referenceLift,
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

/**
 * Splits ONE of a bridge's designated breakable planks (see BRIDGE_DEFAULTS.
 * breakableT / group.userData.bridge.breakablePlanks) into two jagged
 * pieces — called once per plank from skyPath.js at the exact moment the
 * walker reaches them, per Luke's sketch (2026-09-04): a zigzag crack across
 * the width, both halves tipping away as the player falls.
 *
 * This is NOT a slice of the plank's actual mesh. All three plank models are
 * close to a plain box — their surface detail lives in the wood-grain
 * texture, not sculpted geometry — so a real mesh-boolean cut (clipping
 * triangles against a cutting surface, capping the new faces, fixing up UVs)
 * would be a lot of fragile machinery for a difference nobody would see.
 * Instead this builds two NEW pieces from scratch, sized to the SAME plank's
 * own bounding box and textured with its own (already-cloned, wind-free)
 * material, seamed by a randomised zigzag.
 *
 * Disposes the original intact mesh's geometry and detaches it from its
 * parent — its material is NOT disposed, since both returned pieces keep
 * using that same material reference.
 *
 * Returns `[{ mesh, halfExtents }, { mesh, halfExtents }]`, each already
 * positioned/oriented in world space (`mesh.position`/`mesh.quaternion`) —
 * ready to add straight to a scene — and centred on its OWN geometric
 * centroid rather than the original plank's, specifically so a caller wiring
 * up physics can hand `halfExtents` straight to a box collider without it
 * being offset from the body's own origin.
 */
export function breakPlank(breakablePlank) {
  const { mesh, position, side, up, tangent, halfWidth, halfThickness, halfDepth } = breakablePlank;
  mesh.parent?.remove(mesh);
  mesh.geometry.dispose();

  // Reused for both pieces: their local axes match the plank's (X = across
  // the deck, Y = up/thickness, Z = direction of travel), even though each
  // piece is built and centred in its own local frame below. No translation
  // component, so applying it to a point rotates without also translating.
  const basis = new THREE.Matrix4().makeBasis(side, up, tangent);

  // The seam: a polyline from the depth-wise front edge to the back edge,
  // zigzagging across the width. 3 interior points read as a deliberate
  // jagged crack rather than a single diagonal cut or a busy sawtooth.
  const SEAM_SEGMENTS = 4;
  const JITTER = halfWidth * 0.35;
  const seam = [];
  for (let i = 0; i <= SEAM_SEGMENTS; i++) {
    const z = THREE.MathUtils.lerp(-halfDepth, halfDepth, i / SEAM_SEGMENTS);
    // Endpoints pinned to the centreline (x=0) so the crack starts and ends
    // at the plank's actual long edges rather than partway along them;
    // interior points jitter left/right of it.
    const x = i === 0 || i === SEAM_SEGMENTS ? 0 : (Math.random() * 2 - 1) * JITTER;
    seam.push(new THREE.Vector2(x, z));
  }

  // sideSign: -1 = the half toward -X, +1 = the half toward +X.
  function pieceGeometry(sideSign) {
    const outerX = sideSign * halfWidth;
    const shape = new THREE.Shape();
    shape.moveTo(outerX, -halfDepth);
    shape.lineTo(outerX, halfDepth);
    // Walked in opposite directions from each side so both shapes trace a
    // simple (non-self-intersecting) polygon around their own half of the
    // original footprint.
    for (const pt of sideSign < 0 ? [...seam].reverse() : seam) shape.lineTo(pt.x, pt.y);
    shape.lineTo(outerX, -halfDepth);

    // Shape-space is (X-across-deck, Z-depth); ExtrudeGeometry extrudes
    // along its own Z, which becomes thickness — rotateX(-90°) below maps
    // that extrusion onto local Y (up) instead, matching every other plank's
    // axis convention in this file.
    const geo = new THREE.ExtrudeGeometry(shape, { depth: halfThickness * 2, bevelEnabled: false, curveSegments: 1 });
    geo.translate(0, 0, -halfThickness); // centre the extrusion (was 0..2*halfThickness)
    geo.rotateX(-Math.PI / 2);

    // Re-centre on this piece's OWN centroid, not the original plank's — a
    // physics body wants its collider centred on the body's own origin.
    geo.computeBoundingBox();
    const centre = geo.boundingBox.getCenter(new THREE.Vector3());
    geo.translate(-centre.x, -centre.y, -centre.z);
    const halfExtents = geo.boundingBox.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    return { geo, centre, halfExtents };
  }

  // Winding direction isn't worth chasing exactly for two pieces of tumbling
  // debris that are gone within a couple of seconds — DoubleSide sidesteps
  // it entirely. Safe to mutate: this material is already a per-plank clone
  // (see the plank section above), shared by nothing else.
  mesh.material.side = THREE.DoubleSide;

  return [-1, 1].map((sideSign) => {
    const { geo, centre, halfExtents } = pieceGeometry(sideSign);
    const piece = new THREE.Mesh(geo, mesh.material);
    piece.castShadow = true;
    piece.receiveShadow = true;
    // The centroid was computed in the plank's local frame — rotate it into
    // world space by the same basis before offsetting the world position.
    piece.position.copy(position).add(centre.applyMatrix4(basis));
    piece.quaternion.setFromRotationMatrix(basis);
    return { mesh: piece, halfExtents };
  });
}

/**
 * Frees a bridge group's geometry/materials. Mirrors clearJourney()'s
 * handling of template-sourced islands: a plank mesh using a loaded variant
 * shares its material across every bridge in the game (see the plank section
 * above), so disposing it here would break every other bridge's planks the
 * next time one of THEM is torn down. Its geometry is still safe to dispose —
 * that IS cloned per bridge, for the wind attribute's sake — so only the
 * material is skipped, via the `sharedMaterial` flag set when that mesh was
 * built.
 */
export function disposeBridge(group) {
  for (const child of group.children) {
    child.geometry?.dispose();
    if (!child.userData?.sharedMaterial) child.material?.dispose();
  }
}
