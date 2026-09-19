import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import RAPIER from '@dimforge/rapier3d-compat';

// Rapier ships as WASM and needs an async init before any RAPIER.* class can be
// used — everything below waits on this. Same pattern as blow-trial.js.
await RAPIER.init();

// ---------------------------------------------------------------- constants
// Card + gust tuning is lifted straight from blow-trial.js's tuned baseline (see
// BLOW_SPEC.md — "treat its constants and approach as your tuned starting
// baseline"), not re-derived. Only the things that genuinely differ for a
// multi-player arena (island radius, blow direction, multiple simultaneous
// cards) are new.
const CARD_LEN = 2;
const CARD_ASPECT = 400 / 563; // figure-indy.png w/h — kept even though this prototype
// draws flat-coloured placeholder cards instead of that texture (BLOW_SPEC.md: "final
// art... out of scope, placeholder art/colours are fine"), so the collider/plane shape
// still matches a real character card.
const CARD_WIDTH = CARD_LEN * CARD_ASPECT;
const CARD_THICK = 0.05;
const CARD_MASS = 0.4;

const ARENA_RADIUS_DEFAULT = 12; // world units — BLOW_SPEC.md §1: 3x Sky Path's ISLAND_RADIUS (4)
const ISLAND_TOP_Y = 0;

// A blow is a handful of off-centre puffs spread over a short window, not one
// clean shove through the centre of mass — see blow-trial.js's own comment
// above GUST_DURATION_STEPS for why (a centred impulse produces zero torque by
// construction, which is what made the pre-Rapier version feel rigid).
const BLOW_BASE_SPEED = 10; // m/s a strength=1 blow imparts, at CARD_MASS — same peak as blow-trial's near/full-strength case
const BLOW_UPKICK = 0.05;
const GUST_DURATION_STEPS = 16;
const GUST_PUFF_COUNT = 4;
const PUFF_JITTER_MAG = 0.3;
const PUFF_JITTER_ANGLE = (14 * Math.PI) / 180;
const PUFF_SPREAD_X = CARD_WIDTH * 0.4;
const PUFF_SPREAD_Y = CARD_LEN * 0.4;

// Upright spring/damping + flutter — identical role to blow-trial.js: a weak
// spring stops a card that's just standing there from spontaneously toppling
// (nothing else holds a strip this thin upright on its edge), easily
// overpowered by an actual blow or by gravity once off the edge. Flutter adds
// noise-driven wobble while moving so a fall doesn't rotate on one clean axis.
const UPRIGHT_SPRING = 0.9;
const UPRIGHT_DAMPING = 0.35;
const FLUTTER_STRENGTH = 0.5;
const FLUTTER_MIN_SPEED = 0.3;

// ---- "at rest" + recovery detection — new for this file, blow-trial.js
// didn't need it (it only ever showed one card mid-tumble on a tuning page,
// nobody needed to know programmatically when it was "done"). BLOW_SPEC.md
// §4 asks for "velocity below some threshold, held for some duration" without
// naming numbers, so these are a first-pass judgment call, not read off
// anything upstream — worth revisiting once this is watched against a real
// blow rather than just this prototype's own sliders.
const REST_LINEAR_THRESHOLD = 0.35; // m/s
const REST_ANGULAR_THRESHOLD = 0.5; // rad/s
const REST_HOLD_TIME = 0.35; // seconds the card must stay under both thresholds before it's considered settled
const UPRIGHT_DOT_TOLERANCE = Math.cos((20 * Math.PI) / 180); // within 20° of vertical counts as "landed upright"
const RECOVERY_DURATION = 0.45; // seconds for the animated snap-to-upright

const FIXED_DT = 1 / 60;

// ---------------------------------------------------------------- module state
// Deliberately module-scope arrays/singletons, same shape as blow-trial.js's
// single cardBody/gustQueue — just widened from "one card" to "a list of
// players." This file is a physics/mechanics module meant to be driven by a
// caller (BLOW_SPEC.md's createArena/addPlayer/blow/step API), not a class,
// so there's one arena per page load; good enough for a standalone prototype
// and consistent with how blow-trial.js is structured.
let scene, camera, renderer, controls;
let world = null;
let islandRadius = ARENA_RADIUS_DEFAULT;
let simTime = 0;
let accumulator = 0;
let lastT = null;

