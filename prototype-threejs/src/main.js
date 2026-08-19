/**
 * Sky Path — multiplane diorama test.
 *
 * The point of this prototype is to answer three questions on a real phone:
 *   1. Does the flat-panels-in-3D "puppet theatre" look actually read?
 *   2. Does it hold a smooth frame rate on a mid-range Android?
 *   3. How fast does it load cold?
 *
 * Everything visible is a flat panel with a painted-on dark edge. The only
 * things that are lit or cast shadows are the ground, the figure and the
 * pillar — that inter-layer shadow is what sells the diorama.
 */

import * as THREE from 'three';

const T_START = performance.now();

// ---------------------------------------------------------------- geometry of the path
//
// The path artwork is a 1024px square laid flat on the ground. These two
// helpers convert a pixel position in that artwork to a world position, so
// waypoints stay in sync with the texture if the art is redrawn.

const GROUND = 14; // world units per side of the ground plane
const px2x = (X) => (X / 1024 - 0.5) * GROUND;
const px2z = (Y) => -GROUND / 2 + (Y / 1024) * GROUND;

const FORK = { x: px2x(512), z: px2z(560) };

const TRUNK = [
  { x: px2x(512), z: px2z(1000) },
  { x: px2x(512), z: px2z(880) },
  { x: px2x(512), z: px2z(760) },
  { x: px2x(512), z: px2z(640) },
  FORK,
];

const branch = (tipX) => {
  const tip = { x: px2x(tipX), z: px2z(96) };
  return [0.34, 0.67, 1].map((t) => ({
    x: FORK.x + (tip.x - FORK.x) * t,
    z: FORK.z + (tip.z - FORK.z) * t,
  }));
};

const BRANCH = { left: branch(172), right: branch(852) };

// Five forks make up the journey. The correct side varies per fork so the
// guide/player mechanic actually gets exercised five times, not once.
const ROUNDS = 5;
const CORRECT_BY_FORK = ['left', 'right', 'left', 'right', 'left'];

// The ground is one hand-painted tile (GROUND units tall) that isn't drawn to
// tile seamlessly — round 2 onward is the same art translated one full tile
// further away (-z). The seam where tiles meet will be visible; that's an
// accepted placeholder trade-off for now, not a bug. TRUNK/FORK/BRANCH above
// are round 0's pattern; every other round is that same pattern shifted.
const shiftPt = (p, k) => ({ x: p.x, z: p.z - k * GROUND });
const trunkFor = (k) => TRUNK.map((p) => shiftPt(p, k));
const branchFor = (k, side) => BRANCH[side].map((p) => shiftPt(p, k));
const forkFor = (k) => shiftPt(FORK, k);

// Fork 1 = dawn, fork 3 = midday, fork 5 = dusk; 2 and 4 sit in between.
// This is also the sun's position parameter: 0 = dawn horizon, 1 = dusk horizon.
const TIME_OF_DAY = [0, 0.25, 0.5, 0.75, 1];
const TIME_LABEL = ['Dawn', 'Morning', 'Midday', 'Afternoon', 'Dusk'];

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
function pathLength(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
}

// ---------------------------------------------------------------- renderer / scene

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x1d3f66, 1);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xbcd8ea, 24, 115);

const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 400);

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
  key.position.set(-Math.cos(angle) * R, BASE_Y + Math.sin(angle) * H, 6);

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
const TINT_DAWN = new THREE.Color(0xcf8a5e);
const TINT_NOON = new THREE.Color(0xffffff);
const TINT_DUSK = new THREE.Color(0xc4795a);
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
const bar = document.querySelector('#bar > i');

manager.onProgress = (_url, loaded, total) => {
  bar.style.width = `${Math.round((loaded / total) * 100)}%`;
};

const tex = (name, { repeatWrap = false, ext = 'png' } = {}) => {
  const t = loader.load(`textures/${name}.${ext}`);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  if (repeatWrap) t.wrapS = THREE.RepeatWrapping;
  return t;
};

