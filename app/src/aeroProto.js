/**
 * THROWAWAY PROTOTYPE — standalone, aerodynamics/shape-comparison tool
 * (2026-09-28), per Luke's explicit ask after pausing the fold prototype.
 * Goal: find out whether different plane SHAPES fly in meaningfully
 * different ways under a simple profile-area-based aero model, before
 * investing more in the folding UI. See TODO.md's aerodynamics-planning
 * entries for the full design discussion.
 *
 * Three hand-built planes (planeShapes.js, NOT the fold system) with equal
 * total area but very different wing dihedral/shape, launched under
 * identical, deterministic conditions (same point, same angle/power/wind),
 * either all together or one at a time, each leaving a persistent trail and
 * live numeric readouts so shape differences are visible both as flight
 * behavior and as actual numbers, not just an impression.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { buildTestPlane, AERO_TEST_PLANES } from './paperPlane/planeShapes.js';
import { AERO_DEFAULTS, stepAeroFlight, makeLaunchVelocity } from './paperPlane/aeroPhysics.js';

const TUNE = { ...AERO_DEFAULTS, wind: new THREE.Vector3() };

// ---------------------------------------------------------------- scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x16324a);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 400);
camera.position.set(2.5, 7, -15);
camera.lookAt(2.5, 1, 10);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.screenSpacePanning = true;
controls.target.set(2.5, 1, 10);
controls.minDistance = 1;
controls.maxDistance = 200;

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  trailMat.resolution.set(innerWidth, innerHeight);
});

// ground: a large flat plane so distance traveled has a visible reference
const groundMat = new THREE.MeshBasicMaterial({ color: 0x1e4a63, side: THREE.DoubleSide });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), groundMat);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
const gridHelper = new THREE.GridHelper(400, 80, 0x2f6a8c, 0x245572);
scene.add(gridHelper);

const trailMat = new LineMaterial({ linewidth: 3, transparent: true, opacity: 0.9 });
trailMat.resolution.set(innerWidth, innerHeight);

// ---------------------------------------------------------------- planes
// Screen-left to screen-right, for the default camera framing below, reads
// glider -> middle -> dart (matches the readout panel's listed order) —
// world +X renders toward screen-left with this camera/lookAt combination,
// confirmed empirically, hence the signs here look "backwards" on paper.
const SPAWN_X = { glider: 3, middle: 0, dart: -3 };
const SPAWN_Y = 1.5;
const MAX_TRAIL_POINTS = 3000;

const planes = {};
for (const kind of Object.keys(AERO_TEST_PLANES)) {
  const rig = buildTestPlane(kind);
  const spawn = new THREE.Vector3(SPAWN_X[kind], SPAWN_Y, 0);
  rig.root.position.copy(spawn);
  scene.add(rig.root);

  const trailLine = new Line2(new LineGeometry(), trailMat.clone());
  trailLine.material.color.setHex(rig.color);
  trailLine.visible = false;
  // Positions are absolute world-space points rewritten wholesale every
  // frame (not a fixed local-space shape), so the auto-computed bounding
  // sphere from the very first (tiny, near-spawn) call can go stale and
  // wrongly cull the whole line once it's grown well past that — disable
  // culling rather than force a recompute every frame for a debug/dev trail.
  trailLine.frustumCulled = false;
  scene.add(trailLine);

  planes[kind] = {
    rig,
    spawn,
    trailLine,
    trailPoints: [],
    state: null, // { position, velocity } while in flight
    landed: false,
    distance: null,
    flightTime: null,
  };
}

function resetPlane(kind) {
  const p = planes[kind];
  p.rig.root.position.copy(p.spawn);
  p.rig.root.quaternion.identity();
  p.state = null;
  p.landed = false;
  p.distance = null;
  p.flightTime = null;
  p.trailPoints = [];
  p.trailLine.visible = false;
}

function launchPlane(kind) {
  resetPlane(kind);
  const p = planes[kind];
  const angleRad = THREE.MathUtils.degToRad(parseFloat(angleInput.value));
  const power = parseFloat(powerInput.value);
  const velocity = makeLaunchVelocity(angleRad, power);
  p.rig.root.quaternion.copy(
    // face the initial velocity immediately, no visible snap on frame 1
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), velocity.clone().normalize())
  );
  p.state = { position: p.spawn.clone(), velocity, elapsed: 0, lastProfiles: null, lastSpeed: 0 };
  p.trailPoints = [p.spawn.x, p.spawn.y, p.spawn.z];
  p.trailLine.visible = true;
}

function readWind() {
  const dirRad = THREE.MathUtils.degToRad(parseFloat(windDirInput.value));
  const strength = parseFloat(windStrengthInput.value);
  TUNE.wind.set(Math.sin(dirRad) * strength, 0, Math.cos(dirRad) * strength);
}

// ---------------------------------------------------------------- controls wiring
const angleInput = document.getElementById('angle');
const angleV = document.getElementById('angleV');
const powerInput = document.getElementById('power');
const powerV = document.getElementById('powerV');
const windDirInput = document.getElementById('windDir');
const windDirV = document.getElementById('windDirV');
const windStrengthInput = document.getElementById('windStrength');
const windStrengthV = document.getElementById('windStrengthV');
const liftCoefInput = document.getElementById('liftCoef');
const liftCoefV = document.getElementById('liftCoefV');
const dragCoefInput = document.getElementById('dragCoef');
const dragCoefV = document.getElementById('dragCoefV');
const windCoefInput = document.getElementById('windCoef');
const windCoefV = document.getElementById('windCoefV');

function syncReadout(input, span, digits = 0) {
  span.textContent = parseFloat(input.value).toFixed(digits);
}
function syncAllSliderReadouts() {
  syncReadout(angleInput, angleV, 0);
  syncReadout(powerInput, powerV, 1);
  syncReadout(windDirInput, windDirV, 0);
  syncReadout(windStrengthInput, windStrengthV, 1);
  syncReadout(liftCoefInput, liftCoefV, 3);
  syncReadout(dragCoefInput, dragCoefV, 3);
  syncReadout(windCoefInput, windCoefV, 3);
}
for (const input of [angleInput, powerInput, windDirInput, windStrengthInput, liftCoefInput, dragCoefInput, windCoefInput]) {
  input.addEventListener('input', () => {
    syncAllSliderReadouts();
    TUNE.liftCoef = parseFloat(liftCoefInput.value);
    TUNE.dragCoef = parseFloat(dragCoefInput.value);
    TUNE.windCoef = parseFloat(windCoefInput.value);
    readWind();
  });
}
syncAllSliderReadouts();
readWind();
TUNE.liftCoef = parseFloat(liftCoefInput.value);
TUNE.dragCoef = parseFloat(dragCoefInput.value);
TUNE.windCoef = parseFloat(windCoefInput.value);

document.getElementById('launchAll').addEventListener('click', () => {
  for (const kind of Object.keys(planes)) launchPlane(kind);
});
document.getElementById('launchGlider').addEventListener('click', () => launchPlane('glider'));
document.getElementById('launchMiddle').addEventListener('click', () => launchPlane('middle'));
document.getElementById('launchDart').addEventListener('click', () => launchPlane('dart'));
document.getElementById('resetAll').addEventListener('click', () => {
  for (const kind of Object.keys(planes)) resetPlane(kind);
});

// ---------------------------------------------------------------- readout panel
const readoutsEl = document.getElementById('readouts');
const readoutRefs = {};
for (const kind of Object.keys(AERO_TEST_PLANES)) {
  const cfg = AERO_TEST_PLANES[kind];
  const div = document.createElement('div');
  div.className = 'plane-readout';
  div.innerHTML = `
    <div class="name"><span class="swatch" style="background:#${cfg.color.toString(16).padStart(6, '0')}"></span>${cfg.label}</div>
    <div>dihedral ${cfg.dihedralDeg}&deg; &middot; span ${cfg.span.toFixed(2)}</div>
    <div class="status">not launched</div>
  `;
  readoutsEl.appendChild(div);
  readoutRefs[kind] = div.querySelector('.status');
}

function updateReadout(kind) {
  const p = planes[kind];
  const el = readoutRefs[kind];
  if (!p.state) {
    el.textContent = p.landed ? 'landed' : 'not launched';
    return;
  }
  const prof = p.state.lastProfiles;
  const profStr = prof
    ? `vert ${prof.vertical.toFixed(2)} / fwd ${prof.fwd.toFixed(2)} / lat ${prof.lat.toFixed(2)}`
    : '';
  if (p.landed) {
    el.innerHTML = `landed &mdash; distance ${p.distance.toFixed(2)}, time ${p.flightTime.toFixed(2)}s<br/>${profStr}`;
  } else {
    el.innerHTML = `flying &mdash; speed ${p.state.lastSpeed.toFixed(2)}, height ${p.state.position.y.toFixed(2)}<br/>${profStr}`;
  }
}

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  controls.update();

  for (const kind of Object.keys(planes)) {
    const p = planes[kind];
    if (p.state && !p.landed) {
      const landed = stepAeroFlight(p.state, dt, p.rig, TUNE);
      p.state.elapsed += dt;

      p.trailPoints.push(p.state.position.x, p.state.position.y, p.state.position.z);
      if (p.trailPoints.length > MAX_TRAIL_POINTS * 3) p.trailPoints.splice(0, p.trailPoints.length - MAX_TRAIL_POINTS * 3);
      if (p.trailPoints.length >= 6) p.trailLine.geometry.setPositions(p.trailPoints);

      if (landed) {
        p.landed = true;
        p.distance = Math.hypot(p.state.position.x - p.spawn.x, p.state.position.z - p.spawn.z);
        p.flightTime = p.state.elapsed;
      }
    }
    updateReadout(kind);
  }

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();

window.__resetAero = () => {
  for (const kind of Object.keys(planes)) resetPlane(kind);
};