const players = []; // each: see addPlayer()
let nextPlayerId = 1;
const PLAYER_COLORS = [0xffcf5c, 0x5cc2ff, 0xff6f91, 0x8dff7a, 0xc79bff, 0xffa557];

let onWentOffEdge = null; // (playerId) => void — set via arena.onWentOffEdge = fn, or passed to createArena()

// ---------------------------------------------------------------- three.js setup
// Only runs if a canvas host exists — lets this module also be imported by a
// headless/test context without a DOM, though nothing here has been run that
// way; the standalone page (blow-arena.html) always has one.
function initRenderer() {
  const canvasHost = document.body;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);
  canvasHost.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(0, 22, 30);
  camera.lookAt(0, 0, 0);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 6;
  controls.maxDistance = 90;

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Depth-cue dust field, same trick as blow-trial.js — cheap, gives a card
  // falling off the edge something to read its motion against.
  const DUST_COUNT = 260;
  const positions = new Float32Array(DUST_COUNT * 3);
  for (let i = 0; i < DUST_COUNT; i++) {
    const r = islandRadius * 1.3 + Math.random() * 60;
    const theta = Math.random() * Math.PI * 2;
    positions[i * 3] = Math.cos(theta) * r;
    positions[i * 3 + 1] = -Math.random() * 70 + 10;
    positions[i * 3 + 2] = Math.sin(theta) * r;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ color: 0xffe9c8, size: 0.18, transparent: true, opacity: 0.55, fog: false });
  scene.add(new THREE.Points(geo, mat));
}

// ---------------------------------------------------------------- public API
/** Builds the island + its collider + a placeholder central object. Per
 * BLOW_SPEC.md §1/§2. Call once before addPlayer()/blow(). */
export function createArena({ radius = ARENA_RADIUS_DEFAULT, onWentOffEdge: offEdgeCb } = {}) {
  if (typeof document !== 'undefined' && !renderer) initRenderer();

  islandRadius = radius;
  onWentOffEdge = offEdgeCb || null;

  world = new RAPIER.World({ x: 0, y: -9.82, z: 0 });
  world.timestep = FIXED_DT;

  if (scene) {
    // Flat circular deck — unlit MeshBasicMaterial per this project's convention
    // (BLOW_SPEC.md's visual-conventions section: blow-trial.js used lit
        // MeshLambertMaterial because it's a physics trial, this file is meant to
    // be a step closer to what ships, so it doesn't).
    const deck = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, 0.6, 48),
      new THREE.MeshBasicMaterial({ color: 0x4c7a3f })
    );
    deck.position.y = ISLAND_TOP_Y - 0.3;
    scene.add(deck);

    // Placeholder central object — BLOW_SPEC.md §2: "assume for now it's simply
    // a solid, non-interactive obstacle... this is an assumption, flag it
    // clearly." Flagged here and in TODO.md: no special blow-physics
    // interaction, just something to path around.
    const centerMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1.25, 2, 10),
      new THREE.MeshBasicMaterial({ color: 0x2c2c3a })
    );
    centerMesh.position.y = ISLAND_TOP_Y + 1;
    scene.add(centerMesh);
  }

  // Island collider is a cylinder matching the visual deck exactly (unlike
  // blow-trial.js's box approximation, which only had to look right under a
  // free-orbiting camera on a tuning page). Here, "off the edge" is a
  // first-class result the caller depends on (BLOW_SPEC.md §5), so the
  // physical support needs to disappear at exactly the same radius the game
  // logic checks against, not an inscribed-box approximation of it.
  const islandBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, ISLAND_TOP_Y - 0.3, 0));
  world.createCollider(
    RAPIER.ColliderDesc.cylinder(0.3, radius).setFriction(0.55).setRestitution(0.15),
    islandBody
  );

  const centerBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, ISLAND_TOP_Y + 1, 0));
  world.createCollider(RAPIER.ColliderDesc.cylinder(1, 1.15), centerBody);

  players.length = 0;
  nextPlayerId = 1;

  return { radius };
}

/** Places a card at (startDistance, startAngle) from the arena centre —
 * angle in radians, 0 = +Z. Returns an opaque handle for blow(). Per
 * BLOW_SPEC.md's deliverable list. */
