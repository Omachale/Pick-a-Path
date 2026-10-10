/**
 * Island Throw: the paper-plane minigame played from the temple island at the
 * end of Sky Path (Luke's brief, 2026-09-29). Players stand on the edge of the
 * temple island, read the target island and the wind flag, pick one of three
 * planes, and throw.
 *
 * Its own scene by design, not a stand-in for the game world. Luke: players
 * doing this "will not in fact be in the same instanced environment as the
 * other players who are still doing Sky Path... It will use the same visuals
 * for the ground and cloud cover below." So this page reuses Sky Path's real
 * backdrop (throwGame/skyBackdrop.js), its temple island model and its island
 * model, rather than approximating them.
 *
 * Module map:
 *   throwGame/flightModel.js - physics, plane stats and every LEVER
 *   throwGame/course.js      - challenges, random courses, collision, scoring
 *   throwGame/skyBackdrop.js - Sky Path's floor, sky and wind clouds (copied; see its header)
 *   throwGame/windFlag.js    - the neutral wind flag
 *   throwGame/throwWorld.js  - temple island, course islands, target marker, trails
 *   scripts/throwSim.mjs     - headless validator: which plane each course favours
 *
 * Input is two separate decisions (see INPUT_DEFAULTS): tap to lock a
 * sweeping launch angle, then swipe to throw. The swipe's direction sets
 * left/right and its length sets power. It works the same with a mouse drag
 * or a finger.
 *
 * The levers panel on the right is a TEMPORARY tuning panel. Delete it once
 * values are settled and baked into flightModel.js / course.js.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import {
  PLANE_TYPES, PLANE_ORDER, LEVER_DEFAULTS, throwVelocity, stepFlight, makeFlightState, simulateThrow, launchVelocity,
} from './throwGame/flightModel.js';
import { CHALLENGES, THROW_ORIGIN, buildCourse, randomChallenge, testSegment } from './throwGame/course.js';
import { createSkyBackdrop } from './throwGame/skyBackdrop.js';
import { createWindFlag } from './throwGame/windFlag.js';
import { loadIslandFactory, loadTempleIsland, buildTargetMarker, createTrail } from './throwGame/throwWorld.js';
import { buildTestPlane } from './paperPlane/planeShapes.js';

// ---------------------------------------------------------------- live settings
const DEFAULT_STATS = JSON.parse(JSON.stringify(PLANE_TYPES));
const STATS = JSON.parse(JSON.stringify(PLANE_TYPES));
const LEVERS = { ...LEVER_DEFAULTS };
const VIEW_DEFAULTS = {
  camera: 'chase', // 'chase' follows the plane, 'fixed' stays at the throw point
  timeOfDay: 1, // Sky Path's sunP: 0 dawn, 0.5 noon, 1 dusk. Players reach the temple at dusk.
  windHud: false, // numeric wind readout. Off, because the flag is meant to be the cue.
  cloudsShowWind: true, // cloud sheets drift with the course's wind, a second cue
  playback: 1.5, // flight playback speed. Long glides at 1x can drag.
  failSpeedup: 5, // extra playback multiplier once a throw has clearly missed every island. 1 = off.
  // Slow-motion, as a percentage slowed (0 = normal, 60 = 40% of normal speed).
  // Playback only: the flight is simulated in fixed steps whatever the speed,
  // so it can never change where a throw lands. It is there so the player can
  // watch what happens more easily (Luke, 2026-09-29).
  flightSlowdown: 0,
  arrowLength: 11, // launch arrow length at full power, in world units
};
const VIEW = { ...VIEW_DEFAULTS };

// The throw is two separate decisions (Luke, 2026-09-29, replacing
// point-at-the-target aiming, which "does too much of the work for the
// player"):
//   1. BEFORE launch, the upward angle: a needle sweeps up and down and the
//      player taps to lock it, so hitting an exact value is hard.
//   2. AT launch, hold-to-choose: press and hold, drag to set the launch
//      arrow (its direction is left/right, its length is power), release to
//      throw. Luke, 2026-09-29: "rather than an instant swipe... a
//      hold-to-choose option, where the player can see the direction and
//      length of the arrow representing the launch vector."
const INPUT_DEFAULTS = {
  angleMin: -10, // degrees
  angleMax: 70,
  angleSweepSeconds: 1.2, // time for the needle to travel min -> max
  // 'triangle': constant speed, every angle equally hard to hit.
  // 'sine': slows near the ends, so extremes are easy and middle angles hard.
  angleSweepShape: 'triangle',
  swipeFullPower: 0.45, // swipe length for 100% power, as a fraction of the screen's shorter side
  maxYawDeg: 50, // largest left/right throw angle; the result is clamped to this
  // Softer direction (Luke's pick from the forgiveness ideas): the drag's
  // direction is turned into throw direction at less than 1:1, so a wobble of
  // the hand moves the throw less. The deadzone makes anything within a few
  // degrees of straight up exactly straight. With the defaults a fully
  // sideways drag (90 deg) still reaches the max: 0.6 * (90 - 4) = 51.6 -> 50.
  yawSensitivity: 0.6,
  yawDeadzoneDeg: 4,
};
const INPUT = { ...INPUT_DEFAULTS };

const FIXED_DT = 1 / 120; // flight step, same as simulateThrow's default, so the guide and the flight agree

// ---------------------------------------------------------------- scene
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.3, 5000); // Sky Path's FOV
// Directly behind the throw point, so the plane in hand sits dead centre and
// a swipe straight up the screen reads as straight ahead: a little left of
// straight means a little left. Luke, 2026-09-29, on the earlier off-centre
// camera: the launch point was right of centre, "so that the player has to
// ask what the angle would be from that point of view". Height, not a
// sideways offset, is what keeps the plane below the targets rather than on
// top of them (the reason the camera was offset in the first place).
const HOME_POS = new THREE.Vector3(0, 5.8, 8.2);
const HOME_TARGET = new THREE.Vector3(0, -1, -30);
camera.position.copy(HOME_POS);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(HOME_TARGET);
controls.enableDamping = true;
// Left button and one-finger touch are the throw, so looking around is
// right-drag or two fingers, and zoom is the wheel or a pinch.
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
controls.update();

const loader = new THREE.TextureLoader();
function tex(name, { ext = 'webp', repeatWrap = false, tile = false } = {}) {
  const t = loader.load(`textures/${name}.${ext}`);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  if (repeatWrap) t.wrapS = THREE.RepeatWrapping;
  if (tile) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

const backdrop = createSkyBackdrop(scene, renderer, tex);
backdrop.setTimeOfDay(VIEW.timeOfDay);

const gltfLoader = new GLTFLoader();
loadTempleIsland(gltfLoader, scene);

const flag = createWindFlag();
// Toward the left of the (centred) home view: prominent, but clear of the
// courses' bearings. At (-2.6, 0, -0.9) it stood right in front of most targets.
flag.group.position.set(-3.4, 0, -0.6);
scene.add(flag.group);

// ---------------------------------------------------------------- planes
// Visuals reuse the aero prototype's three hand-built shapes: same names, same
// colours, clearly different silhouettes. Physics doesn't read their geometry.
const PLANE_VISUAL_SCALE = 0.38;
const planeMeshes = {};
for (const kind of PLANE_ORDER) {
  const rig = buildTestPlane(kind);
  rig.root.scale.setScalar(PLANE_VISUAL_SCALE);
  rig.root.visible = false;
  scene.add(rig.root);
  planeMeshes[kind] = rig.root;
}
let selected = 'middle';

// planeShapes' local frame has its nose on +Z and up on +Y, which is right-handed
// with +X on the plane's own left. So local X is cross(up, forward).
const _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3(), _m = new THREE.Matrix4();
function orientAlong(obj, dir) {
  _bz.copy(dir).normalize();
  _bx.crossVectors(THREE.Object3D.DEFAULT_UP, _bz);
  if (_bx.lengthSq() < 1e-6) _bx.set(1, 0, 0);
  _bx.normalize();
  _by.crossVectors(_bz, _bx);
  _m.makeBasis(_bx, _by, _bz);
  obj.quaternion.setFromRotationMatrix(_m);
}

// ---------------------------------------------------------------- course
let islandFactory = null;
let courseIndex = 0;
let randomSeed = 1;
let current = null; // { challenge, course, group }
const best = {}; // course id -> best points

function courseWind() {
  return current.course.wind.clone().multiplyScalar(LEVERS.windScale);
}

function setCourse(challenge) {
  if (current?.group) scene.remove(current.group);
  const course = buildCourse(challenge);
  const group = new THREE.Group();
  for (const isl of course.islands) {
    const holder = new THREE.Group();
    holder.position.set(isl.x, isl.y, isl.z);
    if (islandFactory) holder.add(islandFactory(isl.r));
    else {
      // stand-in until the glTF arrives; replaced by rebuildCourseVisuals()
      const m = new THREE.Mesh(new THREE.CylinderGeometry(isl.r, isl.r * 0.2, isl.depth, 24), new THREE.MeshBasicMaterial({ color: 0x8a7a62 }));
      m.position.y = -isl.depth / 2;
      holder.add(m);
    }
    if (isl.isTarget) holder.add(buildTargetMarker(isl.r));
    group.add(holder);
  }
  scene.add(group);
  current = { challenge, course, group };
  clearTrails();
  applyWindCues();
  updateCourseBar();
  guideKey = '';
}

function applyWindCues() {
  const w = courseWind();
  flag.setWind(w);
  backdrop.setWind(VIEW.cloudsShowWind ? w : null);
  updateWindHud();
}

loadIslandFactory(gltfLoader, tex('island-circle')).then((factory) => {
  islandFactory = factory;
  setCourse(current.challenge);
});

// ---------------------------------------------------------------- aim: angle sweep, then swipe
const aim = { yaw: 0, pitch: THREE.MathUtils.degToRad(20), power: 0 };
let sweepT = Math.random() * 10; // random starting point, so the sweep's timing can't be learned by counting from the start

/** Where the sweeping needle is right now, in degrees. */
function sweepAngleDeg() {
  const s = INPUT.angleSweepSeconds;
  let u;
  if (INPUT.angleSweepShape === 'sine') u = 0.5 - 0.5 * Math.cos((Math.PI * sweepT) / s);
  else {
    const x = (sweepT / s) % 2;
    u = x < 1 ? x : 2 - x;
  }
  return THREE.MathUtils.lerp(INPUT.angleMin, INPUT.angleMax, u);
}