const TEX = {
  // Real art test (Option B): one wide dawn→noon→dusk strip, panned via UV
  // offset instead of tinted, since it already carries its own colour grading.
  skyStrip: tex('sky-strip', { ext: 'webp' }),
  cloudReal: tex('cloud-real'),
  cloud2: tex('cloud-2'),
  cloud3: tex('cloud-3'),
  peaks: tex('peaks', { repeatWrap: true }),
  cloudDeck: tex('cloud-deck', { repeatWrap: true }),
  cloudsFar: tex('clouds-far', { repeatWrap: true }),
  cloudsMid: tex('clouds-mid', { repeatWrap: true }),
  path: tex('path'),
  figure: tex('figure'),
  pillar: tex('pillar'),
  safe: tex('marker-safe'),
  hazard: tex('marker-hazard'),
};

// ---------------------------------------------------------------- panel helpers

/**
 * An unlit flat panel. Used for every distant layer — sky, peaks, cloud banks.
 * Unlit keeps the poster-flat look and costs almost nothing to draw.
 */
function backdrop(map, { w, h, x = 0, y = 0, z, order, fog = true, opacity = 1, tint = true }) {
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
  scene.add(mesh);
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
function cutout(map, { w, h, x = 0, y = 0, z, castShadow = true }) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({
      map,
      transparent: true,
      alphaTest: 0.45,
      side: THREE.DoubleSide,
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
 * A cloud deck: a flat panel lying horizontally far below the path. Seen edge-on
 * from above it reads as an endless floor of cloud, which is what actually
 * conveys "we are very high up" — vertical cloud panels just look like walls.
 */
function deck(map, { w, d, y, z, repeat, order, opacity }) {
  const m = map.clone();
  m.needsUpdate = true;
  m.wrapS = m.wrapT = THREE.RepeatWrapping;
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
  scene.add(mesh);
  atmosphereMaterials.push(mesh.material);
  return mesh;
}

// Sizing note: with a 52° vertical field of view, a panel at distance D spans
// a frame roughly 0.98 * D tall. So a distant layer that should read as a thin
// band near the horizon has to be *small* relative to its distance — getting
// this wrong is what turns a sky into a white floor.

// The sky strip is one wide dawn→noon→dusk image; only a third of it is
// visible at once (repeat.x = 1/3), and offset.x pans across it as sunP goes
// 0→1. tint:false because the art already carries the correct colour grading
// — multiplying a day-cycle tint over it would double the effect.
TEX.skyStrip.wrapS = THREE.ClampToEdgeWrapping;
TEX.skyStrip.repeat.set(1 / 3, 1);
const sky = backdrop(TEX.skyStrip, { w: 460, h: 330, y: -4, z: -170, order: 0, fog: false, tint: false });
backdrop(TEX.peaks, { w: 190, h: 17, y: -1.5, z: -118, order: 1, fog: false, opacity: 0.75 });

// soft band of cloud along the horizon, hiding where the decks run out
const horizonBank = backdrop(TEX.cloudsFar, { w: 200, h: 11, y: -2.5, z: -100, order: 2, fog: false, opacity: 0.9 });

// Two cloud decks lying flat, a long way down. Because they are far below, they
// only occupy a band near the horizon — the open blue between them and the path
// is what actually conveys height.
// Both decks stop well short of the camera. Leaving open blue immediately below
// the path is the difference between "suspended over a void" and "standing on a
// white floor" — a deck that runs under your feet just reads as ground.
const deckDeep = deck(TEX.cloudDeck, { w: 1800, d: 1200, y: -95, z: -800, repeat: [18, 12], order: 3, opacity: 0.55 });
const deckHigh = deck(TEX.cloudDeck, { w: 900, d: 620, y: -40, z: -390, repeat: [11, 8], order: 4, opacity: 0.75 });

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
  scene.add(row);
  cloudRows.push(row);
}

// The ground: the path artwork laid flat, alpha-cut so there is nothing but
// sky either side of it, repeated once per round (see shiftPt above) so the
// avatar can walk the whole 5-fork journey without ever resetting position.
const groundMat = new THREE.MeshLambertMaterial({ map: TEX.path, transparent: true, alphaTest: 0.4 });
for (let k = 0; k < ROUNDS; k++) {
  const seg = new THREE.Mesh(new THREE.PlaneGeometry(GROUND, GROUND), groundMat);
  seg.rotation.x = -Math.PI / 2;
  seg.position.z = -k * GROUND;
  seg.receiveShadow = true;
  seg.renderOrder = 6;
  scene.add(seg);
}

// Props beside the path, purely to throw shadows across the stones — one pair
// per fork, offset the same way as the fork itself.
for (let k = 0; k < ROUNDS; k++) {
  const fz = forkFor(k).z;
  cutout(TEX.pillar, { w: 1.0, h: 2.6, x: 1.55, z: fz + (3.6 - FORK.z) });
  cutout(TEX.pillar, { w: 0.85, h: 2.2, x: -1.5, z: fz + (1.2 - FORK.z) });
}

// The avatar.
const figure = cutout(TEX.figure, { w: 1.26, h: 2.2, x: TRUNK[0].x, z: TRUNK[0].z });

// Guide-only overlay: which branch is safe, which is not. One pair per fork
// (they sit at different world positions now that the path is continuous),
// but only the pair at the fork currently being decided is ever visible —
// updateMarkers() below enforces that, called from refreshUI().
const markerSets = [];
for (let k = 0; k < ROUNDS; k++) {
  const set = {};
  for (const side of ['left', 'right']) {
    const at = branchFor(k, side)[0];
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(1.15, 1.15),
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, fog: false })
    );
    m.position.set(at.x, 1.5, at.z);
    m.renderOrder = 9;
    m.visible = false;
    scene.add(m);
    set[side] = m;
  }
  markerSets.push(set);
}
function updateMarkers() {
  const showCurrent = !leg && !finished && role === 'guide';
  markerSets.forEach((set, idx) => {
    const correct = CORRECT_BY_FORK[idx];
    set.left.material.map = correct === 'left' ? TEX.safe : TEX.hazard;
    set.right.material.map = correct === 'right' ? TEX.safe : TEX.hazard;
    set.left.material.needsUpdate = true;
    set.right.material.needsUpdate = true;
    const visible = showCurrent && idx === forkIndex - 1;
    set.left.visible = visible;
    set.right.visible = visible;
  });
}