export function addPlayer({ startDistance = 0, startAngle = 0 } = {}) {
  if (!world) throw new Error('addPlayer() called before createArena()');

  const id = nextPlayerId++;
  const x = Math.sin(startAngle) * startDistance;
  const z = Math.cos(startAngle) * startDistance;
  const y = ISLAND_TOP_Y + CARD_LEN / 2;

  let group = null;
  if (scene) {
    const color = PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length];
    group = new THREE.Group();
    const geo = new THREE.PlaneGeometry(CARD_WIDTH, CARD_LEN);
    const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    group.add(new THREE.Mesh(geo, mat));
    scene.add(group);
  }

  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setLinearDamping(0.05)
      .setAngularDamping(0.5)
      .setAdditionalMass(CARD_MASS)
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(CARD_WIDTH / 2, CARD_LEN / 2, CARD_THICK / 2).setFriction(0.55).setRestitution(0.15),
    body
  );

  const player = {
    id,
    body,
    group,
    gustQueue: [],
    gustStep: 0,
    blowing: false, // true from blow() until the sequence resolves (landed or off-edge)
    restTimer: 0,
    recovering: false,
    recoveryT: 0,
    recoveryFrom: null,
    recoveryTo: null,
    offEdge: false, // sticky once true — the sequence is over, card just keeps falling under gravity
    pendingOutcome: null, // { resolve } for the Promise blow() returned, cleared once settled
  };
  players.push(player);
  return player;
}

/** Applies a gust to a player's card. `direction` is the aim, chosen by the
 * blower per BLOW_SPEC.md §3 — either a unit vector `{x, z}` or an angle in
 * radians (0 = +Z), NOT derived from blower/target positions here. `strength`
 * is 0..1, same scale as blow-trial.js's slider. Returns a Promise resolving
 * to `{ status: 'landed', x, z, playerId }` or `{ status: 'offEdge', playerId }`
 * once the sequence settles — BLOW_SPEC.md also asks for an explicit
 * onWentOffEdge callback (set via createArena's option) for the off-edge case,
 * since that's meant to be handled distinctly from a normal landing, not just
 * inferred from the promise's resolved value. */
export function blow(handle, { direction, strength = 1 } = {}) {
  const player = handle;
  if (!player || player.offEdge) {
    return Promise.resolve({ status: 'offEdge', playerId: player ? player.id : undefined });
  }

  let dir;
  if (typeof direction === 'number') {
    dir = { x: Math.sin(direction), z: Math.cos(direction) };
  } else if (direction && typeof direction.x === 'number' && typeof direction.z === 'number') {
    const len = Math.hypot(direction.x, direction.z) || 1;
    dir = { x: direction.x / len, z: direction.z / len };
  } else {
    throw new Error('blow() requires a direction: a unit vector {x, z} or an angle in radians');
  }

  const speed = BLOW_BASE_SPEED * THREE.MathUtils.clamp(strength, 0, 1);
  const totalMag = speed * CARD_MASS; // impulse = mass * desired velocity change
  const perPuffMag = totalMag / GUST_PUFF_COUNT;

  player.gustQueue = [];
  player.gustStep = 0;
  player.blowing = true;
  player.recovering = false;
  player.restTimer = 0;

  for (let i = 0; i < GUST_PUFF_COUNT; i++) {
    const atStep = Math.round((i / GUST_PUFF_COUNT) * GUST_DURATION_STEPS);
    const jitteredMag = perPuffMag * (1 + (Math.random() * 2 - 1) * PUFF_JITTER_MAG);
    const wobble = (Math.random() * 2 - 1) * PUFF_JITTER_ANGLE;
    const v = new THREE.Vector3(dir.x, 0, dir.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), wobble);
    const impulse = v.multiplyScalar(jitteredMag);
    impulse.y += jitteredMag * BLOW_UPKICK * (0.5 + Math.random());
    const localPoint = new THREE.Vector3((Math.random() * 2 - 1) * PUFF_SPREAD_X, (Math.random() * 2 - 1) * PUFF_SPREAD_Y, 0);
    player.gustQueue.push({ atStep, impulse, localPoint });
  }
  player.gustQueue.sort((a, b) => a.atStep - b.atStep);
  player.body.wakeUp();

  return new Promise((resolve) => {
    player.pendingOutcome = { resolve };
  });
}

/** Advances the simulation by `dt` real seconds (accumulated into fixed
 * FIXED_DT physics steps, same pattern as blow-trial.js's tick()), and
 * updates every card's THREE group from its Rapier body. Call once per
 * frame. Also drives per-player rest/recovery/off-edge detection. */