// `last` is the vector from the most recent pointer MOVE, which is what a
// release throws with (see endSwipe). `cancelling` is true whenever releasing
// right now would cancel instead of throw.
const swipe = { active: false, x0: 0, y0: 0, x: 0, y: 0, pointerId: null, pointerType: null, last: null, cancelling: true };
/** True only for events from the pointer that started the current hold. */
const isHoldPointer = (e) => phase === 'swiping' && e.pointerId === swipe.pointerId && e.pointerType === swipe.pointerType;
const MIN_SWIPE_PX = 24; // a hold shorter than this is a cancel, and its direction is too noisy to trust anyway

/**
 * Turns the current hold-drag into yaw and power. Direction is measured from
 * straight up the screen (dragging "away" = straight ahead), then softened:
 * inside the deadzone it's exactly straight, beyond it the throw angle grows
 * at yawSensitivity per degree of drag angle. Length, as a fraction of the
 * screen's shorter side, is power. Returns null if the drag doesn't go upward
 * at all, since dragging toward yourself isn't a throw.
 */
function readSwipe() {
  const dx = swipe.x - swipe.x0;
  const dy = swipe.y - swipe.y0;
  const len = Math.hypot(dx, dy);
  if (-dy <= 0 || len < 1) return null;
  const raw = Math.atan2(dx, -dy);
  const dead = THREE.MathUtils.degToRad(INPUT.yawDeadzoneDeg);
  const maxYaw = THREE.MathUtils.degToRad(INPUT.maxYawDeg);
  const yaw = THREE.MathUtils.clamp(Math.sign(raw) * Math.max(0, Math.abs(raw) - dead) * INPUT.yawSensitivity, -maxYaw, maxYaw);
  const power = Math.min(1, len / (INPUT.swipeFullPower * Math.min(innerWidth, innerHeight)));
  return { yaw, power, len };
}