// ---------------------------------------------------------------- state
//
// There is no manual "step" anymore. Choosing left/right triggers one
// automatic walk that covers the branch and continues straight into the next
// round's trunk (trunkFor/branchFor above), landing at the next fork. The
// figure's position never jumps — it just keeps walking further down the
// (repeated) ground. sunP is driven by how far along that walk the figure has
// travelled, so the sky changes continuously rather than snapping at each fork.

const WALK_SPEED = 3.2; // world units / second

let forkIndex = 1; // 1..ROUNDS — the fork currently awaiting a decision
let finished = false;
let correctCount = 0;
let role = 'guide';
let sunP = TIME_OF_DAY[0];

// leg: the walk currently in progress, or null while awaiting a decision.
let leg = null;

function makeLeg(queue, realPoints, fromP, toP, arriveFork) {
  return { queue, total: pathLength(realPoints), traveled: 0, fromP, toP, arriveFork };
}

function introLeg() {
  const pts = trunkFor(0).slice(1);
  return makeLeg(pts.slice(), [figure.position, ...pts], TIME_OF_DAY[0], TIME_OF_DAY[0], 1);
}

leg = introLeg();

// ---------------------------------------------------------------- controls

const els = {
  left: document.getElementById('left'),
  right: document.getElementById('right'),
  reset: document.getElementById('reset'),
  role: document.getElementById('role'),
  hint: document.getElementById('hint'),
  hud: document.getElementById('hud'),
};

