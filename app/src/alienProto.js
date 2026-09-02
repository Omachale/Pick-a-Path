/**
 * THROWAWAY PROTOTYPE — a live tuning page for the alien abduction event.
 * Same role bridgeProto.js plays for the rope bridges: find the numbers here,
 * bake them into ABDUCTION_DEFAULTS in skypath/alienAbduction.js, and don't
 * guess them anywhere else.
 *
 * What makes this worth a page rather than tuning in-game: the whole event is
 * *timing*, and timing can only be judged by replaying the same three seconds
 * twenty times in a row. In-game that means walking a fork, picking a branch
 * and waiting through the approach for every single attempt. Here it is one
 * button — plus a scrubber, so a pose that only exists for four frames (the
 * moment the beam mouth reaches the card, which is the one the whole effect
 * hangs on) can be parked on and tuned against.
 *
 * The context is reproduced at true scale — real island model, real character
 * card, the game's own camera geometry — for the same reason bridgeProto.js
 * does it: a number that looks right against the wrong scale is just a
 * different wrong number.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buildIsland } from './skypath/islandGen.js';
import { buildAbduction, ABDUCTION_DEFAULTS, totalDuration } from './skypath/alienAbduction.js';

// ============================================================================
// OPTIONAL ABDUCTION PARAMETERS: DO NOT REINSTATE WITHOUT CLEAR INSTRUCTIONS
// ============================================================================
// See the matching banner in alien-tuner.html. Once these numbers are settled
// they get baked into ABDUCTION_DEFAULTS and this panel is hidden:
//
//     http://localhost:5181/alien-tuner.html?tune=1
//
// Do not un-gate it by default, and do not re-enable it as a side effect of
// editing something nearby — that is exactly how the backdrop tuner got
// dragged back to life once before.
//
// NOTE: unlike the bridge page, the gate here hides only the TUNING sliders,
// not the playback controls. A parked bridge page still shows a bridge; a
// parked animation page with no play button shows a single frozen frame, which
// is not a preview of anything.
// ============================================================================
const SHOW_SLIDERS = new URLSearchParams(location.search).has('tune');

// ---------------------------------------------------------------- world constants
// Copied from skyPath.js. NOT tunable here — they are the fixed context the
// event has to work inside. If any changes in the game, change it here too or
// this page starts lying about scale.
const ISLAND_RADIUS = 4;
const FIGURE_SCALE = 0.72;
const FIGURE_H = 2.2 * 0.8 * FIGURE_SCALE; // 1.267
const FIGURE_ASPECT = 400 / 563;
const CAM_BACK = 7.3;
const CAM_HEIGHT = 2.8;
const CAM_LOOK_Y = 0.9;
const CAM_FOV = 52;

// ---------------------------------------------------------------- scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fc4dd);
scene.fog = new THREE.Fog(0x9fc4dd, 40, 110);

const camera = new THREE.PerspectiveCamera(CAM_FOV, innerWidth / innerHeight, 0.1, 500);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Required for the beam's hide-line — without it the clipping plane set in
// alienAbduction.js is silently ignored and the beam's top pokes out above the
// ship. This one line is the difference between the effect working and not.
renderer.localClippingEnabled = true;
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const sun = new THREE.DirectionalLight(0xfff2d8, 1.15);
sun.position.set(8, 14, 6);
scene.add(sun);

// ---------------------------------------------------------------- island
// One island at the origin, loaded and scaled exactly as skyPath.js does —
// including measuring the deck radius off the vertices rather than a bounding
// box (a Box3 around a flat disc is a square, and its bounding sphere
// overstates the radius by sqrt(2)).
const islandGroup = new THREE.Group();
scene.add(islandGroup);

new GLTFLoader().load(
  'models/island-basic-v2.glb',
  (gltf) => {
    let deckMesh = null;
    let flattest = Infinity;
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.computeBoundingBox();
      const h = o.geometry.boundingBox.max.y - o.geometry.boundingBox.min.y;
      if (h < flattest) { flattest = h; deckMesh = o; }
    });
    gltf.scene.updateWorldMatrix(true, true);
    const pos = deckMesh.geometry.attributes.position;
    const v = new THREE.Vector3();
    let deckRadius = 0;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(deckMesh.matrixWorld);
      deckRadius = Math.max(deckRadius, Math.hypot(v.x, v.z));
    }
    const deckMat = deckMesh.material.clone();
    deckMat.map = new THREE.TextureLoader().load('textures/island-circle.png', (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
    });
    deckMat.vertexColors = false;
    deckMat.color.set(0xffffff);
    deckMat.needsUpdate = true;
    deckMesh.material = deckMat;

    for (const child of gltf.scene.clone().children) islandGroup.add(child);
    islandGroup.scale.setScalar(ISLAND_RADIUS / deckRadius);
  },
  undefined,
  () => {
    // Model missing — the procedural rock is the same size, so scale stays honest.
    const built = buildIsland({
      seed: 1234, bump: 0.32, taper: 0.75, depth: 0.43, size: ISLAND_RADIUS * 2, grassCount: 0,
    });
    for (const child of [...built.children]) islandGroup.add(child);
  }
);

// ---------------------------------------------------------------- the card
// The abducted player. Built exactly as makeCharacterRig() does in skyPath.js
// (a single plane, unlit, alphaTest) so its size and look are honest — this is
// the thing the beam has to reach and the thing that ends up partly hidden, so
// getting it wrong here invalidates beamGap and captureRise together.
const card = new THREE.Mesh(
  new THREE.PlaneGeometry(FIGURE_H * FIGURE_ASPECT, FIGURE_H),
  new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.45, side: THREE.DoubleSide })
);
new THREE.TextureLoader().load('textures/figure-indy.png', (t) => {
  t.colorSpace = THREE.SRGBColorSpace;
  card.material.map = t;
  card.material.needsUpdate = true;
});
card.position.set(0, FIGURE_H / 2, 0);
scene.add(card);

const CARD_HOME = card.position.clone();

// ---------------------------------------------------------------- abduction rig
const texLoader = new THREE.TextureLoader();
const loadTex = (name) => {
  const t = texLoader.load(`textures/${name}.png`);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  return t;
};
const textures = {
  ship: loadTex('spaceship'),
  beams: loadTex('spaceship-beams'),
  string: loadTex('string'),
};

let abduction = null;

/** Reads every slider whose id matches an ABDUCTION_DEFAULTS key. */
function currentParams() {
  const p = {};
  for (const [key, def] of Object.entries(ABDUCTION_DEFAULTS)) {
    const el = document.getElementById(key);
    if (!el) continue;
    p[key] = typeof def === 'boolean' ? el.checked : parseFloat(el.value);
  }
  return p;
}