// The launch arrow: a plain, standard arrow (flat-ended rectangular shaft,
// sharp triangular head) from the hand along the launch direction, and the ONLY
// indicator of the throw. While holding it IS the launch vector: it swings
// left/right with the drag, and power is shown by the arrow alone (no power bar,
// no numbers): it gets longer, fatter, bigger-headed and redder as power rises,
// from white at none to a reddish orange at full. It turns grey when releasing
// would cancel.
//
// It is drawn as a shape on the screen (an SVG polygon in #arrowShape) between
// the projected hand and the projected tip, rather than as 3D geometry. A 3D
// line has round end caps and a cone head looks round from behind (Luke,
// 2026-09-29: "a completely normal, standard arrow shape. No rounded head"), and
// a screen-space shape keeps the same clean proportions at any distance and
// angle instead of tapering with perspective.
//
// Its full-power length is VIEW.arrowLength (a world length, projected). The
// default is long on purpose: the arrow points away from the camera, so
// perspective squashes its length, and a short arrow made 30% and 70% power
// look nearly the same at a level launch angle. The other lengths are fixed
// fractions of it.
const ARROW_IDLE_FRAC = 0.29; // before the hold starts
const ARROW_MIN_FRAC = 0.145; // at 0 power
const ARROW_GREY = 0xb9b4bd;
const ARROW_WIDTH_MIN = 4; // shaft width in px at 0 power
const ARROW_WIDTH_MAX = 24; // ...and at full power
const ARROW_HEAD_WIDTH_PER_SHAFT = 2.2; // head base width, as a multiple of the shaft width...
const ARROW_HEAD_WIDTH_EXTRA = 6; // ...plus this many px
const ARROW_HEAD_LEN_PER_WIDTH = 0.95; // head length, as a multiple of its base width
const ARROW_COLOR_LOW = new THREE.Color(0xffffff); // no power
const ARROW_COLOR_MID = new THREE.Color(0xffb347); // over halfway: warm orange
const ARROW_COLOR_HIGH = new THREE.Color(0xff4a1c); // full power: reddish orange
/** White -> warm orange -> reddish orange as power goes 0 -> 0.55 -> 1. */
function arrowColorFor(power, out) {
  return power < 0.55
    ? out.copy(ARROW_COLOR_LOW).lerp(ARROW_COLOR_MID, power / 0.55)
    : out.copy(ARROW_COLOR_MID).lerp(ARROW_COLOR_HIGH, (power - 0.55) / 0.45);
}
const _arrowColor = new THREE.Color();
const arrowShape = document.getElementById("arrowShape");
const _hand = new THREE.Vector3();
const _tipW = new THREE.Vector3();
const toScreen = (v, out) => {
  _hand.copy(v).project(camera);
  out.x = (_hand.x * 0.5 + 0.5) * innerWidth;
  out.y = (-_hand.y * 0.5 + 0.5) * innerHeight;
  return out;
};
const _s0 = { x: 0, y: 0 };
const _s1 = { x: 0, y: 0 };
/** Builds the arrow polygon from screen point a to screen point b, in px. Returns false if too short to draw. */
function setArrowPolygon(a, b, shaftW, headW) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (L < 6) return false;
  const ux = dx / L, uy = dy / L; // along the arrow
  const nx = -uy, ny = ux; // across it
  const headL = Math.min(headW * ARROW_HEAD_LEN_PER_WIDTH, L * 0.6);
  const sx = b.x - ux * headL, sy = b.y - uy * headL; // where the shaft meets the head
  const h = shaftW / 2, H = headW / 2;
  const pts = [
    [a.x + nx * h, a.y + ny * h], [sx + nx * h, sy + ny * h], [sx + nx * H, sy + ny * H],
    [b.x, b.y],
    [sx - nx * H, sy - ny * H], [sx - nx * h, sy - ny * h], [a.x - nx * h, a.y - ny * h],
  ];
  arrowShape.setAttribute("points", pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" "));
  return true;
}

// Guide, 'plane' / 'full' modes: the predicted path, live during the swipe only.
const guideMat = new LineMaterial({ color: 0xffffff, linewidth: 2.5, transparent: true, opacity: 0.7, dashed: true, dashSize: 0.8, gapSize: 0.5 });
guideMat.resolution.set(innerWidth, innerHeight);
const guideLine = new Line2(new LineGeometry(), guideMat);
guideLine.frustumCulled = false;
guideLine.visible = false;
scene.add(guideLine);
let guideKey = '';

const _dir = new THREE.Vector3();
function updateGuide() {
  const aiming = phase === 'angle' || phase === 'swipe' || phase === 'swiping';
  const mode = LEVERS.guide;
  const showArrow = aiming && mode !== 'off';
  const holding = phase === 'swiping';
  arrowShape.style.display = showArrow ? "" : "none";
  if (showArrow) {
    _dir.copy(launchVelocity(STATS[selected], { ...aim, power: 0 })).normalize();
    const maxLen = VIEW.arrowLength;
    const len = holding ? THREE.MathUtils.lerp(maxLen * ARROW_MIN_FRAC, maxLen, aim.power) : maxLen * ARROW_IDLE_FRAC;
    _tipW.copy(THROW_ORIGIN).addScaledVector(_dir, len);
    const k = holding ? aim.power : 0.35; // before the hold, a modest mid-size arrow
    const shaftW = THREE.MathUtils.lerp(ARROW_WIDTH_MIN, ARROW_WIDTH_MAX, k);
    const headW = shaftW * ARROW_HEAD_WIDTH_PER_SHAFT + ARROW_HEAD_WIDTH_EXTRA;
    if (!setArrowPolygon(toScreen(THROW_ORIGIN, _s0), toScreen(_tipW, _s1), shaftW, headW)) arrowShape.style.display = "none";
    if (holding && swipe.cancelling) _arrowColor.setHex(ARROW_GREY);
    else arrowColorFor(holding ? aim.power : 0, _arrowColor);
    arrowShape.setAttribute("fill", "#" + _arrowColor.getHexString());
    arrowShape.setAttribute("fill-opacity", holding && swipe.cancelling ? 0.5 : 0.95);
    arrowShape.setAttribute("stroke-opacity", holding && swipe.cancelling ? 0.25 : 0.55);
  }

  const showPath = phase === 'swiping' && (mode === 'plane' || mode === 'full');
  if (!showPath) {
    guideLine.visible = false;
    return;
  }
  const key = [aim.yaw, aim.pitch, aim.power, selected, JSON.stringify(LEVERS), JSON.stringify(STATS[selected]), current.challenge.id].join('|');
  if (key === guideKey) return;
  guideKey = key;
  const type = STATS[selected];
  // By default the path is shown as if in calm air (guideIncludesWind), so
  // reading the wind from the flag is still the player's job.
  const wind = LEVERS.guideIncludesWind ? current.course.wind : new THREE.Vector3();
  const { path } = simulateThrow({
    origin: THROW_ORIGIN,
    velocity: throwVelocity(type, aim, wind, LEVERS),
    type, levers: LEVERS, wind,
    maxTime: mode === 'full' ? 20 : type.guideSeconds,
    testSegment: (a, b) => testSegment(current.course, a, b),
    recordPath: true, recordEvery: 3,
  });
  if (path.length < 2) { guideLine.visible = false; return; }
  const flat = [];
  for (const p of path) flat.push(p.x, p.y, p.z);
  guideLine.geometry.setPositions(flat);
  guideLine.computeLineDistances();
  guideLine.visible = true;
}

