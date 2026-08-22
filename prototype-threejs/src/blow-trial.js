import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import RAPIER from '@dimforge/rapier3d-compat';

// Rapier ships as WASM and needs an async init before any RAPIER.* class can be
// used — everything below waits on this.
await RAPIER.init();

// ---------------------------------------------------------------- constants
const ISLAND_RADIUS = 5; // world units — 10m diameter
const ISLAND_TOP_Y = 0; // world Y of the flat island surface the card rests on
const CARD_LEN = 2; // "2m tall" character, now lying flat — this is its long axis
const CARD_ASPECT = 400 / 563; // figure-indy.png w/h
const CARD_WIDTH = CARD_LEN * CARD_ASPECT;
const CARD_THICK = 0.05;
const CARD_MASS = 0.4;

const BLOW_NEAR = ISLAND_RADIUS + 1.5; // closest the mouth can get
const BLOW_FAR = ISLAND_RADIUS + 9; // furthest
const BLOW_BASE_SPEED = 10; // peak speed (m/s) a full-strength, close-range puff imparts — tuned so max strength/near clears the island edge
const BLOW_FALLOFF = 0.65; // fraction of speed retained at BLOW_FAR (vs BLOW_NEAR)
const BLOW_UPKICK = 0.05; // small upward component so the card tips/tumbles rather than just skids

// A blow is a handful of separate off-centre puffs spread over a short window, not
// one clean shove at the centre of mass — a single centred impulse produces zero
// torque by construction (r × F with r=0), which is the main reason the old version
// felt rigid. Off-centre force is what makes a physics engine generate rotation on
// its own, for free — no extra simulation needed, just where the force lands.
const GUST_DURATION_STEPS = 16; // ~0.27s at 60fps — long enough to read as a puff of breath, not a snap
const GUST_PUFF_COUNT = 4;
const PUFF_JITTER_MAG = 0.3; // +/- fraction of a puff's share of the total impulse
const PUFF_JITTER_ANGLE = (14 * Math.PI) / 180; // waver left/right around vertical, per puff
const PUFF_SPREAD_X = CARD_WIDTH * 0.4; // how far off-centre (card-local) a puff can land
const PUFF_SPREAD_Y = CARD_LEN * 0.4;

// A light spring pulling the card back toward vertical — without it, unlocked
// rotation means the card just topples over on its own (a strip this thin standing
// on its edge has no physical reason to stay up). Weak enough that any real blow,
// or gravity once it's off the edge, easily overpowers it — it's there to stop
// spontaneous idle collapse, not to keep the card rigid.
const UPRIGHT_SPRING = 0.9;
const UPRIGHT_DAMPING = 0.35;

// A small noise-driven torque, active only while the card is actually moving, so
// it "catches air" unevenly as it slides or falls instead of rotating on a single
// clean axis — this is the same cheap trick falling-leaf/confetti effects use
// (hand-tuned wobble, not real aerodynamics) rather than anything computed from
// the card's actual surface area or airflow.
const FLUTTER_STRENGTH = 0.5;
const FLUTTER_MIN_SPEED = 0.3; // m/s — below this the card is basically at rest, don't jitter it

// ---------------------------------------------------------------- three.js setup
const canvasHost = document.body;
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0); // transparent — the void is a CSS gradient behind the canvas, not a rendered scene
canvasHost.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 500);
camera.position.set(0, 11, 17);
camera.lookAt(0, -1, 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, -1, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 4;
controls.maxDistance = 60;

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

scene.add(new THREE.AmbientLight(0xaabbee, 0.55));
const sun = new THREE.DirectionalLight(0xfff2d8, 1.1);
sun.position.set(6, 10, 4);
scene.add(sun);

// -------------------------------------------------------------- depth cues
// A sparse field of small points scattered through the void below/around the
// island — cheap (one draw call), but gives the falling card something to
// pass by so its motion actually reads as depth rather than just "shrinking."
{
  const DUST_COUNT = 260;
  const positions = new Float32Array(DUST_COUNT * 3);
  for (let i = 0; i < DUST_COUNT; i++) {
    const r = 15 + Math.random() * 60;
    const theta = Math.random() * Math.PI * 2;
    positions[i * 3] = Math.cos(theta) * r;
    positions[i * 3 + 1] = -Math.random() * 70 + 10; // spread mostly below the island, some above
    positions[i * 3 + 2] = Math.sin(theta) * r;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ color: 0xffe9c8, size: 0.18, transparent: true, opacity: 0.55, fog: false });
  scene.add(new THREE.Points(geo, mat));
}

