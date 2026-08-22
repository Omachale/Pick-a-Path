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
 * pillars — that inter-layer shadow is what sells the diorama.
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

// Rapier ships as WASM and needs an async init before any RAPIER.* class can
// be used — everything below (including the wrong-turn fall physics) waits
// on this, same pattern as blow-trial.js.
await RAPIER.init();

const T_START = performance.now();

// ---------------------------------------------------------------- journey shape
//
// The path is generated as a chain of straight legs (a "trunk" leading to a
// fork, then a "branch" out of it) advancing from a running cursor of
// {x, z, heading}. heading 0 means "walking toward -Z", which is also the
// direction the temple sits in. Because the actual choice made at each fork
// determines the heading of everything downstream. Because the correct side
// at every fork is fixed in advance, the whole route can nonetheless be built
// before the player moves — see buildJourney() below.

const N_FORKS = 6; // fixed for a given round; would come from teacher setup in a real build
const FORK_HALF_ANGLE = THREE.MathUtils.degToRad(12); // each branch's turn off centre — kept tight so a run of same-direction picks can't build up a big drift
const HEADING_CORRECTION = 0.7; // fraction of heading drift straightened out during the trunk that follows a branch
const TRUNK_SEGMENTS = 4;
const BRANCH_SEGMENTS = 3;

// The temple's distance is the one dial that matters for pacing — everything
// below derives from it, so changing it doesn't require re-tuning trunk and
// branch lengths by hand. CRUISE_FRACTION is how much of that distance the
// N_FORKS ordinary forks cover; the gap between CRUISE_FRACTION and
// STOP_FRACTION is the dramatic final close-in walked only on a correct last
// pick (see choose()); the last (1 - STOP_FRACTION) is just clearance so the
// camera never ends up clipped into the temple's plane.
const TEMPLE_DISTANCE = 70; // straight-line world distance from spawn to the temple
const CRUISE_FRACTION = 0.75;
const STOP_FRACTION = 0.9;
const CRUISE_DISTANCE = TEMPLE_DISTANCE * CRUISE_FRACTION;
const APPROACH_DISTANCE = TEMPLE_DISTANCE * (STOP_FRACTION - CRUISE_FRACTION);

// Trunk:branch pacing shape (branch slightly longer than trunk) — only the
// ratio matters here, the absolute scale is fixed below by CRUISE_DISTANCE.
const ROUND_SHAPE_TRUNK = 6.0;
const ROUND_SHAPE_BRANCH = 6.5;
const ROUND_UNIT = ROUND_SHAPE_TRUNK + ROUND_SHAPE_BRANCH * Math.cos(FORK_HALF_ANGLE);
const ROUND_SCALE = CRUISE_DISTANCE / (N_FORKS * ROUND_UNIT);
const TRUNK_LEN = ROUND_SHAPE_TRUNK * ROUND_SCALE;
const BRANCH_LEN = ROUND_SHAPE_BRANCH * ROUND_SCALE;

// Correct side is randomised per fork — including runs of the same side
// (left,left,left,... etc). The heading-correction step above pulls the
// world-absolute heading back toward 0 after every fork regardless of which
// side was taken, so a same-direction streak damps out rather than
// compounding; nothing here assumes an alternating pattern.
//
// For testing a specific pattern (e.g. an all-left run to check how the path
// visuals handle a strong sideways veer), append ?forks=LLLRRR to the URL —
// one L/R per fork, case-insensitive, missing/extra forks fall back to
// random. Example: index.html?forks=LLLLLL
function genCorrectSequence() {
  const override = new URLSearchParams(location.search).get('forks');
  return Array.from({ length: N_FORKS }, (_, i) => {
    const forced = override?.[i]?.toUpperCase();
    if (forced === 'L') return 'left';
    if (forced === 'R') return 'right';
    return Math.random() < 0.5 ? 'left' : 'right';
  });
}
const CORRECT_BY_FORK = genCorrectSequence();

