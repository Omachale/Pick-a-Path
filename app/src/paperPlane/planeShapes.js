/**
 * Three hand-built test planes for the aerodynamics prototype (2026-09-28) —
 * deliberately NOT built through the paper-fold system (paperPlaneGen.js).
 * Folding is paused (see TODO.md, "Paper plane folding — PAUSED") specifically
 * because its generic line-clipping machinery kept producing new bugs; these
 * shapes sidestep that entirely by authoring fixed 3D vertices directly, so
 * we can validate the aerodynamics model in isolation before folding comes
 * back into the picture.
 *
 * Local frame (fresh, independent of the fold system's own UV-based frame):
 *   +X = right, +Y = up, +Z = forward/nose direction.
 *
 * REVISED 2026-09-28, same day: v1 held keel AND total wing area fixed across
 * all three designs, varying only dihedral — Luke caught that this doesn't
 * match what he actually asked for ("a single piece of paper of fixed area
 * arranged in different ways... a glider should have larger wings at the cost
 * of less fuselage, and vice versa"), and separately reported the resulting
 * lift differences were too small to give the three designs distinct
 * identities. Both are fixed by the same change: `wingAreaFraction` is now a
 * per-design knob (glider spends most of the fixed total on wings, dart
 * spends most of it on keel/fuselage instead), with only TOTAL area (keel +
 * nose + both wings) held fixed — matching the fixed-paper-quantity idea.
 * Nose area alone stays fixed across designs (small, representing folded
 * bulk at the tip that doesn't meaningfully trade off against wing shape).
 *
 * Lift now varies through TWO compounding factors instead of one: wing area
 * AND dihedral (cos(dihedral)) — deliberately pushed further apart than v1's
 * dihedral-only spread (10/35/75) specifically so glider and middle stop
 * being close to indistinguishable (cosine is nearly flat near 0°, so a
 * dihedral-only difference between two shallow angles barely separates them
 * — confirmed numerically in TODO.md's aero-model entries). Dart's dihedral
 * was also pulled back from a v1 extreme (75° -> 50°).
 *
 * The wing/fuselage tradeoff area goes into the NOSE panel, not the keel —
 * tried keel first and it backfired: the keel's normal is fixed dead sideways
 * (1,0,0), so it converts area into lateral ("wind") profile at 100% no
 * matter its size, with NO angle to soften it the way wings have. Routing
 * dart's "extra fuselage" there made dart's bulk fuselage make it MORE
 * exposed to crosswind, the opposite of Luke's spec ("dart... less
 * susceptible to the wind, partly due to profile"). The nose panel's normal
 * is fixed forward instead, so routing the tradeoff there converts a smaller
 * wing into MORE DRAG instead of more sideways area — which independently
 * helps two other things Luke asked for: a dart that doesn't go as far, and
 * one that flies a straighter, less floaty, easier-to-aim path (more drag +
 * less lift == closer to a plain ballistic arc). Keel area is now fixed
 * across all three designs (a constant baseline fuselage/spine, the same
 * "doesn't vary much with wing design" reasoning v1 used, just no longer
 * applied to the wing/nose tradeoff too).
 *
 * Each plane is 3 kinds of flat panel — a vertical "keel" triangle (folded
 * fuselage/spine, fixed size), a forward-facing "nose" triangle (flat
 * cross-section — a perfectly flat, unswept wing/keel panel has zero area
 * projected along the direction of travel by construction, so this is the
 * only source of drag, and now the wing/fuselage tradeoff's destination),
 * and two mirrored wing quads tilted up from horizontal by the design's
 * dihedral angle.
 */
import * as THREE from 'three';

const TOTAL_AREA = 1.3; // fixed "one sheet of paper" budget, same across all three designs — arbitrary world-unit scale
const KEEL_FRAC = 0.2; // fixed across designs — constant baseline fuselage/spine, not part of the wing/nose tradeoff
const KEEL_AREA = TOTAL_AREA * KEEL_FRAC;
const TRADEABLE_AREA = TOTAL_AREA - KEEL_AREA; // this is what each design splits between wings and nose

const KEEL_LEN = 0.9;
const KEEL_HEIGHT = (2 * KEEL_AREA) / KEEL_LEN;
const NOSE_ASPECT = 1.1; // height/width, fixed — keeps the nose panel's proportions sane as its AREA varies a lot between designs
const NOSE_Z_OFFSET = KEEL_LEN / 2; // flush with the keel's own nose tip

export const AERO_TEST_PLANES = {
  glider: { wingAreaFraction: 0.85, span: 1.3, dihedralDeg: 15, color: 0xbfe3ff, label: 'Glider (broad wings)' },
  middle: { wingAreaFraction: 0.55, span: 0.85, dihedralDeg: 40, color: 0xf3ead9, label: 'Middle' },
  dart: { wingAreaFraction: 0.25, span: 0.45, dihedralDeg: 50, color: 0xffb3a0, label: 'Dart (narrow wings)' },
};