// -------------------------------------------------------------- the island
// A chunky low-poly rock (tapered cylinder) with a flat grass-green cap —
// cheap, and reads instantly as "floating island" without needing a texture.
const islandGroup = new THREE.Group();
{
  const rock = new THREE.Mesh(
    new THREE.CylinderGeometry(ISLAND_RADIUS, ISLAND_RADIUS * 0.55, 2.4, 9),
    new THREE.MeshLambertMaterial({ color: 0x6b5847 })
  );
  rock.position.y = ISLAND_TOP_Y - 1.2 - 0.15;
  islandGroup.add(rock);

  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(ISLAND_RADIUS * 1.02, ISLAND_RADIUS * 0.98, 0.3, 9),
    new THREE.MeshLambertMaterial({ color: 0x5a9a4f })
  );
  cap.position.y = ISLAND_TOP_Y - 0.15;
  islandGroup.add(cap);
}
scene.add(islandGroup);

// -------------------------------------------------------------- the card
// Two thin planes glued back-to-back (front art + backing art), so as it
// tumbles in freefall the correct side always shows — a real billboard trick
// won't work here since the whole point is watching it rotate under physics.
const loader = new THREE.TextureLoader();
const frontTex = loader.load('/textures/figure-indy.png');
const backTex = loader.load('/textures/figure-indy-backing.png');
frontTex.colorSpace = backTex.colorSpace = THREE.SRGBColorSpace;

const cardGroup = new THREE.Group();
{
  const geo = new THREE.PlaneGeometry(CARD_WIDTH, CARD_LEN);
  const front = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: frontTex, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide }));
  front.position.z = CARD_THICK / 2;
  const back = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: backTex, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide }));
  back.position.z = -CARD_THICK / 2;
  back.rotation.y = Math.PI;
  cardGroup.add(front, back);
}
scene.add(cardGroup);

// ---------------------------------------------------------------- physics (Rapier)
// Swapped in after cannon-es proved unable to handle this exact shape: a thin, wide
// box resting on a flat surface got 4 simultaneous corner contacts, and cannon-es's
// friction solver locked tangential velocity to ~zero within a few steps regardless
// of the friction coefficient's magnitude (verified down to 0.005 — still an instant
// stop; a sphere with the same mass/friction slid normally, isolating it to the
// box's multi-point contact manifold specifically). Rapier's contact resolution is
// built for exactly this case.
const world = new RAPIER.World({ x: 0, y: -9.82, z: 0 });
const FIXED_DT = 1 / 60;
world.timestep = FIXED_DT;

// Static island collider — a box standing in for the round island (matches the
// cannon-es trial's approach: box-vs-box is the simplest, most predictable pair).
const ISLAND_PHYS_H = 2.7; // 2.4 rock + 0.3 cap
const ISLAND_PHYS_HALF_SIZE = ISLAND_RADIUS * 0.8; // inset from the visual radius so the box footprint stays under the round cap
const islandBody = world.createRigidBody(
  RAPIER.RigidBodyDesc.fixed().setTranslation(0, ISLAND_TOP_Y - ISLAND_PHYS_H / 2, 0)
);
world.createCollider(
  RAPIER.ColliderDesc.cuboid(ISLAND_PHYS_HALF_SIZE, ISLAND_PHYS_H / 2, ISLAND_PHYS_HALF_SIZE)
    .setFriction(0.55)
    .setRestitution(0.15),
  islandBody
);