// Fork 1 = dawn, last fork = dusk, evenly spread between. Also doubles as the
// sun's position parameter: 0 = dawn horizon, 1 = dusk horizon.
function timeOfDay(forkIdx1) {
  return N_FORKS <= 1 ? 0.5 : (forkIdx1 - 1) / (N_FORKS - 1);
}
function timeLabel(p) {
  if (p < 0.15) return 'Dawn';
  if (p < 0.4) return 'Morning';
  if (p < 0.6) return 'Midday';
  if (p < 0.85) return 'Afternoon';
  return 'Dusk';
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
function pathLength(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
}

/** Unit-ish forward vector for a heading, scaled by d. heading 0 = -Z. */
function forward(heading, d) {
  return { x: Math.sin(heading) * d, z: -Math.cos(heading) * d };
}
function advance(pos, heading, d) {
  const f = forward(heading, d);
  return { x: pos.x + f.x, z: pos.z + f.z };
}
/** A straight run of `segments` waypoints from `from`, `len` total, along `heading`. */
function genStraight(from, heading, len, segments) {
  const pts = [];
  for (let i = 1; i <= segments; i++) pts.push(advance(from, heading, (len * i) / segments));
  return pts;
}
/** World position offset from a cursor by a lateral (right) and forward amount in its local frame. */
function localToWorld(cursor, right, fwd) {
  const f = forward(cursor.heading, fwd);
  const r = forward(cursor.heading + Math.PI / 2, right);
  return { x: cursor.x + f.x + r.x, z: cursor.z + f.z + r.z };
}

// ---------------------------------------------------------------- renderer / scene
//
// `powerPreference: 'high-performance'` forces the discrete GPU on hybrid-
// graphics laptops, which is the faster choice when it works but is also
// the option most likely to hit a blocklisted/misbehaving driver (seen in
// practice as Firefox's "Exhausted GL driver options" — it tried every
// ANGLE/EGL backend it knows and none of them would create a context for
// that GPU). Retry with progressively safer options rather than failing
// outright the first time a context can't be created, and if every attempt
// fails, replace the loading spinner with an actual message — silently
// hanging on "Loading sky path…" forever is a worse failure mode than a
// blunt error.
function createRenderer() {
  const attempts = [
    { antialias: true, powerPreference: 'high-performance' },
    { antialias: true }, // let the browser pick the GPU
    { antialias: false }, // antialiasing itself can be part of what's failing
    { antialias: false, failIfMajorPerformanceCaveat: false }, // accept a software/slow fallback rather than none
  ];
  let lastErr;
  for (const opts of attempts) {
    try {
      return new THREE.WebGLRenderer(opts);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

let renderer;
try {
  renderer = createRenderer();
} catch (err) {
  const loaderEl = document.getElementById('loader');
  if (loaderEl) {
    loaderEl.innerHTML =
      '<div style="max-width: 320px; text-align: center; line-height: 1.5;">' +
      "Your browser couldn't create a 3D graphics context, so this can't run here.<br><br>" +
      'Try: enabling hardware acceleration in your browser settings, updating your graphics drivers, or a different browser (Chrome/Edge tend to recover from this better than Firefox).' +
      '</div>';
  }
  throw err;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x1d3f66, 1);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();

// One mild atmospheric fog for both roles — purely for depth. Hiding the
// path ahead is no longer this fog's job: that's the curtain props standing
// at each junction (see makeCurtain), which is why there is no longer a
// per-role near/far swap here.
scene.fog = new THREE.Fog(0xbcd8ea, 24, 260);

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

const tex = (name, { repeatWrap = false, ext = 'png', linear = false, tile = false } = {}) => {
  const t = loader.load(`textures/${name}.${ext}`);
  // `linear` is for data textures (noise fields the shader does maths on)
  // rather than pictures — sRGB decoding would bend the value distribution
  // the shader is calibrated against.
  t.colorSpace = linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  if (repeatWrap) t.wrapS = THREE.RepeatWrapping;
  if (tile) t.wrapS = t.wrapT = THREE.RepeatWrapping;
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
  stoneA: tex('stone-a'),
  stoneB: tex('stone-b'),
  stoneC: tex('stone-c'),
  stoneD: tex('stone-d'),
  pillar: tex('pillar'),
  safe: tex('marker-safe'),
  hazard: tex('marker-hazard'),
  fogNoise: tex('fog-noise', { linear: true, tile: true }),
  fogPuff: tex('fog-puff'),
  temple: tex('temple', { ext: 'webp' }),
  gull1: tex('gull-1', { ext: 'webp' }),
  gull2: tex('gull-2', { ext: 'webp' }),
};

// ---------------------------------------------------------------- character roster
//
// Each character loads a single texture (the front-facing art).
// New characters just need an entry here — the selection screen and rig are
// both built from this list, not hardcoded to any one character.
const ROSTER = [
  { key: 'woman2', tex: 'figure-woman2', ext: 'webp' },
  { key: 'indy', tex: 'figure-indy', ext: 'png' },
];
const CHAR_TEX = {};
for (const c of ROSTER) {
  CHAR_TEX[c.key] = { front: tex(c.tex, { ext: c.ext }) };
}

// A small fixed palette rather than a free colour picker — every option here
// has been checked against the backing art, which a free picker couldn't
// guarantee (very low saturation, for instance, would wash out the fold
// shading the split preserves).
const PALETTE = [
  { key: 'blue', label: 'Blue', hex: 0x5a9fe0 },
  { key: 'red', label: 'Red', hex: 0xd9564a },
  { key: 'green', label: 'Green', hex: 0x5cb86c },
  { key: 'yellow', label: 'Yellow', hex: 0xe0b93c },
  { key: 'purple', label: 'Purple', hex: 0x9a6fd6 },
  { key: 'orange', label: 'Orange', hex: 0xe08a3c },
  { key: 'teal', label: 'Teal', hex: 0x3fb8b0 },
  { key: 'pink', label: 'Pink', hex: 0xe07fb0 },
];

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
function cutout(map, { w, h, x = 0, y = 0, z, castShadow = true, fog = true }) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({
      map,
      transparent: true,
      alphaTest: 0.45,
      side: THREE.DoubleSide,
      fog,
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

// The temple: a single flat billboard-style cut-out, planted at a fixed world
// position straight ahead. No manual scaling logic needed — a real
// perspective camera makes it grow on its own as the player gets closer.
// fog:false so it stays visible through the heavy player-side fog too; it's
// meant to be the one landmark you can always see.
// TODO: once the approach has more than one fork of buildup, add 2–3 layers
// of props in front of it (pillars, trees) for depth — flat single billboard
// is a deliberate placeholder for now.
// TODO: a ground-plane "approach" image — cobblestones/steps laid flat,
// perpendicular to the temple's own billboard, its near edge meeting the
// temple's base — for the player to walk onto for the last stretch.
// Source art was widened (2048x1112 -> 3686x1668: +80% width, +50% height —
// not a uniform scale). TEMPLE_H below is scaled by that same +50% height
// growth; TEMPLE_ASPECT is read straight from the new art, so width follows
// along at its own correct +80% automatically rather than needing a second
// constant to track.
const TEMPLE_ASPECT = 1024 / 463;
// Sized/placed so it starts noticeably large (~4x the frame-height fraction
// a "realistic" small building at this distance would read as) and fills
// nearly the whole frame by the final approach — measured directly in the
// browser and tuned by eye, not derived from the sizing-note formula above.
const TEMPLE_H = 13 * 1.5;
const temple = cutout(TEX.temple, {
  w: TEMPLE_H * TEMPLE_ASPECT,
  h: TEMPLE_H,
  x: 0,
  z: -TEMPLE_DISTANCE,
  castShadow: false,
  fog: false,
});
// The temple sits farther out (z=-200) than the sky panel (z=-170), so
// three.js's automatic back-to-front transparent sort draws it *before* the
// sky — and the sky, despite depthWrite:false, still depth-tests, so it then
// paints straight over it. Explicit renderOrder (higher than every backdrop
// layer above, 0-4) forces it to always draw after them regardless of distance.
temple.renderOrder = 4.5;

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

// The ground is built from small paving-stone instances dropped along the
// *actual* waypoints of the route — trunk, both branches of every fork, and
// the final approach (see scatterAlong, driven by buildJourney below) —
// rather than one rigid pre-shaped art tile. That's what makes it track the
// player's real turns exactly, at any heading, instead of approximating them.
//
// Four stone-cluster textures round-robin so it doesn't read as an obvious
// repeat. Each variant is one THREE.InstancedMesh — capped at a fixed
// capacity generous enough for a full playthrough — so however many hundred
// stones end up on screen, it's still only 4 draw calls, which matters for
// holding frame rate on the target phone.
const STONE_SIZE = 1.0; // world units, square
const STONE_COLS = 3; // stones across the path width
const PATH_WIDTH = 2.6;
const ROW_SPACING = STONE_SIZE * 0.83; // rows overlap along the direction of travel too, so no gaps
const STONE_CAPACITY = 200; // per variant — one playthrough's worth plus headroom

const FLATTEN_Q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const UP = new THREE.Vector3(0, 1, 0);
const stoneDummy = new THREE.Object3D();
const stoneYawQ = new THREE.Quaternion();

function makeStoneMesh(map) {
  const mesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(STONE_SIZE, STONE_SIZE),
    new THREE.MeshLambertMaterial({ map }),
    STONE_CAPACITY
  );
  mesh.count = 0;
  mesh.receiveShadow = true;
  mesh.renderOrder = 6;
  // Instances move via per-instance matrices, not this mesh's own transform,
  // which stays at the world origin forever — so THREE's default frustum
  // culling (built from the base geometry's tiny bounding sphere sitting at
  // that origin) culls the *entire* mesh the moment the origin itself drifts
  // out of view, even while individual instances near the camera are still
  // plainly on screen. Disabling culling is the fix; total instance count
  // here is modest enough that this costs nothing measurable.
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
}
const stoneMeshes = [TEX.stoneA, TEX.stoneB, TEX.stoneC, TEX.stoneD].map(makeStoneMesh);
let stoneVariant = 0; // round-robins which mesh gets the next stone

function placeStone(x, z) {
  const mesh = stoneMeshes[stoneVariant % stoneMeshes.length];
  stoneVariant++;
  if (mesh.count >= STONE_CAPACITY) return; // headroom exhausted — drop silently rather than throw
  stoneYawQ.setFromAxisAngle(UP, Math.random() * Math.PI * 2); // pavers don't need to face any particular way
  stoneDummy.quaternion.copy(stoneYawQ).multiply(FLATTEN_Q);
  stoneDummy.position.set(x, 0.01 + Math.random() * 0.01, z); // tiny y jitter avoids z-fighting between overlapping stones
  stoneDummy.updateMatrix();
  mesh.setMatrixAt(mesh.count, stoneDummy.matrix);
  mesh.count++;
  mesh.instanceMatrix.needsUpdate = true;
}

/**
 * Lays rows of stones along a chain of waypoints.
 *
 * `phase` is the distance walked since the last row was laid; it is passed in
 * and returned rather than kept in module scope because the path is no longer
 * one single chain. At a fork, *both* branches must start from the same phase
 * (so the two sides look symmetrical leaving the fork), while the correct
 * branch's end phase is what carries on into the trunk beyond it.
 */
function scatterAlong(fromPos, points, phase) {
  let prev = fromPos;
  let dSinceRow = phase;
  for (const pt of points) {
    const segLen = dist(prev, pt);
    if (segLen < 1e-6) { prev = pt; continue; }
    const ux = (pt.x - prev.x) / segLen;
    const uz = (pt.z - prev.z) / segLen;
    const nx = -uz;
    const nz = ux;
    let travelled = 0;
    while (dSinceRow + (segLen - travelled) >= ROW_SPACING) {
      travelled += ROW_SPACING - dSinceRow;
      const bx = prev.x + ux * travelled;
      const bz = prev.z + uz * travelled;
      for (let c = 0; c < STONE_COLS; c++) {
        const off = (c - (STONE_COLS - 1) / 2) * (PATH_WIDTH / STONE_COLS);
        const jitter = (Math.random() - 0.5) * 0.25;
        placeStone(bx + nx * (off + jitter), bz + nz * (off + jitter));
      }
      dSinceRow = 0;
    }
    dSinceRow += segLen - travelled;
    prev = pt;
  }
  return dSinceRow;
}

function resetGround() {
  for (const mesh of stoneMeshes) mesh.count = 0;
  stoneVariant = 0;
}

const pillars = [];

function spawnPillars(forkCursor) {
  const pR = localToWorld(forkCursor, 1.55, 2.4);
  const pL = localToWorld(forkCursor, -1.5, 1.0);
  pillars.push(cutout(TEX.pillar, { w: 1.0, h: 2.6, x: pR.x, z: pR.z }));
  pillars.push(cutout(TEX.pillar, { w: 0.85, h: 2.2, x: pL.x, z: pL.z }));
}

// ---------------------------------------------------------------- fog curtains
//
// A curtain is the prop standing just past each fork that hides everything
// beyond it. Because a closed curtain blocks the view, the path beyond can
// already be standing there fully built without the player ever seeing it
// get built — which is the whole point.
//
// It's built as a hybrid of two parts, because the two jobs pull against
// each other: hiding the path *reliably*, and looking like mist.
//
//   1. One dense sheet does the hiding. Its alpha is computed in a shader
//      from scrolling tileable noise, and is saturated to a solid 1 across
//      the core while closed — so occlusion is guaranteed by construction,
//      not by hoping enough sprites overlap.
//   2. A ring of soft puff sprites in front of it does the looking. These
//      are free to be loose and gappy precisely because the sheet behind
//      them is already doing the occluding.
//
// Opening is a dissolve, not a curtain-parting: a threshold rises through
// the noise field so holes open and widen and tendrils thin out, while the
// puffs drift outward, shrink and fade. Nothing slides aside as a rigid
// rectangle.
//
// Cost note: on a mid-range phone the budget here is overdraw, not CPU. The
// sheet is ~1x fullscreen at its closest (the old three-layer stack was 3x),
// which leaves room for the puffs — ~28 sprites at roughly 9% of frame each.
// Only the nearest un-dissolved curtain is ever visible, since a closed one
// hides every curtain behind it, so this cost is paid once at a time.
// The sheet's *physical* quad is much bigger than the fog anyone will ever
// see. Visibility is governed entirely by CORE_R*/FADE_R* below — the quad
// just needs to be large enough that its edge sits well past FADE_R (plus
// the domain warp's own reach), so that edge is provably always at alpha 0,
// never something the geometry itself has to draw a line at.
const FOG_W = 16;
const FOG_H = 7;
const FOG_Y = 1.6; // centre height — unrelated to FOG_H now; see CORE_RY/FADE_RY for what's actually visible
const FOG_RISE = 0.9; // the bank lifts a little as it burns off
const FOG_EXPAND = 0.14; // ...and swells slightly, as thinning fog does

// The guaranteed-solid zone, in world units from the sheet's centre — must
// cover the path corridor (±1.3) with a little margin. Nothing here ever
// gets warped or faded; see the warp gate in FOG_FRAG for why that's exact,
// not approximate.
const FOG_CORE_RX = 1.35;
const FOG_CORE_RY = 0.95;
// Where alpha reaches 0. The gap between CORE and FADE is deliberately much
// wider in X than Y — "wider is fine" for how gradually it dissipates
// sideways, but a matching vertical expansion would undo the earlier fix
// for the fog sitting too high.
const FOG_FADE_RX = 5.5;
const FOG_FADE_RY = 2.3;
// Domain warp: bends the whole silhouette in flowing curves instead of a
// smooth-but-still-rectangular product of two 1D falloffs, which is what
// still read as a soft-edged box even after the noisy-border pass. Sized
// well under (FADE - CORE) on each axis so the quad-size margin above still
// holds even at the warp's full reach.
const FOG_WARP_X = 1.0;
const FOG_WARP_Y = 0.4;

const PUFF_COUNT = 28;
const PUFF_ALPHA = 0.5;
const PUFF_SIZE = [1.1, 2.5];
const PUFF_SPREAD_X = 4.5; // wider, to match the sheet's wider dissipation
const PUFF_SPREAD_Y = 4.4 * 0.6; // matches the shorter sheet
const PUFF_DEPTH = [0.05, 1.6]; // all in front of the sheet — see renderOrder note below
const PUFF_PUSH = 2.6; // outward drift once dissolving
const PUFF_LIFT = 1.5;

const CURTAIN_DIST = BRANCH_LEN * 0.4; // how far past the fork the curtain stands
const CURTAIN_OPEN_LEAD = 1.6; // starts dissolving this far before the avatar reaches it
const CURTAIN_OPEN_TIME = 1.0; // seconds to fully dissolve
const CURTAIN_GUIDE_OPACITY = 0.28; // guide sees through it — the cheap version of "the guide can see ahead"

const curtains = [];

const FOG_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec2 vPos; // local xy in world units — see FOG_FRAG for why this replaced vUv there
  void main() {
    vUv = uv;
    vPos = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Three samples of one tiling noise texture at different scales, drifting in
// different directions, stand in for fbm — enough churn to read as moving
// fog. Extra texture samples cost ALU/bandwidth but no extra *blended*
// pixels, which is the cheap direction to spend on mobile.
//
// Sampled from vPos (world units) rather than vUv: the quad is much bigger
// than the visible fog (see FOG_W/H above), so UV-based frequencies would
// have stretched — and blurred — the noise pattern across that extra empty
// margin. World-space frequencies stay a fixed apparent size regardless of
// how big the quad's own dead space is.
//
// uOpen drives a threshold sweeping through that noise field: at 0 the
// smoothstep saturates to 1 everywhere in the core (guaranteed occlusion),
// and by 1 it has passed above the field's maximum so nothing is left.
const FOG_FRAG = /* glsl */ `
  uniform sampler2D uNoise;
  uniform float uTime;
  uniform float uOpen;
  uniform float uAlpha;
  uniform vec3 uColor;
  varying vec2 vUv;
  varying vec2 vPos;

  void main() {
    float n =
      0.50 * texture2D(uNoise, vPos * 0.14 + vec2( 0.013,  0.007) * uTime).r +
      0.30 * texture2D(uNoise, vPos * 0.29 + vec2(-0.021,  0.011) * uTime).r +
      0.20 * texture2D(uNoise, vPos * 0.60 + vec2( 0.008, -0.017) * uTime).r;

    // Denser low, wispier up top: reads as fog sitting on the path, and
    // means it burns off from above first as it dissolves.
    float vert = mix(1.0, 0.72, smoothstep(-2.0, 2.5, vPos.y));
    float base = (0.58 + 0.42 * n) * vert;

    float thr = mix(-0.30, 1.10, uOpen);
    float a = smoothstep(thr, thr + 0.38, base);

    // The silhouette: two independent per-axis falloffs (CORE_R* stays
    // solid, fades out to 0 by FADE_R*), rather than one shared distance —
    // that's deliberate, not a simplification, because it's what lets the
    // fade reach much further sideways (FOG_CORE_RX..FOG_FADE_RX is a wide
    // gap) without also pulling the vertical extent back up to where the
    // fog used to sit too high (FOG_CORE_RY..FOG_FADE_RY stays tight).
    //
    // A plain product of two such falloffs is still, structurally, a
    // rounded rectangle — soft-edged, but a rectangle. What breaks that up
    // is domain-warping the position before measuring it: bending the
    // sampled point along flowing noise, rather than jittering the boundary
    // in place, turns the contour into an organic blob instead of a box.
    // The warp is gated to exactly zero inside the guaranteed core (see
    // warpGate below), so it can never be the thing that lets something
    // through that was supposed to stay hidden.
    vec2 warpUv = vPos * 0.10 + vec2(0.037, 0.021) * uTime;
    vec2 warpN = vec2(
      texture2D(uNoise, warpUv).r - 0.5,
      texture2D(uNoise, warpUv * 1.3 + 3.7).r - 0.5
    );
    float gx = smoothstep(${FOG_CORE_RX}, ${FOG_CORE_RX + 0.8}, abs(vPos.x));
    float gy = smoothstep(${FOG_CORE_RY}, ${FOG_CORE_RY + 0.8}, abs(vPos.y));
    float warpGate = max(gx, gy);
    vec2 wp = vPos + warpN * vec2(${FOG_WARP_X}, ${FOG_WARP_Y}) * warpGate;

    float ex = 1.0 - smoothstep(${FOG_CORE_RX}, ${FOG_FADE_RX}, abs(wp.x));
    float ey = 1.0 - smoothstep(${FOG_CORE_RY}, ${FOG_FADE_RY}, abs(wp.y));
    a *= ex * ey;

    gl_FragColor = vec4(uColor, a * uAlpha);

    // THREE.Color holds values in the linear working space, and a raw
    // ShaderMaterial gets none of the output conversion the built-in
    // materials do for free — without this the fog draws markedly darker
    // than its own tint colour.
    #include <colorspace_fragment>
  }
`;

function makeCurtain(pos, heading) {
  const group = new THREE.Group();
  group.position.set(pos.x, FOG_Y, pos.z);
  group.rotation.y = heading; // plane's own normal is +Z, i.e. back toward the approaching avatar

  const sheet = new THREE.Mesh(
    new THREE.PlaneGeometry(FOG_W, FOG_H),
    new THREE.ShaderMaterial({
      uniforms: {
        uNoise: { value: TEX.fogNoise },
        uTime: { value: 0 },
        uOpen: { value: 0 },
        uAlpha: { value: 1 },
        uColor: { value: new THREE.Color(0xffffff) },
      },
      vertexShader: FOG_VERT,
      fragmentShader: FOG_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  sheet.renderOrder = 8; // after the stones and the temple
  group.add(sheet);

  // Puffs are one InstancedMesh — a single draw call however many there are.
  // They all sit *in front* of the sheet (PUFF_DEPTH is positive, and +Z
  // local faces the approaching avatar) because an InstancedMesh sorts as one
  // object: instances can't individually sort against the sheet, so keeping
  // them all on the near side makes "draw after the sheet" always correct.
  const puffs = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      map: TEX.fogPuff,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      opacity: PUFF_ALPHA,
    }),
    PUFF_COUNT
  );
  puffs.renderOrder = 9;
  puffs.frustumCulled = false; // instances move via per-instance matrices; see the stone meshes for the same reasoning
  group.add(puffs);

  const seeds = [];
  for (let i = 0; i < PUFF_COUNT; i++) {
    seeds.push({
      bx: (Math.random() * 2 - 1) * PUFF_SPREAD_X,
      // biased low so the bank is thickest around path level
      by: -FOG_H / 2 + Math.pow(Math.random(), 0.7) * PUFF_SPREAD_Y,
      bz: PUFF_DEPTH[0] + Math.random() * (PUFF_DEPTH[1] - PUFF_DEPTH[0]),
      size: PUFF_SIZE[0] + Math.random() * (PUFF_SIZE[1] - PUFF_SIZE[0]),
      rot: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 0.25,
      p1: Math.random() * Math.PI * 2,
      p2: Math.random() * Math.PI * 2,
      p3: Math.random() * Math.PI * 2,
      delay: Math.random() * 0.4, // staggers which puffs wink out first
    });
  }

  scene.add(group);
  const curtain = { group, sheet, puffs, seeds, pos, heading, open: 0, opening: false, done: false };
  curtains.push(curtain);
  return curtain;
}

/** Smoothstep, matching the GLSL one so JS and shader easing agree. */
const smoothstep = (edge0, edge1, x) => {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

const puffDummy = new THREE.Object3D();

/**
 * Dissolves any curtain the avatar has walked up to, and keeps every
 * curtain's colour/opacity current. Colour comes from tintScratch, which
 * applyAtmosphere has already set for this frame — that way a curtain takes
 * the dawn/dusk grading like the rest of the sky without having to live in
 * atmosphereMaterials (whose entries are never removed, so putting
 * per-journey props in it would leak across resets).
 */
function updateCurtains(dt, t) {
  const roleScale = role === 'guide' ? CURTAIN_GUIDE_OPACITY : 1;
  for (const c of curtains) {
    if (c.done) continue;
    if (!c.opening) {
      const f = forward(c.heading, 1);
      const ahead = (walker.x - c.pos.x) * f.x + (walker.z - c.pos.z) * f.z;
      if (ahead > -CURTAIN_OPEN_LEAD) c.opening = true;
    }
    if (c.opening) c.open = Math.min(1, c.open + dt / CURTAIN_OPEN_TIME);

    const u = c.sheet.material.uniforms;
    u.uTime.value = t;
    u.uOpen.value = c.open;
    u.uAlpha.value = roleScale;
    u.uColor.value.copy(tintScratch);
    c.sheet.position.y = FOG_RISE * c.open;
    c.sheet.scale.set(1 + FOG_EXPAND * c.open, 1 + FOG_EXPAND * 0.6 * c.open, 1);

    c.puffs.material.color.copy(tintScratch);
    c.puffs.material.opacity = PUFF_ALPHA * roleScale * (1 - smoothstep(0.55, 1.0, c.open));

    for (let i = 0; i < c.seeds.length; i++) {
      const s = c.seeds[i];
      // Sine fields rather than a real simulation: cheaper, and easier to
      // keep looking like a slow churn rather than drifting particles.
      const churnX = Math.sin(t * 0.32 + s.p1) * 0.28;
      const churnY = Math.sin(t * 0.24 + s.p2) * 0.2;
      const churnZ = Math.sin(t * 0.29 + s.p3) * 0.16;
      const spent = THREE.MathUtils.clamp((c.open - s.delay) / (1 - s.delay), 0, 1);
      const shrink = 1 - smoothstep(0, 1, spent);
      const push = Math.sign(s.bx || 1) * PUFF_PUSH * c.open;

      puffDummy.position.set(s.bx + churnX + push, s.by + churnY + PUFF_LIFT * c.open, s.bz + churnZ);
      puffDummy.rotation.set(0, 0, s.rot + t * s.rotSpeed);
      const sc = s.size * shrink;
      puffDummy.scale.set(sc, sc, 1);
      puffDummy.updateMatrix();
      c.puffs.setMatrixAt(i, puffDummy.matrix);
    }
    c.puffs.instanceMatrix.needsUpdate = true;

    if (c.open >= 1) {
      c.group.visible = false;
      c.done = true;
    }
  }
}

// ---------------------------------------------------------------- birds
//
// Two flying-gull cut-outs (a puppeteer's hand holding a bird-on-a-stick up
// from off-screen — the same diorama "puppet theatre" idea as everything
// else here) that appear at random real-time intervals, unrelated to the
// player's progress. Each appearance spawns at a *fixed* world position, a
// constant distance ahead of wherever the player currently is (not, as
// before, halfway to the temple — that shrank as the player advanced,
// which is why birds used to visibly grow across a playthrough). A fixed
// distance from a moving reference point still isn't a fixed world
// position, so a spawned bird still doesn't literally follow the player —
// it just always *starts out* at the same apparent size, the same
// real-perspective trick as the temple and clouds otherwise use. It flies
// in along a random angled line (never through the top of the screen or
// the path), hovers, then exits straight out from screen centre through
// the hover point, flattened so it never angles back up through the top.
// Depth-testing is off and render order is above everything else in the
// scene (path, pillars, player) — birds are a screen-space overlay, not
// scene geometry, so they must never be occluded by it; on a narrow/portrait
// screen the reduced horizontal FOV can otherwise push a bird's world
// position close enough to the path centreline for real 3-D pillars/ground
// to legitimately z-test in front of it.
const BIRD_KINDS = [
  { map: TEX.gull1, aspect: 347 / 1024 },
  { map: TEX.gull2, aspect: 351 / 529 },
];
const BIRD_H = 26; // world-unit height of the whole cut-out (bird + stick + hand)
const BIRD_DEPTH_OFFSET = 35; // world units ahead of the player a bird spawns — fixed, so apparent size never drifts
const BIRD_NDC_X = 0.5; // how far toward a screen edge (in NDC, 0=centre, 1=edge) a bird hovers — clear of the path
const BIRD_NDC_RADIUS = 1.6; // how far off-screen (in NDC units, from the hover point) a bird starts and ends up
// The bottom of the image — the puppeteer's hand and the base of the stick — must
// never be visible, at any point in the animation, on any screen shape: the whole
// puppet-theatre illusion depends on it always reading as "held up from below
// frame," never as the full cut-out floating free. Rise/hover/exit each aim for
// their own on-screen target and don't individually guarantee that, so instead
// it's enforced as a hard clamp every frame afterward (see updateBirds): whatever
// the animation wants, the image is pushed down further if needed so its bottom
// edge never rises above this NDC line, comfortably below the visible frame.
const BIRD_BOTTOM_MAX_NDC_Y = -1.08;
// Entry tilt, degrees, measured from "straight outward" on the bird's own side (0=horizontal outward, positive=upward,
// negative=downward) — never an angle in absolute terms, so it's mechanically impossible for a bird whose hover point
// is on the right to approach from anywhere left of it, or vice versa: the path/centre can't be crossed.
// The positive end is capped well short of 90 so entry never approaches through the top of the screen either.
const BIRD_ENTRY_TILT = [-80, 55];
const BIRD_RISE_TIME = 1.6;
const BIRD_HOVER_TIME = 3.5;
const BIRD_EXIT_DURATION = 2; // seconds to cross from hover to off-screen — always exactly this long
const BIRD_EXIT_MARGIN = 0.5; // extra seconds a bird stays after nominally reaching the edge, as slack for the estimate
const BIRD_BOB_RATE = 4.2;
const BIRD_BOB_HEIGHT = 0.36;
const BIRD_BOB_LATERAL = 0.48;
const BIRD_GAP = [1, 3]; // DEV: tightened for testing — restore to something like [16, 34] for real play

/** Direction from the hover point outward on `side`, tilted by a random angle within BIRD_ENTRY_TILT. Always points away from centre. */
function randomBirdDir(side) {
  const tiltDeg = THREE.MathUtils.lerp(BIRD_ENTRY_TILT[0], BIRD_ENTRY_TILT[1], Math.random());
  const tilt = tiltDeg * Math.PI / 180;
  return { x: side * Math.cos(tilt), y: Math.sin(tilt) };
}

function makeBirdMesh(kind) {
  const w = BIRD_H * kind.aspect;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, BIRD_H),
    new THREE.MeshBasicMaterial({
      map: kind.map,
      transparent: true,
      alphaTest: 0.35,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false, // always drawn on top of scene geometry — see the header note above
    })
  );
  mesh.visible = false;
  mesh.renderOrder = 11; // above every other layer (guide markers are the previous highest, at 10) — only future decision UI sits above this
  scene.add(mesh);
  return mesh;
}
const birdMeshes = BIRD_KINDS.map(makeBirdMesh);

// Where a screen-space (NDC) point actually sits in world space depends on
// the camera's current position/pitch and how far away the target depth is —
// there's no fixed world-Y that reads as "bottom of screen" or "the player's
// eye line" across every point in the journey. So each anchor is solved for
// with a real ray cast through the camera at spawn time, intersected with
// the bird's fixed world-Z plane, rather than guessed as a constant.
const birdRaycaster = new THREE.Raycaster();
function ndcToWorldAtZ(ndcX, ndcY, z) {
  birdRaycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
  const o = birdRaycaster.ray.origin;
  const d = birdRaycaster.ray.direction;
  const t = (z - o.z) / d.z;
  return { x: o.x + d.x * t, y: o.y + d.y * t };
}

let bird = null; // { mesh, z, side, entryX, entryY, hoverX, hoverY, hoverNdcX, hoverNdcY, exitDirX, exitDirY, t }
let birdTimer = THREE.MathUtils.lerp(BIRD_GAP[0], BIRD_GAP[1], Math.random());

function maybeSpawnBird(dt) {
  if (bird || finished || falling) return;
  birdTimer -= dt;
  if (birdTimer > 0) return;
  birdTimer = THREE.MathUtils.lerp(BIRD_GAP[0], BIRD_GAP[1], Math.random());

  camera.updateMatrixWorld();
  // A fixed distance ahead of the player, clamped so a bird spawned very late in
  // the walk still lands short of the temple rather than at/behind its facade.
  const z = Math.max(walker.z - BIRD_DEPTH_OFFSET, -TEMPLE_DISTANCE + 10);
  const side = Math.random() < 0.5 ? -1 : 1;
  const hoverNdcX = side * BIRD_NDC_X;

  // "Roughly level with the player": found by asking where the avatar's own
  // head height projects to on screen right now, then reusing that same
  // screen fraction — not the avatar's world Y — for the bird's hover point,
  // since the bird sits at a very different depth.
  const eyeNdc = new THREE.Vector3(walker.x, FIGURE_H, walker.z).project(camera);

  // Entry point: a random tilt away from the hover point, always outward on
  // `side` (see randomBirdDir) so the bird approaches from off-screen without
  // ever crossing the centre/path.
  const entryDir = randomBirdDir(side);
  const entryNdcX = hoverNdcX + entryDir.x * BIRD_NDC_RADIUS;
  const entryNdcY = eyeNdc.y + entryDir.y * BIRD_NDC_RADIUS;

  const hoverWorld = ndcToWorldAtZ(hoverNdcX, eyeNdc.y, z);
  const entryWorld = ndcToWorldAtZ(entryNdcX, entryNdcY, z);

  // Exit direction: straight out from screen *centre* through the hover point — the
  // simplest way to guarantee it can never angle back across the centre/path — with
  // any upward component clamped flat, so it still never exits back through the top.
  const radialLen = Math.hypot(hoverNdcX, eyeNdc.y) || 1;
  let exitDirX = hoverNdcX / radialLen;
  let exitDirY = Math.min(eyeNdc.y / radialLen, 0);
  const exitLen = Math.hypot(exitDirX, exitDirY) || 1;
  exitDirX /= exitLen;
  exitDirY /= exitLen;

  const mesh = birdMeshes[Math.floor(Math.random() * birdMeshes.length)];
  mesh.position.set(entryWorld.x, entryWorld.y - BIRD_H / 2, z);
  mesh.material.opacity = 1; // undo any fade-out left over from a bird cut short by a fall (see cancelBirdsForFall)
  mesh.visible = true;
  bird = {
    mesh, z, side, t: 0,
    entryX: entryWorld.x, entryY: entryWorld.y,
    hoverX: hoverWorld.x, hoverY: hoverWorld.y,
    hoverNdcX, hoverNdcY: eyeNdc.y,
    exitDirX, exitDirY,
    fading: false, fadeT: 0,
  };
}

const BIRD_FALL_FADE = 0.3; // seconds — how fast any on-screen bird fades out once a fall starts
/** Called once from startFall(): whatever bird is currently on screen fades
 * out over BIRD_FALL_FADE instead of finishing its own flight, and no new
 * bird spawns until the fall is over (see the `falling` check in
 * maybeSpawnBird) — a mid-air gust isn't the moment for wildlife spotting. */
function cancelBirdsForFall() {
  if (bird && !bird.fading) {
    bird.fading = true;
    bird.fadeT = 0;
  }
}

let birdDebugFreeze = false; // dev-only: pauses updateBirds' own repositioning so a debug override sticks on screen
/** Fly in along a random angled line, hover with a bob, then fly straight out past the screen edge. */
function updateBirds(dt) {
  if (birdDebugFreeze) return;
  maybeSpawnBird(dt);
  if (!bird) return;

  if (bird.fading) {
    bird.fadeT += dt;
    bird.mesh.material.opacity = Math.max(0, 1 - bird.fadeT / BIRD_FALL_FADE);
    if (bird.fadeT >= BIRD_FALL_FADE) {
      bird.mesh.visible = false;
      bird = null;
    }
    return; // held in place while fading — no flight-path repositioning
  }

  bird.t += dt;
  const { mesh, z, t, entryX, entryY, hoverX, hoverY, hoverNdcX, hoverNdcY, exitDirX, exitDirY } = bird;
  const riseEnd = BIRD_RISE_TIME;
  const hoverEnd = riseEnd + BIRD_HOVER_TIME;
  camera.updateMatrixWorld();

  let topX, topY;
  if (t < riseEnd) {
    const p = smoothstep(0, riseEnd, t);
    topX = THREE.MathUtils.lerp(entryX, hoverX, p);
    topY = THREE.MathUtils.lerp(entryY, hoverY, p);
  } else if (t < hoverEnd) {
    const hp = t - riseEnd;
    topX = hoverX + Math.sin(hp * BIRD_BOB_RATE * 0.7 + 1.1) * BIRD_BOB_LATERAL;
    topY = hoverY + Math.sin(hp * BIRD_BOB_RATE) * BIRD_BOB_HEIGHT;
  } else {
    // Exit always takes exactly BIRD_EXIT_DURATION seconds. The interpolation has to
    // happen in *screen space*, not world space: near/past the screen edge, world
    // distance and screen distance stop corresponding to each other in any simple
    // way (that's what perspective foreshortening is), so a world-space lerp toward
    // an off-screen target moves at wildly different, direction-dependent rates on
    // screen — barely creeping for some directions, jumping most of the way almost
    // immediately for others. Lerping the NDC coordinates directly is linear by
    // construction, so screen-space progress is the same for every direction. Only
    // the *final* step — turning that NDC point into a world position for this
    // frame's render — needs the camera, so it's still redone fresh every frame,
    // which is what keeps this correct as the camera tracks the walking player.
    const p = smoothstep(0, BIRD_EXIT_DURATION, t - hoverEnd);
    const ndcX = hoverNdcX + exitDirX * BIRD_NDC_RADIUS * p;
    const ndcY = hoverNdcY + exitDirY * BIRD_NDC_RADIUS * p;
    const w = ndcToWorldAtZ(ndcX, ndcY, z);
    topX = w.x;
    topY = w.y;
  }

  // Hard floor: whatever the phase above wanted, never let the image's bottom
  // edge (BIRD_H below topY) rise above the safe off-screen line. Re-derived
  // every frame from the current camera, so it holds through camera motion and
  // on any aspect ratio, not just the one it happened to be tuned against.
  const ndcOfTop = new THREE.Vector3(topX, topY, z).project(camera);
  const safeBottom = ndcToWorldAtZ(ndcOfTop.x, BIRD_BOTTOM_MAX_NDC_Y, z);
  topY = Math.min(topY, safeBottom.y + BIRD_H);

  mesh.position.set(topX, topY - BIRD_H / 2, z);
  mesh.quaternion.copy(camera.quaternion); // billboard — always faces the camera

  if (t >= hoverEnd + BIRD_EXIT_DURATION + BIRD_EXIT_MARGIN) {
    mesh.visible = false;
    bird = null;
  }
}

// ---------------------------------------------------------------- the journey
//
// The whole route is built once, up front, before the player moves — every
// trunk, both branches of every fork, and every curtain. That is possible
// because the correct side at each fork is fixed in advance, so the route a
// successful player walks is fully determined; and it is what guarantees the
// player never watches the path assemble itself.
//
// Both branches of a fork look identical up to the curtain. Past it, the
// correct one carries on to the next fork while the wrong one simply stops
// in mid-air a short way further — invisible until you are already inside
// the fog, which is what makes taking it a fall rather than a dead end you
// could have seen coming.
const WRONG_STUB_LEN = BRANCH_LEN * 0.8; // wrong branch stops here — past the curtain, short of anywhere

const sections = []; // one per fork: { fork, correct, branch:{left,right}, trunkAfter, approach, curtain }
let introTrunkPts = [];

function clearJourney() {
  resetGround();
  for (const p of pillars) {
    scene.remove(p);
    p.geometry.dispose();
    p.material.dispose();
  }
  pillars.length = 0;
  for (const c of curtains) {
    scene.remove(c.group);
    for (const part of [c.sheet, c.puffs]) {
      part.geometry.dispose();
      part.material.dispose();
    }
    c.puffs.dispose(); // InstancedMesh also owns its instance buffers
  }
  curtains.length = 0;
  sections.length = 0;
}

function buildJourney() {
  clearJourney();
  const origin = { x: 0, z: 0, heading: 0 };
  let phase = ROW_SPACING;

  introTrunkPts = genStraight(origin, origin.heading, TRUNK_LEN, TRUNK_SEGMENTS);
  phase = scatterAlong(origin, introTrunkPts, phase);

  const introEnd = introTrunkPts[introTrunkPts.length - 1];
  let cursor = { x: introEnd.x, z: introEnd.z, heading: origin.heading };

  for (let k = 1; k <= N_FORKS; k++) {
    const correct = CORRECT_BY_FORK[k - 1];
    spawnPillars(cursor);

    const branch = {};
    const forkPhase = phase; // both branches leave the fork on the same row phase
    let nextCursor = null;

    for (const side of ['left', 'right']) {
      const isCorrect = side === correct;
      const heading = cursor.heading + (side === 'right' ? FORK_HALF_ANGLE : -FORK_HALF_ANGLE);
      const len = isCorrect ? BRANCH_LEN : WRONG_STUB_LEN;
      const segs = isCorrect ? BRANCH_SEGMENTS : 2;
      const pts = genStraight(cursor, heading, len, segs);
      const endPhase = scatterAlong(cursor, pts, forkPhase);
      branch[side] = pts;
      if (isCorrect) {
        phase = endPhase;
        const end = pts[pts.length - 1];
        nextCursor = { x: end.x, z: end.z, heading: heading * (1 - HEADING_CORRECTION) };
      }
    }

    const sec = { fork: { ...cursor }, correct, branch, trunkAfter: null, approach: null };

    if (k < N_FORKS) {
      const trunkPts = genStraight(nextCursor, nextCursor.heading, TRUNK_LEN, TRUNK_SEGMENTS);
      phase = scatterAlong(nextCursor, trunkPts, phase);
      sec.trunkAfter = trunkPts;
      const end = trunkPts[trunkPts.length - 1];
      cursor = { x: end.x, z: end.z, heading: nextCursor.heading };
    } else {
      const approachPts = genStraight(nextCursor, nextCursor.heading, APPROACH_DISTANCE, 3);
      phase = scatterAlong(nextCursor, approachPts, phase);
      sec.approach = approachPts;
    }

    sec.curtain = makeCurtain(advance(sec.fork, sec.fork.heading, CURTAIN_DIST), sec.fork.heading);
    sections.push(sec);
  }
}

// The avatar is a rig of two stacked planes — the character art in front,
// its recolourable cardboard backing just behind — rather than a single
// cutout(), so the backing's tint can change per the player's selection
// screen choice. Figure art is 400x563 (728x1024 source, resized) — wider
// relative to its height than the old placeholder, so width is derived from
// that aspect ratio rather than reused, to avoid a stretched look. Height is
// 80% of the original placeholder's 2.2.
const FIGURE_H = 2.2 * 0.8;
const FIGURE_ASPECT = 400 / 563;

/**
 * Builds one character rig: the character art as a single plane.
 * The group shares Object3D API so position/rotation work identically
 * to a Mesh, even though it contains one.
 */
function makeCharacterRig(key) {
  const { front } = CHAR_TEX[key];
  const w = FIGURE_H * FIGURE_ASPECT;
  const group = new THREE.Group();

  const frontMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, FIGURE_H),
    new THREE.MeshBasicMaterial({ map: front, transparent: true, alphaTest: 0.45, side: THREE.DoubleSide })
  );
  frontMesh.castShadow = true;

  group.add(frontMesh);
  group.position.y = FIGURE_H / 2;
  scene.add(group);
  return { group, frontMesh };
}

function disposeRig(r) {
  scene.remove(r.group);
  r.frontMesh.geometry.dispose();
  r.frontMesh.material.dispose();
}

let characterKey = ROSTER[0].key;
let rig = makeCharacterRig(characterKey);
let figure = rig.group;

function setCharacter(key) {
  if (key !== characterKey) {
    const old = rig;
    characterKey = key;
    rig = makeCharacterRig(key);
    figure = rig.group;
    disposeRig(old);
  }
}
setCharacter(ROSTER[0].key);

// ---------------------------------------------------------------- fall physics (Rapier)
//
// Used only for the wrong-turn consequence — the avatar drops off the path
// under real gravity instead of just vanishing. No colliders exist for it to
// land on; it free-falls until FALL_UI_DELAY shows the result, then keeps
// falling for FALL_EXTRA_DURATION longer before actually freezing.
//
// "Wind" is faked rather than simulated: a true helical field would need a
// force that keeps rotating around the fall for as long as it blows, which
// is a lot of machinery for something on screen a couple of seconds. Instead
// a single off-centre force is applied each physics step for a short window,
// its magnitude decaying to zero and its horizontal direction slowly
// rotating — a decaying, turning push reads as "caught by a gust and spun
// around" close enough to a helix at this timescale, for a few lines of code
// instead of a field simulation. See blow-trial.js for the fuller multi-puff
// version of this idea if a later pass wants more chaos than one rotating
// force gives.
const fallWorld = new RAPIER.World({ x: 0, y: -9.82, z: 0 });
const FALL_FIXED_DT = 1 / 60;
fallWorld.timestep = FALL_FIXED_DT;

const CARD_THICK = 0.05;
// The "you fell" message/Again button and the card actually stopping are two
// different clocks: the UI shows up at FALL_UI_DELAY, but the card keeps
// tumbling in the background for FALL_EXTRA_DURATION more seconds after
// that — the player reads the result while the fall is still visibly
// happening, rather than staring at a frozen card the instant the message
// appears.
const FALL_UI_DELAY = 2.2; // seconds — when "you fell…" + Again appear
const FALL_EXTRA_DURATION = 5; // seconds the card keeps falling after that, before it actually freezes
const FALL_DISAPPEAR = 5; // seconds — the card itself vanishes (too far/small to read as falling any more), well before the freeze at FALL_UI_DELAY + FALL_EXTRA_DURATION

const WIND_DURATION = 0.9; // seconds — how long the gust lasts before the card just free-falls
const WIND_STRENGTH = 2.4; // peak sideways force (N-ish, tuned by eye against CARD mass below)
const WIND_ANGULAR_SPEED = (280 * Math.PI) / 180; // rad/s the push direction sweeps around — the "helical" part
const WIND_SPREAD_Y = FIGURE_H * 0.45; // how far off-centre (local, vertical) the push lands — generates tumble via r x F
const CARD_MASS = 0.4;

let fallBody = null;
let falling = false;
let fallAccumulator = 0;
let fallElapsed = 0;
let windAngle = 0; // current heading of the sweeping wind push, radians

// The fall camera doesn't lean out from wherever it happened to be trailing
// the walker — that's still CAM_BACK behind the edge, so tilting down from
// there looks *through* the walkway itself rather than past it. Instead it
// eases to a fixed point beside the edge (walker's position when the stub
// ran out — see startFall), offset sideways so the walkway's own stones
// aren't between the camera and the open air the figure is falling through.
const fallCamAnchor = new THREE.Vector3(); // computed once in startFall(), held fixed for the whole fall
const FALL_CAM_HEIGHT = 2.6; // above the edge — enough to look down and clear of the stones
const FALL_CAM_SIDE = 2.8; // sideways offset from the walkway's centreline
const FALL_CAM_FORWARD = 0.8; // small nudge out past the last stone
const FALL_CAM_EASE = 3.2; // per-second ease rate toward the anchor

function startFall() {
  figure.visible = true; // in case a previous fall hid it and something skipped the reset handler's restore
  if (fallBody) fallWorld.removeRigidBody(fallBody);

  fallBody = fallWorld.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(figure.position.x, figure.position.y, figure.position.z)
      .setRotation({ x: figure.quaternion.x, y: figure.quaternion.y, z: figure.quaternion.z, w: figure.quaternion.w })
      .setLinearDamping(0.05)
      .setAngularDamping(0.15)
      .setAdditionalMass(CARD_MASS)
  );
  fallWorld.createCollider(
    RAPIER.ColliderDesc.cuboid((FIGURE_H * FIGURE_ASPECT) / 2, FIGURE_H / 2, CARD_THICK / 2),
    fallBody
  );

  // One-off random stumble so every fall spins differently from the start —
  // the sweeping wind force (applied per-step below) takes over the ongoing
  // chaos a moment later.
  fallBody.setAngvel(
    { x: (Math.random() * 2 - 1) * 2.4, y: (Math.random() * 2 - 1) * 2.4, z: (Math.random() * 2 - 1) * 2.4 },
    true
  );
  fallBody.setLinvel(
    { x: (Math.random() * 2 - 1) * 0.6, y: 0.4, z: (Math.random() * 2 - 1) * 0.6 },
    true
  );

  windAngle = Math.random() * Math.PI * 2; // random starting heading so falls don't all spiral the same way

  falling = true;
  fallAccumulator = 0;
  fallElapsed = 0;

  // Anchor beside the edge (walker's position when the stub ran out), not
  // wherever the trailing camera happened to be — see comment above.
  // Lean in the direction of the falling path: left if they chose left, right if they chose right.
  const angleOffset = choiceSide === 'left' ? Math.PI / 2 : -Math.PI / 2;
  const side = forward(facing + angleOffset, FALL_CAM_SIDE);
  const ahead = forward(facing, FALL_CAM_FORWARD);
  fallCamAnchor.set(walker.x + side.x + ahead.x, FALL_CAM_HEIGHT, walker.z + side.z + ahead.z);

  cancelBirdsForFall();
}

/** Applies the decaying, rotating wind push for one physics step — call once
 * per fallWorld.step() while within WIND_DURATION of the fall starting. */
function applyFallWind() {
  if (fallElapsed >= WIND_DURATION) return;
  const decay = 1 - fallElapsed / WIND_DURATION; // linear fade to zero
  windAngle += WIND_ANGULAR_SPEED * FALL_FIXED_DT;

  const mag = WIND_STRENGTH * decay * CARD_MASS * FALL_FIXED_DT; // force -> impulse over one step
  const dir = { x: Math.cos(windAngle), z: Math.sin(windAngle) };
  const impulse = { x: dir.x * mag, y: 0, z: dir.z * mag };

  const t = fallBody.translation();
  const worldPoint = { x: t.x, y: t.y + WIND_SPREAD_Y, z: t.z }; // off-centre vertically -> torque for free
  fallBody.applyImpulseAtPoint(impulse, worldPoint, true);
}

// figure.position/rotation are the *visual* transform, redrawn from these
// every frame (see the step-bob block in tick()) — walker is the actual
// logical path position everything else (movement, camera, fork/curtain
// checks, key light) reads and writes. Splitting them is what lets the walk
// bob nudge the mesh sideways and tilt it without that offset silently
// feeding back into "how far has the avatar actually walked".
const walker = new THREE.Vector3(0, 0, 0);

// Guide-only overlay: which branch is safe, which is not, for the fork
// currently being decided. Just one pair, repositioned onto whichever fork
// that is, so old forks don't stay flagged behind the player.
function makeMarker() {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(1.15, 1.15),
    new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, fog: false })
  );
  m.renderOrder = 10; // above the fog puffs (9), so a guide's markers are never veiled
  m.visible = false;
  scene.add(m);
  return m;
}
const markerPair = { left: makeMarker(), right: makeMarker() };