export function step(dt) {
  if (!world) return;

  accumulator += Math.min(0.1, dt);
  let steps = 0;
  while (accumulator >= FIXED_DT && steps < 5) {
    for (const p of players) applyContinuousTorque(p);
    world.step();
    simTime += FIXED_DT;
    for (const p of players) {
      p.gustStep++;
      applyDueGustPuffs(p);
    }
    for (const p of players) updatePlayerState(p, FIXED_DT);
    accumulator -= FIXED_DT;
    steps++;
  }

  for (const p of players) {
    if (!p.group) continue;
    if (p.recovering) {
      applyRecoveryVisual(p);
    } else {
      const t = p.body.translation();
      const r = p.body.rotation();
      p.group.position.set(t.x, t.y, t.z);
      p.group.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  if (renderer && scene && camera) {
    controls.update();
    renderer.render(scene, camera);
  }
}

export function getPlayerState(handle) {
  const t = handle.body.translation();
  return { id: handle.id, x: t.x, y: t.y, z: t.z, offEdge: handle.offEdge, blowing: handle.blowing };
}

// ---------------------------------------------------------------- per-step internals
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Upright spring + flutter — identical logic to blow-trial.js's
 * applyContinuousTorques(), just per-player. Skipped while a player is mid
 * recovery-snap since that phase drives the body kinematically instead. */
function applyContinuousTorque(p) {
  if (p.recovering) {
    p.body.resetTorques(true);
    return;
  }
  const r = p.body.rotation();
  const quat = new THREE.Quaternion(r.x, r.y, r.z, r.w);
  const currentUp = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
  const spring = currentUp.clone().cross(WORLD_UP).multiplyScalar(UPRIGHT_SPRING);

  const av = p.body.angvel();
  const damping = new THREE.Vector3(av.x, av.y, av.z).multiplyScalar(-UPRIGHT_DAMPING);

  const torque = spring.add(damping);

  const lv = p.body.linvel();
  const speed = Math.hypot(lv.x, lv.y, lv.z);
  if (speed > FLUTTER_MIN_SPEED) {
    const s = Math.min(1, speed / 4);
    torque.x += Math.sin(simTime * 9.1 + p.id * 1.7) * FLUTTER_STRENGTH * s;
    torque.z += Math.sin(simTime * 6.3 + p.id * 4.2) * FLUTTER_STRENGTH * s;
  }

  p.body.resetTorques(true);
  p.body.addTorque({ x: torque.x, y: torque.y, z: torque.z }, true);
}

function applyDueGustPuffs(p) {
  while (p.gustQueue.length && p.gustQueue[0].atStep <= p.gustStep) {
    const puff = p.gustQueue.shift();
    const r = p.body.rotation();
    const t = p.body.translation();
    const quat = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const worldOffset = puff.localPoint.clone().applyQuaternion(quat);
    p.body.applyImpulseAtPoint(
      { x: puff.impulse.x, y: puff.impulse.y, z: puff.impulse.z },
      { x: t.x + worldOffset.x, y: t.y + worldOffset.y, z: t.z + worldOffset.z },
      true
    );
  }
}

/** Per-player, per-physics-step bookkeeping: off-edge detection (checked
 * unconditionally — BLOW_SPEC.md §5 says "at any point after a blow", and a
 * settled-but-nudged card could in principle still be pushed over later),
 * then — only while a blow sequence is actually in flight — at-rest
 * detection and the landed-vs-recover branch. */
function updatePlayerState(p, dt) {
  if (p.offEdge) return;

  const t = p.body.translation();
  const distFromCenter = Math.hypot(t.x, t.z);
  if (distFromCenter > islandRadius) {
    p.offEdge = true;
    p.blowing = false;
    p.recovering = false;
    if (p.pendingOutcome) {
      p.pendingOutcome.resolve({ status: 'offEdge', playerId: p.id });
      p.pendingOutcome = null;
    }
    if (typeof onWentOffEdge === 'function') onWentOffEdge(p.id);
    return;
  }

  if (!p.blowing) return;

  if (p.recovering) {
    p.recoveryT += dt;
    if (p.recoveryT >= RECOVERY_DURATION) finishRecovery(p);
    return;
  }

  const lv = p.body.linvel();
  const av = p.body.angvel();
  const speed = Math.hypot(lv.x, lv.y, lv.z);
  const aspeed = Math.hypot(av.x, av.y, av.z);
  if (speed < REST_LINEAR_THRESHOLD && aspeed < REST_ANGULAR_THRESHOLD) {
    p.restTimer += dt;
  } else {
    p.restTimer = 0;
  }

  if (p.restTimer >= REST_HOLD_TIME) settleBlow(p);
}

/** Called once a card has been "at rest" for REST_HOLD_TIME. Either the blow
 * sequence is done (already upright), or a recovery snap starts — per
 * BLOW_SPEC.md §4. */
function settleBlow(p) {
  const r = p.body.rotation();
  const quat = new THREE.Quaternion(r.x, r.y, r.z, r.w);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
  const dot = up.dot(WORLD_UP);

  if (dot >= UPRIGHT_DOT_TOLERANCE) {
    finishBlowSequence(p, 'landed');
  } else {
    startRecovery(p, quat);
  }
}

/** Animated snap-to-upright. Drives the body kinematically for
 * RECOVERY_DURATION rather than via forces — a spring/torque-based recovery
 * would fight gravity and the surface's friction unpredictably (see the
 * upright-spring comment above; it's deliberately too weak to guarantee this
 * on its own) and has no guaranteed finish time, whereas BLOW_SPEC.md wants
 * the blow sequence to report itself finished with the target *guaranteed*
 * upright. A kinematic lerp/slerp guarantees both the outcome and the
 * timing. */
function startRecovery(p, currentQuat) {
  if (globalThis.__BLOW_ARENA_DEBUG__) console.log(`[debug] player ${p.id} recovering (settled non-upright)`);
  p.recovering = true;
  p.recoveryT = 0;
  const t = p.body.translation();

  // JUDGMENT CALL (not specified by BLOW_SPEC.md, flagged per its own
  // "leave a note rather than guess silently" instruction): recovery keeps
  // whichever way the card was facing horizontally when it settled (its yaw)
  // rather than resetting to some fixed heading — "stand back up where you
  // fell, facing however you happened to land" reads more natural than
  // snapping to face a default direction. Position (x, z) is likewise
  // whatever it came to rest at; only y and pitch/roll are corrected.
  const euler = new THREE.Euler().setFromQuaternion(currentQuat, 'YXZ');
  const uprightQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, euler.y, 0));

  p.recoveryFrom = { pos: new THREE.Vector3(t.x, t.y, t.z), quat: currentQuat.clone() };
  p.recoveryTo = { pos: new THREE.Vector3(t.x, ISLAND_TOP_Y + CARD_LEN / 2, t.z), quat: uprightQuat };

  p.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
}

