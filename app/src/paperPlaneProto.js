/**
 * THROWAWAY PROTOTYPE — standalone, per Luke's explicit ask (2026-09-27).
 *
 * 2026-09-27, later the same day: after the first diagnostic-tool pass, Luke
 * flagged four real problems with it:
 *   1. Once past the first 3 lines, none of the crease lines stay visible —
 *      no way to see where any fold actually is while working on the next one.
 *   2. The "free rotate" toggle rotated around ANY world axis via a 3D gizmo
 *      — not what he asked for. He wanted rotation locked to the axis a fold
 *      actually creases along, with the toggle just choosing HOW you drive
 *      that (a slider, or grabbing the paper directly) — never a free axis.
 *   3. The side-view camera for drawing wing creases read as "looking down
 *      from above" instead of side-on with the spine at the bottom running
 *      left-to-right — likely made worse by (1), since there was nothing on
 *      screen to anchor the orientation.
 *   4. There was no way to reach an actual "held ready to launch" view — the
 *      flow dead-ended in the face-picker with no final pose ever shown.
 *
 * Fixes in this pass: every hinge gets a live 3D line drawn along its own
 * crease axis, updated every frame, so all creases are visible throughout
 * (not just the first 3). "Free rotate" no longer exists as a separate
 * concept from the locked slider — there is only ever ONE rotation, always
 * locked to that fold's own axis; the toggle just arms/disarms grabbing the
 * selected face directly in the viewport to drag that same angle instead of
 * using the slider. A final step re-orients the whole plane into its actual
 * launch pose (same axis remap the old throw code used) and parks the camera
 * to show it clearly — still no throwing, just the held pose.
 *
 * 2026-09-27, third pass: that crease-visibility fix used a fixed-length
 * line centred on each hinge's pivot, which shot past the paper's edge
 * whenever the pivot wasn't near the crease's middle (it never is — the
 * pivot sits at one real END of the crease). Replaced with each hinge's
 * actual crease length (`hinge.creaseFar`, set in paperPlaneGen.js) so every
 * indicator stops exactly where the real fold does. Also restored the centre
 * fold actually running: it was left as a non-auto step with nothing left to
 * trigger it manually, so it silently never played — it's now auto, same as
 * the two nose folds, and runs before the player's wing-fold input as Luke's
 * original design called for.
 *
 * See TODO.md's paper-plane entries and src/paperPlane/paperPlaneGen.js (the
 * fold geometry — this file is scene, input, and UI wiring only).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { PLANE_DEFAULTS, buildFoldedPlane, buildPlaneRig, addWingFold } from './paperPlane/paperPlaneGen.js';

const TUNE = { ...PLANE_DEFAULTS };

// ---------------------------------------------------------------- scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x16324a);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 200);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

// Free camera whenever we're not actively capturing a crease swipe — Luke's
// explicit ask for "maximum visibility" while diagnosing folds.
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.screenSpacePanning = true;
controls.minDistance = 0.1;
controls.maxDistance = 100;
controls.enabled = false;

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  guideLineMat.resolution.set(innerWidth, innerHeight);
  creaseLineMat.resolution.set(innerWidth, innerHeight);
});

// paper background quad, visible during the fold phase only
const paperMat = new THREE.MeshBasicMaterial({ color: 0xf3ead9, side: THREE.DoubleSide });
const paperMesh = new THREE.Mesh(new THREE.PlaneGeometry(TUNE.paperW, TUNE.paperH), paperMat);
paperMesh.position.set(0, -TUNE.paperH / 2, -0.01);
scene.add(paperMesh);

// Fat, high-contrast lines — a plain THREE.Line renders at 1px on most
// platforms regardless of `linewidth`, which is why Luke couldn't see fold
// lines at all in an earlier pass; Line2/LineMaterial actually respects a
// pixel width. Two colors: gold for the line currently being drawn, cyan for
// every crease that already exists (kept visible permanently, not just
// during the first 3 lines — Luke: "I need to be able to see all the creases").
const guideLineMat = new LineMaterial({ color: 0xffce3a, linewidth: 5 });
guideLineMat.resolution.set(innerWidth, innerHeight);
const creaseLineMat = new LineMaterial({ color: 0x39c2ff, linewidth: 3 });
creaseLineMat.resolution.set(innerWidth, innerHeight);
// Crease indicators sit exactly ON the mesh surface (no z-bias, unlike the
// drawing guide lines) since they're derived from the hinge's own axis, not
// authored with a fudge factor — depth-testing them normally would hide
// most of each line behind the opaque paper it's tracing. Always-on-top
// instead, since these are reference overlays, not real geometry.
creaseLineMat.depthTest = false;
creaseLineMat.transparent = true;

function makeLine(mat) {
  const geo = new LineGeometry();
  geo.setPositions([0, 0, 0, 0, 0, 0]);
  const line = new Line2(geo, mat);
  line.visible = false;
  scene.add(line);
  return line;
}

function setLinePointsUV(line, points) {
  const pts = points.length >= 2 ? points : [points[0], points[0]];
  const flat = [];
  for (const p of pts) flat.push(p.u, -p.v, 0.02);
  line.geometry.setPositions(flat);
  line.visible = true;
}

// one reusable line for the swipe currently being dragged...
const guideLine = makeLine(guideLineMat);
// ...and one persistent line per committed crease, so all 3 stay visible
// together on the flat paper before folding starts.
const committedLines = { center: makeLine(guideLineMat), left: makeLine(guideLineMat), right: makeLine(guideLineMat) };

// ---------------------------------------------------------------- live crease indicators
// One line per hinge, redrawn every frame along that hinge's OWN axis through
// its OWN pivot, transformed by the current full parent chain. A point ON the
// rotation axis doesn't move when the hinge rotates, so this stays correct
// automatically through any fold angle, and through the final launch-pose
// re-orientation too — no separate bookkeeping needed for either.
//
// The pivot itself sits at one REAL end of every crease we build, and
// `hinge.creaseFar` (set in paperPlaneGen.js) is that crease's actual length
// — so the indicator is drawn strictly between those two real points, never
// a fixed length past them. Luke, second diagnostic pass: "Fold lines should
// only ever exist on the paper... the excess should be immediately and
// permanently deleted" — a fixed-length line centred on the pivot used to
// shoot past the paper's edge whenever the pivot sat near one end of it.
const creaseIndicators = []; // { hinge, line }

function addCreaseIndicator(hinge) {
  const line = makeLine(creaseLineMat);
  line.renderOrder = 999; // draw after (on top of) the opaque mesh regardless of scene order
  creaseIndicators.push({ hinge, line });
}

function updateCreaseIndicators() {
  for (const { hinge, line } of creaseIndicators) {
    const p1 = hinge.pivot.localToWorld(new THREE.Vector3(0, 0, 0));
    const p2 = hinge.pivot.localToWorld(hinge.axis.clone().multiplyScalar(hinge.creaseFar));
    line.geometry.setPositions([p1.x, p1.y, p1.z, p2.x, p2.y, p2.z]);
    line.visible = true;
  }
}

function clearCreaseIndicators() {
  for (const { line } of creaseIndicators) scene.remove(line);
  creaseIndicators.length = 0;
}

// ---------------------------------------------------------------- fold-phase camera
function setFoldCamera() {
  camera.up.set(0, 1, 0);
  camera.position.set(0, -TUNE.paperH / 2, 4.2);
  camera.lookAt(0, -TUNE.paperH / 2, 0);
}
setFoldCamera();

// ---------------------------------------------------------------- pointer -> uv
const raycaster = new THREE.Raycaster();
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
function pointerToUV(clientX, clientY) {
  const ndc = new THREE.Vector2((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = new THREE.Vector3();
  raycaster.ray.intersectPlane(dragPlane, hit);
  return { u: hit.x, v: -hit.y };
}

// ---------------------------------------------------------------- fold input state
let phase = 'fold'; // 'fold' -> 'folding' -> 'diag' <-> 'wingfold-input' / 'spinning'
let swipeCount = 0;
const swipes = { center: null, left: null, right: null };
let dragging = false;
let dragPath = [];
let downClientX = 0, downClientY = 0;

const hint = document.getElementById('hint');

function setHint(text) {
  hint.textContent = text ?? '';
}
setHint('Swipe down the middle to crease the centre fold');

// ---------------------------------------------------------------- direct "grab and fold" drag
// Armed by the "Free rotate" toggle. When armed, pointerdown ON the selected
// face drags that fold's OWN angle directly (never a free axis — Luke:
// "rotating the paper about the axis defined by the folds I make").
let rotateDrag = null; // { startClientX, startDeg }

renderer.domElement.addEventListener('pointerdown', (e) => {
  downClientX = e.clientX;
  downClientY = e.clientY;
  if (phase === 'fold' || phase === 'wingfold-input') {
    dragging = true;
    dragPath = [pointerToUV(e.clientX, e.clientY)];
    guideLine.visible = true;
    return;
  }
  if (phase === 'diag' && freeMode && selectedMesh && selectedHinge) {
    const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    if (raycaster.intersectObject(selectedMesh, false).length) {
      rotateDrag = { startClientX: e.clientX, startDeg: THREE.MathUtils.radToDeg(selectedHinge.angleRad) };
      controls.enabled = false;
    }
  }
});

renderer.domElement.addEventListener('pointermove', (e) => {
  if (rotateDrag) {
    const deg = THREE.MathUtils.clamp(rotateDrag.startDeg + (e.clientX - rotateDrag.startClientX) * 0.5, -360, 360);
    setHingeAngleDeg(deg);
    return;
  }
  if (!dragging) return;
  if (phase !== 'fold' && phase !== 'wingfold-input') return;
  const p = pointerToUV(e.clientX, e.clientY);
  dragPath.push(p);
  // draw the ACTUAL wobbly path the player swiped, not the straight
  // start->end chord — the chord is only used later to compute the fold
  // itself (Luke, 2026-09-27: it should look hand-drawn even though it's
  // interpreted as straight)
  setLinePointsUV(guideLine, dragPath);
});

renderer.domElement.addEventListener('pointerup', (e) => {
  if (rotateDrag) { rotateDrag = null; controls.enabled = true; return; }
  if (phase === 'diag') {
    handleDiagClick(e);
    return;
  }
  if (!dragging) return;
  dragging = false;
  const end = pointerToUV(e.clientX, e.clientY);
  const start = dragPath[0];

  if (phase === 'fold') {
    guideLine.visible = false;
    const swipe = { a: start, b: end, path: dragPath };
    let committedKey = 'center';
    if (swipeCount === 0) {
      swipes.center = swipe;
    } else {
      committedKey = (start.u + end.u) / 2 - (swipes.center.a.u + swipes.center.b.u) / 2 < 0 ? 'left' : 'right';
      swipes[committedKey] = swipe;
    }
    setLinePointsUV(committedLines[committedKey], swipe.path);
    swipeCount++;
    setHint([
      'Swipe down the middle to crease the centre fold',
      'Swipe the left corner down toward the centre',
      'Swipe the right corner down toward the centre',
    ][swipeCount] ?? '');
    if (swipeCount === 3) {
      if (!swipes.left) swipes.left = mirrorSwipe(swipes.right, swipes.center);
      if (!swipes.right) swipes.right = mirrorSwipe(swipes.left, swipes.center);
      startFold();
    }
  } else if (phase === 'wingfold-input') {
    guideLine.visible = false;
    playWingFold({ a: start, b: end });
  }
});

function mirrorSwipe(src, center) {
  const cx = (center.a.u + center.b.u) / 2;
  const mirror = (p) => ({ u: 2 * cx - p.u, v: p.v });
  return { a: mirror(src.a), b: mirror(src.b), path: src.path.map(mirror) };
}

// ---------------------------------------------------------------- fold animation (nose only — unchanged, works fine)
let rig = null;
let foldAnim = null;
let planeData = null;
let pendingStepIndex = 0; // index into rig.steps of the next AUTO step not yet played
let selectable = []; // meshes that can be clicked in 'diag' mode

function startFold() {
  phase = 'folding';
  setHint('');
  for (const key in committedLines) committedLines[key].visible = false;
  planeData = buildFoldedPlane(swipes, TUNE);
  rig = buildPlaneRig(planeData, TUNE, 0xf3ead9);
  rig.root.position.set(0, 0, 0);
  scene.add(rig.root);
  paperMesh.visible = false;
  pendingStepIndex = 0;
  foldAnim = { t: 0 };
  selectable = [rig.sideMeshes.left.bodyMesh, rig.sideMeshes.left.flapMesh, rig.sideMeshes.right.bodyMesh, rig.sideMeshes.right.flapMesh];

  clearCreaseIndicators();
  addCreaseIndicator(rig.sideMeshes.left.noseHinge);
  addCreaseIndicator(rig.sideMeshes.right.noseHinge);
  addCreaseIndicator(rig.centerHinge);
}

// Only the two nose-corner folds still auto-play — Luke confirmed that part
// already works and doesn't need a pause. Everything after (centre fold,
// both wing folds) is diagnosed manually from here on.
function updateFold(dt) {
  if (!foldAnim) return;
  const step = rig.steps[pendingStepIndex];
  if (!step || !step.auto) {
    foldAnim = null;
    beginDiag(0);
    return;
  }
  foldAnim.t += dt / TUNE.foldStepSeconds;
  const k = Math.min(1, foldAnim.t);
  const eased = 1 - Math.pow(1 - k, 3);
  step.hinge.setAngle(step.from + (step.to - step.from) * eased);
  if (k >= 1) {
    pendingStepIndex++;
    foldAnim.t = 0;
  }
}

// ---------------------------------------------------------------- diagnostic mode
const stepPanel = document.getElementById('stepPanel');
const stepText = document.getElementById('stepText');
const stepContinueBtn = document.getElementById('stepContinueBtn');

const STEP_INFO = [
  { msg: 'Inspect the nose folds and centre fold. Continue when ready.', btn: 'Continue to left wing crease' },
  { msg: 'Inspect the left wing fold. Continue when ready.', btn: 'Continue to right wing crease' },
  { msg: 'Inspect the right wing fold. Continue when ready.', btn: 'Show launch pose' },
  { msg: 'Plane held ready to launch.', btn: null },
];
let foldStep = 0;

function beginDiag(step) {
  phase = 'diag';
  foldStep = step;
  controls.enabled = true;
  const info = STEP_INFO[step];
  stepPanel.style.display = 'block';
  stepText.textContent = info.msg;
  if (info.btn) {
    stepContinueBtn.style.display = 'block';
    stepContinueBtn.textContent = info.btn;
  } else {
    stepContinueBtn.style.display = 'none';
  }
  if (step === 0) {
    camera.up.set(0, 1, 0);
    camera.position.set(2, 1.6, 2.4);
    controls.target.set(0, -TUNE.paperH / 2, 0);
  }
}

stepContinueBtn.addEventListener('click', () => {
  if (foldStep === 0) beginWingFoldSide('left');
  else if (foldStep === 1) spinToOtherSide();
  else if (foldStep === 2) showLaunchPose();
});

// Same axis remap the throw code used before it was stripped out: folding
// leaves the nose along local +Y, "away from spine" along local -X, and the
// wing-fold's own rotation puts wing-spread along local -Z. None of those is
// "up" for holding the plane — this re-orients the whole assembly ONCE,
// statically, into keel-down / nose-forward, purely so Luke can see the held
// pose (Luke, 2026-09-27: "there doesn't seem to be any way to get to the
// end... to see what the plane's orientation will be when it is to be
// thrown"). No throwing happens here, just the static re-orientation.
const LAUNCH_POSE = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().makeBasis(
    new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(-1, 0, 0)
  )
);

function showLaunchPose() {
  rig.root.quaternion.copy(LAUNCH_POSE);
  beginDiag(3);
  camera.up.set(0, 1, 0);
  controls.target.set(0, 0, 0);
  camera.position.set(5, 3, -6);
  camera.lookAt(controls.target);
}

// ---------------------------------------------------------------- player-drawn wing folds (crease capture unchanged)
let wingFoldSide = null;
let sideCameraTarget = new THREE.Vector3();
let spinAnim = null;

function setSideCamera(facing) {
  const halfW = TUNE.paperW / 2;
  const tx = (planeData.centerX - halfW) / 2;
  const ty = -TUNE.paperH / 2;
  sideCameraTarget.set(tx, ty, 0);
  camera.up.set(-1, 0, 0);
  const dist = 4;
  camera.position.set(tx, ty, facing === 'left' ? dist : -dist);
  camera.lookAt(sideCameraTarget);
}

function beginWingFoldSide(side) {
  wingFoldSide = side;
  phase = 'wingfold-input';
  stepPanel.style.display = 'none';
  clearSelection();
  controls.enabled = false;
  setSideCamera(side);
  setHint(`Swipe roughly parallel to the spine to crease the ${side} wing`);
}

function toSideLocal(p, side) {
  return side === 'right' ? { u: 2 * planeData.centerX - p.u, v: p.v } : { u: p.u, v: p.v };
}

// Same clamp-to-panel treatment the nose-fold swipes already get in
// buildFoldedPlane — a wing crease drawn (even partly) off the current panel
// would otherwise cut and hinge from a point that was never really on the
// paper (Luke, second diagnostic pass: any drawn line's relevant section
// should be kept and everything past the paper's edge discarded).
function clampToSidePanel(p, side) {
  const halfW = TUNE.paperW / 2;
  const uMin = side === 'left' ? -halfW : planeData.centerX;
  const uMax = side === 'left' ? planeData.centerX : halfW;
  return { u: THREE.MathUtils.clamp(p.u, uMin, uMax), v: THREE.MathUtils.clamp(p.v, 0, TUNE.paperH) };
}

function playWingFold({ a, b }) {
  const side = wingFoldSide;
  const sideInfo = rig.sideMeshes[side];
  const lineA = clampToSidePanel(toSideLocal(a, side), side);
  const lineB = clampToSidePanel(toSideLocal(b, side), side);
  const step = addWingFold(sideInfo, lineA, lineB, Math.PI / 2, rig.colorHex);
  step.hinge.setAngle(0); // stays flat until manually rotated — no auto-tween anymore
  selectable.push(step.wingMesh);
  addCreaseIndicator(step.hinge);
  setHint('');
  beginDiag(side === 'left' ? 1 : 2);
}

function spinToOtherSide() {
  phase = 'spinning';
  stepPanel.style.display = 'none';
  clearSelection();
  setHint('Spinning the plane over...');
  spinAnim = { t: 0, fromZ: camera.position.z };
}

function updateSpin(dt) {
  if (!spinAnim) return;
  spinAnim.t += dt / 0.8;
  const k = Math.min(1, spinAnim.t);
  const eased = 1 - Math.pow(1 - k, 3);
  camera.position.z = spinAnim.fromZ * (1 - 2 * eased);
  camera.lookAt(sideCameraTarget);
  if (k >= 1) {
    spinAnim = null;
    beginWingFoldSide('right');
  }
}

// ---------------------------------------------------------------- face selection + manipulation
const diagNone = document.getElementById('diagNone');
const diagSelected = document.getElementById('diagSelected');
const diagFoldControls = document.getElementById('diagFoldControls');
const diagFoldName = document.getElementById('diagFoldName');
const lockedAngle = document.getElementById('lockedAngle');
const lockedAngleV = document.getElementById('lockedAngleV');
const freeRotateToggle = document.getElementById('freeRotateToggle');
const diagStaticNote = document.getElementById('diagStaticNote');
const flagBtn = document.getElementById('flagBtn');
const flaggedList = document.getElementById('flaggedList');

let selectedMesh = null;
let selectedHinge = null; // the mesh's "primary" (nearest ancestor) hinge, or null if static
let freeMode = false;

function findPrimaryHinge(mesh) {
  let o = mesh.parent;
  while (o) {
    if (o.userData && o.userData.hingeRef) return o.userData.hingeRef;
    o = o.parent;
  }
  return null;
}

function baseColorOf(mesh) {
  if (mesh.userData.baseColor === undefined) mesh.userData.baseColor = mesh.material.color.getHex();
  return mesh.userData.baseColor;
}

function refreshMeshVisual(mesh) {
  const base = baseColorOf(mesh);
  const color = new THREE.Color(mesh.userData.flagged ? 0xe2554f : base);
  if (mesh === selectedMesh) color.lerp(new THREE.Color(0xffffff), 0.35);
  mesh.material.color.copy(color);
}

function handleDiagClick(e) {
  const dx = e.clientX - downClientX, dy = e.clientY - downClientY;
  if (Math.hypot(dx, dy) > 6) return; // was an orbit drag, not a click
  const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(selectable, false);
  selectFace(hits.length ? hits[0].object : null);
}

function selectFace(mesh) {
  const prev = selectedMesh;
  selectedMesh = mesh;
  if (prev) refreshMeshVisual(prev);
  if (mesh) refreshMeshVisual(mesh);

  if (!mesh) {
    diagNone.style.display = 'block';
    diagSelected.style.display = 'none';
    diagFoldControls.style.display = 'none';
    diagStaticNote.style.display = 'none';
    flagBtn.style.display = 'none';
    selectedHinge = null;
    return;
  }

  diagNone.style.display = 'none';
  diagSelected.style.display = 'block';
  diagSelected.textContent = mesh.userData.label ?? '(unlabelled face)';
  flagBtn.style.display = 'block';
  flagBtn.textContent = mesh.userData.flagged ? 'Unflag' : 'Flag as wrong / extra';
  flagBtn.className = mesh.userData.flagged ? 'danger' : '';

  selectedHinge = findPrimaryHinge(mesh);
  if (selectedHinge) {
    diagFoldControls.style.display = 'block';
    diagStaticNote.style.display = 'none';
    diagFoldName.textContent = `Fold: ${selectedHinge.name}`;
    const deg = THREE.MathUtils.radToDeg(selectedHinge.angleRad);
    lockedAngle.value = deg;
    lockedAngleV.textContent = deg.toFixed(0);
  } else {
    diagFoldControls.style.display = 'none';
    diagStaticNote.style.display = 'block';
  }
}

function clearSelection() {
  selectFace(null);
}

// There is only ever ONE rotation for a fold — around its own crease axis.
// This toggle doesn't change WHAT gets rotated, only HOW you drive it: off,
// the slider is the only way; on, you can also grab the selected face
// directly in the viewport and drag it (see the pointerdown handler above).
freeRotateToggle.addEventListener('click', () => {
  if (!selectedHinge) return;
  freeMode = !freeMode;
  freeRotateToggle.textContent = `Grab to fold: ${freeMode ? 'ON' : 'OFF'}`;
  freeRotateToggle.className = freeMode ? 'active' : '';
});

function setHingeAngleDeg(deg) {
  lockedAngle.value = deg;
  lockedAngleV.textContent = deg.toFixed(0);
  selectedHinge.setAngle(THREE.MathUtils.degToRad(deg));
}

lockedAngle.addEventListener('input', () => {
  if (!selectedHinge) return;
  setHingeAngleDeg(parseFloat(lockedAngle.value));
});

flagBtn.addEventListener('click', () => {
  if (!selectedMesh) return;
  selectedMesh.userData.flagged = !selectedMesh.userData.flagged;
  flagBtn.textContent = selectedMesh.userData.flagged ? 'Unflag' : 'Flag as wrong / extra';
  flagBtn.className = selectedMesh.userData.flagged ? 'danger' : '';
  refreshMeshVisual(selectedMesh);
  refreshFlaggedList();
});

function refreshFlaggedList() {
  flaggedList.innerHTML = '';
  for (const mesh of selectable) {
    if (!mesh.userData.flagged) continue;
    const li = document.createElement('li');
    li.textContent = mesh.userData.label ?? '(unlabelled)';
    li.style.cursor = 'pointer';
    li.addEventListener('click', () => selectFace(mesh));
    flaggedList.appendChild(li);
  }
  if (!flaggedList.children.length) flaggedList.innerHTML = '<li style="opacity:0.6;border:none">(none yet)</li>';
}

// ---------------------------------------------------------------- start over
function resetAll() {
  clearSelection();
  freeMode = false;
  freeRotateToggle.textContent = 'Grab to fold: OFF';
  freeRotateToggle.className = '';
  rotateDrag = null;
  controls.enabled = false;
  spinAnim = null;
  wingFoldSide = null;
  clearCreaseIndicators();
  if (rig) scene.remove(rig.root);
  rig = null;
  planeData = null;
  selectable = [];
  swipeCount = 0;
  swipes.center = swipes.left = swipes.right = null;
  paperMesh.visible = true;
  stepPanel.style.display = 'none';
  refreshFlaggedList();
  phase = 'fold';
  setHint('Swipe down the middle to crease the centre fold');
  setFoldCamera();
}

document.getElementById('startOverBtn').addEventListener('click', resetAll);

// ---------------------------------------------------------------- loop
refreshFlaggedList();
const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (phase === 'folding') updateFold(dt);
  if (phase === 'diag') controls.update();
  updateSpin(dt);
  updateCreaseIndicators();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();

window.__resetPlane = resetAll;
window.__capture = () => {
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
};