// The card stands upright, centred on the island, face-on to the camera — its
// natural resting pose (PlaneGeometry already lies vertical in XY, so no rotation
// needed). Rotation is fully free on all three axes now — the earlier version
// locked X/Z to stop it spontaneously toppling, but that's also what made it feel
// flat (no tipping, no wobble, ever). Idle stability instead comes from the
// UPRIGHT_SPRING torque applied each step below, which is weak enough to get out
// of the way the moment a real force — a blow, or gravity once it's off the edge
// — is acting on it.
const CARD_START_QUAT = new THREE.Quaternion(); // identity — already upright
const CARD_START = { x: 0, y: ISLAND_TOP_Y + CARD_LEN / 2, z: 0 }; // centre lifted so the bottom edge sits on the surface

const cardBody = world.createRigidBody(
  RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(CARD_START.x, CARD_START.y, CARD_START.z)
    .setRotation(CARD_START_QUAT)
    .setLinearDamping(0.05)
    .setAngularDamping(0.5)
    .setAdditionalMass(CARD_MASS)
);
world.createCollider(
  RAPIER.ColliderDesc.cuboid(CARD_WIDTH / 2, CARD_LEN / 2, CARD_THICK / 2)
    .setFriction(0.55)
    .setRestitution(0.15),
  cardBody
);

function resetCard() {
  cardBody.setTranslation(CARD_START, true);
  cardBody.setRotation(CARD_START_QUAT, true);
  cardBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
  cardBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
  cardBody.resetTorques(true);
  cardBody.wakeUp();
  gustQueue.length = 0;
}

// ---------------------------------------------------------------- blow control
// The "mouth" sits on a fixed line south of the island — the distance slider
// moves it along that line, the strength slider scales the puff. Direction is
// always recomputed toward the card's current position at the moment of the
// blow, horizontal only (breath doesn't lift a card, it pushes it).
const distanceInput = document.getElementById('distance');
const strengthInput = document.getElementById('strength');
const distanceVal = document.getElementById('distanceVal');
const strengthVal = document.getElementById('strengthVal');
const blowBtn = document.getElementById('blowBtn');
const resetBtn = document.getElementById('resetBtn');

function mouthPosition() {
  const d = THREE.MathUtils.lerp(BLOW_NEAR, BLOW_FAR, parseFloat(distanceInput.value));
  return new THREE.Vector3(0, ISLAND_TOP_Y + 1.2, d); // fixed line: straight "south" of the island, roughly head height
}

distanceInput.addEventListener('input', () => {
  const t = parseFloat(distanceInput.value);
  distanceVal.textContent = t < 0.34 ? 'near' : t < 0.67 ? 'mid' : 'far';
});
strengthInput.addEventListener('input', () => {
  strengthVal.textContent = parseFloat(strengthInput.value).toFixed(2);
});

// Queued puffs waiting to land — each is {atStep, impulse: THREE.Vector3, localPoint:
// THREE.Vector3}. atStep counts physics steps since the gust started (see tick()),
// not wall-clock time, so it stays correct regardless of frame rate.
let gustQueue = [];
let gustStep = 0;

blowBtn.addEventListener('click', () => {
  const mouth = mouthPosition();
  const cardPos = cardBody.translation();
  const toCard = new THREE.Vector3(cardPos.x - mouth.x, 0, cardPos.z - mouth.z);
  const dist = toCard.length() || 1;
  toCard.multiplyScalar(1 / dist);

  const distT = parseFloat(distanceInput.value);
  const strengthT = parseFloat(strengthInput.value);
  const falloff = THREE.MathUtils.lerp(1, BLOW_FALLOFF, distT);
  const speed = BLOW_BASE_SPEED * strengthT * falloff;
  const totalMag = speed * CARD_MASS; // impulse = mass * desired velocity change
  const perPuffMag = totalMag / GUST_PUFF_COUNT;

  gustQueue = [];
  gustStep = 0;
  for (let i = 0; i < GUST_PUFF_COUNT; i++) {
    const atStep = Math.round((i / GUST_PUFF_COUNT) * GUST_DURATION_STEPS);
    const jitteredMag = perPuffMag * (1 + (Math.random() * 2 - 1) * PUFF_JITTER_MAG);
    const wobble = (Math.random() * 2 - 1) * PUFF_JITTER_ANGLE;
    const dir = toCard.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), wobble);
    const impulse = dir.multiplyScalar(jitteredMag);
    impulse.y += jitteredMag * BLOW_UPKICK * (0.5 + Math.random());
    const localPoint = new THREE.Vector3(
      (Math.random() * 2 - 1) * PUFF_SPREAD_X,
      (Math.random() * 2 - 1) * PUFF_SPREAD_Y,
      0
    );
    gustQueue.push({ atStep, impulse, localPoint });
  }
  gustQueue.sort((a, b) => a.atStep - b.atStep);

  cardBody.wakeUp();
});

