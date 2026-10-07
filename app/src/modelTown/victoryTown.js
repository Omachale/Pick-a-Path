/**
 * The victory stage's new setting, as a test page (model-town.html). Luke,
 * 2026-10-06: the victory stage moves off the space hemisphere onto "a table
 * which has a miniature trainset on it: a small model town with a small
 * mountain and tunnel with a track going through it... We will just be able
 * to see the edges of the table, and on the wall in the distance we will see
 * a full-size window, making it clear that the small town in the foreground
 * is miniature. The teams will be arranged in a semi-circular arc, though
 * less than 180°, and the camera will pan slightly to each team in turn."
 * Built separately first ("create the town and the room it's in as a
 * separate prototype before putting the existing victory screens into it").
 *
 * Stages so far: a block layout to arrange; then (Luke) "Have the train
 * track loop around the stage area, so it passes in front of the stage...
 * Up the quality by one step." So this is past blocks (card textures,
 * pitched roofs and windows, a proper little engine with smoke) but still
 * not final art. Style is cardboard and homemade, less realistic than
 * Luke's model-railway reference photos; the room itself basic and a little
 * retro. Outside the window, by contrast, a cyberpunk city (cyberCity.js).
 *
 * Units are metres, at real-room scale: the table is a real table, so the
 * window and the room read as full size and the town as a model on it.
 *
 * Lit (MeshStandardMaterial, shadows), unlike the game: this only ever runs
 * on the teacher's computer, once, so it can afford real lighting, and a
 * table lit from a window is most of what sells "miniature".
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { buildTeamPodium, PODIUM, SHARP_LAYER } from './teamPodium.js';
import { createFireworks } from './fireworks.js';
import { buildCyberCity, SMOG } from './cyberCity.js';
import { makeModels } from './models.js';

/**
 * Mounts the scene into `container` (which it fills) for the given teams,
 * plays the reveal, and returns { dispose }. Used by the teacher's lobby
 * board at the end of a series of rounds (LobbyBoard.jsx), and by the test
 * page (model-town.html, testPage.js) with made-up teams.
 *
 * teams: up to 4, each { seats: [{ name, characterKey, colorHex, breakdown }] }
 *   (see teamPodium.js). demo: the test page's extras (buttons, press D to
 *   show them; window.__ debug hooks).
 */
export function mountVictoryTown(container, { teams: TEAM_DATA, demo = false } = {}) {
const VW = () => container.clientWidth || innerWidth;
const VH = () => container.clientHeight || innerHeight;
const listeners = [];
const listen = (target, type, fn) => {
  target.addEventListener(type, fn);
  listeners.push([target, type, fn]);
};

// ------------------------------------------------------------- layout numbers
// Gathered here so the arrangement can be changed in one place.
const LAYOUT = {
  table: { w: 2.2, d: 1.4, h: 0.78, top: 0.04 },
  room: { w: 7, d: 6, h: 2.7, tableToBackWall: 1.3 },
  window: { w: 2.2, h: 1.4, sill: 0.9 },
  // The team arc: its centre lies toward the camera, so every team faces it.
  // platform.w is the width each team's victory base is scaled to; its
  // depth follows from the base's own proportions.
  arc: { radius: 0.7, spanDeg: 120, centreZ: 0.6, platform: { w: 0.36, d: 0.29, h: 0.03 } },
  // A rounded-rectangle loop right round the stage: its front straight runs
  // between the stage and the table's front edge, its back-left corner
  // through the mountain.
  track: { x0: -0.94, x1: 0.94, zBack: -0.54, zFront: 0.54, corner: 0.25, gauge: 0.035 },
  mountain: { x: -0.74, z: -0.38, rx: 0.3, rz: 0.26, h: 0.3 },
  trainSpeed: 0.16, // m/s along the track (a slow model train)
};

const T = LAYOUT.table;
const TOP = T.h + T.top; // the table's surface height

// ------------------------------------------------------------------ renderer
// Logarithmic depth: the camera sees from centimetres (the model) to 12 km
// (the clouds outside), far more range than an ordinary depth buffer holds.
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
container.appendChild(renderer.domElement);
renderer.domElement.style.display = 'block';

const scene = new THREE.Scene();
// A clear colour rather than scene.background: a background forces a clear
// on every render, which would wipe the picture under the sharp name-tag
// pass (see SHARP_LAYER).
renderer.setClearColor(0x2a2119);
// Far enough for the city outside the window (see cyberCity.js).
const camera = new THREE.PerspectiveCamera(32, 1, 0.02, 12000);
// Haze over the clouds outside (cyberCity.js). Exponential, and thin enough per metre
// that across the few metres of the room it changes nothing indoors.
scene.fog = new THREE.FogExp2(SMOG, 0.00032);

// Daylight from the window behind the table, plus a soft room fill so the
// fronts (facing the camera, away from the window) aren't black.
scene.add(new THREE.HemisphereLight(0xfff4e6, 0x5a4634, 1.25));
const sun = new THREE.DirectionalLight(0xfff0d8, 2.6);
sun.position.set(-1.2, 3.2, -3.0);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -1.6, right: 1.6, top: 1.6, bottom: -1.6, near: 0.5, far: 8 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.002;
sun.shadow.radius = 3;
scene.add(sun);
const fill = new THREE.DirectionalLight(0xffe2c0, 0.7);
fill.position.set(1.5, 2.5, 3);
scene.add(fill);

// ------------------------------------------------------------------ textures
const rand = mulberry32(11);
function canvasTex(w, h, draw, repeat = 1) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  return t;
}
// Near-white card with speckles and faint fibres, to be tinted by each
// material's colour, so one texture serves every piece of card.
const cardTex = canvasTex(256, 256, (g, w, h) => {
  g.fillStyle = '#ece6dc';
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 2600; i++) {
    const v = 200 + rand() * 55;
    g.fillStyle = `rgba(${v},${v - 8},${v - 20},${0.25 + rand() * 0.3})`;
    g.fillRect(rand() * w, rand() * h, 1 + rand() * 2, 1 + rand() * 2);
  }
  g.strokeStyle = 'rgba(150,120,90,0.12)';
  for (let i = 0; i < 70; i++) {
    g.beginPath();
    const x = rand() * w;
    const y = rand() * h;
    g.moveTo(x, y);
    g.lineTo(x + (rand() - 0.5) * 30, y + (rand() - 0.5) * 6);
    g.stroke();
  }
});
const grassTex = canvasTex(512, 512, (g, w, h) => {
  g.fillStyle = '#7e8f57';
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 260; i++) {
    const r = 10 + rand() * 40;
    const x = rand() * w;
    const y = rand() * h;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    const c = rand() < 0.5 ? '96,120,62' : '128,138,80';
    grad.addColorStop(0, `rgba(${c},0.45)`);
    grad.addColorStop(1, `rgba(${c},0)`);
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = rand() < 0.5 ? 'rgba(70,92,48,0.35)' : 'rgba(160,168,104,0.3)';
    g.fillRect(rand() * w, rand() * h, 1.5, 1.5);
  }
}, 3);
const woodTex = canvasTex(512, 128, (g, w, h) => {
  g.fillStyle = '#a06c40';
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 90; i++) {
    g.strokeStyle = `rgba(${90 + rand() * 40},${50 + rand() * 25},25,${0.15 + rand() * 0.25})`;
    g.lineWidth = 0.5 + rand() * 2;
    g.beginPath();
    const y = rand() * h;
    g.moveTo(0, y);
    for (let x = 0; x <= w; x += 32) g.lineTo(x, y + Math.sin(x * 0.02 + i) * 3);
    g.stroke();
  }
});
const floorTex = canvasTex(512, 512, (g, w, h) => {
  const boards = 6;
  for (let b = 0; b < boards; b++) {
    const v = 0.85 + rand() * 0.25;
    g.fillStyle = `rgb(${110 * v},${76 * v},${46 * v})`;
    g.fillRect(0, (b * h) / boards, w, h / boards);
    for (let i = 0; i < 25; i++) {
      g.strokeStyle = `rgba(60,38,20,${0.1 + rand() * 0.15})`;
      g.beginPath();
      const y = (b * h) / boards + rand() * (h / boards);
      g.moveTo(0, y);
      g.lineTo(w, y + (rand() - 0.5) * 4);
      g.stroke();
    }
    g.fillStyle = 'rgba(30,18,10,0.6)';
    g.fillRect(0, (b * h) / boards, w, 2);
    g.fillRect(rand() * w, (b * h) / boards, 2, h / boards);
  }
}, 4);
const wallTex = canvasTex(256, 256, (g, w, h) => {
  g.fillStyle = '#e2d6c2';
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 400; i++) {
    const r = 6 + rand() * 20;
    g.fillStyle = `rgba(${rand() < 0.5 ? '200,186,164' : '238,230,214'},0.12)`;
    g.beginPath();
    g.arc(rand() * w, rand() * h, r, 0, Math.PI * 2);
    g.fill();
  }
}, 3);