/**
 * Tears the rig down and rebuilds it from the current sliders, preserving the
 * playback position so a slider drag re-poses the SAME frame you were looking
 * at rather than jumping to the start. That is the whole ergonomic point of
 * pairing a scrubber with the sliders.
 *
 * Rebuild-on-change (rather than mutating params in place) is deliberate: ship
 * width and beam width both change plane geometry, and the retracted beam
 * position is derived from those at construction. Mutating would leave those
 * stale in a way that is invisible until it looks subtly wrong.
 */
function rebuild() {
  const keepTime = abduction ? abduction.state.time : 0;
  const wasPlaying = abduction ? abduction.state.playing : false;
  if (abduction) abduction.dispose();

  abduction = buildAbduction({ scene, textures, params: currentParams() });
  card.position.copy(CARD_HOME);
  card.rotation.z = 0;
  abduction.start({ at: { x: 0, y: 0, z: 0 }, targetCard: card, cardHeight: FIGURE_H, cardWidth: FIGURE_H * FIGURE_ASPECT });
  abduction.state.playing = wasPlaying;
  abduction.seek(Math.min(keepTime, abduction.duration));

  syncReadouts();
  report();
}

function syncReadouts() {
  for (const [key, def] of Object.entries(ABDUCTION_DEFAULTS)) {
    const el = document.getElementById(key);
    const out = document.getElementById(key + 'V');
    if (!el || !out) continue;
    if (typeof def === 'boolean') continue;
    // Angles read better whole and with a degree sign; everything else takes
    // its precision from its own slider step, so a 0.005-step control doesn't
    // display as if it moved in 0.01s.
    const isAngle = /angle|Angle|Pitch|swayAmp/.test(key);
    const step = parseFloat(el.step) || 0.01;
    out.textContent = isAngle
      ? `${(+el.value).toFixed(0)}°`
      : (+el.value).toFixed(step < 0.01 ? 3 : 2);
  }
  document.getElementById('speedV').textContent = speed().toFixed(2);
}