// ---------------------------------------------------------------- phases + flight
// 'angle'    - the needle sweeps; tap to lock it
// 'swipe'    - angle locked, waiting for the swipe to start
// 'swiping'  - finger or mouse down, direction and power following it
// 'flying' | 'result'
let phase = 'angle';
let flight = null; // { state, trail, acc, steps, kind }
let resultTimer = 0;
let throwCount = 0;
const trails = []; // { trail, marker }

function lockAngle() {
  aim.pitch = THREE.MathUtils.degToRad(sweepAngleDeg());
  aim.yaw = 0;
  phase = 'swipe';
}

function repickAngle() {
  if (phase !== 'swipe' && phase !== 'swiping') return;
  swipe.active = false;
  phase = 'angle';
}

// Missed throws used to be watched all the way down (Luke, 2026-09-29: "it
// takes a long time to watch it slowly fail"). Flights are deterministic, so
// the throw is simulated ahead at launch with the game's own stepper, and if
// it won't land on any island, the moment it has "clearly failed" is worked
// out: the last time the plane was still within reach of an island. Playback
// speeds up from there (VIEW.failSpeedup), so a near miss is still watched at
// normal speed right up until it has gone by.
const REACH_MARGIN = 6; // horizontal distance past an island's rim that still counts as within reach
const MIN_WATCH_SECONDS = 1.2; // always show at least this much of the throw at normal speed
const LINGER_SECONDS = 0.5; // ...and this long after the last chance passes
function planFailureSpeedup(velocity, seed) {
  const type = STATS[selected];
  const { outcome, path } = simulateThrow({
    origin: THROW_ORIGIN, velocity, type, levers: LEVERS, wind: current.course.wind, seed, dt: FIXED_DT,
    testSegment: (a, b) => testSegment(current.course, a, b), recordPath: true, recordEvery: 1,
  });
  // landings resolve themselves, and a crash ends at the rock, inside the window anyway
  if (outcome.type === 'target' || outcome.type === 'island' || outcome.type === 'crash') return Infinity;
  let lastReach = 0;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    for (const isl of current.course.islands) {
      if (p.y < isl.y - isl.depth - 3) continue; // well below the rock: gone
      if (Math.hypot(p.x - isl.x, p.z - isl.z) < isl.r + REACH_MARGIN) { lastReach = i * FIXED_DT; break; }
    }
  }
  return Math.max(MIN_WATCH_SECONDS, lastReach + LINGER_SECONDS);
}

function throwPlane() {
  const type = STATS[selected];
  throwCount++;
  for (const t of trails) t.trail.fade(0.3);
  const velocity = throwVelocity(type, aim, current.course.wind, LEVERS);
  const state = makeFlightState(THROW_ORIGIN, velocity, throwCount);
  const trail = createTrail(scene, type.color);
  trail.push(state.pos);
  trails.push({ trail, marker: null });
  const speedupAt = VIEW.failSpeedup > 1 ? planFailureSpeedup(velocity, throwCount) : Infinity;
  flight = { state, trail, acc: 0, steps: 0, kind: selected, prev: new THREE.Vector3(), speedupAt };
  phase = 'flying';
  updateGuide();
  if (VIEW.camera === 'chase') startChase();
}

function updateFlight(dt) {
  if (!flight) return;
  const type = STATS[flight.kind];
  const mesh = planeMeshes[flight.kind];
  // Only how fast the fixed-step simulation is CONSUMED changes with these; the
  // steps themselves, and so the result, are identical at any setting.
  flight.acc += dt * VIEW.playback * (1 - VIEW.flightSlowdown / 100) * (flight.state.t >= flight.speedupAt ? VIEW.failSpeedup : 1);
  while (flight.acc >= FIXED_DT) {
    flight.acc -= FIXED_DT;
    flight.prev.copy(flight.state.pos);
    stepFlight(flight.state, FIXED_DT, type, LEVERS, current.course.wind);
    flight.steps++;
    if (flight.steps % 2 === 0) flight.trail.push(flight.state.pos);
    const hit = testSegment(current.course, flight.prev, flight.state.pos);
    if (hit || flight.state.t > 20) {
      finishFlight(hit ?? { type: 'timeout', point: flight.state.pos.clone() });
      return;
    }
  }
  mesh.position.copy(flight.state.pos);
  const dir = flight.state.vel.clone();
  if (dir.lengthSq() > 1e-6) {
    // ease toward the flight direction rather than snapping, so the plane's attitude reads smoothly
    const q = mesh.quaternion.clone();
    orientAlong(mesh, dir);
    mesh.quaternion.slerpQuaternions(q, mesh.quaternion, 1 - Math.exp(-dt * 12));
  }
}

const MESSAGES = {
  island: ['Wrong island', 'It landed on a different island'],
  crash: ['Crashed!', 'It hit the rock under an island'],
  short: ['Too short', 'It came down on the temple island'],
  lost: ['Lost in the clouds', ''],
  timeout: ['Out of sight', 'It sailed on past everything'],
};

function finishFlight(hit) {
  const mesh = planeMeshes[flight.kind];
  flight.trail.push(hit.point);
  mesh.position.copy(hit.point);
  mesh.visible = hit.type !== 'lost' && hit.type !== 'timeout';
  if (hit.type === 'target' || hit.type === 'island') {
    // settle flat on the deck, nose along the direction of travel
    const d = flight.state.vel.clone(); d.y = 0;
    if (d.lengthSq() > 1e-6) orientAlong(mesh, d);
    mesh.position.y += 0.05;
  }
  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.18, 0.32, 20),
    new THREE.MeshBasicMaterial({ color: STATS[flight.kind].color, side: THREE.DoubleSide, depthWrite: false, transparent: true })
  );
  marker.rotation.x = -Math.PI / 2;
  marker.position.copy(hit.point).y += 0.06;
  marker.renderOrder = 9;
  if (hit.type === 'target' || hit.type === 'island' || hit.type === 'short') scene.add(marker);
  trails[trails.length - 1].marker = marker;

  if (hit.type === 'target') {
    const id = current.challenge.id;
    best[id] = Math.max(best[id] ?? 0, hit.points);
    showToast(`${hit.label} +${hit.points}`, `${hit.dist.toFixed(1)} from the centre · ${flight.state.t.toFixed(1)}s in the air`);
    updateCourseBar();
  } else {
    const [a, b] = MESSAGES[hit.type];
    showToast(a, b);
  }
  flight = null;
  phase = 'result';
  resultTimer = 2.2;
  if (camMode === 'chase') camHold = 1.4;
}