const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.9, ...opts });
const card = (color) => mat(color, { map: cardTex });
const M = {
  floor: mat(0xffffff, { map: floorTex, roughness: 0.75 }),
  wall: mat(0xffffff, { map: wallTex }),
  trim: mat(0xf2ede4, { roughness: 0.6 }),
  table: mat(0xffffff, { map: woodTex, roughness: 0.6 }),
  board: mat(0xffffff, { map: grassTex }),
  boardEdge: card(0x6d5236),
  stage: card(0xc9a26e),
  rail: mat(0x7a7068, { roughness: 0.4, metalness: 0.6 }),
  sleeper: mat(0x5a3b22),
  ballast: mat(0xffffff, { map: cardTex, color: 0x9a8f80 }),
  curtain: mat(0x7d4a3a, { roughness: 1 }),
};

// The detailed models (train, buildings, hill, greenery: models.js), built
// from this room's own materials so they match.
const models = makeModels({ mat, card, rand });

function box(w, h, d, material, x = 0, y = 0, z = 0, parent = scene) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  parent.add(m);
  return m;
}
function cyl(r, len, material, parent, segs = 16) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, segs), material);
  m.castShadow = m.receiveShadow = true;
  parent.add(m);
  return m;
}

let city = null; // the view out of the window, built with the room

// ---------------------------------------------------------------------- room
{
  const R = LAYOUT.room;
  const backZ = -T.d / 2 - R.tableToBackWall;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(R.w, R.d), M.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = backZ + R.d / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  // Back wall, built round the window opening.
  const W = LAYOUT.window;
  const sideW = (R.w - W.w) / 2;
  box(sideW, R.h, 0.1, M.wall, -(W.w / 2 + sideW / 2), R.h / 2, backZ);
  box(sideW, R.h, 0.1, M.wall, W.w / 2 + sideW / 2, R.h / 2, backZ);
  box(W.w, W.sill, 0.1, M.wall, 0, W.sill / 2, backZ);
  const above = R.h - W.sill - W.h;
  box(W.w, above, 0.1, M.wall, 0, R.h - above / 2, backZ);
  box(R.w, 0.1, 0.02, M.trim, 0, 0.05, backZ + 0.06); // skirting board
  // The view out: a cyberpunk city (cyberCity.js).
  city = buildCyberCity({ renderer, backZ, rand });
  scene.add(city.group);
  const f = 0.07;
  box(W.w + 2 * f, f, 0.1, M.trim, 0, W.sill + W.h + f / 2, backZ + 0.03);
  box(f, W.h, 0.1, M.trim, -W.w / 2 - f / 2, W.sill + W.h / 2, backZ + 0.03);
  box(f, W.h, 0.1, M.trim, W.w / 2 + f / 2, W.sill + W.h / 2, backZ + 0.03);
  box(0.04, W.h, 0.06, M.trim, 0, W.sill + W.h / 2, backZ + 0.02); // mullion
  box(W.w, 0.035, 0.05, M.trim, 0, W.sill + W.h * 0.62, backZ + 0.02); // transom
  box(W.w + 0.3, 0.04, 0.24, M.trim, 0, W.sill - 0.02, backZ + 0.1); // sill
  // Curtains, gathered either side: a few soft folds each.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const fold = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, W.h + 0.45, 10), M.curtain);
      fold.position.set(side * (W.w / 2 + 0.12 + i * 0.075), W.sill + W.h / 2 + 0.1, backZ + 0.13 + (i % 2) * 0.02);
      fold.castShadow = fold.receiveShadow = true;
      scene.add(fold);
    }
  }
  box(W.w + 1.2, 0.025, 0.025, M.wall, 0, W.sill + W.h + 0.32, backZ + 0.13); // rail
  // Side walls, so a wide shot doesn't run out of room.
  box(0.1, R.h, R.d, M.wall, -R.w / 2, R.h / 2, backZ + R.d / 2);
  box(0.1, R.h, R.d, M.wall, R.w / 2, R.h / 2, backZ + R.d / 2);
}