/**
 * How much of the card is still visible below the cone's mouth once fully
 * lifted, as a percentage of its height. The cone's art bottom sits at
 * BEAM_ART.bottom/height down the plane, so the mouth's world Y is the beam's
 * extended top edge minus that fraction of the plane height.
 */
function cardVisiblePct() {
  const p = abduction.params;
  const m = abduction.metrics;
  const beamTopExtended = p.hoverHeight + m.beamRetractedY - m.beamTravel + m.beamPlaneH / 2;
  const mouth = beamTopExtended - m.beamPlaneH * (459 / 469);
  const cardCentre = CARD_HOME.y + p.captureRise;
  const top = cardCentre + FIGURE_H / 2;
  const bottom = cardCentre - FIGURE_H / 2;
  return (100 * Math.max(0, Math.min(mouth, top) - bottom)) / FIGURE_H;
}

/** Live read-out of the things that decide whether this reads correctly. */
function report() {
  const p = abduction.params;
  // Straight from the module rather than recomputed here — these depend on the
  // art's alpha-bbox constants, and a second copy of that arithmetic on this
  // page is exactly the kind of thing that drifts silently.
  const m = abduction.metrics;
  const total = totalDuration(p);

  // How much cone ends up in open air, between the ship's lower edge and the
  // card. Everything above that is behind the ship and might as well not be
  // drawn. Under ~1.5 units it shows two rings and stops reading as a beam at
  // all — the trap the first set of defaults fell straight into.
  const shipBottom = p.hoverHeight - m.shipH / 2;
  const beamMouth = p.hoverHeight + m.beamRetractedY - m.beamTravel
    - m.beamPlaneH * (459 / 469 - 0.5);
  const visibleCone = Math.max(0, shipBottom - beamMouth);

  document.getElementById('report').innerHTML = [
    `ship <b>${p.shipWidth.toFixed(1)} × ${m.shipH.toFixed(1)}</b> = ${(p.shipWidth / FIGURE_H).toFixed(1)} character-heights wide`,
    `beam mouth <b>${(p.beamWidth / (FIGURE_H * FIGURE_ASPECT)).toFixed(2)}×</b> the card's width`,
    `total <b>${total.toFixed(2)}s</b>`,
    // The beam's top edge against the ship's cardboard edge. The first is
    // always the larger, by design — that overshoot is precisely what the
    // clipping plane exists to hide, so seeing a positive number here is the
    // hide-line confirming it has work to do.
    `beam overshoots ship edge by <b>${(m.beamTopLocal - m.cardboardTopLocal).toFixed(2)}</b>` +
      (m.beamTopLocal > m.cardboardTopLocal
        ? ' — <b style="color:#8f8">clipped</b>'
        : ' — <b style="color:#fc9">no clip needed</b>'),
    // "Partially hidden" made into a number. The cone's cardboard is opaque,
    // so this is simply how much card is left below its mouth — 0% means the
    // lift has hidden the player completely, which is a different (and much
    // worse) effect than the one being aimed at.
    `card rises <b>${(p.captureRise / FIGURE_H).toFixed(2)}×</b> its height, ` +
      `<b>${cardVisiblePct().toFixed(0)}%</b> still showing` +
      (cardVisiblePct() < 12 ? ' — <b style="color:#f99">swallowed</b>' : ''),
    `beam reach <b>${m.beamTravel.toFixed(2)}</b>, visible cone <b>${visibleCone.toFixed(2)}</b>` +
      (visibleCone > 1.5 ? '' : ' — <b style="color:#f99">too little showing</b>'),
    // The two angles rolled for THIS run. Shown because a random range can
    // only be judged by watching the rolls it actually produces — hit replay.
    `this run: entry <b>${abduction.state.entryAngle.toFixed(0)}°</b>, ` +
      `exit <b>${abduction.state.exitAngle.toFixed(0)}°</b>`,
  ].join('<br>');
}