function returnToAim() {
  phase = 'angle';
  for (const k of PLANE_ORDER) planeMeshes[k].visible = false;
  planeMeshes[selected].visible = true;
  guideKey = '';
  if (camMode === 'chase') camMode = 'return';
}

function clearTrails() {
  for (const t of trails) {
    t.trail.dispose();
    if (t.marker) scene.remove(t.marker);
  }
  trails.length = 0;
}

// ---------------------------------------------------------------- camera
let camMode = 'home'; // 'home' (orbit controls live) | 'chase' | 'return'
let camHold = 0;
const lookAt = new THREE.Vector3();

function startChase() {
  camMode = 'chase';
  controls.enabled = false;
  lookAt.copy(controls.target);
}

function updateCamera(dt) {
  if (camMode === 'home') {
    controls.update();
    return;
  }
  const k = 1 - Math.exp(-dt * 3.5);
  if (camMode === 'chase') {
    const mesh = planeMeshes[selected];
    const p = flight ? flight.state.pos : mesh.position;
    const v = flight ? flight.state.vel : new THREE.Vector3(0, 0, -1);
    const back = new THREE.Vector3(v.x, 0, v.z);
    if (back.lengthSq() < 1e-6) back.set(0, 0, -1);
    back.normalize().multiplyScalar(-4.6);
    const desired = p.clone().add(back).add(new THREE.Vector3(0, 1.7, 0));
    camera.position.lerp(desired, k);
    lookAt.lerp(p, 1 - Math.exp(-dt * 6));
    camera.lookAt(lookAt);
    if (!flight) {
      camHold -= dt;
      if (camHold <= 0 && phase === 'angle') camMode = 'return';
    }
  } else if (camMode === 'return') {
    camera.position.lerp(HOME_POS, k);
    lookAt.lerp(HOME_TARGET, k);
    camera.lookAt(lookAt);
    if (camera.position.distanceTo(HOME_POS) < 0.05) {
      camMode = 'home';
      controls.target.copy(HOME_TARGET);
      controls.enabled = true;
      controls.update();
    }
  }
}

function resetView() {
  camMode = 'home';
  camera.position.copy(HOME_POS);
  controls.target.copy(HOME_TARGET);
  controls.enabled = true;
  controls.update();
}

// ---------------------------------------------------------------- input
// Tap (or Space) locks the sweeping angle. Then press and HOLD anywhere: the
// launch arrow follows the drag, and releasing throws. Pulling back to the
// start point (or below it) and releasing cancels, so a hold can be abandoned
// without throwing. A tap that never moves is a cancel too, so double-tapping
// the angle can't fire a zero-power throw.
const canvas = renderer.domElement;
canvas.style.touchAction = 'none';

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  // tapping the scene tucks the plane picker away, and carries on as normal
  if (pickerOpen) { setPickerOpen(false); renderPicker(); }
  if (phase === 'result') { returnToAim(); return; }
  if (phase === 'angle') { lockAngle(); return; }
  if (phase === 'swipe') {
    swipe.active = true;
    swipe.pointerId = e.pointerId;
    swipe.pointerType = e.pointerType;
    swipe.x0 = swipe.x = e.clientX;
    swipe.y0 = swipe.y = e.clientY;
    swipe.last = null;
    swipe.cancelling = true;
    aim.yaw = 0;
    aim.power = 0;
    // Capture keeps move/up events coming if the pointer leaves the canvas. If
    // it isn't available the hold still works, just without that guarantee.
    try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    phase = 'swiping';
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!isHoldPointer(e)) return;
  // A mouse moving with no button down means the release was missed (let go
  // outside the window, say). Abandon the hold rather than leaving it steering
  // the throw with every hover.
  if (e.pointerType === 'mouse' && e.buttons === 0) {
    swipe.active = false;
    phase = 'swipe';
    aim.yaw = 0;
    aim.power = 0;
    return;
  }
  swipe.x = e.clientX;
  swipe.y = e.clientY;
  const r = readSwipe();
  swipe.last = r;
  if (r && r.len >= MIN_SWIPE_PX) {
    aim.yaw = r.yaw;
    aim.power = r.power;
    swipe.cancelling = false;
  } else {
    aim.yaw = 0;
    aim.power = 0;
    swipe.cancelling = true;
  }
});
// Release throws with what was shown at the last MOVE, never with the release
// event's own coordinates: on a touchscreen the finger drifts as it lifts off
// the glass, which would change the throw at the last instant, after the
// player had already set it by eye.
function endSwipe(e) {
  if (!isHoldPointer(e)) return;
  swipe.active = false;
  if (swipe.cancelling) {
    const pulledDown = swipe.last === null && Math.hypot(swipe.x - swipe.x0, swipe.y - swipe.y0) >= MIN_SWIPE_PX;
    phase = 'swipe';
    aim.yaw = 0;
    aim.power = 0;
    if (pulledDown) showToast('Drag away from you', 'Up the screen, toward the islands');
    return;
  }
  throwPlane();
}
canvas.addEventListener('pointerup', endSwipe);
canvas.addEventListener('pointercancel', (e) => {
  if (isHoldPointer(e)) {
    swipe.active = false;
    phase = 'swipe';
    aim.yaw = 0;
    aim.power = 0;
  }
});

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space' && !e.repeat) {
    e.preventDefault();
    if (phase === 'angle') lockAngle();
    else if (phase === 'result') returnToAim();
  }
  if (e.code === 'Backspace' || e.code === 'KeyA') repickAngle();
  if (['Digit1', 'Digit2', 'Digit3'].includes(e.code) && ['angle', 'swipe', 'result'].includes(phase)) selectPlane(PLANE_ORDER[+e.code.slice(5) - 1]);
  if (e.code === 'KeyR') resetView();
  if (e.code === 'KeyN') nextCourse(1);
});