// --------------------------------------------------------------------- table
{
  box(T.w, T.top, T.d, M.table, 0, T.h + T.top / 2, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(0.07, T.h, 0.07, M.table, sx * (T.w / 2 - 0.08), T.h / 2, sz * (T.d / 2 - 0.08));
  box(T.w - 0.1, 0.08, 0.025, M.table, 0, T.h - 0.04, T.d / 2 - 0.06); // apron
  // The layout board sits on the table, a little in from its edges, so the
  // table's own edge stays visible as a frame round the model. Its rim is
  // bare card, as homemade layouts are.
  box(T.w - 0.12, 0.02, T.d - 0.12, [M.boardEdge, M.boardEdge, M.board, M.boardEdge, M.boardEdge, M.boardEdge], 0, TOP + 0.01, 0);
}
const BOARD = TOP + 0.02; // the model's ground level
const BX = T.w / 2 - 0.06; // the board's half extents
const BZ = T.d / 2 - 0.06;

// --------------------------------------------------------------------- track
const L = LAYOUT.track;
// The loop as a dense list of points round a rounded rectangle, then a
// closed curve through them (sampled by distance, so the train runs evenly).
const trackPath = (() => {
  const r = L.corner;
  const pts = [];
  const straight = (ax, az, bx, bz) => {
    const n = Math.max(2, Math.round(Math.hypot(bx - ax, bz - az) / 0.05));
    for (let i = 0; i < n; i++) pts.push(new THREE.Vector3(ax + ((bx - ax) * i) / n, BOARD, az + ((bz - az) * i) / n));
  };
  // Each corner turns a quarter, starting from angle a0 (in x/z, 0 = +x,
  // π/2 = +z, toward the camera).
  const corner = (cx, cz, a0) => {
    for (let i = 0; i < 12; i++) {
      const a = a0 - (i / 12) * (Math.PI / 2);
      pts.push(new THREE.Vector3(cx + Math.cos(a) * r, BOARD, cz + Math.sin(a) * r));
    }
  };
  // Front straight left to right, then round: right side, back, left side.
  straight(L.x0 + r, L.zFront, L.x1 - r, L.zFront);
  corner(L.x1 - r, L.zFront - r, Math.PI / 2);
  straight(L.x1, L.zFront - r, L.x1, L.zBack + r);
  corner(L.x1 - r, L.zBack + r, 0);
  straight(L.x1 - r, L.zBack, L.x0 + r, L.zBack);
  corner(L.x0 + r, L.zBack + r, -Math.PI / 2);
  straight(L.x0, L.zBack + r, L.x0, L.zFront - r);
  corner(L.x0 + r, L.zFront - r, -Math.PI);
  return new THREE.CatmullRomCurve3(pts, true, 'centripetal');
})();
const trackLen = trackPath.getLength();
// Sideways from the track at u (to the right of travel), flat on the board.
function trackSide(u) {
  const t = trackPath.getTangentAt(u);
  return new THREE.Vector3(-t.z, 0, t.x);
}
{
  // Ballast: a ribbon of grey-brown grit under the sleepers.
  const N = 600;
  const pos = [];
  const uv = [];
  const idx = [];
  for (let i = 0; i <= N; i++) {
    const u = (i % N) / N;
    const p = trackPath.getPointAt(u);
    const s = trackSide(u);
    for (const k of [-1, 1]) {
      pos.push(p.x + s.x * k * 0.034, BOARD + 0.003, p.z + s.z * k * 0.034);
      uv.push((i / N) * 40, k < 0 ? 0 : 1);
    }
    if (i < N) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); // wound to face up
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const ballast = new THREE.Mesh(geo, M.ballast);
  ballast.receiveShadow = true;
  scene.add(ballast);
  // Sleepers, instanced.
  const n = Math.round(trackLen / 0.022);
  const sleepers = new THREE.InstancedMesh(new THREE.BoxGeometry(0.008, 0.005, L.gauge + 0.022), M.sleeper, n);
  const o = new THREE.Object3D();
  for (let i = 0; i < n; i++) {
    const p = trackPath.getPointAt(i / n);
    const t = trackPath.getTangentAt(i / n);
    o.position.set(p.x, BOARD + 0.0055, p.z);
    o.rotation.set(0, Math.atan2(-t.z, t.x), 0);
    o.updateMatrix();
    sleepers.setMatrixAt(i, o.matrix);
  }
  sleepers.castShadow = sleepers.receiveShadow = true;
  scene.add(sleepers);
  // Rails as thin tubes either side of the centre line.
  for (const k of [-1, 1]) {
    const pts = Array.from({ length: 400 }, (_, i) => {
      const u = i / 400;
      const p = trackPath.getPointAt(u);
      const s = trackSide(u);
      return new THREE.Vector3(p.x + s.x * k * (L.gauge / 2), BOARD + 0.01, p.z + s.z * k * (L.gauge / 2));
    });
    const rail = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 400, 0.0022, 5, true), M.rail);
    rail.castShadow = true;
    scene.add(rail);
  }
}

// ------------------------------------------------------------------ mountain
const Mt = LAYOUT.mountain;
const ARCH_R = 0.042; // tunnel mouth radius
// The hill (models.js): a heightfield with ridges, rock and trees.
const hill = models.buildHill(scene, Mt, BOARD);
// True where the hill stands at least a tunnel mouth high over a point on
// the board: the track there is inside the tunnel.
function inMountain(x, z) {
  return hill.heightAt(x, z) > ARCH_R * 1.5;
}
{
  // Tunnel mouths where the track goes in and out, square to the track.
  const N = 800;
  for (let i = 0; i < N; i++) {
    const u0 = i / N;
    const u1 = (i + 1) / N;
    const a = trackPath.getPointAt(u0);
    const b = trackPath.getPointAt(u1);
    const ina = inMountain(a.x, a.z);
    if (ina === inMountain(b.x, b.z)) continue;
    // Outward: the direction of travel when leaving, reversed when entering.
    const t = trackPath.getTangentAt(u0).multiplyScalar(ina ? 1 : -1);
    const g = models.tunnelMouth(scene, ARCH_R);
    g.position.set((a.x + b.x) / 2, BOARD, (a.z + b.z) / 2);
    g.rotation.y = Math.atan2(-t.z, t.x); // local +x = outward
  }
}

// --------------------------------------------------------------------- train
// Engine, tender and three coaches (models.js), each a group whose +x is its
// direction of travel, with its distance behind the engine (offset).
const train = models.buildTrain();
for (const car of train) scene.add(car.g);
// Smoke: a small pool of puffs, recycled; one leaves the chimney every
// so often, then rises, swells and fades.
const puffs = Array.from({ length: 30 }, () => {
  const m = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0xf4f1ec, transparent: true, opacity: 0, roughness: 1, depthWrite: false }));
  m.visible = false;
  scene.add(m);
  return { m, age: 99, life: 2.4, drift: new THREE.Vector3() };
});
let puffTimer = 0;