function updateMarkers() {
  const sec = sections[forkIndex - 1];
  const showCurrent = !leg && !finished && !falling && role === 'guide' && sec;
  if (!showCurrent) {
    markerPair.left.visible = false;
    markerPair.right.visible = false;
    return;
  }
  const correct = sec.correct;
  const step = BRANCH_LEN / BRANCH_SEGMENTS;
  const leftAt = advance(sec.fork, sec.fork.heading - FORK_HALF_ANGLE, step);
  const rightAt = advance(sec.fork, sec.fork.heading + FORK_HALF_ANGLE, step);
  markerPair.left.position.set(leftAt.x, 1.5, leftAt.z);
  markerPair.right.position.set(rightAt.x, 1.5, rightAt.z);
  markerPair.left.material.map = correct === 'left' ? TEX.safe : TEX.hazard;
  markerPair.right.material.map = correct === 'right' ? TEX.safe : TEX.hazard;
  markerPair.left.material.needsUpdate = true;
  markerPair.right.material.needsUpdate = true;
  markerPair.left.visible = true;
  markerPair.right.visible = true;
}

// ---------------------------------------------------------------- state
//
// There is no manual "step" anymore. Choosing left/right triggers one
// automatic walk that covers the branch and continues straight into the next
// round's trunk, landing at the next fork. The figure's position never jumps
// — it just keeps walking. sunP is driven by how far along that walk the
// figure has travelled, so the sky changes continuously rather than snapping
// at each fork. facing (below) drives the camera's heading the same way.

