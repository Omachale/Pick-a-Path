/**
 * Paper-plane folding + flight, kept separate from the prototype's scene/UI
 * code the same way skypath's *Gen.js modules are — this is the one place
 * that turns 3 player-drawn crease lines into an actual folded shape and a
 * flight, so a real minigame can reuse it later without dragging the
 * prototype's Three.js scene wiring along.
 *
 * Fold model (Luke, 2026-09-27 design discussion):
 * - The player draws 3 straight lines on a FLAT sheet: a centre line (which
 *   only ever contributes an X split point — it is not itself re-folded
 *   here, since its one lasting effect on final geometry is bounding where
 *   the other two lines are allowed to land), then one diagonal line per
 *   half, each free to start/end anywhere in its half — NOT snapped to the
 *   "ideal" corner. A line that misses the ideal register is deliberately
 *   still turned into a real (if imperfect) fold: we extend the drawn
 *   segment to a full line and clip the CURRENT panel polygon by it via
 *   Sutherland-Hodgman half-plane clipping, so an off-register or shallow
 *   line can legitimately exit through a different edge than intended.
 * - Everything after that (which strip becomes the wing, the wing's own
 *   fold-down crease) is a FIXED proportion of the paper for this prototype
 *   pass, not derived from the nose geometry — Luke wants to see the whole
 *   loop (fold → throw → fly) working first, then swap this one piece for
 *   a derived rule (with this fixed rule kept as its fallback) once the
 *   loop is proven fun. See TODO.md, paper-plane minigame entry.
 * - Curviness in a swipe is deliberately NOT folded as a curve (a curved
 *   crease isn't flat-foldable without real cloth simulation) — instead we
 *   measure the swipe's max deviation from its own straight chord and feed
 *   that in as a "wobble" that only affects flight stability, not shape.
 */
import * as THREE from 'three';

export const PLANE_DEFAULTS = {
  paperW: 2.0,
  paperH: 2.6,
  wingFoldRatio: 0.5, // fraction of each half's width, from the spine outward, that becomes the wing
  closedFoldDeg: 80, // wing hinge angle at the start of the "opening" animation (folded compact)
  dihedralDeg: 12, // final resting wing angle above horizontal, in flight
  foldStepSeconds: 0.5, // duration of each individual fold/open animation step

  gravity: 2.2,
  liftCoef: 0.16, // lift accel per (wingArea * forwardSpeed)
  dragCoef: 0.045, // drag decel per speed^2
  curveStrength: 0.5, // lateral accel per (curveBias * speed)
  wobbleStrength: 0.35, // extra random lateral jitter per unit wobble

  throwPower: 6.5,
  launchYawMaxDeg: 30, // throw swipe's max horizontal deviation maps to +/- this yaw

  groundY: 0,
  islandDistance: 14,
  islandRadius: 2.6,
  holeRadius: 0.45,
};

// ---------------------------------------------------------------- 2D polygon helpers (u,v space)

function cross2(dir, rel) {
  return dir.u * rel.v - dir.v * rel.u;
}

function sub(a, b) {
  return { u: a.u - b.u, v: a.v - b.v };
}

/** Sutherland-Hodgman clip of a simple polygon against ONE half-plane through linePoint, direction lineDir. keepSign=+1 keeps cross>=0, -1 keeps cross<=0. */
function clipPolygonByLine(poly, linePoint, lineDir, keepSign) {
  const out = [];
  const n = poly.length;
  const side = (p) => keepSign * cross2(lineDir, sub(p, linePoint));
  for (let i = 0; i < n; i++) {
    const curr = poly[i];
    const prev = poly[(i - 1 + n) % n];
    const sCurr = side(curr);
    const sPrev = side(prev);
    if (sCurr >= 0) {
      if (sPrev < 0) out.push(intersect(prev, curr, linePoint, lineDir));
      out.push(curr);
    } else if (sPrev >= 0) {
      out.push(intersect(prev, curr, linePoint, lineDir));
    }
  }
  return out;
}

function intersect(a, b, linePoint, lineDir) {
  const f0 = cross2(lineDir, sub(a, linePoint));
  const f1 = cross2(lineDir, sub(b, linePoint));
  const t = f0 / (f0 - f1);
  return { u: a.u + t * (b.u - a.u), v: a.v + t * (b.v - a.v) };
}