// ----------------------------------------------------------------- team arc
const teamSpots = []; // world positions of each platform's centre, for the camera
let teamCount = Math.min(4, TEAM_DATA.length);
const stage = new THREE.Group();
scene.add(stage);
// The team's total score, on a card placard standing on the stage in front
// of its platform. Luke: "a total score for the team, which should update as
// the team score changes. Perhaps just once at the end of each change... at
// the centre of the stage in front of each team." So it changes when a
// category finishes, not while the pedestals are still rising
// (teamPodium.js teamShown). It stays on the ground when the platform rises.
const SIGN = { w: 0.15, h: 0.06, lean: 0.35 };
const TEAM_WORDS = ['One', 'Two', 'Three', 'Four'];
function teamSign(i) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 205;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const geo = new THREE.PlaneGeometry(SIGN.w, SIGN.h);
  geo.translate(0, SIGN.h / 2, 0); // pivot at the bottom edge, where it stands
  // Unlit: it's drawn in the sharp pass (SHARP_LAYER), where the room's
  // lights don't reach (layers filter lights too).
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, color: 0xe6e0d6 }));
  mesh.rotation.x = -SIGN.lean; // leaning back, like a placard propped up
  mesh.layers.set(SHARP_LAYER);
  let shown = null;
  function draw(score) {
    const text = score == null ? '–' : String(Math.round(score * 10) / 10);
    if (text === shown) return;
    shown = text;
    const g = c.getContext('2d');
    // Cardboard, with a darker rim and the odd fibre.
    g.fillStyle = '#c9a26e';
    g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = '#8d6b42';
    g.lineWidth = 14;
    g.strokeRect(7, 7, c.width - 14, c.height - 14);
    g.fillStyle = '#3a2410';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // The handwriting font has no bold, so the strokes are thickened by
    // outlining each letter in its own colour (Luke: "make the text a
    // little thicker").
    g.strokeStyle = '#3a2410';
    g.lineJoin = 'round';
    g.font = "76px 'Sue Ellen Francisco', cursive";
    g.lineWidth = 5;
    const name = `Team ${TEAM_WORDS[i] ?? i + 1}`;
    g.strokeText(name, c.width * 0.33, c.height * 0.52);
    g.fillText(name, c.width * 0.33, c.height * 0.52);
    g.font = "150px 'Sue Ellen Francisco', cursive";
    g.lineWidth = 8;
    g.strokeText(text, c.width * 0.79, c.height * 0.55);
    g.fillText(text, c.width * 0.79, c.height * 0.55);
    tex.needsUpdate = true;
  }
  document.fonts?.load("150px 'Sue Ellen Francisco'").then(() => {
    const keep = shown;
    shown = null;
    draw(keep === '–' || keep == null ? null : Number(keep));
  });
  draw(null);
  return { mesh, draw };
}

let stageBuild = 0;
const teams = []; // per team: { g: its spot on the arc, podium: once loaded }
function buildStage() {
  stageBuild++;
  stage.clear();
  teamSpots.length = 0;
  teams.length = 0;
  const A = LAYOUT.arc;
  const span = THREE.MathUtils.degToRad(A.spanDeg);
  // A cardboard stage under the whole arc: a fat ring segment.
  const outerR = A.radius + A.platform.d / 2 + 0.05;
  const innerR = A.radius - A.platform.d / 2 - 0.05;
  const shape = new THREE.Shape();
  const a0 = -span / 2 - 0.12;
  const a1 = span / 2 + 0.12;
  shape.absarc(0, 0, outerR, a0, a1, false);
  shape.absarc(0, 0, innerR, a1, a0, true);
  const deckGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.04, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 1, curveSegments: 48 });
  // UVs from ExtrudeGeometry are in metres; scale the card grain to suit.
  const uvs = deckGeo.attributes.uv;
  for (let i = 0; i < uvs.count; i++) uvs.setXY(i, uvs.getX(i) * 3, uvs.getY(i) * 3);
  const deck = new THREE.Mesh(deckGeo, M.stage);
  // Shape is drawn in x/y round +x; turn it to lie flat, opening toward the camera.
  deck.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
  deck.position.set(0, BOARD, A.centreZ);
  deck.castShadow = deck.receiveShadow = true;
  stage.add(deck);
  for (let i = 0; i < teamCount; i++) {
    const a = teamCount === 1 ? 0 : -span / 2 + (i / (teamCount - 1)) * span;
    const x = Math.sin(a) * A.radius;
    const z = A.centreZ - Math.cos(a) * A.radius;
    const g = new THREE.Group();
    g.position.set(x, BOARD + 0.044, z);
    g.rotation.y = -a; // faces the arc's centre (and so the camera)
    // The team's real victory platform, scaled from the victory stage's
    // own units to this spot (arriving once its models have loaded).
    const forBuild = stageBuild;
    // A cardboard riser under the platform, grown to whatever height the
    // reveal has lifted it, so a raised platform stands on something
    // rather than floating.
    const riser = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), M.stage);
    riser.scale.set(A.platform.w * 0.94, 0.0001, A.platform.d * 0.94);
    riser.visible = false;
    riser.castShadow = riser.receiveShadow = true;
    g.add(riser);
    const sign = teamSign(i);
    sign.mesh.position.set(0, 0, A.platform.d / 2 + 0.035);
    g.add(sign.mesh);
    const team = { g, riser, sign, baseY: g.position.y, basePos: g.position.clone(), baseRot: g.rotation.y, podium: null };
    teams.push(team);
    buildTeamPodium(TEAM_DATA[i]).then((podium) => {
      if (forBuild !== stageBuild) return; // the team count changed meanwhile
      podium.group.scale.setScalar(A.platform.w / PODIUM.baseWidth);
      podium.pose(-1, 0); // hidden and flat until its turn
      g.add(podium.group);
      team.podium = podium;
    });
    stage.add(g);
    // The camera looks at about avatar height.
    teamSpots.push(new THREE.Vector3(x, BOARD + 0.11, z));
  }
}
buildStage();