const WALK_SPEED = 3.2; // world units / second

let forkIndex = 1; // 1..N_FORKS — the fork currently awaiting a decision
let finished = false;
let finishedSuccess = false;
let correctCount = 0;
let role = 'guide';
let sunP = timeOfDay(1);

// leg: the walk currently in progress, or null while awaiting a decision.
let leg = null;
let choiceSide = null; // 'left' or 'right' — tracks which path was chosen, used for camera angle during fall

function makeLeg(queue, realPoints, fromP, toP, arriveFork) {
  return { queue, total: pathLength(realPoints), traveled: 0, fromP, toP, arriveFork };
}

function startJourney() {
  buildJourney();
  leg = makeLeg(
    introTrunkPts.slice(),
    [walker, ...introTrunkPts],
    timeOfDay(1),
    timeOfDay(1),
    1
  );
}

startJourney();

// ---------------------------------------------------------------- controls

const els = {
  left: document.getElementById('left'),
  right: document.getElementById('right'),
  reset: document.getElementById('reset'),
  role: document.getElementById('role'),
  hint: document.getElementById('hint'),
  hud: document.getElementById('hud'),
  charSelect: document.getElementById('charSelect'),
  charList: document.getElementById('charList'),
  paletteList: document.getElementById('paletteList'),
  charStart: document.getElementById('charStart'),
};