function pointInPolygon(poly, pt) {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const pi = poly[i], pj = poly[j];
    const intersects = pi.v > pt.v !== pj.v > pt.v &&
      pt.u < ((pj.u - pi.u) * (pt.v - pi.v)) / (pj.v - pi.v) + pi.u;
    if (intersects) inside = !inside;
  }
  return inside;
}

function polygonArea(poly) {
  let a = 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p.u * q.v - q.u * p.v;
  }
  return Math.abs(a) / 2;
}

function normalize(dir) {
  const len = Math.hypot(dir.u, dir.v) || 1;
  return { u: dir.u / len, v: dir.v / len };
}

/**
 * Splits `poly` by the infinite line through the two given points, and
 * returns { flap, body } where `flap` is whichever side contains
 * `flapRefPoint` (a point known to lie in the corner that's meant to fold).
 */
function foldPanel(poly, lineA, lineB, flapRefPoint) {
  const dir = normalize(sub(lineB, lineA));
  const sideA = clipPolygonByLine(poly, lineA, dir, 1);
  const sideB = clipPolygonByLine(poly, lineA, dir, -1);
  const aIsFlap = sideA.length > 2 && pointInPolygon(sideA, flapRefPoint);
  const flap = aIsFlap ? sideA : sideB;
  const body = aIsFlap ? sideB : sideA;
  return { flap, body, creaseA: lineA, creaseB: lineB, dir };
}

// ---------------------------------------------------------------- swipe -> plane

/**
 * @param {object} swipes - { center: {a,b}, left: {a,b,path}, right: {a,b,path} }
 *   each point {u,v} in paper-local space: u in [-halfW,halfW], v in [0,H] (0 = top/nose edge).
 *   `path` (optional) is the full sampled swipe polyline, used only to score wobble.
 */
export function buildFoldedPlane(swipes, tune = PLANE_DEFAULTS) {
  const halfW = tune.paperW / 2;
  const H = tune.paperH;

  const centerX = clamp((swipes.center.a.u + swipes.center.b.u) / 2, -halfW * 0.7, halfW * 0.7);

  const sides = {};
  for (const side of ['left', 'right']) {
    const outerU = side === 'left' ? -halfW : halfW;
    const uMin = side === 'left' ? -halfW : centerX;
    const uMax = side === 'left' ? centerX : halfW;
    const rect = [
      { u: uMin, v: 0 }, { u: uMax, v: 0 }, { u: uMax, v: H }, { u: uMin, v: H },
    ];
    const swipe = swipes[side];
    const a = { u: clamp(swipe.a.u, uMin, uMax), v: clamp(swipe.a.v, 0, H) };
    const b = { u: clamp(swipe.b.u, uMin, uMax), v: clamp(swipe.b.v, 0, H) };
    // `flap` is the ORIGINAL (unreflected) corner polygon on purpose — the
    // hinge's own 180 degree rotation is what mirrors it onto the body when
    // animated, so building the mesh from a pre-reflected shape here would
    // mirror it twice and misalign it from the body it's meant to meet.
    const { flap, body } = foldPanel(rect, a, b, { u: outerU, v: 0 });

    // Wing/spine split kept for later flight-physics use (wing area) only —
    // NOT rendered yet. `body` (the full, uncut post-nose-fold polygon) is
    // what actually gets rendered for now, per Luke's "verify the first
    // three folds before anything else" request (2026-09-27).
    const wingFoldU = centerX + (outerU - centerX) * tune.wingFoldRatio;
    const wingLineA = { u: wingFoldU, v: 0 };
    const wingLineDir = { u: 0, v: 1 };
    // keepSign is chosen so "wing" is always the OUTER piece (away from the
    // spine at centerX) regardless of which side we're on.
    const wingKeep = side === 'left' ? 1 : -1;
    const wingSide = clipPolygonByLine(body, wingLineA, wingLineDir, wingKeep);
    const wingPoly = wingSide.length > 2 ? wingSide : body;

    sides[side] = {
      bodyPoly: body,
      flapPoly: flap,
      wingArea: polygonArea(wingPoly),
      creaseA: a,
      creaseB: b,
      wingFoldU,
    };
  }

  const areaL = sides.left.wingArea, areaR = sides.right.wingArea;
  const areaDiff = (areaL - areaR) / Math.max(areaL + areaR, 0.001);
  const centerOffset = centerX / halfW; // -1..1
  const wobble = scoreWobble(swipes.left.path) + scoreWobble(swipes.right.path);

  return {
    sides,
    centerX,
    totalWingArea: areaL + areaR,
    curveBias: clamp(areaDiff * 1.5 + centerOffset * 0.5, -1, 1),
    wobble: clamp(wobble, 0, 1),
  };
}