// ---------------------------------------------------------------- town, trees
// Buildings (models.js): long side along x, front facing +z (the camera).
const buildings = [
  // The town, inside the loop behind the stage.
  { x: -0.32, z: -0.4, w: 0.13, d: 0.08, h: 0.07, wall: 0xe8d9b8, roof: 0xa8462f, shop: 'BAKERY', awning: ['#b8402f', '#f2e8d4'] },
  { x: -0.16, z: -0.42, w: 0.1, d: 0.08, h: 0.11, wall: 0xb5674a, roof: 0x4a4f57, pitched: false },
  { x: -0.02, z: -0.4, w: 0.12, d: 0.08, h: 0.08, wall: 0xd9b45e, roof: 0x3d6b4a, shop: 'GROCER', awning: ['#3d6b4a', '#f2e8d4'], door: 0x2f4a3a },
  { x: 0.13, z: -0.42, w: 0.1, d: 0.09, h: 0.14, wall: 0x8fa3b0, roof: 0x3a3a40, pitched: false },
  { x: 0.28, z: -0.4, w: 0.12, d: 0.08, h: 0.075, wall: 0xe8d9b8, roof: 0x2f3d4c, shop: 'POST OFFICE', door: 0xa8362a },
  { x: 0.46, z: -0.42, w: 0.16, d: 0.08, h: 0.09, wall: 0xb5674a, roof: 0x5a3b26, shop: 'HOTEL' },
  { x: 0.62, z: -0.3, w: 0.1, d: 0.08, h: 0.065, wall: 0xd9cfa8, roof: 0xa8462f, rot: -0.5 },
  { x: -0.12, z: -0.27, w: 0.08, d: 0.06, h: 0.055, wall: 0xc9a23a, roof: 0x7a5a8a, shop: 'CAFE', awning: ['#7a5a8a', '#f2e8d4'] },
  { x: 0.36, z: -0.27, w: 0.08, d: 0.06, h: 0.06, wall: 0xe0c9a0, roof: 0x3d6b4a },
];
{
  for (const b of buildings) models.building({ ...b, y: BOARD }, scene);
  // The road along the front of the town: tarmac with a dashed centre line,
  // lamp posts along it, a couple of parked cars.
  const roadTex = canvasTex(256, 32, (g, w, h) => {
    g.fillStyle = '#6e6b67';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 300; i++) {
      g.fillStyle = `rgba(${rand() < 0.5 ? '40,40,40' : '150,148,140'},0.25)`;
      g.fillRect(rand() * w, rand() * h, 2, 2);
    }
    g.fillStyle = '#e8e2cc';
    for (let x = 4; x < w; x += 32) g.fillRect(x, h / 2 - 1, 18, 2);
  }, 1);
  roadTex.repeat.set(8, 1);
  box(1.0, 0.003, 0.05, mat(0xffffff, { map: roadTex, roughness: 0.9 }), 0.14, BOARD + 0.0015, -0.33);
  for (const k of [-1, 1]) box(1.0, 0.004, 0.006, card(0xb0aa9c), 0.14, BOARD + 0.002, -0.33 + k * 0.028); // kerbs
  for (let x = -0.3; x <= 0.6; x += 0.15) models.lampPost(scene, x, BOARD, -0.33 + 0.034);
  const carsGroup = new THREE.Group();
  carsGroup.position.y = BOARD + 0.003;
  scene.add(carsGroup);
  models.car(carsGroup, -0.22, -0.344, 0, 0xc0392b);
  models.car(carsGroup, 0.4, -0.316, Math.PI, 0x2f5a8a);
  // The station by the back straight.
  const st = models.station(scene, 0.36, L.zBack + 0.052, 0.28, 0.04);
  st.position.y = BOARD;

  // Greenery: pines, leafy trees and bushes on the free ground, then grass
  // tufts and flowers scattered over it.
  const free = (x, z, margin) => {
    // Keep clear of the stage, the track, the hill, the town, road, station.
    if (Math.hypot(x, z - LAYOUT.arc.centreZ) < LAYOUT.arc.radius + 0.17 + margin && z < 0.42) return false;
    const near = trackPath.getPointAt(nearestU(x, z));
    if (Math.hypot(near.x - x, near.z - z) < 0.045 + margin) return false;
    if (((x - Mt.x) / (Mt.rx * 1.05)) ** 2 + ((z - Mt.z) / (Mt.rz * 1.05)) ** 2 < 1) return false;
    if (buildings.some((b) => Math.abs(x - b.x) < b.w / 2 + 0.02 + margin && Math.abs(z - b.z) < b.d / 2 + 0.02 + margin)) return false;
    if (Math.abs(z + 0.33) < 0.035 + margin && x > -0.38 && x < 0.66) return false;
    if (z < L.zBack + 0.09 && z > L.zBack && x > 0.2 && x < 0.52) return false;
    return true;
  };
  let placed = 0;
  for (let tries = 0; tries < 2500 && placed < 110; tries++) {
    const x = (rand() * 2 - 1) * (BX - 0.03);
    const z = (rand() * 2 - 1) * (BZ - 0.03);
    if (!free(x, z, 0.01)) continue;
    // Nothing tall in front of the stage: that ground stays open, so the
    // front straight and the train on it are never hidden.
    const front = (z > -0.05 && Math.abs(x) < 0.66) || z > L.zFront - 0.06;
    const r = rand();
    if (front && r < 0.85) continue;
    const t = front ? models.bush(0.8 + rand() * 0.6) : r < 0.55 ? models.pine(0.7 + rand() * 0.7) : r < 0.85 ? models.broadleaf(0.7 + rand() * 0.6) : models.bush(0.8 + rand() * 0.8);
    t.position.set(x, BOARD, z);
    t.rotation.y = rand() * Math.PI * 2;
    scene.add(t);
    placed++;
  }
  const grass = [];
  const flowers = [];
  for (let tries = 0; tries < 9000; tries++) {
    const x = (rand() * 2 - 1) * (BX - 0.01);
    const z = (rand() * 2 - 1) * (BZ - 0.01);
    if (!free(x, z, -0.01)) continue;
    grass.push([x, BOARD, z]);
    // Flowers in small patches: a few near each seed point.
    if (rand() < 0.03) for (let k = 0; k < 8; k++) flowers.push([x + (rand() - 0.5) * 0.03, BOARD, z + (rand() - 0.5) * 0.03]);
  }
  models.scatter(scene, grass, 'grass');
  models.scatter(scene, flowers, 'flowers');
}
// The track parameter nearest a board point (coarse, for tree placement).
function nearestU(x, z) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < 200; i++) {
    const p = trackPath.getPointAt(i / 200);
    const dd = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (dd < bestD) {
      bestD = dd;
      best = i / 200;
    }
  }
  return best;
}