// ---------------------------------------------------------------- character selection screen
//
// Shown once, after assets finish loading (see manager.onLoad below). The
// game underneath is already ticking — the screen is a full-screen blocking
// overlay rather than something that delays the walk itself, which is
// simpler than gating startJourney() and looks identical to the player
// either way, since they can't see or reach anything behind it.
let pickedCharacter = ROSTER[0].key;
let pickedColorHex = PALETTE[0].hex;
let charSelectIndex = 0; // carousel index

function renderCharSelect() {
  // Carousel: show one character at a time with left/right navigation
  els.charList.innerHTML = '';
  const c = ROSTER[charSelectIndex];
  const btn = document.createElement('button');
  btn.className = 'charOption selected';
  btn.innerHTML = `<img src="textures/${c.tex}.${c.ext}" alt="" />`;
  btn.style.cursor = 'default';
  btn.style.pointerEvents = 'none';
  els.charList.appendChild(btn);

  els.paletteList.innerHTML = '';
  for (const p of PALETTE) {
    const btn = document.createElement('button');
    btn.className = 'swatch' + (p.hex === pickedColorHex ? ' selected' : '');
    btn.style.background = `#${p.hex.toString(16).padStart(6, '0')}`;
    btn.setAttribute('aria-label', p.label);
    btn.disabled = true;
    els.paletteList.appendChild(btn);
  }

  pickedCharacter = c.key;
}
renderCharSelect();