function triPanel(p0, p1, p2) {
  const e1 = new THREE.Vector3().subVectors(p1, p0);
  const e2 = new THREE.Vector3().subVectors(p2, p0);
  const cross = new THREE.Vector3().crossVectors(e1, e2);
  const area = 0.5 * cross.length();
  const normal = cross.normalize(); // sign doesn't matter — physics only ever uses |dot(normal, axis)|
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z], 3)
  );
  geometry.computeVertexNormals();
  return { geometry, normal, area };
}

function quadPanel(p0, p1, p2, p3) {
  const areaA = 0.5 * new THREE.Vector3().subVectors(p1, p0).cross(new THREE.Vector3().subVectors(p2, p0)).length();
  const areaB = 0.5 * new THREE.Vector3().subVectors(p2, p0).cross(new THREE.Vector3().subVectors(p3, p0)).length();
  const normal = new THREE.Vector3()
    .subVectors(p1, p0)
    .cross(new THREE.Vector3().subVectors(p2, p0))
    .normalize();
  const geometry = new THREE.BufferGeometry();
  const pts = [p0, p1, p2, p0, p2, p3];
  const positions = [];
  for (const p of pts) positions.push(p.x, p.y, p.z);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return { geometry, normal, area: areaA + areaB };
}

function keelPanel() {
  const nose = new THREE.Vector3(0, 0, KEEL_LEN / 2);
  const tailTop = new THREE.Vector3(0, KEEL_HEIGHT, -KEEL_LEN / 2);
  const tailBottom = new THREE.Vector3(0, 0, -KEEL_LEN / 2);
  return triPanel(nose, tailTop, tailBottom);
}

// width solved from a fixed aspect ratio so a much bigger nose (dart) still
// looks like a triangle, not a wall — area = 0.5 * width * (width*ASPECT).
function nosePanel(area) {
  const width = Math.sqrt((2 * area) / NOSE_ASPECT);
  const height = width * NOSE_ASPECT;
  const top = new THREE.Vector3(0, height, NOSE_Z_OFFSET);
  const left = new THREE.Vector3(-width / 2, 0, NOSE_Z_OFFSET);
  const right = new THREE.Vector3(width / 2, 0, NOSE_Z_OFFSET);
  return triPanel(top, left, right);
}

// `side`: +1 = right wing, -1 = left wing. Dihedral is baked directly into
// the vertex positions (rotating the flat rectangle's corners about the
// local Z/forward axis) rather than via a wrapper Group — simpler, and the
// panel's normal/area come straight from the resulting geometry either way.
function wingPanel(span, chord, dihedralRad, side) {
  const theta = side > 0 ? dihedralRad : -dihedralRad;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const rot = (x, z) => new THREE.Vector3(x * cos, x * sin, z);
  const p0 = rot(0, chord / 2);
  const p1 = rot(0, -chord / 2);
  const p2 = rot(side * span, -chord / 2);
  const p3 = rot(side * span, chord / 2);
  return quadPanel(p0, p1, p2, p3);
}

/**
 * Builds one test plane: a THREE.Group (`root`) ready to add to a scene, plus
 * `panels` — {localNormal, area} for each flat piece, in root-local space —
 * for the aero physics module to read every frame (transformed by the root's
 * CURRENT world rotation, since panels never move relative to root; there's
 * no folding/hinging here, root's own orientation is the only thing flight
 * physics needs to update).
 */
export function buildTestPlane(kind) {
  const cfg = AERO_TEST_PLANES[kind];
  if (!cfg) throw new Error(`Unknown test plane kind: ${kind}`);
  const totalWingArea = TRADEABLE_AREA * cfg.wingAreaFraction;
  const noseArea = TRADEABLE_AREA - totalWingArea;
  const wingAreaEach = totalWingArea / 2;
  const chord = wingAreaEach / cfg.span;
  const dihedralRad = THREE.MathUtils.degToRad(cfg.dihedralDeg);

  const root = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: cfg.color, side: THREE.DoubleSide });
  const panels = [];

  // `roles` says which aero profile(s) a panel is allowed to feed — NOT just
  // "whatever its current normal happens to dot with" (see aeroPhysics.js's
  // computeProfiles comment for why: a panel's normal only avoids the OTHER
  // axes at one specific attitude, and leaks into them once pitched/rotated,
  // which becomes a real problem once a panel's area is big enough to matter,
  // as the nose now deliberately is for some designs). The keel structurally
  // can't generate lift or drag (it's a vertical fin), the nose is a drag
  // cross-section only (not a wing), and only the wings legitimately do all
  // three (a wing can catch some sideways air too, e.g. banked).
  for (const [panel, label, roles] of [
    [keelPanel(), 'Keel', ['lateral']],
    [nosePanel(noseArea), 'Nose', ['drag']],
    [wingPanel(cfg.span, chord, dihedralRad, 1), 'Right wing', ['lift', 'drag', 'lateral']],
    [wingPanel(cfg.span, chord, dihedralRad, -1), 'Left wing', ['lift', 'drag', 'lateral']],
  ]) {
    const mesh = new THREE.Mesh(panel.geometry, mat);
    mesh.userData.label = label;
    root.add(mesh);
    panels.push({ mesh, localNormal: panel.normal, area: panel.area, roles });
  }

  return { root, panels, kind, label: cfg.label, totalArea: TOTAL_AREA, color: cfg.color };
}