function mulberry32(seed) {
  return function next() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// -------------------------------------------------------------------- camera
// The overview: in front of the table, a little above it, looking down at
// the stage, close enough that only the table's edges show at the sides.
const VIEW = {
  overview: { pos: new THREE.Vector3(0, TOP + 0.85, 2.1), look: new THREE.Vector3(0, TOP + 0.1, -0.1) },
};
// A team's view: the overview, turned and moved slightly toward that team
// ("the camera will pan slightly to each team in turn").
// Close enough that names and scores read on a projector: the camera comes
// in along the line from the team to the arc's centre (the way the team
// faces), a little above it.
function teamView(i) {
  const s = teamSpots[i];
  const toward = new THREE.Vector3(-s.x, 0, LAYOUT.arc.centreZ - s.z).normalize();
  return {
    pos: s.clone().addScaledVector(toward, 0.95).add(new THREE.Vector3(0, 0.32, 0)).lerp(VIEW.overview.pos, 0.15),
    look: s.clone(),
  };
}
const cam = { pos: VIEW.overview.pos.clone(), look: VIEW.overview.look.clone(), from: null, to: null, t: 1 };
function goTo(view, seconds = 1.6) {
  cam.from = { pos: cam.pos.clone(), look: cam.look.clone() };
  cam.to = view;
  cam.t = 0;
  cam.seconds = seconds;
}

const controls = new OrbitControls(camera, renderer.domElement);
controls.enabled = false;
controls.target.copy(cam.look);

// ------------------------------------------------------------------ controls
// The test controls. Hidden (Luke: remove "the values in the top left"),
// so the page shows only the scene; press D to show or hide them.
const panel = document.createElement('div');
panel.style.cssText = 'position:absolute;top:8px;left:8px;z-index:5;display:none;flex-wrap:wrap;gap:4px;max-width:70%';
panel.className = 'mt-panel';
if (!document.getElementById('mt-panel-css')) {
  const st = document.createElement('style');
  st.id = 'mt-panel-css';
  st.textContent = '.mt-panel button.on { background: #c9813a !important; color: #1d1712 !important; }';
  document.head.appendChild(st);
}
if (demo) {
  container.appendChild(panel);
  listen(window, 'keydown', (e) => {
    if (e.key === 'd' || e.key === 'D') panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
  });
}
function button(text, onClick) {
  const b = document.createElement('button');
  b.textContent = text;
  b.style.cssText = 'padding:4px 9px;border:0;border-radius:4px;background:rgba(20,14,8,0.8);color:#f3e6cf;cursor:pointer;font:13px system-ui,sans-serif';
  b.onclick = () => onClick(b);
  panel.appendChild(b);
  return b;
}
const viewButtons = [];
function setActive(b) {
  for (const x of viewButtons) x.classList.toggle('on', x === b);
}
function free(on) {
  controls.enabled = on;
  if (on) {
    camera.position.copy(cam.pos);
    controls.target.copy(cam.look);
    cam.t = 1;
  }
}
function rebuildViewButtons() {
  for (const b of viewButtons.splice(0)) b.remove();
  const ov = button('Overview', (b) => {
    free(false);
    goTo(VIEW.overview);
    setActive(b);
  });
  viewButtons.push(ov);
  for (let i = 0; i < teamCount; i++) {
    viewButtons.push(
      button(`Team ${i + 1}`, (b) => {
        free(false);
        goTo(teamView(i));
        setActive(b);
      }),
    );
  }
  viewButtons.push(
    button('Free look (drag)', (b) => {
      free(true);
      setActive(b);
    }),
  );
  setActive(ov);
}
button(`Teams: ${teamCount}`, (b) => {
  teamCount = (teamCount % Math.min(4, TEAM_DATA.length)) + 1;
  b.textContent = `Teams: ${teamCount}`;
  buildStage();
  rebuildViewButtons();
  playReveal();
});

// ------------------------------------------------------------------ reveal
// Luke, 2026-10-06: "the camera will pan slightly to each team in turn,
// which will have its platform raise a bit, and then have each player pop
// up, as they do now. At the end, the winning team will be raised higher and
// the avatars will wobble around on their daises as if crudely dancing."
// Then: "speed *1.5, and any empty categories (i.e. no one on the team got
// any points) can be skipped. Also, if two teams win... bring their
// platforms to the front... a simple animation to move them to the
// foreground. Finally, add fireworks above the winning team(s)."
//
// One clock (reveal.t, seconds) drives everything, so any moment of the
// sequence can be shown just by setting it, and Skip simply jumps it to the
// end. For each team in turn, from the moment its turn starts: the camera
// moves to it, its platform rises, its players pop up one by one, then its
// pedestals rise through the categories somebody on the team scored in
// (teamPodium.js, the game's own stage timings), then a pause. So turns
// differ in length. After the last team: back to the overview; tied winners
// slide forward onto the open ground in front of the stage; the winners
// rise higher, dance, and fireworks go up over them. Times are seconds into
// a team's turn, or into the finale; all of it plays at reveal.speed
// (1.5 by default).
const REVEAL = {
  openHold: 1.0, // on the overview before the first team
  camMove: 1.6,
  raiseAt: 1.0,
  raiseS: 0.8,
  raiseBy: 0.035, // metres
  popAt: 1.9,
  stagesAt: 3.0,
  holdAfter: 1.6,
  // Finale, seconds after the camera starts back to the overview.
  frontAt: 0.8, // tied winners start forward
  frontS: 2.2,
  frontZ: 0.3, // where they line up: the open ground in front of the stage
  frontGap: 0.06, // between their platforms
  winnerRaiseS: 1.6,
  winnerRaiseBy: 0.08,
  danceAfterRaise: 0.6,
  fireworksAfterRaise: 0.2,
};
const DEFAULT_SPEED = 1.5;
const turnLength = (tm) => REVEAL.stagesAt + (tm.podium?.stagesMs ?? 0) / 1000 + REVEAL.holdAfter;
// When each team's turn starts, and when the finale does.
function turnStarts() {
  const starts = [];
  let t = REVEAL.openHold;
  for (const tm of teams) {
    starts.push(t);
    t += turnLength(tm);
  }
  return { starts, end: t };
}
const revealEnd = () => turnStarts().end;
const reveal = { t: 0, playing: false, speed: DEFAULT_SPEED, shot: null, fireworkTimer: 0 };
const smooth = (x) => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};
function playReveal() {
  reveal.t = 0;
  reveal.playing = true;
  reveal.shot = null;
  free(false);
}
// The winners: the best team score (each team's average, guide included);
// a tie makes every team on it a winner.
function winners() {
  const scores = teams.map((tm) => tm.podium?.teamScore ?? -1);
  const best = Math.max(...scores);
  return scores.map((x) => x === best);
}
// Finale timings, which depend on whether winners first move forward.
function finaleTimes(tied) {
  const raiseAt = tied ? REVEAL.frontAt + REVEAL.frontS + 0.2 : 1.2;
  return { raiseAt, danceAt: raiseAt + REVEAL.danceAfterRaise, fireworksAt: raiseAt + REVEAL.fireworksAfterRaise };
}
// Where tied winners line up: side by side in front of the stage, facing
// the camera, in their order along the arc.
function frontSpot(rank, count) {
  const w = LAYOUT.arc.platform.w + REVEAL.frontGap;
  return new THREE.Vector3((rank - (count - 1) / 2) * w, BOARD, REVEAL.frontZ);
}
// The finale's camera: the overview, but looking a little forward when the
// winners have come to the front, so they sit in the sharp band.
function finaleView(tied) {
  if (!tied) return VIEW.overview;
  return { pos: VIEW.overview.pos.clone().add(new THREE.Vector3(0, -0.08, -0.25)), look: new THREE.Vector3(0, TOP + 0.1, REVEAL.frontZ - 0.1) };
}
function applyReveal(time) {
  const t = reveal.t;
  const { starts, end } = turnStarts();
  const win = winners();
  const winCount = win.filter(Boolean).length;
  const tied = winCount > 1;
  const F = finaleTimes(tied);
  const f = t - end; // seconds into the finale
  // Which shot the camera should be on: a team's, or the overview.
  let turnIndex = -1;
  if (t >= REVEAL.openHold && t < end) turnIndex = starts.findLastIndex((st) => t >= st);
  if (reveal.playing && turnIndex !== reveal.shot && !controls.enabled) {
    reveal.shot = turnIndex;
    goTo(turnIndex < 0 ? (f > 0 ? finaleView(tied) : VIEW.overview) : teamView(turnIndex), REVEAL.camMove);
  }
  let rank = 0;
  teams.forEach((tm, i) => {
    if (!tm.podium) return;
    const local = t - starts[i];
    // Forward to the front (tied winners only), turning to face the camera.
    const k = win[i] && tied && f > 0 ? smooth((f - REVEAL.frontAt) / REVEAL.frontS) : 0;
    const spot = win[i] && tied ? frontSpot(rank++, winCount) : null;
    const ground = spot ? THREE.MathUtils.lerp(tm.baseY, BOARD, k) : tm.baseY;
    let y = ground;
    if (local >= 0) y += REVEAL.raiseBy * smooth((local - REVEAL.raiseAt) / REVEAL.raiseS);
    if (win[i] && f > 0) y += REVEAL.winnerRaiseBy * smooth((f - F.raiseAt) / REVEAL.winnerRaiseS);
    if (spot) {
      tm.g.position.x = THREE.MathUtils.lerp(tm.basePos.x, spot.x, k);
      tm.g.position.z = THREE.MathUtils.lerp(tm.basePos.z, spot.z, k);
      tm.g.rotation.y = THREE.MathUtils.lerp(tm.baseRot, 0, k);
    } else {
      tm.g.position.x = tm.basePos.x;
      tm.g.position.z = tm.basePos.z;
      tm.g.rotation.y = tm.baseRot;
    }
    tm.g.position.y = y;
    // The riser fills from the ground under it (the deck, or the grass once
    // it has come forward) up to the platform.
    const lift = y - ground;
    tm.riser.visible = lift > 0.0005;
    tm.riser.scale.y = Math.max(0.0001, lift);
    tm.riser.position.y = -lift / 2;
    if (local < 0) tm.podium.pose(-1, 0);
    else tm.podium.pose(local - REVEAL.popAt, Math.max(0, (local - REVEAL.stagesAt) * 1000), local < turnLength(tm));
    // The placard stays on the ground under a raised platform.
    tm.sign.mesh.position.y = -lift;
    tm.sign.draw(local < REVEAL.popAt ? null : tm.podium.teamShown);
    if (win[i] && f > 0) tm.podium.dance(time, smooth((f - F.danceAt) / 0.8));
  });
  return { fireworks: f > F.fireworksAt, win };
}
// Fireworks: while the finale's fireworks are on, a rocket goes up over a
// winning platform every so often, taking turns between winners.
const fireworks = createFireworks(scene, rand);
let fireworkTurn = 0;
function stepFireworks(dt, on, win) {
  fireworks.update(dt);
  if (!on) return;
  reveal.fireworkTimer -= dt;
  if (reveal.fireworkTimer > 0) return;
  reveal.fireworkTimer = 0.45 + rand() * 0.5;
  const winners = teams.filter((_, i) => win[i]);
  const tm = winners[fireworkTurn++ % winners.length];
  const from = tm.g.getWorldPosition(new THREE.Vector3());
  from.x += (rand() - 0.5) * LAYOUT.arc.platform.w * 0.8;
  fireworks.launch(from, 0.35 + rand() * 0.2);
}
button('▶ Play reveal', () => playReveal());
playReveal(); // starts on load (its clock waits for the platforms to load)
button('Skip to end', () => {
  reveal.t = revealEnd() + finaleTimes(winners().filter(Boolean).length > 1).danceAt + 0.5;
  reveal.shot = -1;
  goTo(finaleView(winners().filter(Boolean).length > 1));
});
// Speeds relative to the default (Luke: "speed *1.5").
button(`Speed: ${DEFAULT_SPEED}x`, (b) => {
  const speeds = [DEFAULT_SPEED, DEFAULT_SPEED * 2, DEFAULT_SPEED * 4, 1];
  reveal.speed = speeds[(speeds.indexOf(reveal.speed) + 1) % speeds.length];
  b.textContent = `Speed: ${reveal.speed}x`;
});
// Test: make the first two teams draw, to see tied winners come forward.
let forceTie = false;
button('Test: tie', (b) => {
  forceTie = !forceTie;
  b.classList.toggle('on', forceTie);
  const top = Math.max(...teams.map((tm) => tm.podium?.realScore ?? tm.podium?.teamScore ?? 0));
  teams.forEach((tm, i) => {
    if (!tm.podium) return;
    tm.podium.realScore ??= tm.podium.teamScore;
    tm.podium.teamScore = forceTie && i < 2 ? top + 1 : tm.podium.realScore;
  });
  playReveal();
});
// ---------------------------------------------------------------- tilt-shift
// Luke, 2026-10-06: "Add the tilt-shift blur", the photographer's trick that
// makes real places look like models, and the strongest single cue that
// this is a miniature. A sharp band across the picture at the height of
// whatever the camera is looking at (the stage, or the team it has panned
// to), blurring more and more above and below it. Done on the finished
// picture (screen space) rather than by depth, as a real tilt-shift lens
// does, which is what gives the look; three's own tilt-shift shaders have no
// sharp band (the blur starts at a line), hence this one.
const TILT = { band: 0.1, ramp: 0.3, maxStep: 1.7, passes: 2 }; // band/ramp in screen heights; maxStep in px per tap
const TiltShader = {
  uniforms: {
    tDiffuse: { value: null },
    dir: { value: new THREE.Vector2() }, // one pixel along the blur direction, in UV
    focus: { value: 0.5 }, // the sharp band's centre, 0 bottom .. 1 top
    band: { value: TILT.band },
    ramp: { value: TILT.ramp },
    maxStep: { value: TILT.maxStep },
  },
  vertexShader: `varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 dir; uniform float focus, band, ramp, maxStep;
    varying vec2 vUv;
    void main() {
      // Half strength above the band: the view out of the window should
      // stay recognisable as a city, not dissolve into dots.
      float k = smoothstep(band, band + ramp, abs(vUv.y - focus)) * (vUv.y > focus ? 0.5 : 1.0);
      vec2 st = dir * maxStep * k;
      vec4 sum = texture2D(tDiffuse, vUv) * 0.1633;
      sum += (texture2D(tDiffuse, vUv - st) + texture2D(tDiffuse, vUv + st)) * 0.1531;
      sum += (texture2D(tDiffuse, vUv - 2.0 * st) + texture2D(tDiffuse, vUv + 2.0 * st)) * 0.12245;
      sum += (texture2D(tDiffuse, vUv - 3.0 * st) + texture2D(tDiffuse, vUv + 3.0 * st)) * 0.0918;
      sum += (texture2D(tDiffuse, vUv - 4.0 * st) + texture2D(tDiffuse, vUv + 4.0 * st)) * 0.051;
      gl_FragColor = sum;
    }`,
};
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// Glow on the city's lights (neon, car lights, traffic). Its threshold sits
// well above anything the room's lighting can reach, so only the city's
// deliberately over-bright lights (cyberCity.js GLOW) bloom; the room and
// the model stay exactly as they were.
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.25, 3.0);
composer.addPass(bloom);
const tiltPasses = [];
for (let i = 0; i < TILT.passes; i++) {
  for (const axis of ['x', 'y']) {
    const pass = new ShaderPass(TiltShader);
    pass.axis = axis;
    composer.addPass(pass);
    tiltPasses.push(pass);
  }
}
// Text must stay readable (Luke: "the tilt-cam blurring is blurring the
// player's name tags: it's important that they be legible", and then of the
// team placards, "They're blurry. Make sure they're in focus"), so name tags
// and placards live on their own layer, which the main render skips, and are
// drawn sharp on top once the blur is done. The scene's depth is laid down
// again first (no colour), so a placard can still be hidden by whatever
// stands in front of it (a winning platform coming forward, say). Name tags
// skip that test: they sit above everything near them.
const sharpCam = new THREE.PerspectiveCamera();
sharpCam.layers.set(SHARP_LAYER);
class SharpPass extends Pass {
  constructor() {
    super();
    this.needsSwap = false;
    this.depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false });
  }
  render(r, writeBuffer, readBuffer) {
    const autoClear = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(readBuffer);
    r.clearDepth();
    scene.overrideMaterial = this.depthOnly;
    r.render(scene, camera);
    scene.overrideMaterial = null;
    r.render(scene, sharpCam);
    r.autoClear = autoClear;
  }
}
composer.addPass(new SharpPass());
composer.addPass(new OutputPass());
function syncSharpCam() {
  sharpCam.copy(camera, false);
  sharpCam.layers.set(SHARP_LAYER);
}
let tiltOn = true;
function sizeTilt() {
  const w = VW() * renderer.getPixelRatio();
  const h = VH() * renderer.getPixelRatio();
  for (const p of tiltPasses) p.uniforms.dir.value.set(p.axis === 'x' ? 1 / w : 0, p.axis === 'y' ? 1 / h : 0);
}
// The band follows the camera's point of interest, projected to the screen.
const focusPoint = new THREE.Vector3();
function render() {
  camera.updateMatrixWorld(); // project() reads the camera's matrices, which otherwise update only during the render
  syncSharpCam();
  if (!tiltOn) {
    renderer.autoClear = false;
    renderer.clear();
    renderer.render(scene, camera);
    renderer.render(scene, sharpCam); // the depth from the main render is still there
    renderer.autoClear = true;
    return;
  }
  focusPoint.copy(controls.enabled ? controls.target : cam.look).project(camera);
  const f = THREE.MathUtils.clamp((focusPoint.y + 1) / 2, 0, 1);
  for (const p of tiltPasses) p.uniforms.focus.value = f;
  composer.render();
}
button('Tilt-shift', (b) => {
  tiltOn = !tiltOn;
  b.classList.toggle('on', tiltOn);
}).classList.add('on');