// Carousel navigation buttons
function updateCarouselNav() {
  const charListParent = els.charList.parentElement;

  let navRow = document.getElementById('charNavRow');
  if (!navRow) {
    navRow = document.createElement('div');
    navRow.id = 'charNavRow';
    navRow.style.cssText = 'display: flex; gap: 12px; justify-content: center; margin-top: 12px; align-items: center;';
    charListParent.insertBefore(navRow, els.charList.nextSibling);
  }

  // Update counter
  let counter = navRow.querySelector('span');
  if (!counter) {
    const leftBtn = document.createElement('button');
    leftBtn.id = 'charNavLeft';
    leftBtn.textContent = '‹';
    leftBtn.style.cssText = 'width: 40px; height: 40px; border: 0; border-radius: 8px; background: rgba(244, 247, 250, 0.14); color: #f4f7fa; font-size: 24px; cursor: pointer; display: flex; align-items: center; justify-content: center;';
    leftBtn.addEventListener('click', () => {
      charSelectIndex = (charSelectIndex - 1 + ROSTER.length) % ROSTER.length;
      renderCharSelect();
      updateCarouselNav();
    });

    counter = document.createElement('span');
    counter.style.cssText = 'color: #f4f7fa; font-size: 12px; opacity: 0.6; width: 30px; text-align: center;';

    const rightBtn = document.createElement('button');
    rightBtn.id = 'charNavRight';
    rightBtn.textContent = '›';
    rightBtn.style.cssText = 'width: 40px; height: 40px; border: 0; border-radius: 8px; background: rgba(244, 247, 250, 0.14); color: #f4f7fa; font-size: 24px; cursor: pointer; display: flex; align-items: center; justify-content: center;';
    rightBtn.addEventListener('click', () => {
      charSelectIndex = (charSelectIndex + 1) % ROSTER.length;
      renderCharSelect();
      updateCarouselNav();
    });

    navRow.appendChild(leftBtn);
    navRow.appendChild(counter);
    navRow.appendChild(rightBtn);
  }
  counter.textContent = `${charSelectIndex + 1}/${ROSTER.length}`;
}
updateCarouselNav();