function scoreWobble(path) {
  if (!path || path.length < 3) return 0;
  const a = path[0], b = path[path.length - 1];
  const dir = normalize(sub(b, a));
  let maxDev = 0;
  const chordLen = Math.hypot(b.u - a.u, b.v - a.v) || 1;
  for (const p of path) {
    const perp = Math.abs(cross2(dir, sub(p, a)));
    if (perp > maxDev) maxDev = perp;
  }
  return maxDev / chordLen;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ---------------------------------------------------------------- 3D mesh + hinge rig

function shapeFromPoly(poly) {
  const shape = new THREE.Shape(poly.map((p) => new THREE.Vector2(p.u, -p.v)));
  return new THREE.ShapeGeometry(shape);
}

// `name` is purely for the diagnostic tool (2026-09-27 pass) — it's stamped
// onto the pivot so a mesh's "primary fold" can be found and labelled just by
// walking up its parent chain looking for a `userData.hingeRef`.
//
// `creaseLen` is the crease's ACTUAL length (pivot sits at one real end of
// every crease we build, so the other end is just pivot + axis*creaseLen) —
// the diagnostic tool's live crease-indicator line is drawn strictly between
// these two real points, never past them. Luke, 2026-09-27, second diagnostic
// pass: "Fold lines should only ever exist on the paper... [any excess]
// should be immediately and permanently deleted" — an earlier version drew a
// fixed-length line symmetric about the pivot, which shot past the paper's
// edge whenever the pivot wasn't near the line's middle.
function makeHinge(parent, pivotPoint, axisDirUV, name, creaseLen = 0) {
  const pivot = new THREE.Group();
  pivot.position.set(pivotPoint.u, -pivotPoint.v, 0);
  parent.add(pivot);
  const axis = new THREE.Vector3(axisDirUV.u, -axisDirUV.v, 0).normalize();
  const hinge = {
    pivot,
    axis,
    name,
    creaseFar: creaseLen,
    angleRad: 0, // tracked here so UI can read back "what's this fold currently set to" without decomposing quaternions
    setAngle(theta) {
      this.angleRad = theta;
      pivot.quaternion.setFromAxisAngle(axis, theta);
    },
  };
  pivot.userData.hingeRef = hinge;
  return hinge;
}

function dist(a, b) {
  return Math.hypot(a.u - b.u, a.v - b.v);
}

function attachAt(hinge, mesh, pivotPoint) {
  mesh.position.set(-pivotPoint.u, pivotPoint.v, 0);
  hinge.pivot.add(mesh);
}

/**
 * Builds the Three.js rig for a folded plane: a root Group plus a list of
 * hinge steps to animate IN ORDER. Each step is { hinge, from, to, auto,
 * label }: `auto` steps play automatically right after drawing (the two
 * nose-corner folds); non-auto steps wait for the player to click "Next
 * fold" in the prototype UI, so they can position the camera first
 * (Luke, 2026-09-27: "I want to be able to see each step... one at a time").
 */
// Both sides get the SAME small +Z nudge here, BEFORE the centre fold. The
// centre fold rotates the right half by -PI around the nose-tail (Y) axis,
// which flips the sign of any local Z — so the right half naturally ends up
// at -LAYER_GAP once folded while the left half stays at +LAYER_GAP, giving
// the two layers real separation for the wing-fold step below without this
// module needing to reason about the flip itself.
const LAYER_GAP = 0.003;

// `tune` isn't used yet by the auto steps below, but addWingFold() takes its
// own angle so future tuning still flows through the caller.
export function buildPlaneRig(plane, tune = PLANE_DEFAULTS, colorHex = 0xffffff) {
  const root = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: colorHex, side: THREE.DoubleSide });
  const flapMat = new THREE.MeshBasicMaterial({ color: colorHex, side: THREE.DoubleSide, opacity: 0.9, transparent: true });

  const steps = [];
  const sideMeshes = {};

  // The right half is nested under its own hinge (centred on the SAME X the
  // player's centre swipe defined) so that folding it in half later carries
  // its already-folded nose flap along for free — nesting, not new geometry.
  const leftGroup = new THREE.Group();
  root.add(leftGroup);
  const centerHinge = makeHinge(root, { u: plane.centerX, v: 0 }, { u: 0, v: 1 }, 'Centre fold', tune.paperH);

  // The right side's geometry is authored with ABSOLUTE u-coordinates (u in
  // [centerX, halfW]), same as left — but centreHinge.pivot itself sits at
  // world (centerX, 0, 0). Adding that geometry straight to the pivot (as a
  // plain child, with no compensating offset) double-counts centerX: the
  // pivot's own position PLUS the rotated absolute coordinate, instead of
  // pivot + R*(absolute - pivot). Concretely, the spine edge (u=centerX) was
  // landing at world x=0 instead of x=centerX — coinciding with the left
  // side's spine only when centerX happened to be ~0, which is why this went
  // unnoticed until a less-centred first swipe exposed it as the wing folds
  // going the wrong way / landing on the wrong region entirely.
  const rightContent = new THREE.Group();
  rightContent.position.x = -plane.centerX;
  centerHinge.pivot.add(rightContent);

  for (const side of ['left', 'right']) {
    const s = plane.sides[side];
    const parent = side === 'left' ? leftGroup : rightContent;

    // static body — the full post-nose-fold polygon, nothing clipped out of
    // it, so there is never a gap between this and the flap that folds onto it
    const bodyGeo = shapeFromPoly(s.bodyPoly);
    const bodyMesh = new THREE.Mesh(bodyGeo, mat);
    bodyMesh.position.z = LAYER_GAP;
    bodyMesh.userData.label = `${side === 'left' ? 'Left' : 'Right'} body/spine`;
    parent.add(bodyMesh);

    // the corner flap hinging 180 degrees onto the body along the player's
    // own crease line — this plays automatically right after drawing
    const noseHinge = makeHinge(parent, s.creaseA, sub(s.creaseB, s.creaseA), `${side === 'left' ? 'Left' : 'Right'} nose fold`, dist(s.creaseA, s.creaseB));
    const flapGeo = shapeFromPoly(s.flapPoly);
    const flapMesh = new THREE.Mesh(flapGeo, flapMat);
    attachAt(noseHinge, flapMesh, s.creaseA);
    flapMesh.position.z = LAYER_GAP;
    flapMesh.userData.label = `${side === 'left' ? 'Left' : 'Right'} nose flap`;
    noseHinge.setAngle(0);
    steps.push({ hinge: noseHinge, from: 0, to: Math.PI, auto: true, label: `Fold the ${side} corner down` });

    // kept mutable so addWingFold() can replace the body's geometry with
    // just its "spine" remainder once a wing is split off of it. noseHinge
    // is kept too so addWingFold can check whether the nose flap actually
    // fell inside the wing being split off, and move it along if so.
    const halfW = tune.paperW / 2;
    sideMeshes[side] = { group: parent, bodyMesh, flapMesh, bodyPoly: s.bodyPoly, noseHinge, side, outerU: side === 'left' ? -halfW : halfW };
  }

  // Fold the whole right half over onto the left along the centre crease —
  // Luke: "in the opposite direction of the two diagonal lines", hence -PI
  // where the nose folds above used +PI. `auto: true` so this plays right
  // after the two nose folds, same as them — Luke, second diagnostic pass:
  // "you haven't restored the central axis fold... this should happen before
  // the player makes their final [wing] folds." It had been left non-auto
  // with nothing left to trigger it manually, so it silently never ran.
  centerHinge.setAngle(0);
  steps.push({ hinge: centerHinge, from: 0, to: -Math.PI, auto: true, label: 'Fold in half down the centre' });

  return { root, steps, sideMeshes, centerHinge, colorHex };
}