// ---------------------------------------------------------------- playback
const speed = () => parseFloat(document.getElementById('speed').value);
const looping = () => document.getElementById('loop').checked;

function setScrubFromState() {
  const el = document.getElementById('scrub');
  const d = abduction.duration;
  el.value = d > 0 ? abduction.state.time / d : 0;
  document.getElementById('scrubV').textContent = `${abduction.state.time.toFixed(2)}s`;
  document.getElementById('phase').textContent = currentPhaseName();
}

/**
 * Which beat the playhead is parked on. Recomputed here rather than exported
 * from the module because it exists purely for this read-out — the module has
 * no reason to name its phases to anyone but itself.
 */
function currentPhaseName() {
  const p = abduction.params;
  const order = [
    ['descend', p.descendDur], ['hover', p.hoverDur], ['beam extend', p.beamDur],
    ['beam hold', p.beamHoldDur], ['lift', p.liftDur], ['ascend', p.ascendDur],
  ];
  let t = abduction.state.time;
  for (const [name, dur] of order) {
    if (t < dur) return name;
    t -= dur;
  }
  return 'done';
}

function play() {
  if (abduction.state.time >= abduction.duration) abduction.seek(0);
  abduction.state.playing = true;
  document.getElementById('playBtn').textContent = 'pause';
}
function pause() {
  abduction.state.playing = false;
  document.getElementById('playBtn').textContent = 'play';
}
function replay() {
  card.position.copy(CARD_HOME);
  card.rotation.z = 0;
  abduction.start({ at: { x: 0, y: 0, z: 0 }, targetCard: card, cardHeight: FIGURE_H, cardWidth: FIGURE_H * FIGURE_ASPECT });
  document.getElementById('playBtn').textContent = 'pause';
  // start() rolls fresh entry/exit angles, and the read-out shows them — so it
  // has to be refreshed here, not only on a slider change, or every replay
  // would display the previous run's roll.
  report();
}

// ---------------------------------------------------------------- camera presets
//
// `gameCam` is the important one: "off the top of the screen" is a claim about
// a specific framing, and it is only true or false against the game's own
// camera geometry and field of view.
let followCam = true;
function viewGame() {
  followCam = true;
  controls.enabled = false;
}
function viewOrbit() {
  followCam = false;
  controls.enabled = true;
  camera.position.set(9, 4.5, 9);
  controls.target.set(0, 2.5, 0);
}
function viewSide() {
  followCam = false;
  controls.enabled = true;
  camera.position.set(14, 3, 0);
  controls.target.set(0, 3, 0);
}

/**
 * The game's trailing camera, plus the tilt and dolly-back the event asks for.
 *
 * Mirrors skyPath.js's own camera block exactly, INCLUDING the way its zoom
 * raises the camera as it pulls back (`CAM_HEIGHT * (1 + (pull - 1) * 0.45)`).
 * That coupling is what makes a pull-back read as stepping back rather than
 * lying down, so a page that pulled back without it would be tuning a shot the
 * game never shows.
 */