// ---------------------------------------------------------------- aiming visuals
// The launch arrow in the world is the only direction indicator. There used to
// be a second one, a line on the screen tracing the raw drag; it duplicated the
// arrow and disagreed with it (the arrow shows the softened direction), so it
// was removed (Luke, 2026-09-29: "we don't need the smaller, lower one").

// The gauge: a side-on protractor from angleMin to angleMax. 0 deg is level,
// pointing right (the throw direction as seen from the side).
function buildGauge() {
  const R = 100;
  const a0 = THREE.MathUtils.degToRad(INPUT.angleMin);
  const a1 = THREE.MathUtils.degToRad(INPUT.angleMax);
  const pt = (a, r) => `${(Math.cos(a) * r).toFixed(1)} ${(-Math.sin(a) * r).toFixed(1)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  document.getElementById('gaugeArc').setAttribute('d', `M 0 0 L ${pt(a0, R)} A ${R} ${R} 0 ${large} 0 ${pt(a1, R)} Z`);
  const ticks = document.getElementById('gaugeTicks');
  ticks.innerHTML = '';
  for (let d = Math.ceil(INPUT.angleMin / 15) * 15; d <= INPUT.angleMax; d += 15) {
    const a = THREE.MathUtils.degToRad(d);
    const major = d % 30 === 0;
    ticks.insertAdjacentHTML('beforeend', `<line x1="${(Math.cos(a) * (major ? 84 : 90)).toFixed(1)}" y1="${(-Math.sin(a) * (major ? 84 : 90)).toFixed(1)}" x2="${(Math.cos(a) * R).toFixed(1)}" y2="${(-Math.sin(a) * R).toFixed(1)}" stroke="rgba(244,236,223,0.7)" stroke-width="${major ? 2 : 1}" />`);
  }
}
// No numbers on the gauge, by design (Luke, 2026-09-29): the angle is meant
// to be judged by eye from the needle, not read off a label.
function updateGauge(deg, locked) {
  const a = THREE.MathUtils.degToRad(deg);
  const n = document.getElementById('gaugeNeedle');
  n.setAttribute('x2', (Math.cos(a) * 95).toFixed(1));
  n.setAttribute('y2', (-Math.sin(a) * 95).toFixed(1));
  n.setAttribute('stroke', locked ? '#ffce3a' : '#f4ecdf');
  document.getElementById('angleValue').textContent = locked ? 'Locked' : '';
}
document.getElementById('repick').onclick = repickAngle;

// ---------------------------------------------------------------- UI
const $ = (id) => document.getElementById(id);
const toastEl = $('toast');
let toastTimer = null;

function showToast(title, sub) {
  toastEl.innerHTML = `${title}${sub ? `<small>${sub}</small>` : ''}`;
  toastEl.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), 2000);
}

function describeCourse(ch) {
  const t = ch.target;
  const h = t.height > 0.5 ? `${t.height.toFixed(0)} above you` : t.height < -0.5 ? `${(-t.height).toFixed(0)} below you` : 'level with you';
  return `Target ${t.distance.toFixed(0)} away, ${h}`;
}

function updateCourseBar() {
  const ch = current.challenge;
  const isRandom = ch.id.startsWith('random');
  $('courseName').textContent = isRandom ? ch.name : `${courseIndex + 1}/${CHALLENGES.length} · ${ch.name}`;
  $('courseSub').textContent = describeCourse(ch);
  const total = CHALLENGES.reduce((s, c) => s + (best[c.id] ?? 0), 0);
  $('scoreLine').textContent = `Best here: ${best[ch.id] ?? '-'} / 3  ·  Challenge total: ${total} / ${CHALLENGES.length * 3}`;
}

function nextCourse(delta) {
  courseIndex = (courseIndex + delta + CHALLENGES.length) % CHALLENGES.length;
  setCourse(CHALLENGES[courseIndex]);
  returnIfIdle();
}
function returnIfIdle() {
  if (phase === 'result') returnToAim();
}
$('prevCourse').onclick = () => nextCourse(-1);
$('nextCourse').onclick = () => nextCourse(1);
$('randomCourse').onclick = () => { setCourse(randomChallenge(randomSeed++)); returnIfIdle(); };
$('clearTrails').onclick = clearTrails;

// Plane cards: bars come straight from the stats, so they stay honest as the stats are tuned.
function calmRange(type) {
  let bestD = 0;
  for (let p = 0; p <= 60; p += 5) {
    const { outcome } = simulateThrow({
      origin: THROW_ORIGIN, velocity: launchVelocity(type, { yaw: 0, pitch: THREE.MathUtils.degToRad(p), power: 1 }),
      type, levers: LEVERS, wind: new THREE.Vector3(), dt: 1 / 60, maxTime: 30,
      testSegment: (a, b) => (b.y < -3 ? { type: 'floor', point: b.clone() } : null),
    });
    bestD = Math.max(bestD, -outcome.point.z);
  }
  return bestD;
}
// The picker starts open, so a new player sees the three options and reads
// them. Choosing a plane collapses it to a chip, and it stays out of the way of
// the throw until the chip is tapped. Tapping the scene collapses it too.
let pickerOpen = true;
const pickerEl = document.getElementById('picker');
function setPickerOpen(open) {
  pickerOpen = open;
  pickerEl.classList.toggle('collapsed', !open);
}
const canPick = () => ['angle', 'swipe', 'result'].includes(phase);

function renderPicker() {
  const el = pickerEl;
  el.innerHTML = '';
  const cur = STATS[selected];
  const chip = document.createElement('div');
  chip.id = 'pickerChip';
  chip.innerHTML = `<span class="swatch" style="background:#${cur.color.toString(16).padStart(6, '0')}"></span>${cur.label}<small>${pickerOpen ? 'pick a plane' : 'tap to change'}</small>`;
  chip.onclick = () => { if (canPick()) { setPickerOpen(!pickerOpen); renderPicker(); } };
  el.appendChild(chip);
  // The stack is column-reverse (chip at the bottom), so cards go in backwards
  // to read dart, all-rounder, glider from the top down.
  [...PLANE_ORDER].reverse().forEach((kind) => {
    const i = PLANE_ORDER.indexOf(kind);
    const s = STATS[kind];
    const range = calmRange(s);
    const bars = [
      ['Range', Math.min(1, range / 130)],
      ['Wind grip', Math.max(0, 1 - s.windPush)],
    ];
    // only meaningful when the per-plane trajectory guide is in use
    if (LEVERS.guide === 'plane') bars.push(['Aim guide', Math.min(1, s.guideSeconds / 1.6)]);
    const card = document.createElement('div');
    card.className = `card${kind === selected ? ' sel' : ''}`;
    card.innerHTML = `
      <div class="name"><span class="swatch" style="background:#${s.color.toString(16).padStart(6, '0')}"></span>${s.label}<span class="key">${i + 1}</span></div>
      <div class="tag">${s.tagline}</div>
      ${bars.map(([n, f]) => `<div class="bar"><span>${n}</span><i><b style="width:${(f * 100).toFixed(0)}%"></b></i></div>`).join('')}`;
    card.onclick = () => { if (canPick()) selectPlane(kind); };
    el.appendChild(card);
  });
  el.classList.toggle('collapsed', !pickerOpen);
}
function selectPlane(kind, { collapse = true } = {}) {
  selected = kind;
  if (collapse) setPickerOpen(false);
  if (phase === 'result') returnToAim();
  for (const k of PLANE_ORDER) planeMeshes[k].visible = k === kind && phase !== 'flying';
  guideKey = '';
  renderPicker();
}

function updateWindHud() {
  const hud = $('windHud');
  hud.style.display = VIEW.windHud ? 'block' : 'none';
  if (!VIEW.windHud || !current) return;
  const w = courseWind();
  const s = w.length();
  // 0 deg = blowing away from the player, i.e. an up arrow on screen
  $('windArrow').style.transform = `rotate(${current.challenge.wind.dir}deg)`;
  $('windArrow').style.opacity = s < 0.05 ? 0.25 : 1;
  $('windText').textContent = s < 0.05 ? 'Calm' : `Wind ${s.toFixed(1)}`;
}

// ---------------------------------------------------------------- levers panel
const LEVER_SPEC = [
  ['h', 'Flight model'],
  ['liftDirection', 'select', ['perpendicular', 'vertical'], 'Lift direction', 'Perpendicular: swoops and glides, and can never add energy. Vertical: floatier, more arcade.'],
  ['profileExponent', 'range', [0, 3, 0.5], 'Profile effect (cos^n)', 'Your vertical-profile idea: steep climbs and dives get less lift. 0 = off.'],
  ['liftCapG', 'range', [0, 3, 0.1], 'Lift cap (x gravity)', 'Stops loops from hard throws. 0 = uncapped.'],
  ['stability', 'range', [0, 4, 0.25], 'Swoop damping', '0 = raw porpoising glides; about 2 settles quickly into a glide.'],
  ['h', 'Wind'],
  ['windMode', 'select', ['both', 'air', 'push'], 'Wind mode', 'Air: headwind/tailwind change airspeed. Push: a direct shove by each plane’s wind stat. Both: both.'],
  ['windScale', 'range', [0, 3, 0.1], 'Wind strength x', 'Scales every course’s wind.'],
  ['pushStrength', 'range', [0, 2, 0.05], 'Push strength', 'How fast a light plane is dragged up to wind speed.'],
  ['launchWithWind', 'check', null, 'Throws start at air speed', 'Tailwinds always help and headwinds always hurt. Off = stricter physics, where a tailwind can shorten a glide.'],
  ['gusts', 'range', [0, 1, 0.05], 'Gusts', 'Smooth random wind wobble, scaled by each plane’s wind stat.'],
  ['h', 'Aiming'],
  ['guide', 'select', ['arrow', 'plane', 'full', 'off'], 'Aim guide', 'Arrow: the launch arrow only. Plane/Full: the arrow plus the predicted path while holding (plane: its length depends on the plane). Off: nothing at all.'],
  ['guideIncludesWind', 'check', null, 'Path guide includes wind', 'Only affects the Plane and Full guides. Off means the flag is the only way to read the wind.'],
];
const INPUT_SPEC = [
  ['h', 'Input'],
  ['angleSweepSeconds', 'range', [0.4, 3, 0.1], 'Angle sweep time (s)', 'Time for the needle to travel from lowest to highest. Shorter is harder to time.'],
  ['angleSweepShape', 'select', ['triangle', 'sine'], 'Angle sweep shape', 'Triangle: constant speed. Sine: lingers at the ends, so extreme angles are easier to hit than middle ones.'],
  ['angleMin', 'range', [-30, 20, 5], 'Lowest angle', ''],
  ['angleMax', 'range', [30, 85, 5], 'Highest angle', ''],
  ['swipeFullPower', 'range', [0.15, 0.9, 0.05], 'Drag length for full power', 'As a fraction of the screen’s shorter side.'],
  ['yawSensitivity', 'range', [0.3, 1, 0.05], 'Direction softening', '1 = the throw turns exactly as much as your drag. Lower = a wobble of the hand moves the throw less.'],
  ['yawDeadzoneDeg', 'range', [0, 10, 0.5], 'Straight-ahead dead zone (°)', 'Drags this close to straight up count as exactly straight.'],
  ['maxYawDeg', 'range', [15, 80, 5], 'Max left/right (°)', 'Largest throw angle. With softening below 1, a fully sideways drag may not reach it.'],
];
const VIEW_SPEC = [
  ['h', 'View'],
  ['camera', 'select', ['chase', 'fixed'], 'Camera', ''],
  ['timeOfDay', 'range', [0, 1, 0.05], 'Time of day', '0 dawn · 0.5 noon · 1 dusk (arrival at the temple).'],
  ['cloudsShowWind', 'check', null, 'Clouds drift with the wind', ''],
  ['windHud', 'check', null, 'Show wind numbers', 'For testing. The flag is meant to be the cue.'],
  ['flightSlowdown', 'range', [0, 60, 5], 'Slow the flight (%)', 'Slow-motion so it is easier to watch. 60 = 40% of normal speed. Never changes where a throw lands.'],
  ['arrowLength', 'range', [4, 22, 1], 'Launch arrow length', 'Length at full power. Shorter arrows are easier to keep on screen.'],
  ['playback', 'range', [0.5, 3, 0.25], 'Flight playback speed', 'The base speed the slow-down is taken from.'],
  ['failSpeedup', 'range', [1, 10, 0.5], 'Speed-up once clearly missed', 'A throw that can no longer reach any island plays this many times faster. 1 = off.'],
];
const STAT_SPEC = [
  ['speedMin', [2, 30, 0.5], 'Speed at 0% power'],
  ['speedMax', [4, 35, 0.5], 'Speed at 100% power'],
  ['lift', [0, 0.15, 0.002], 'Lift'],
  ['drag', [0, 0.02, 0.0005], 'Drag'],
  ['windPush', [0, 2, 0.05], 'Wind susceptibility'],
  ['guideSeconds', [0, 3, 0.05], 'Aim guide length (s)'],
];

function control(obj, key, type, arg, label, why, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'lever';
  const val = () => (type === 'range' ? (+obj[key]).toFixed(arg[2] < 0.01 ? 4 : arg[2] < 0.1 ? 3 : 2) : '');
  let input;
  if (type === 'select') {
    input = document.createElement('select');
    for (const o of arg) input.add(new Option(o, o));
    input.value = obj[key];
    input.onchange = () => { obj[key] = input.value; onChange(); };
  } else if (type === 'check') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = obj[key];
    input.onchange = () => { obj[key] = input.checked; onChange(); };
  } else {
    input = document.createElement('input');
    input.type = 'range';
    [input.min, input.max, input.step] = arg;
    input.value = obj[key];
    input.oninput = () => { obj[key] = +input.value; wrap.querySelector('.v').textContent = val(); onChange(); };
  }
  wrap.innerHTML = `<div class="top"><b>${label}</b><span class="v">${val()}</span></div>`;
  wrap.appendChild(input);
  if (why) wrap.insertAdjacentHTML('beforeend', `<div class="why">${why}</div>`);
  return wrap;
}

function onPhysicsChange() {
  guideKey = '';
  applyWindCues();
  renderPicker();
}
function onViewChange() {
  backdrop.setTimeOfDay(VIEW.timeOfDay);
  applyWindCues();
}
function onInputChange() {
  if (INPUT.angleMax <= INPUT.angleMin) INPUT.angleMax = INPUT.angleMin + 5;
  buildGauge();
}

function buildLeversPanel() {
  const body = $('leversBody');
  body.innerHTML = '';
  for (const [spec, target, onChange] of [[INPUT_SPEC, INPUT, onInputChange], [LEVER_SPEC, LEVERS, onPhysicsChange], [VIEW_SPEC, VIEW, onViewChange]]) {
    for (const s of spec) {
      if (s[0] === 'h') { body.insertAdjacentHTML('beforeend', `<h4>${s[1]}</h4>`); continue; }
      body.appendChild(control(target, s[0], s[1], s[2], s[3], s[4], onChange));
    }
  }
  body.insertAdjacentHTML('beforeend', '<h4>Plane stats</h4>');
  for (const kind of PLANE_ORDER) {
    const d = document.createElement('details');
    d.innerHTML = `<summary>${STATS[kind].label}</summary>`;
    for (const [key, arg, label] of STAT_SPEC) d.appendChild(control(STATS[kind], key, 'range', arg, label, '', onPhysicsChange));
    body.appendChild(d);
  }
  const btns = document.createElement('div');
  btns.className = 'btns';
  const copy = document.createElement('button');
  copy.textContent = 'Copy settings';
  copy.onclick = async () => {
    const json = JSON.stringify({ input: INPUT, levers: LEVERS, view: VIEW, stats: STATS }, null, 2);
    try { await navigator.clipboard.writeText(json); showToast('Settings copied', 'Paste them to Claude to bake in'); }
    catch { console.log(json); showToast('Copy failed', 'Printed to the console instead'); }
  };
  const reset = document.createElement('button');
  reset.className = 'ghost';
  reset.textContent = 'Reset to defaults';
  reset.onclick = () => {
    Object.assign(INPUT, INPUT_DEFAULTS);
    Object.assign(LEVERS, LEVER_DEFAULTS);
    Object.assign(VIEW, VIEW_DEFAULTS);
    for (const k of PLANE_ORDER) Object.assign(STATS[k], DEFAULT_STATS[k]);
    buildLeversPanel();
    onInputChange();
    onPhysicsChange();
    onViewChange();
  };
  btns.append(copy, reset);
  body.appendChild(btns);
}

// ---------------------------------------------------------------- loop
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  guideMat.resolution.set(innerWidth, innerHeight);
  for (const t of trails) t.trail.resize();
});

setCourse(CHALLENGES[0]);
buildLeversPanel();
buildGauge();
selectPlane(selected, { collapse: false }); // starts open; see pickerOpen

const HINTS = {
  angle: 'Tap to lock the launch angle',
  swipe: 'Press and hold, then drag up: the arrow is your throw',
  swiping: 'Release to throw · drag back to the start to cancel',
};
const clock = new THREE.Timer();
function tick(time) {
  clock.update(time);
  const dt = Math.min(clock.getDelta(), 0.05);

  const aiming = phase === 'angle' || phase === 'swipe' || phase === 'swiping';
  if (phase === 'angle') {
    sweepT += dt;
    aim.pitch = THREE.MathUtils.degToRad(sweepAngleDeg());
    aim.yaw = 0;
    aim.power = 0;
  }
  if (phase === 'swipe') { aim.yaw = 0; aim.power = 0; }
  $('angleGauge').classList.toggle('hidden', !aiming);
  $('repick').style.display = phase === 'swipe' ? 'block' : 'none';
  $('hint').textContent = HINTS[phase] ?? '';
  if (aiming) {
    updateGauge(THREE.MathUtils.radToDeg(aim.pitch), phase !== 'angle');
    const mesh = planeMeshes[selected];
    mesh.visible = true;
    mesh.position.copy(THROW_ORIGIN);
    orientAlong(mesh, launchVelocity(STATS[selected], aim));
    updateGuide();
    // Words only. Direction and power are read off the arrow (Luke,
    // 2026-09-29: remove the numbers from the readout; remove the power bar).
    $('aimReadout').textContent = phase === 'swiping' && swipe.cancelling ? 'Releasing now cancels' : '';
  } else {
    $('aimReadout').textContent = '';
    updateGuide();
  }
  if (phase === 'flying') updateFlight(dt);
  if (phase === 'result') {
    resultTimer -= dt;
    if (resultTimer <= 0) returnToAim();
  }

  flag.update(dt);
  updateCamera(dt);
  backdrop.update(dt, camera);
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// dev-only handle for automated checks: throwWith() skips the input entirely
// and fires an exact aim, for comparing against scripts/throwFindAim.mjs.
window.__throw = {
  get phase() { return phase; }, get current() { return current; }, aim, INPUT, LEVERS, STATS, VIEW,
  get flight() { return flight ? { t: flight.state.t, speedupAt: flight.speedupAt } : null; },
  get pickerOpen() { return pickerOpen; },
  throwWith(a) { Object.assign(aim, a); throwPlane(); },
};