els.charStart.addEventListener('click', () => {
  setCharacter(pickedCharacter);
  els.charSelect.classList.remove('visible');
  setTimeout(() => els.charSelect.classList.remove('show'), 350);
});

function refreshUI() {
  updateMarkers();
  const walking = !!leg;
  els.left.classList.toggle('hidden', walking || finished || falling);
  els.right.classList.toggle('hidden', walking || finished || falling);
  els.reset.classList.toggle('hidden', !finished);

  if (finished) {
    els.hint.textContent = finishedSuccess
      ? `You reached the temple — all ${N_FORKS} crossings were safe.`
      : `The path ran out — you fell at fork ${forkIndex} of ${N_FORKS}, after ${correctCount} safe crossing${correctCount === 1 ? '' : 's'}.`;
  } else if (falling) {
    els.hint.textContent = 'Falling…';
  } else if (walking) {
    els.hint.textContent = 'Walking to the next fork…';
  } else {
    const label = timeLabel(timeOfDay(forkIndex));
    els.hint.textContent =
      role === 'guide'
        ? `Fork ${forkIndex} of ${N_FORKS} (${label}) — you can see which way is safe.`
        : `Fork ${forkIndex} of ${N_FORKS} (${label}) — a junction. You cannot see which way is safe.`;
  }
}

// Every piece of path already exists (see buildJourney) — choosing only picks
// which set of waypoints to walk. A correct pick continues through the fork's
// branch into whatever follows it; a wrong pick walks the short stub and runs
// out of stones in mid-air, which ends the journey.
const choose = (side) => () => {
  if (leg || finished) return;
  const sec = sections[forkIndex - 1];
  if (!sec) return;

  choiceSide = side; // track which path was chosen for camera angle during fall
  const wasCorrect = side === sec.correct;
  const branchPts = sec.branch[side];
  const queue = branchPts.slice();
  const realPoints = [walker.clone(), ...branchPts];

  if (wasCorrect) {
    correctCount++;
    const continuation = sec.trunkAfter || sec.approach || [];
    queue.push(...continuation);
    realPoints.push(...continuation);
    const arriveFork = sec.trunkAfter ? forkIndex + 1 : null;
    const toP = sec.trunkAfter ? timeOfDay(forkIndex + 1) : timeOfDay(N_FORKS);
    leg = makeLeg(queue, realPoints, timeOfDay(forkIndex), toP, arriveFork);
    leg.success = true;
  } else {
    leg = makeLeg(queue, realPoints, timeOfDay(forkIndex), timeOfDay(forkIndex), null);
    leg.success = false;
  }
  refreshUI();
};
els.left.addEventListener('click', choose('left'));
els.right.addEventListener('click', choose('right'));

els.reset.addEventListener('click', () => {
  forkIndex = 1;
  finished = false;
  finishedSuccess = false;
  falling = false;
  correctCount = 0;
  choiceSide = null;
  walker.set(0, 0, 0);
  facing = 0;
  walkPhase = 0;
  // The fall leaves figure.quaternion tumbled on all three axes; the walk-bob
  // code only ever writes rotation.z back, so x/y would otherwise carry the
  // fall's tilt into the new walk. Clear the whole rotation explicitly.
  figure.rotation.set(0, 0, 0);
  figure.visible = true; // undo the FALL_DISAPPEAR hide, if the card vanished before this click
  startJourney();
  refreshUI();
});