/**
 * Splits a side's CURRENT body polygon along a player-drawn line (in that
 * side's own local u,v frame) into a kept "spine" piece and a folded-away
 * "wing" piece, replaces the body mesh with the spine, and returns a new
 * hinge step that folds the wing out to `toAngle` radians (90 degrees =
 * PI/2, per Luke's spec: "folded down to 90 degrees... perpendicular to the
 * central fuselage"). Mutates `sideInfo` in place (its bodyMesh geometry and
 * bodyPoly) so a later call would split further, though nothing does yet.
 */
export function addWingFold(sideInfo, lineA, lineB, toAngle, colorHex) {
  const farRef = { u: sideInfo.outerU, v: (lineA.v + lineB.v) / 2 };
  const { flap: wingPoly, body: spinePoly } = foldPanel(sideInfo.bodyPoly, lineA, lineB, farRef);

  sideInfo.bodyMesh.geometry.dispose();
  sideInfo.bodyMesh.geometry = shapeFromPoly(spinePoly);
  sideInfo.bodyPoly = spinePoly;

  const mat = new THREE.MeshBasicMaterial({ color: colorHex, side: THREE.DoubleSide });
  const sideLabel = sideInfo.side === 'left' ? 'Left' : 'Right';
  const wingHinge = makeHinge(sideInfo.group, lineA, sub(lineB, lineA), `${sideLabel} wing fold`, dist(lineA, lineB));
  const wingMesh = new THREE.Mesh(shapeFromPoly(wingPoly), mat);
  attachAt(wingHinge, wingMesh, lineA);
  wingMesh.position.z = sideInfo.bodyMesh.position.z;
  wingMesh.userData.label = `${sideLabel} wing`;
  wingHinge.setAngle(0);

  // The earlier nose-corner flap is a SEPARATE mesh, still attached (static)
  // to this side's group. If the player's wing crease happens to fall
  // between the spine and that flap, the flap now belongs on the wing side
  // — left where it was, it wouldn't move with the wing, and would be left
  // behind as a stray, disconnected-looking shape once the wing rotates out
  // (Luke, 2026-09-27: "some extra face/edge comes from somewhere").
  // `.attach()` reparents while preserving world transform, so the flap
  // doesn't jump when it changes parents here.
  const flapPivotLocal = { u: sideInfo.noseHinge.pivot.position.x, v: -sideInfo.noseHinge.pivot.position.y };
  if (pointInPolygon(wingPoly, flapPivotLocal)) {
    wingHinge.pivot.attach(sideInfo.noseHinge.pivot);
  }

  return { hinge: wingHinge, wingMesh, from: 0, to: toAngle, auto: false, label: 'Fold the wing out' };
}