resetBtn.addEventListener('click', resetCard);

window.__scene = scene;
window.__camera = camera;
window.__cardGroup = cardGroup;
window.__cardBody = cardBody;
window.__world = world;
window.__mouthPosition = mouthPosition;
window.__resetCard = resetCard;

// ---------------------------------------------------------------- per-step forces
const WORLD_UP = new THREE.Vector3(0, 1, 0);
let simTime = 0; // simulated seconds, advances one FIXED_DT per physics step — drives the flutter noise

/** Upright spring + flutter, recomputed fresh every physics step from the card's
 * current state. Rapier's addTorque persists until reset, so each step resets
 * first rather than accumulating on top of the previous step's value. */
function applyContinuousTorques() {
  const r = cardBody.rotation();
  const quat = new THREE.Quaternion(r.x, r.y, r.z, r.w);
  const currentUp = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
  const spring = currentUp.clone().cross(WORLD_UP).multiplyScalar(UPRIGHT_SPRING);

  const av = cardBody.angvel();
  const damping = new THREE.Vector3(av.x, av.y, av.z).multiplyScalar(-UPRIGHT_DAMPING);

  const torque = spring.add(damping);

  const lv = cardBody.linvel();
  const speed = Math.hypot(lv.x, lv.y, lv.z);
  if (speed > FLUTTER_MIN_SPEED) {
    const s = Math.min(1, speed / 4); // don't let flutter keep growing without bound at high speed
    torque.x += Math.sin(simTime * 9.1 + 1.7) * FLUTTER_STRENGTH * s;
    torque.z += Math.sin(simTime * 6.3 + 4.2) * FLUTTER_STRENGTH * s;
  }

  cardBody.resetTorques(true);
  cardBody.addTorque({ x: torque.x, y: torque.y, z: torque.z }, true);
}

/** Fires any gust puffs whose scheduled step has arrived. Off-centre application
 * point is what generates torque here — see GUST_* constants above. */
function applyDueGustPuffs() {
  while (gustQueue.length && gustQueue[0].atStep <= gustStep) {
    const puff = gustQueue.shift();
    const r = cardBody.rotation();
    const t = cardBody.translation();
    const quat = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const worldOffset = puff.localPoint.clone().applyQuaternion(quat);
    cardBody.applyImpulseAtPoint(
      { x: puff.impulse.x, y: puff.impulse.y, z: puff.impulse.z },
      { x: t.x + worldOffset.x, y: t.y + worldOffset.y, z: t.z + worldOffset.z },
      true
    );
  }
}

// ---------------------------------------------------------------- loop
let lastT = performance.now();
let accumulator = 0;
function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  const frameDt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;

  accumulator += frameDt;
  let steps = 0;
  while (accumulator >= FIXED_DT && steps < 5) {
    applyContinuousTorques();
    world.step();
    simTime += FIXED_DT;
    gustStep++;
    applyDueGustPuffs();
    accumulator -= FIXED_DT;
    steps++;
  }

  const t = cardBody.translation();
  const r = cardBody.rotation();
  cardGroup.position.set(t.x, t.y, t.z);
  cardGroup.quaternion.set(r.x, r.y, r.z, r.w);

  controls.update();
  renderer.render(scene, camera);
}
requestAnimationFrame(tick);

/** Drives exactly one physics step the same way the real loop does — continuous
 * torques, then world.step(), then any due gust puffs. Exposed so test scripts can
 * step deterministically without waiting on rAF/wall-clock timing. */
window.__physicsStep = function () {
  applyContinuousTorques();
  world.step();
  simTime += FIXED_DT;
  gustStep++;
  applyDueGustPuffs();
};