function applyRecoveryVisual(p) {
  const t = Math.min(1, p.recoveryT / RECOVERY_DURATION);
  const eased = t * t * (3 - 2 * t); // smoothstep
  const pos = p.recoveryFrom.pos.clone().lerp(p.recoveryTo.pos, eased);
  const quat = p.recoveryFrom.quat.clone().slerp(p.recoveryTo.quat, eased);
  p.body.setNextKinematicTranslation(pos);
  p.body.setNextKinematicRotation(quat);
  p.group.position.copy(pos);
  p.group.quaternion.copy(quat);
}

function finishRecovery(p) {
  p.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
  p.body.setTranslation(p.recoveryTo.pos, true);
  p.body.setRotation(p.recoveryTo.quat, true);
  p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  p.recovering = false;
  finishBlowSequence(p, 'landed');
}

function finishBlowSequence(p, status) {
  p.blowing = false;
  p.restTimer = 0;
  const t = p.body.translation();
  if (p.pendingOutcome) {
    p.pendingOutcome.resolve({ status, x: t.x, z: t.z, playerId: p.id });
    p.pendingOutcome = null;
  }
}

// ---------------------------------------------------------------- render loop
// Only starts once a page (blow-arena.html) actually calls startLoop() — a
// caller embedding this module elsewhere can instead call step(dt) itself on
// its own render loop, per BLOW_SPEC.md's "step(dt) or internal render-loop
// tick, however fits."
export function startLoop() {
  lastT = performance.now();
  function tick() {
    requestAnimationFrame(tick);
    const now = performance.now();
    const dt = (now - lastT) / 1000;
    lastT = now;
    step(dt);
  }
  requestAnimationFrame(tick);
}

export function getArenaRadius() {
  return islandRadius;
}