// ---------------------------------------------------------------- flight

export function makeLaunchVelocity(launchYawRad, launchAngleUpRad, tune = PLANE_DEFAULTS) {
  const p = tune.throwPower;
  return new THREE.Vector3(
    p * Math.cos(launchAngleUpRad) * Math.sin(launchYawRad),
    p * Math.sin(launchAngleUpRad),
    p * Math.cos(launchAngleUpRad) * Math.cos(launchYawRad)
  );
}

/** Advances flight state by dt (seconds) in place. Returns true if it has landed (position.y <= groundY). */
export function stepFlight(state, dt, plane, tune = PLANE_DEFAULTS) {
  const v = state.velocity;
  const speed = v.length();
  const horizSpeed = Math.hypot(v.x, v.z);

  v.y -= tune.gravity * dt;
  v.y += tune.liftCoef * plane.totalWingArea * horizSpeed * dt;

  if (speed > 0.0001) {
    const dragAccel = tune.dragCoef * speed * speed;
    v.addScaledVector(v.clone().normalize(), -dragAccel * dt);
  }

  v.x += plane.curveBias * tune.curveStrength * horizSpeed * dt;
  v.x += (state.wobblePhaseNoise?.() ?? 0) * plane.wobble * tune.wobbleStrength * dt;

  state.position.addScaledVector(v, dt);

  if (state.position.y <= tune.groundY) {
    state.position.y = tune.groundY;
    return true;
  }
  return false;
}

export function classifyLanding(position, tune = PLANE_DEFAULTS) {
  const dx = position.x - 0;
  const dz = position.z - tune.islandDistance;
  const dist = Math.hypot(dx, dz);
  if (dist <= tune.holeRadius) return { result: 'hole', dist };
  if (dist <= tune.islandRadius) return { result: 'island', dist };
  return { result: 'miss', dist };
}