function refreshUI() {
  updateMarkers();
  const walking = !!leg;
  els.left.classList.toggle('hidden', walking || finished);
  els.right.classList.toggle('hidden', walking || finished);
  els.reset.classList.toggle('hidden', !finished);

  if (finished) {
    els.hint.textContent = `Journey complete — ${correctCount} of ${ROUNDS} crossings were safe.`;
  } else if (walking) {
    els.hint.textContent = 'Walking to the next fork…';
  } else {
    const label = TIME_LABEL[forkIndex - 1];
    els.hint.textContent =
      role === 'guide'
        ? `Fork ${forkIndex} of ${ROUNDS} (${label}) — you can see which way is safe.`
        : `Fork ${forkIndex} of ${ROUNDS} (${label}) — a junction. You cannot see which way is safe.`;
  }
}

const choose = (side) => () => {
  if (leg || finished) return;
  if (side === CORRECT_BY_FORK[forkIndex - 1]) correctCount++;

  const roundIdx = forkIndex - 1;
  const branchPts = branchFor(roundIdx, side);
  const queue = branchPts.slice();
  const realPoints = [figure.position.clone(), ...branchPts];

  if (forkIndex < ROUNDS) {
    const nextTrunk = trunkFor(roundIdx + 1);
    queue.push(...nextTrunk);
    realPoints.push(...nextTrunk);
    leg = makeLeg(queue, realPoints, TIME_OF_DAY[forkIndex - 1], TIME_OF_DAY[forkIndex], forkIndex + 1);
  } else {
    leg = makeLeg(queue, realPoints, TIME_OF_DAY[forkIndex - 1], TIME_OF_DAY[forkIndex - 1], null);
  }
  refreshUI();
};
els.left.addEventListener('click', choose('left'));
els.right.addEventListener('click', choose('right'));

els.reset.addEventListener('click', () => {
  forkIndex = 1;
  finished = false;
  correctCount = 0;
  figure.position.set(TRUNK[0].x, figure.position.y, TRUNK[0].z);
  leg = introLeg();
  refreshUI();
});

els.role.addEventListener('click', () => {
  role = role === 'guide' ? 'player' : 'guide';
  els.role.dataset.role = role;
  els.role.textContent = role === 'guide' ? 'Guide view' : 'Player view';
  refreshUI();
});

// Drag to look. This is the clearest demonstration of the multiplane effect on
// a touch screen — the layers shift against each other by real parallax.
const look = { x: 0, y: 0, tx: 0, ty: 0 };
let dragging = null;

renderer.domElement.addEventListener('pointerdown', (e) => {
  dragging = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: look.tx, oy: look.ty };
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!dragging || dragging.id !== e.pointerId) return;
  const s = 6 / window.innerWidth;
  look.tx = THREE.MathUtils.clamp(dragging.ox + (e.clientX - dragging.x) * s, -2.2, 2.2);
  look.ty = THREE.MathUtils.clamp(dragging.oy - (e.clientY - dragging.y) * s, -0.7, 1.3);
});
const endDrag = () => { dragging = null; };
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);

// ---------------------------------------------------------------- loop

let fps = 0;
let frames = 0;
let fpsClock = performance.now();
let loadMs = null;

manager.onLoad = () => {
  loadMs = Math.round(performance.now() - T_START);
  document.getElementById('loader').classList.add('done');
  refreshUI();
};

const timer = new THREE.Timer();