rebuildViewButtons();

// --------------------------------------------------------------------- loop
function resize() {
  renderer.setSize(VW(), VH());
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(VW(), VH());
  bloom.resolution.set(VW(), VH());
  sizeTilt();
  camera.aspect = VW() / VH();
  camera.updateProjectionMatrix();
}
listen(window, 'resize', resize);
resize();

let trainDist = 0;
const ease = (t) => t * t * (3 - 2 * t);
const tmp = new THREE.Vector3();
function placeTrain() {
  for (const car of train) {
    const u = (((trainDist - car.offset) % trackLen) + trackLen) % trackLen / trackLen;
    const p = trackPath.getPointAt(u);
    const t = trackPath.getTangentAt(u);
    car.g.position.set(p.x, BOARD + 0.0105, p.z); // wheels on the rail tops
    car.g.rotation.y = Math.atan2(-t.z, t.x);
    car.roll(trainDist - car.offset);
  }
}
let clockS = 0;
function step(dt) {
  clockS += dt;
  // The reveal's clock runs only once every team's platform has loaded, so
  // nobody's turn passes while their models are still on the way.
  if (teams.length && teams.every((tm) => tm.podium)) {
    if (reveal.playing) reveal.t += dt * reveal.speed;
    const r = applyReveal(clockS);
    stepFireworks(dt * reveal.speed, r.fireworks, r.win);
  }
  city?.update(dt);
  trainDist = (trainDist + LAYOUT.trainSpeed * dt) % trackLen;
  placeTrain();
  // Smoke, only while the engine is out in the open.
  const engine = train[0];
  puffTimer -= dt;
  if (puffTimer <= 0 && !inMountain(engine.g.position.x, engine.g.position.z)) {
    puffTimer = 0.22;
    const p = puffs.find((q) => q.age >= q.life);
    if (p) {
      p.age = 0;
      p.m.position.copy(engine.chimney).applyMatrix4(engine.g.matrixWorld);
      p.drift.set((rand() - 0.5) * 0.01, 0.045 + rand() * 0.02, (rand() - 0.5) * 0.01);
      p.m.visible = true;
    }
  }
  for (const p of puffs) {
    if (p.age >= p.life) continue;
    p.age += dt;
    const k = p.age / p.life;
    p.m.position.addScaledVector(p.drift, dt);
    p.m.scale.setScalar(0.006 + k * 0.022);
    p.m.material.opacity = 0.85 * (1 - k) * Math.min(1, p.age * 8);
    if (p.age >= p.life) p.m.visible = false;
  }
}

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(0.05, clock.getDelta());
  step(dt);
  if (controls.enabled) controls.update();
  else {
    if (cam.t < 1) {
      cam.t = Math.min(1, cam.t + (dt * (reveal.playing ? reveal.speed : 1)) / (cam.seconds ?? 1.6));
      const e = ease(cam.t);
      cam.pos.lerpVectors(cam.from.pos, cam.to.pos, e);
      cam.look.lerpVectors(cam.from.look, cam.to.look, e);
    }
    camera.position.copy(cam.pos);
    camera.lookAt(cam.look);
  }
  render();
  rafId = requestAnimationFrame(frame);
}
let rafId = requestAnimationFrame(frame);