const camTarget = new THREE.Vector3();
function placeGameCam() {
  const pull = abduction.state.cameraPull;
  const back = CAM_BACK * pull;
  camera.position.set(CARD_HOME.x, CAM_HEIGHT * (1 + (pull - 1) * 0.45), CARD_HOME.z + back);
  // Tilting "up" is a rotation of the look-at point about the camera, not a
  // move of the camera itself — pitching in place is what a tripod head does,
  // and it keeps the ship centred while the ground falls out of frame.
  const pitch = abduction.state.cameraPitch;
  const dist = back + 4.6;
  camTarget.set(
    CARD_HOME.x,
    CAM_LOOK_Y + Math.sin(pitch) * dist,
    CARD_HOME.z - Math.cos(pitch) * dist
  );
  camera.lookAt(camTarget);
}

// ---------------------------------------------------------------- UI wiring
//
// Slider positions are pushed from ABDUCTION_DEFAULTS at load rather than read
// from the `value` attributes in the HTML — those are documentation only, so
// there is exactly one source of truth for a baked number.
function syncSlidersToDefaults() {
  for (const [key, val] of Object.entries(ABDUCTION_DEFAULTS)) {
    const el = document.getElementById(key);
    if (!el) continue;
    if (typeof val === 'boolean') el.checked = val;
    else el.value = val;
  }
}
syncSlidersToDefaults();

for (const key of Object.keys(ABDUCTION_DEFAULTS)) {
  const el = document.getElementById(key);
  el?.addEventListener('input', rebuild);
  el?.addEventListener('change', rebuild);
}

document.getElementById('scrub').addEventListener('input', (e) => {
  pause();
  abduction.seek(parseFloat(e.target.value) * abduction.duration);
  setScrubFromState();
});
document.getElementById('speed').addEventListener('input', syncReadouts);
document.getElementById('playBtn').addEventListener('click', () => {
  if (abduction.state.playing) pause();
  else play();
});
document.getElementById('replayBtn').addEventListener('click', replay);
document.getElementById('viewGame').addEventListener('click', viewGame);
document.getElementById('viewOrbit').addEventListener('click', viewOrbit);
document.getElementById('viewSide').addEventListener('click', viewSide);
document.getElementById('resetBtn').addEventListener('click', () => {
  syncSlidersToDefaults();
  rebuild();
  replay();
});
document.getElementById('logBtn').addEventListener('click', () => {
  const p = currentParams();
  const text = [
    '// ABDUCTION_DEFAULTS (skypath/alienAbduction.js)',
    // Falling back to the default matters for every param without a slider —
    // `beamTravel` today (see the note in alien-tuner.html). Without the
    // fallback those log as `undefined`, which pastes straight into the module
    // as a syntax-valid, behaviour-destroying value.
    ...Object.keys(ABDUCTION_DEFAULTS).map(
      (k) => `  ${k}: ${p[k] ?? ABDUCTION_DEFAULTS[k]},`
    ),
  ].join('\n');
  document.getElementById('log').textContent = text;
  navigator.clipboard?.writeText(text).catch(() => {});
});

// Hide most tuning groups, but never Playback or Camera — see the banner
// above "Camera" in alien-tuner.html for why that section stays live (Luke
// asked to keep tuning the pull-back/tilt after seeing it in-game, without
// bringing back every other slider).
const ALWAYS_SHOWN_HEADERS = new Set(['Playback', 'Camera']);
if (!SHOW_SLIDERS) {
  const ui = document.getElementById('ui');
  let hiding = false;
  for (const node of [...ui.children]) {
    if (node.tagName === 'H3') hiding = !ALWAYS_SHOWN_HEADERS.has(node.textContent);
    if (node.id === 'report') hiding = false;
    if (hiding) node.style.display = 'none';
  }
}

rebuild();
viewGame();
replay();