function tick() {
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.05);
  const t = timer.getElapsed();

  // avatar: walk the current leg's waypoint queue at a constant speed, never
  // jumping — each leg's waypoints continue straight into the next round's
  // trunk (see choose() below). sunP tracks how far through the leg we are,
  // so the sky changes smoothly as the figure walks rather than snapping.
  if (leg) {
    const head = leg.queue[0];
    if (head) {
      const dx = head.x - figure.position.x;
      const dz = head.z - figure.position.z;
      const distToHead = Math.hypot(dx, dz);
      const moveAmount = Math.min(distToHead, WALK_SPEED * dt);
      if (distToHead > 1e-4) {
        figure.position.x += (dx / distToHead) * moveAmount;
        figure.position.z += (dz / distToHead) * moveAmount;
      }
      leg.traveled += moveAmount;
      if (distToHead <= moveAmount + 1e-4) {
        figure.position.x = head.x;
        figure.position.z = head.z;
        leg.queue.shift();
      }
    }

    const p = leg.total > 0 ? THREE.MathUtils.clamp(leg.traveled / leg.total, 0, 1) : 1;
    sunP = THREE.MathUtils.lerp(leg.fromP, leg.toP, p);

    if (leg.queue.length === 0) {
      sunP = leg.toP;
      if (leg.arriveFork) forkIndex = leg.arriveFork;
      else finished = true;
      leg = null;
      refreshUI();
    }
  }
  figure.position.y = 1.1 + Math.sin(t * 2.1) * 0.035;
  applySun(sunP);
  applyAtmosphere(sunP);
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
  const recycleBehind = figure.position.z + CAM_BACK + 12;
  for (let i = 0; i < cloudRows.length; i++) {
    const row = cloudRows[i];
    row.position.x = Math.sin(t * 0.05 + i * 1.7) * 2.5;
    while (row.position.z > recycleBehind) row.position.z -= CLOUD_SPAN;
  }

  // camera: trails the avatar, plus the drag offset, eased
  look.x += (look.tx - look.x) * Math.min(1, dt * 4);
  look.y += (look.ty - look.y) * Math.min(1, dt * 4);

  camera.position.set(
    figure.position.x * 0.4 + look.x,
    3.9 + look.y + Math.sin(t * 0.6) * 0.05,
    figure.position.z + CAM_BACK
  );
  camera.lookAt(figure.position.x * 0.45, 1.25, figure.position.z - 4.6);

  key.target.position.set(figure.position.x, 0, figure.position.z);

  renderer.render(scene, camera);

  frames++;
  const now = performance.now();
  if (now - fpsClock >= 500) {
    fps = Math.round((frames * 1000) / (now - fpsClock));
    frames = 0;
    fpsClock = now;
    els.hud.innerHTML =
      `<b>${fps}</b> fps · ${window.innerWidth}×${window.innerHeight} @${renderer.getPixelRatio().toFixed(1)}x` +
      (loadMs === null ? '' : ` · loaded <b>${loadMs}</b> ms`);
  }

  requestAnimationFrame(tick);
}
tick();

// Debug hook: render and hand back a PNG, used to inspect the scene headlessly.
// Dev only — stripped from the production bundle.
if (import.meta.env.DEV) {
  window.__capture = () => {
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/png');
  };
  window.__tick = tick;
  window.__state = () => ({ forkIndex, finished, walking: !!leg, sunP, correctCount });
  window.__figureZ = () => figure.position.z;
  window.__cloudRows = () => cloudRows.map((r) => +r.position.z.toFixed(2));
  window.__markers = () => markerSets.map((s) => ({ leftVisible: s.left.visible, rightVisible: s.right.visible }));
  window.__atmos = () => ({
    skyTint: atmosphereMaterials[0].color.getHexString(),
    clear: renderer.getClearColor(new THREE.Color()).getHexString(),
    fog: scene.fog.color.getHexString(),
    keyColor: key.color.getHexString(),
    keyIntensity: key.intensity,
    keyPos: key.position.toArray(),
    skyOffsetX: sky.material.map.offset.x,
  });
}

// ---------------------------------------------------------------- resize

addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});