if (demo) {
// Debug: a frame as a data URL (POST to the dev server's /__shot to save).
window.__capture = () => {
  render();
  return renderer.domElement.toDataURL('image/png');
};
window.__view = (name) => {
  const v = name === 'overview' ? VIEW.overview : teamView(name);
  cam.pos.copy(v.pos);
  cam.look.copy(v.look);
  cam.t = 1;
  camera.position.copy(cam.pos);
  camera.lookAt(cam.look);
};
// Debug: look from any point at any point, e.g. out of the window.
window.__look = (px, py, pz, tx, ty, tz) => {
  cam.pos.set(px, py, pz);
  cam.look.set(tx, ty, tz);
  cam.t = 1;
  camera.position.copy(cam.pos);
  camera.lookAt(cam.look);
};
// Debug: hold the reveal at t seconds (camera untouched; see REVEAL for the
// timings, e.g. a team's turn starts at 1 + i * the turn length).
window.__revealAt = (t) => {
  reveal.t = t;
  reveal.playing = false;
  applyReveal(clockS);
};
window.__revealTimes = () => turnStarts();
// Debug: where the engine is now.
window.__enginePos = () => train[0].g.position.toArray();
// Debug: run the train (and its smoke) on by s seconds without waiting.
window.__advance = (s) => {
  for (let t = 0; t < s; t += 1 / 30) {
    step(1 / 30);
    scene.updateMatrixWorld();
  }
};
}

return {
  dispose() {
    cancelAnimationFrame(rafId);
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
    controls.dispose();
    composer.dispose?.();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
    panel.remove();
  },
};
}