els.role.addEventListener('click', () => {
  role = role === 'guide' ? 'player' : 'guide';
  els.role.dataset.role = role;
  els.role.textContent = role === 'guide' ? 'Guide view' : 'Player view';
  refreshUI(); // curtain opacity follows `role` in updateCurtains each frame
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
  els.charSelect.classList.add('show');
  requestAnimationFrame(() => els.charSelect.classList.add('visible')); // let 'show' (display) apply before the opacity transition starts
  refreshUI();
};

const timer = new THREE.Timer();

// facing: the camera's smoothed heading. It eases toward whatever direction
// the avatar is currently walking, so a turn at a fork reads as the camera
// gently swinging round rather than snapping — this is the whole
// "camera turns slightly with you" effect, and it falls out of one lerp.
let facing = 0;

// Step bob: up-and-right-and-tilt, back down, then up-and-left-and-tilt, back
// down — one lobe of walkPhase (0..PI) per half-step. Only advances while
// walking; see the clamp-to-next-boundary logic in tick() for why a stop
// never lands mid-lobe.
const WALK_BOB_RATE = Math.PI / 0.35; // radians/sec — 0.35s per lobe
const WALK_BOB_HEIGHT = 0.09;
const WALK_BOB_LATERAL = 0.07;
const WALK_BOB_TILT = THREE.MathUtils.degToRad(9);
let walkPhase = 0;

function tick() {
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.05);
  const t = timer.getElapsed();

  // avatar: walk the current leg's waypoint queue at a constant speed, never
  // jumping — each leg's waypoints continue straight into the next round's
  // trunk (see choose() above). sunP tracks how far through the leg we are,
  // so the sky changes smoothly as the figure walks rather than snapping.
  // `walking` is captured before this block can null out `leg`, so the frame
  // a leg completes on still counts as walking for the step-bob below — it
  // shouldn't cut off just because arrival and the last step land together.
  const walking = !!leg;
  if (leg) {
    const head = leg.queue[0];
    if (head) {
      const dx = head.x - walker.x;
      const dz = head.z - walker.z;
      const distToHead = Math.hypot(dx, dz);
      const moveAmount = Math.min(distToHead, WALK_SPEED * dt);
      if (distToHead > 1e-4) {
        walker.x += (dx / distToHead) * moveAmount;
        walker.z += (dz / distToHead) * moveAmount;
      }
      leg.traveled += moveAmount;
      if (distToHead <= moveAmount + 1e-4) {
        walker.x = head.x;
        walker.z = head.z;
        leg.queue.shift();
      }
    }

    const p = leg.total > 0 ? THREE.MathUtils.clamp(leg.traveled / leg.total, 0, 1) : 1;
    sunP = THREE.MathUtils.lerp(leg.fromP, leg.toP, p);

    if (leg.queue.length === 0) {
      sunP = leg.toP;
      if (leg.arriveFork) {
        forkIndex = leg.arriveFork;
      } else if (leg.success) {
        finished = true;
        finishedSuccess = true;
      } else {
        // The fall fires here, at the moment the stones run out, rather than
        // back when the button was pressed — the consequence should land when
        // the player walks off the edge. startFall() hands the figure off to
        // physics for the drop itself — `finished` doesn't flip true until
        // the fall resolves, below.
        startFall();
      }
      leg = null;
      refreshUI();
    }
  }

  // Step bob: only while walking, and it always finishes the lobe (one
  // up-then-down) it's in the middle of before settling flat — walkPhase is
  // clamped to the next multiple of PI rather than just stopped, so motion
  // never cuts off mid-rise or mid-fall. Each PI-wide lobe lifts and tilts
  // the figure one way; consecutive lobes alternate right/left via `side`.
  // Three states: falling (physics owns figure.position); just fell and
  // waiting on "Again" (frozen exactly where the fall left it — the bob code
  // would otherwise snap it back to standing the very next frame); or the
  // normal walking/idle/reached-the-temple case (bob code, as before).
  if (falling) {
    fallAccumulator += dt;
    let steps = 0;
    while (fallAccumulator >= FALL_FIXED_DT && steps < 5) {
      applyFallWind();
      fallWorld.step();
      fallAccumulator -= FALL_FIXED_DT;
      steps++;
    }
    fallElapsed += dt;
    const ft = fallBody.translation();
    const fr = fallBody.rotation();
    figure.position.set(ft.x, ft.y, ft.z);
    figure.quaternion.set(fr.x, fr.y, fr.z, fr.w);
    if (fallElapsed >= FALL_DISAPPEAR) figure.visible = false;

    // The message/Again button show up at FALL_UI_DELAY, but `falling` stays
    // true — and the physics keeps running, above — for FALL_EXTRA_DURATION
    // longer, so the card is still visibly tumbling behind the UI rather
    // than freezing the instant the result appears.
    if (!finished && fallElapsed >= FALL_UI_DELAY) {
      finished = true;
      finishedSuccess = false;
      refreshUI();
    }
    if (fallElapsed >= FALL_UI_DELAY + FALL_EXTRA_DURATION) {
      falling = false;
    }
  } else if (!(finished && !finishedSuccess)) {
    if (walking) {
      walkPhase += dt * WALK_BOB_RATE;
    } else if (walkPhase > 0) {
      const nextBoundary = Math.ceil(walkPhase / Math.PI - 1e-6) * Math.PI;
      walkPhase = Math.min(walkPhase + dt * WALK_BOB_RATE, nextBoundary);
      if (walkPhase >= nextBoundary - 1e-6) walkPhase = 0;
    }
    const lobe = Math.floor(walkPhase / Math.PI);
    const within = walkPhase - lobe * Math.PI;
    const lift = Math.sin(within); // 0 -> 1 -> 0 across each lobe
    const side = lobe % 2 === 0 ? 1 : -1; // right lobe first, then left, alternating
    figure.position.set(walker.x + side * lift * WALK_BOB_LATERAL, FIGURE_H / 2 + lift * WALK_BOB_HEIGHT, walker.z);
    figure.rotation.z = -side * lift * WALK_BOB_TILT;
  }

  applySun(sunP);
  applyAtmosphere(sunP); // leaves the current tint in tintScratch for updateCurtains
  updateCurtains(dt, t);
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
  const recycleBehind = walker.z + CAM_BACK + 12;
  for (let i = 0; i < cloudRows.length; i++) {
    const row = cloudRows[i];
    row.position.x = Math.sin(t * 0.05 + i * 1.7) * 2.5;
    while (row.position.z > recycleBehind) row.position.z -= CLOUD_SPAN;
  }

  // camera facing: ease toward the direction of travel (see comment above).
  if (leg && leg.queue[0]) {
    const head = leg.queue[0];
    const dx = head.x - walker.x;
    const dz = head.z - walker.z;
    if (Math.hypot(dx, dz) > 1e-3) {
      const targetHeading = Math.atan2(dx, -dz);
      let delta = targetHeading - facing;
      delta = ((delta + Math.PI) % (Math.PI * 2)) - Math.PI; // shortest angular distance
      facing += delta * Math.min(1, dt * 2.5);
    }
  }

  // Recomputed fresh here rather than reusing a value from the block above —
  // that block can flip `falling`/`finished` mid-tick (the fall resolving
  // this exact frame), and the camera needs to see the up-to-date state,
  // not whatever was true at the top of tick().
  const justFell = finished && !finishedSuccess;
  if (falling) {
    // Eases to the fixed anchor beside the edge (see startFall) and pans
    // the look-at down to track the figure as it drops — a held position
    // with a moving gaze, not a scripted camera path.
    camera.position.lerp(fallCamAnchor, Math.min(1, dt * FALL_CAM_EASE));
    camera.lookAt(figure.position.x, figure.position.y, figure.position.z);
  } else if (!justFell) {
    // camera: trails the avatar along its facing direction, plus the drag offset, eased
    look.x += (look.tx - look.x) * Math.min(1, dt * 4);
    look.y += (look.ty - look.y) * Math.min(1, dt * 4);

    const behind = forward(facing, CAM_BACK);
    const ahead = forward(facing, 4.6);
    camera.position.set(
      walker.x - behind.x + look.x,
      3.9 + look.y + Math.sin(t * 0.6) * 0.05,
      walker.z - behind.z
    );
    camera.lookAt(walker.x + ahead.x, 1.25, walker.z + ahead.z);
  }
  // else: just fell — camera stays exactly where the fall left it, frozen
  // alongside the figure, until "Again" resets everything at once.

  key.target.position.set(walker.x, 0, walker.z);

  updateBirds(dt);

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
  window.__camera = camera;
  window.__temple = temple;
  window.__THREE = THREE;
  window.__capture = () => {
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/png');
  };
  window.__tick = tick;
  window.__state = () => ({
    forkIndex,
    finished,
    finishedSuccess,
    walking: !!leg,
    sunP,
    correctCount,
    facing,
    fork: sections[forkIndex - 1] ? sections[forkIndex - 1].fork : null,
  });
  window.__curtains = () =>
    curtains.map((c) => ({
      z: +c.pos.z.toFixed(2),
      open: +c.open.toFixed(2),
      done: c.done,
      visible: c.group.visible,
      sheet: {
        uOpen: +c.sheet.material.uniforms.uOpen.value.toFixed(3),
        uAlpha: +c.sheet.material.uniforms.uAlpha.value.toFixed(3),
        y: +c.sheet.position.y.toFixed(3),
      },
      puffOpacity: +c.puffs.material.opacity.toFixed(3),
    }));
  window.__curtainObjs = () => curtains;
  window.__spawnBird = () => {
    birdTimer = 0;
    bird = null;
    maybeSpawnBird(0);
    return window.__bird();
  };
  window.__bird = () =>
    bird && {
      t: +bird.t.toFixed(2),
      side: bird.side,
      pos: bird.mesh.position.toArray().map((v) => +v.toFixed(2)),
      visible: bird.mesh.visible,
    };
  window.__birdMesh = () => bird && bird.mesh;
  window.__birdFreeze = (v) => {
    birdDebugFreeze = v;
  };
  window.__freezeBird = (t) => {
    if (!bird) return false;
    bird.t = t - 1e-4; // updateBirds adds dt below, land exactly on t
    updateBirds(1e-4);
    return window.__bird();
  };
  window.__sections = () =>
    sections.map((s) => ({
      correct: s.correct,
      forkZ: +s.fork.z.toFixed(2),
      leftPts: s.branch.left.length,
      rightPts: s.branch.right.length,
      hasTrunkAfter: !!s.trunkAfter,
      hasApproach: !!s.approach,
    }));
  window.__figureZ = () => walker.z;
  window.__figurePose = () => ({
    walkPhase: +walkPhase.toFixed(3),
    pos: figure.position.toArray().map((v) => +v.toFixed(4)),
    rot: figure.rotation.toArray().slice(0, 3).map((v) => +v.toFixed(4)),
    walker: walker.toArray().map((v) => +v.toFixed(4)),
  });
  window.__fallDebug = () => ({
    falling,
    fallElapsed: +fallElapsed.toFixed(3),
    camPos: camera.position.toArray().map((v) => +v.toFixed(3)),
    figurePos: figure.position.toArray().map((v) => +v.toFixed(3)),
    figureVisible: figure.visible,
  });
  window.__rig = () => ({
    characterKey,
    frontMap: rig.frontMesh.material.map.source.data?.currentSrc || rig.frontMesh.material.map.name,
  });
  window.__cloudRows = () => cloudRows.map((r) => +r.position.z.toFixed(2));
  window.__markers = () => ({ leftVisible: markerPair.left.visible, rightVisible: markerPair.right.visible });
  window.__stoneCounts = () => stoneMeshes.map((m) => m.count);
  window.__stoneMeshes = stoneMeshes;
  window.__atmos = () => ({
    skyTint: atmosphereMaterials[0].color.getHexString(),
    clear: renderer.getClearColor(new THREE.Color()).getHexString(),
    fog: scene.fog.color.getHexString(),
    fogNearFar: [scene.fog.near, scene.fog.far],
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