// ---------------------------------------------------------------- loop
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(clock.getDelta(), 0.05) * speed();
  abduction.update(dt);
  // Billboard the rig at whatever camera is actually in use, so the orbit and
  // side views show the same face the player would see rather than the rig
  // edge-on (a flat plane seen edge-on is invisible, which reads as a bug).
  abduction.facePoint(camera.position);

  if (abduction.state.playing) setScrubFromState();
  if (!abduction.state.playing && abduction.state.time >= abduction.duration && looping()) replay();

  if (followCam) placeGameCam();
  else controls.update();

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();

// ---------------------------------------------------------------- debug hooks
window.__capture = () => {
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
};
window.__abduction = () => ({
  time: +abduction.state.time.toFixed(3),
  duration: +abduction.duration.toFixed(3),
  phase: currentPhaseName(),
  playing: abduction.state.playing,
  rig: abduction.rig.position.toArray().map((v) => +v.toFixed(3)),
  beamLocalY: +abduction.beam.position.y.toFixed(3),
  clipY: +abduction.beam.material.clippingPlanes[0].constant.toFixed(3),
  card: card.position.toArray().map((v) => +v.toFixed(3)),
  cardRoll: +THREE.MathUtils.radToDeg(card.rotation.z).toFixed(2),
  camPitch: +THREE.MathUtils.radToDeg(abduction.state.cameraPitch).toFixed(2),
  camPull: +abduction.state.cameraPull.toFixed(3),
  camZ: +camera.position.z.toFixed(2),
  entryAngle: +abduction.state.entryAngle.toFixed(2),
  exitAngle: +abduction.state.exitAngle.toFixed(2),
});
window.__seek = (t) => { pause(); abduction.seek(t); setScrubFromState(); return window.__abduction(); };
/**
 * Steps the sequence by hand, the way skyPath.js's window.__tick() does.
 * requestAnimationFrame is throttled to a stop whenever the browser pane is
 * hidden or backgrounded, which makes "let it play and look at it" useless for
 * automated checking — this advances the same code path deterministically and
 * without needing a visible pane.
 */
window.__advance = (dt = 1 / 60, steps = 1) => {
  for (let i = 0; i < steps; i++) {
    abduction.update(dt);
    abduction.facePoint(camera.position);
    // Place the camera too, not just the rig — otherwise a headless step
    // reports last frame's camera and the pitch/pull can't be checked at all.
    if (followCam) placeGameCam();
    if (!abduction.state.playing && abduction.state.time >= abduction.duration && looping()) replay();
  }
  setScrubFromState();
  return window.__abduction();
};
window.__params = () => abduction.params;
window.__camera = camera;
window.__controls = controls; // so a close-in inspection camera isn't fought by controls.update()
window.__scene = scene;
window.__THREE = THREE;
/**
 * Where the string's knot and the ship's loop apex actually ended up, in world
 * space. The knot landing on the loop is the one thing the string's placement
 * has to get right, and it is far easier to confirm as two numbers than by
 * squinting at a screenshot.
 */
window.__knotCheck = () => {
  scene.updateMatrixWorld(true);
  const m = abduction.metrics;
  // Both meshes are children of the rig, so their `.position` is rig-local.
  // localToWorld on each mesh takes the feature's offset within that mesh all
  // the way out to world space, which is what a camera aiming at it needs —
  // and the dx/dy comparison stays valid either way, since both features ride
  // the same rig transform.
  const apex = abduction.ship.localToWorld(
    new THREE.Vector3(m.loopApexLocalX, m.loopApexLocalY, 0)
  );
  const knot = abduction.string.localToWorld(
    new THREE.Vector3(m.knotLocalX, m.knotLocalY, 0)
  );
  return {
    loopApex: apex.toArray().map((v) => +v.toFixed(4)),
    knotCentre: knot.toArray().map((v) => +v.toFixed(4)),
    dx: +(knot.x - apex.x).toFixed(4),
    dy: +(knot.y - apex.y).toFixed(4), // should equal -stringDrop
    knotHeight: +m.knotHeight.toFixed(4),
  };
};
