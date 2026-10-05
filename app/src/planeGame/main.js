/**
 * Paper Planes: a standalone minigame page (app/plane-game.html), set on the
 * edge of Sky Path's Temple Island. Written fresh from PAPER_PLANE_BRIEF.md.
 *
 * The loop of play, per throw:
 *   pick a plane (the picker gets out of the way once one is chosen)
 *   -> angle: a needle sweeps up and down; tap to stop it
 *   -> aim: press, drag (the arrow's direction is left/right, its length is
 *      power), let go to throw; drag back to the middle to cancel
 *   -> flight: the camera keeps the plane, its path and the target in view;
 *      hold anywhere to fast-forward
 *   -> result: words and a little map say what happened and why
 * Three throws per island, eight islands, best stars per island count.
 *
 * Module map:
 *   flight.js   the flight model (pure; shared with scripts/planeGameSim.mjs)
 *   course.js   targets, winds, scoring (pure; shared with the sim)
 *   world.js    Sky Path's sky, clouds and Temple Island
 *   islands.js  the target islands
 *   planes.js   the three paper planes
 *   effects.js  trail, shadow, thrower, wind particles
 *   results.js  a throw, in words
 *   ui.js       everything on screen that isn't 3D
 *
 * Variations Luke can switch between live are in the "Looks" panel (LOOKS
 * below). Deliberately few sliders: just wind strength and flight speed.
 */

import * as THREE from 'three';
import { buildWorld } from './world.js';
import { buildIsland, buildFlag, makeStarTexture } from './islands.js';
import { TARGETS, courseIslands, windVector, floorFor } from './course.js';
import { fly, PLANES, PLANE_ORDER, AIM, HAND, stateAt } from './flight.js';
import { buildPlane, posePlane, PLANE_COLORS } from './planes.js';
import { Trail, makePlaneShadow, makeThrower, makeWindParticles, makeLocator } from './effects.js';
import { buildUI } from './ui.js';
import { describeThrow, ICONS } from './results.js';

const THROWS_PER_ISLAND = 3;
const SWEEP_SECONDS = 1.15; // needle, bottom to top (one way)

// ------------------------------------------------------------------ looks

/**
 * The variations, each a real design choice to judge by eye (the brief's
 * "build two or three versions and let Luke switch"). Remembered per device.
 */
const LOOKS = {
  camera: {
    label: 'Flight camera',
    options: [
      ['director', 'Follow & frame'],
      ['chase', 'Chase'],
      ['side', 'Side on'],
    ],
  },
  wind: {
    label: 'Wind in the air',
    options: [
      ['streaks', 'Streaks'],
      ['petals', 'Petals'],
      ['flags', 'Flags only'],
    ],
  },
  paper: {
    label: 'Paper',
    options: [
      ['colour', 'Coloured'],
      ['notebook', 'Notebook'],
      ['plain', 'White'],
    ],
  },
  islands: {
    label: 'Target islands',
    options: [
      ['skypath', 'Sky Path'],
      ['stone', 'Stone target'],
    ],
  },
  results: {
    label: 'Paths shown',
    options: [
      ['ghosts', 'All throws here'],
      ['trail', 'Last throw only'],
    ],
  },
};
// Temporary tuning sliders (the brief allows "a few, for things that really
// need tuning by eye"). The sim proves the course at 1.0 for both.
const SLIDERS = {
  windScale: { label: 'Wind strength', min: 0.5, max: 1.5, step: 0.05 },
  flightSpeed: { label: 'Flight speed (playback)', min: 0.6, max: 1.6, step: 0.05 },
};
const settings = {
  camera: 'director',
  wind: 'streaks',
  // Coloured by default: white paper vanishes against the white cloud floor
  // (found in the first test throw).
  paper: 'colour',
  islands: 'skypath',
  results: 'ghosts',
  windScale: 1,
  flightSpeed: 1,
};
try {
  Object.assign(settings, JSON.parse(localStorage.getItem('pgSettings') || '{}'));
} catch {
  /* private mode etc.: defaults are fine */
}
const saveSettings = () => {
  try {
    localStorage.setItem('pgSettings', JSON.stringify(settings));
  } catch {
    /* ignore */
  }
};

// ------------------------------------------------------------------ renderer

const container = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.3, 3000);
camera.position.set(3, 2, -8);

function onResize() {
  const w = container.clientWidth;
  const h = container.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  // Portrait (phones held upright, before the rotate prompt is obeyed):
  // widen the view so the target still fits.
  camera.fov = w < h ? 68 : 50;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);

const manager = new THREE.LoadingManager();
const loader = new THREE.TextureLoader(manager);
const world = buildWorld({ scene, renderer, manager });

// ------------------------------------------------------------------ course

const islands = courseIslands(); // targets first, then scenery
const targetWind = () => {
  const t = TARGETS[S.targetIndex];
  const w = windVector(t.wind);
  return { x: w.x * settings.windScale, z: w.z * settings.windScale };
};

const starTex = makeStarTexture();
let islandHandles = [];
function buildIslands() {
  for (const h of islandHandles) scene.remove(h.group);
  islandHandles = islands.map((isl, i) => {
    const isTarget = i < TARGETS.length;
    const h = buildIsland(isl, {
      look: settings.islands,
      number: isTarget ? i + 1 : null,
      seed: i + 1,
      loader,
      towardThrower: { x: -isl.x, z: -isl.z },
    });
    scene.add(h.group);
    return h;
  });
  refreshIslandMarks();
}
function refreshIslandMarks() {
  islandHandles.forEach((h, i) => {
    if (i >= TARGETS.length) return;
    h.setCurrent(i === S.targetIndex);
    const tried = S.best[i] !== undefined;
    if (tried) h.setStars(S.best[i], starTex);
    // Flags: the current target's is up; finished ones lowered a little.
    if (h.flag) h.flag.group.scale.setScalar(i === S.targetIndex ? 1.25 : tried ? 0.7 : 0.9);
  });
}

// ------------------------------------------------------------------ state

const S = {
  phase: 'loading',
  targetIndex: 0,
  throwsUsed: 0,
  best: [],
  plane: null,
  angle: 0,
  sweepT: 0,
  turn: 0,
  power: 0,
  drag: null,
  flight: null,
  flightT: 0,
  flightDone: 0,
  cutAt: null,
  ff: false,
  replay: false,
  ghostEnds: [],
  ghostAngles: [],
  zeroStreak: 0,
  totalStars: () => S.best.reduce((a, b) => a + (b || 0), 0),
};

// ------------------------------------------------------------------ actors

const thrower = makeThrower(scene, loader, new URLSearchParams(location.search).get('figure') || 'woman1');
thrower.pivot.position.set(0, 0, 0.15);

// The thrower's own wind flag, on the rim beside them: the wind where the
// plane starts, as well as the one at the target.
const rimFlag = buildFlag('');
rimFlag.group.position.set(-2.3, 0, -0.5);
rimFlag.group.scale.setScalar(0.7);
scene.add(rimFlag.group);

const shadow = makePlaneShadow(scene);
const locator = makeLocator(scene);
const windFx = makeWindParticles(scene);

let handPlane = null; // the plane held before a throw
let flyingPlane = null;
const restingPlanes = []; // planes left lying where they landed
let trails = []; // current target's trails (ghosts)
let currentTrail = null;

function makeHandPlane() {
  if (handPlane) scene.remove(handPlane);
  handPlane = S.plane ? buildPlane(S.plane, settings.paper) : null;
  if (handPlane) scene.add(handPlane);
}

/** The aim line: which way the throw will go (direction only, never range). */
const aimLine = (() => {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 8;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 36, 8);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.set(14, 1);
  const L = 16;
  const geo = new THREE.PlaneGeometry(L, 0.07);
  geo.translate(L / 2, 0, 0);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ map: tex, color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false, fog: false });
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = 8;
  m.visible = false;
  scene.add(m);
  return m;
})();

// ------------------------------------------------------------------ UI

const ui = buildUI(container, {
  onPickPlane(key) {
    S.plane = key;
    ui.setPlane(key);
    ui.showPicker(false);
    makeHandPlane();
    if (S.phase === 'pick' || S.phase === 'intro') startAngle();
  },
  onOpenPicker() {
    if (S.phase === 'flight') return;
    if (S.phase === 'result') ui.showResult(null);
    ui.showPicker(true);
    S.phase = 'pick';
    ui.setGaugeMode('hidden');
    ui.showRedo(false);
    ui.setHint('');
  },
  onGaugeTap() {
    if (S.phase === 'angle') lockAngle();
  },
  onRedoAngle() {
    if (S.phase === 'aim') startAngle();
  },
});
buildLooksPanel();

function buildLooksPanel() {
  const p = ui.looks;
  p.innerHTML = '';
  for (const [key, def] of Object.entries(LOOKS)) {
    const grp = document.createElement('div');
    grp.className = 'grp';
    grp.innerHTML = `<div class="lbl">${def.label}</div><div class="opts"></div>`;
    const opts = grp.querySelector('.opts');
    for (const [val, label] of def.options) {
      const b = document.createElement('button');
      b.textContent = label;
      b.classList.toggle('sel', settings[key] === val);
      b.addEventListener('click', () => {
        settings[key] = val;
        saveSettings();
        applyLook(key);
        buildLooksPanel();
        ui.looks.classList.add('open');
      });
      opts.append(b);
    }
    p.append(grp);
  }
  const tmp = document.createElement('div');
  tmp.className = 'tmp';
  tmp.textContent = 'Temporary tuning (the course is proven at 1.0):';
  p.append(tmp);
  for (const [key, def] of Object.entries(SLIDERS)) {
    const wrap = document.createElement('label');
    wrap.className = 'slider';
    wrap.innerHTML = `<span>${def.label}: <b>${settings[key].toFixed(2)}</b></span><input type="range" min="${def.min}" max="${def.max}" step="${def.step}" value="${settings[key]}">`;
    const input = wrap.querySelector('input');
    input.addEventListener('input', () => {
      settings[key] = Number(input.value);
      wrap.querySelector('b').textContent = settings[key].toFixed(2);
      saveSettings();
      if (key === 'windScale') updateWindUI();
    });
    p.append(wrap);
  }
  const close = document.createElement('button');
  close.className = 'pgBtn';
  close.textContent = 'Close';
  close.addEventListener('click', () => ui.looks.classList.remove('open'));
  p.append(close);
}

function applyLook(key) {
  if (key === 'islands') buildIslands();
  if (key === 'paper') {
    makeHandPlane();
    for (const r of restingPlanes) {
      const fresh = buildPlane(r.userData.key, settings.paper);
      fresh.position.copy(r.position);
      fresh.quaternion.copy(r.quaternion);
      scene.remove(r);
      scene.add(fresh);
      restingPlanes[restingPlanes.indexOf(r)] = fresh;
    }
  }
  if (key === 'wind') windFx.setMode(settings.wind);
  if (key === 'results') refreshTrails();
}

function refreshTrails() {
  trails.forEach((t, i) => {
    const last = i === trails.length - 1;
    t.mesh.visible = settings.results === 'ghosts' || last;
    t.setOpacity(last ? 0.95 : 0.4);
  });
}

function updateIslandCard() {
  const t = TARGETS[S.targetIndex];
  ui.setIsland(S.targetIndex, TARGETS.length, t, S.throwsUsed, THROWS_PER_ISLAND, S.best[S.targetIndex] || 0);
  ui.setScore(S.totalStars());
}

let lastWindUi = '';
function updateWindUI() {
  const w = targetWind();
  const speed = Math.hypot(w.x, w.z);
  // The arrow on screen: wind direction relative to where the camera looks.
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  const camYaw = Math.atan2(fwd.x, -fwd.z);
  const windYaw = Math.atan2(w.x, -w.z);
  const a = windYaw - camYaw;
  const key = speed.toFixed(2) + ':' + a.toFixed(2);
  if (key === lastWindUi) return;
  lastWindUi = key;
  ui.setWind(speed, a);
}

// ------------------------------------------------------------------ phases

function startIntro() {
  S.phase = 'intro';
  ui.hideLoading();
  updateIslandCard();
  ui.showPicker(true);
  ui.setGaugeMode('hidden');
  ui.setHint('');
  windFx.setMode(settings.wind);
  setWindBox();
}

function startAngle() {
  S.phase = 'angle';
  S.sweepT = 0;
  ui.showResult(null);
  ui.setGaugeMode('sweep');
  ui.setGhosts(S.ghostAngles);
  ui.showRedo(false);
  ui.drawArrow(null);
  aimLine.visible = false;
  ui.setHint('<b>Tap</b> to set the angle');
  if (!handPlane) makeHandPlane();
}

function lockAngle() {
  S.phase = 'aim';
  ui.setGaugeMode('locked');
  ui.showRedo(true);
  ui.setHint('<b>Hold</b> and <b>drag</b> to aim, <b>let go</b> to throw');
}

function throwNow() {
  const plane = PLANES[S.plane];
  const aim = { angle: S.angle, turn: S.turn, power: S.power };
  S.flight = fly(plane, aim, targetWind(), islands, undefined, { floorY: floorFor(TARGETS[S.targetIndex]) });
  S.flight.aim = aim;
  S.flight.planeKey = S.plane;
  S.flightT = 0;
  S.flightDone = 0;
  S.cutAt = null;
  S.replay = false;
  S.phase = 'flight';
  S.throwsUsed++;
  S.ghostAngles.push(S.angle);
  if (S.ghostAngles.length > 3) S.ghostAngles.shift();
  ui.setGaugeMode('hidden');
  ui.showRedo(false);
  ui.drawArrow(null);
  ui.setHint('Hold to speed up');
  aimLine.visible = false;
  thrower.throwLean();
  flyingPlane = handPlane;
  handPlane = null;
  currentTrail = new Trail(scene, S.flight, S.plane, PLANE_COLORS[S.plane]);
  trails.push(currentTrail);
  refreshTrails();
  updateIslandCard();
  camState.sidePlaced = false;
}

function finishFlight() {
  const t = TARGETS[S.targetIndex];
  const f = S.flight;
  t.windVec = targetWind();
  const r = describeThrow(t, f, islands, S.ghostEnds.slice());
  S.ghostEnds.push(r.end);
  const prevBest = S.best[S.targetIndex] || 0;
  S.best[S.targetIndex] = Math.max(prevBest, r.stars);
  S.zeroStreak = r.stars ? 0 : S.zeroStreak + 1;
  refreshIslandMarks();
  updateIslandCard();
  if (S.zeroStreak >= 2 && r.stars === 0) r.why += `<div>${ICONS.tip}<span>Try a different plane?</span></div>`;
  S.lastResult = r;
  S.phase = 'result';
  ui.setHint('');
  ui.showFF(false);
  const done = r.stars === 3 || S.throwsUsed >= THROWS_PER_ISLAND;
  const last = S.targetIndex === TARGETS.length - 1;
  const btns = [];
  if (!done) btns.push({ label: 'Throw again', primary: true, onClick: () => startAngle() });
  btns.push({
    label: last ? 'Finish ▶' : 'Next island ▶',
    primary: done,
    onClick: () => nextIsland(),
  });
  btns.push({ label: '▶ Replay', onClick: () => replay() });
  S.cardSide = cardSideFor(r);
  ui.showResult(r, btns, S.cardSide);
}

/** The result card goes on the side away from where the throw ended up. */
function cardSideFor(r) {
  return r.end && r.end.side > TARGETS[S.targetIndex].r * 0.5 ? 'left' : 'right';
}

function replay() {
  ui.showResult(null);
  S.phase = 'flight';
  S.replay = true;
  S.flightT = 0;
  S.flightDone = 0;
  S.cutAt = null;
  if (!flyingPlane) {
    flyingPlane = buildPlane(S.flight.planeKey, settings.paper);
    scene.add(flyingPlane);
  }
  ui.setHint('Hold to speed up');
}

function clearTargetLeftovers() {
  for (const t of trails) t.dispose();
  trails = [];
  currentTrail = null;
  S.ghostEnds = [];
  S.ghostAngles = [];
  S.zeroStreak = 0;
}

function nextIsland() {
  ui.showResult(null);
  clearTargetLeftovers();
  if (S.targetIndex >= TARGETS.length - 1) {
    showSummary();
    return;
  }
  S.targetIndex++;
  S.throwsUsed = 0;
  refreshIslandMarks();
  updateIslandCard();
  setWindBox();
  lastWindUi = '';
  camState.travel = 1.6; // a slower glide to the next island's view
  startAngle();
}

function showSummary() {
  S.phase = 'done';
  ui.setGaugeMode('hidden');
  ui.showRedo(false);
  ui.setHint('');
  const total = S.totalStars();
  const max = TARGETS.length * 3;
  const rows = TARGETS.map((t, i) => {
    const n = S.best[i] || 0;
    return `<div>${i + 1}. ${t.name} <span style="color:#ffd34d">${'★'.repeat(n)}</span><span style="opacity:.3">${'★'.repeat(3 - n)}</span></div>`;
  }).join('');
  S.cardSide = 'right';
  ui.showResult(
    { title: `★ ${total} of ${max}`, tone: 'good', why: rows, stars: total >= max * 0.75 ? 3 : total >= max * 0.45 ? 2 : 1, map: null },
    [
      {
        label: 'Play again',
        primary: true,
        onClick: () => {
          S.targetIndex = 0;
          S.throwsUsed = 0;
          S.best = [];
          for (const p of restingPlanes) scene.remove(p);
          restingPlanes.length = 0;
          buildIslands();
          updateIslandCard();
          setWindBox();
          startAngle();
        },
      },
    ]
  );
}

function setWindBox() {
  const t = TARGETS[S.targetIndex];
  windFx.setBox({ x: 0, y: 0, z: 0 }, t);
}

// ------------------------------------------------------------------ input

const canvas = renderer.domElement;
function dragReach() {
  const m = Math.min(canvas.clientWidth, canvas.clientHeight);
  return { reach: Math.min(230, m * 0.42), dead: 22 };
}
function camYaw() {
  const f = new THREE.Vector3();
  camera.getWorldDirection(f);
  return Math.atan2(f.x, -f.z);
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 2) return;
  if (S.phase === 'angle') {
    lockAngle();
    return;
  }
  if (S.phase === 'aim') {
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* not capturable (synthetic or already released): moves still arrive */
    }
    S.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
    updateDrag();
    return;
  }
  if (S.phase === 'flight') {
    S.ff = true;
    ui.showFF(true);
  }
  if (S.phase === 'intro' || S.phase === 'pick') {
    // Tapping the world while the picker is open does nothing; the picker
    // is the only thing to do.
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (S.drag && e.pointerId === S.drag.id) {
    S.drag.x1 = e.clientX;
    S.drag.y1 = e.clientY;
    updateDrag();
  }
});
const endPointer = (e, cancelled) => {
  if (S.ff) {
    S.ff = false;
    ui.showFF(false);
  }
  if (!S.drag || e.pointerId !== S.drag.id) return;
  const d = S.drag;
  S.drag = null;
  ui.drawArrow(null);
  if (!cancelled && d.valid && S.phase === 'aim') throwNow();
  else if (S.phase === 'aim') ui.setHint('<b>Hold</b> and <b>drag</b> to aim, <b>let go</b> to throw');
};
canvas.addEventListener('pointerup', (e) => endPointer(e, false));
canvas.addEventListener('pointercancel', (e) => endPointer(e, true));
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.drag) {
    S.drag = null;
    ui.drawArrow(null);
    aimLine.visible = false;
  }
  if (e.key === ' ' && S.phase === 'angle') lockAngle();
});

function updateDrag() {
  const d = S.drag;
  const rect = canvas.getBoundingClientRect();
  const { reach, dead } = dragReach();
  let dx = d.x1 - d.x0;
  let dy = d.y1 - d.y0;
  let len = Math.hypot(dx, dy);
  const cancel = len < dead;
  // Direction: the drag's angle from straight up the screen, turned into a
  // compass heading relative to where the camera looks, then held inside
  // the reachable fan. The arrow is redrawn along the HELD direction, so it
  // shows honestly when you're at the limit.
  const screenA = Math.atan2(dx, -dy);
  const cy = camYaw();
  const turn = THREE.MathUtils.clamp(cy + THREE.MathUtils.clamp(screenA, -Math.PI / 2, Math.PI / 2), -AIM.maxTurn, AIM.maxTurn);
  const shownA = turn - cy;
  len = Math.min(len, reach);
  S.turn = turn;
  S.power = cancel ? 0 : THREE.MathUtils.clamp((len - dead) / (reach - dead), AIM.minPower, 1);
  d.valid = !cancel;
  const x0 = d.x0 - rect.left;
  const y0 = d.y0 - rect.top;
  ui.drawArrow({
    x0,
    y0,
    x1: x0 + Math.sin(shownA) * len,
    y1: y0 - Math.cos(shownA) * len,
    reach,
    dead,
    color: PLANE_COLORS[S.plane],
    cancel,
  });
  ui.setHint(cancel ? 'Let go here to <b>cancel</b>' : Math.abs(turn) >= AIM.maxTurn - 1e-3 ? "Can't throw further round than this" : 'Let go to <b>throw</b>');
}

// ------------------------------------------------------------------ camera

/**
 * One camera, eased toward a goal that each phase sets. Positions and
 * look-at points ease separately so cuts between phases are smooth glides,
 * not jumps; `travel` sets how slow the next glide is.
 */
const camState = {
  pos: new THREE.Vector3(14, 9, -46),
  look: new THREE.Vector3(0, 12, 20),
  goalPos: new THREE.Vector3(),
  goalLook: new THREE.Vector3(),
  travel: 0,
  sidePlaced: false,
  sidePos: new THREE.Vector3(),
  shift: 0,
};

function targetFrame() {
  const t = TARGETS[S.targetIndex];
  const b = Math.atan2(t.x, -t.z);
  return {
    t,
    dir: new THREE.Vector3(Math.sin(b), 0, -Math.cos(b)),
    right: new THREE.Vector3(Math.cos(b), 0, Math.sin(b)),
  };
}

/** Over the thrower's shoulder, the target ahead, both in frame. */
function aimGoal(pos, look) {
  const { t, dir, right } = targetFrame();
  pos.set(0, 0, 0).addScaledVector(dir, -4.2).addScaledVector(right, 1.1);
  pos.y = 4.0;
  const tp = new THREE.Vector3(t.x, t.y + 0.5, t.z);
  look.set(0, 1.0, 0).lerp(tp, 0.62);
  // Far targets: aim a little higher so the thrower stays on screen.
  look.y = Math.max(look.y, -3.2);
}

/** Looking back at the thrower, with the temple behind them. */
/**
 * The opening: starts wide, out over the void, with the whole temple and
 * its island in view, then glides in to the thrower standing on the rim
 * (low, looking slightly up past them, so they stand in the upper middle
 * and the picker can fill the bottom of the screen).
 */
const INTRO_SECONDS = 4.5;
const introWide = { pos: new THREE.Vector3(14, 9, -46), look: new THREE.Vector3(0, 12, 20) };
const introNear = { pos: new THREE.Vector3(1.5, 0.95, -3.7), look: new THREE.Vector3(-0.25, 0.8, 2) };
function introGoal(pos, look) {
  const u = THREE.MathUtils.clamp(S.introT / INTRO_SECONDS, 0, 1);
  const e = u * u * (3 - 2 * u);
  pos.lerpVectors(introWide.pos, introNear.pos, e);
  look.lerpVectors(introWide.look, introNear.look, e);
}

function flightGoal(pos, look, p) {
  const { t, dir, right } = targetFrame();
  const tp = new THREE.Vector3(t.x, t.y, t.z);
  const toT = tp.clone().sub(p);
  const alongLeft = Math.max(0, toT.dot(dir));
  if (settings.camera === 'chase') {
    const st = stateAt(S.flight, S.flightT);
    const h = new THREE.Vector3(Math.sin(st.heading), 0, -Math.cos(st.heading));
    // Close behind and a little above, looking just past the plane, so it
    // sits in the lower middle of the picture with the way ahead above it.
    pos.copy(p).addScaledVector(h, -2.6);
    pos.y = p.y + 1.5;
    look.copy(p).addScaledVector(h, 3);
    look.y = p.y - 0.2;
    return;
  }
  if (settings.camera === 'side') {
    // Placed once per throw: off to the side of the line from the thrower
    // to the target, far enough to see the whole arc, then only turning.
    if (!camState.sidePlaced) {
      const D = Math.hypot(t.x, t.z);
      const mid = new THREE.Vector3(t.x * 0.5, 0, t.z * 0.5);
      camState.sidePos.copy(mid).addScaledVector(right, -(D * 0.62 + 6));
      camState.sidePos.y = Math.max(2, t.y + 3) + D * 0.12;
      camState.sidePlaced = true;
    }
    pos.copy(camState.sidePos);
    look.copy(p).lerp(tp, 0.25);
    return;
  }
  // Follow & frame: behind the plane along the throw line, rising and
  // backing off while the target is far so both stay in view, closing in
  // as it nears.
  pos.copy(p).addScaledVector(dir, -(3.2 + alongLeft * 0.12)).addScaledVector(right, 0.8);
  // Never lower than a view down onto the target's deck, so the landing is
  // seen against the whole island, not from deck level.
  pos.y = Math.max(p.y + 1.1, t.y + 3.4) + alongLeft * 0.05;
  look.copy(p).lerp(tp, THREE.MathUtils.clamp(0.15 + alongLeft * 0.006, 0.15, 0.4));
}

function resultGoal(pos, look) {
  const { t, dir, right } = targetFrame();
  // Where it ended as far as the result is concerned (for a miss, where it
  // passed the target's height), so the shot holds the island and the miss.
  const ew = S.lastResult?.endWorld ?? S.flight.end;
  const end = new THREE.Vector3(ew.x, t.y, ew.z);
  // Centred nearer the island than the miss: the island is the reference.
  const mid = new THREE.Vector3(t.x, t.y, t.z).lerp(end, 0.45);
  const spread = Math.min(30, end.distanceTo(new THREE.Vector3(t.x, t.y, t.z)));
  // Pull back up behind the thrower: the whole path, from the hand to where
  // it ended, seen from the player's own side, and the same way round as
  // the little map on the card (up the screen is away, left is left).
  const D = Math.hypot(mid.x, mid.z);
  pos.set(0, 0, 0).addScaledVector(dir, -(4 + D * 0.12));
  pos.y = 5 + D * 0.3 + spread * 0.25;
  look.copy(mid);
  look.y -= 1;
  // (The card on the right is dealt with by shifting the whole picture
  // left, camState.shift, rather than by aiming off to one side.)
}

/**
 * Lifts a camera goal until no island sits between it and what it's looking
 * at. Islands are big and float at all heights; without this a shot can end
 * up staring at the underside of the wrong one.
 */
const _seg = new THREE.Vector3();
const _rel = new THREE.Vector3();
function clearLineOfSight(pos, look, skip = -1) {
  for (let tries = 0; tries < 12; tries++) {
    let blocked = false;
    _seg.subVectors(look, pos);
    const len = _seg.length();
    _seg.divideScalar(len);
    for (let i = 0; i < islands.length && !blocked; i++) {
      if (i === skip) continue;
      const isl = islands[i];
      // A sphere roughly covering the deck and the top of the rock.
      _rel.set(isl.x - pos.x, isl.y - isl.r * 0.35 - pos.y, isl.z - pos.z);
      const along = _rel.dot(_seg);
      if (along < 0 || along > len - isl.r) continue;
      const off = _rel.addScaledVector(_seg, -along).length();
      if (off < isl.r * 1.15) blocked = true;
    }
    if (!blocked) return;
    pos.y += 1.5;
  }
}

function updateCamera(dt) {
  const { goalPos, goalLook } = camState;
  let rate = 2.2;
  if (S.phase === 'intro' || S.phase === 'loading') {
    S.introT = (S.introT || 0) + (S.phase === 'intro' ? dt : 0);
    introGoal(goalPos, goalLook);
    rate = 8;
  } else if (S.phase === 'pick' || S.phase === 'angle' || S.phase === 'aim') {
    aimGoal(goalPos, goalLook);
    rate = camState.travel > 0 ? 1.1 : 2.0;
  } else if (S.phase === 'flight' && flyingPlane) {
    flightGoal(goalPos, goalLook, flyingPlane.position);
    rate = settings.camera === 'chase' ? 9 : settings.camera === 'side' ? 3 : 4;
  } else if (S.phase === 'result') {
    resultGoal(goalPos, goalLook);
    rate = 1.5;
  } else if (S.phase === 'done') {
    // The end: drift back out to the opening's wide shot of the temple.
    goalPos.copy(introWide.pos);
    goalLook.copy(introWide.look);
    rate = 0.6;
  }
  if (S.phase !== 'intro' && S.phase !== 'loading') clearLineOfSight(goalPos, goalLook, S.phase === 'result' || S.phase === 'flight' ? S.targetIndex : -1);
  camState.travel = Math.max(0, camState.travel - dt);
  const k = 1 - Math.exp(-rate * dt);
  camState.pos.lerp(goalPos, k);
  camState.look.lerp(goalLook, Math.min(1, k * 1.3));
  camera.position.copy(camState.pos);
  camera.lookAt(camState.look);
  // While the result card is up (it sits on the right), slide the picture
  // left so what it's describing is in the clear part of the screen.
  const shiftGoal = S.phase === 'result' ? (S.cardSide === 'left' ? -0.14 : 0.14) : 0;
  camState.shift += (shiftGoal - camState.shift) * Math.min(1, dt * 3);
  const w = renderer.domElement.clientWidth;
  const h = renderer.domElement.clientHeight;
  if (Math.abs(camState.shift) > 0.001) camera.setViewOffset(w, h, w * camState.shift, 0, w, h);
  else if (camera.view?.enabled) camera.clearViewOffset();
}

// ------------------------------------------------------------------ frame

const clock = new THREE.Clock();
const st = {};
let elapsed = 0;

let manualSteps = false; // dev: when set, frames only advance via __pg.advance()
function frame() {
  if (!manualSteps) step(Math.min(0.05, clock.getDelta()));
  requestAnimationFrame(frame);
}

function step(dt) {
  elapsed += dt;
  const wind = targetWind();

  // --- the needle
  if (S.phase === 'angle') {
    S.sweepT += dt;
    const u = (S.sweepT / SWEEP_SECONDS) % 2;
    const tri = u < 1 ? u : 2 - u;
    S.angle = AIM.minAngle + (AIM.maxAngle - AIM.minAngle) * tri;
    ui.setNeedle(S.angle);
  }

  // --- the plane in hand: pitched to the angle, pointing the aim
  if (handPlane) {
    const heading = S.phase === 'aim' && S.drag?.valid ? S.turn : camYaw();
    const h = THREE.MathUtils.clamp(heading, -AIM.maxTurn, AIM.maxTurn);
    // Same hand position as flight.js launches from.
    const hx = Math.sin(h) * HAND.out + Math.cos(h) * HAND.side;
    const hz = -Math.cos(h) * HAND.out + Math.sin(h) * HAND.side;
    posePlane(handPlane, hx, HAND.up, hz, h, S.phase === 'angle' || S.phase === 'aim' ? S.angle : 0.1, 0);
    handPlane.visible = S.phase !== 'intro' && S.phase !== 'loading' && S.phase !== 'done';
    // Direction line, while dragging.
    aimLine.visible = S.phase === 'aim' && !!S.drag?.valid;
    if (aimLine.visible) {
      aimLine.position.set(hx, HAND.up - 0.25, hz);
      aimLine.rotation.y = Math.PI / 2 - h;
      const atLimit = Math.abs(S.turn) >= AIM.maxTurn - 1e-3;
      aimLine.material.color.set(atLimit ? 0xffa060 : 0xffffff);
    }
  }

  // --- flight playback
  if (S.phase === 'flight' && S.flight && flyingPlane) {
    const speed = settings.flightSpeed * (S.ff ? 3 : 1) * (S.replay ? 0.8 : 1);
    S.flightT += dt * speed;
    const f = S.flight;
    // A miss that has already dropped well below the target is decided:
    // cut the flight there rather than watch it sink to the clouds.
    if (S.cutAt === null && f.end.type === 'fell') {
      stateAt(f, S.flightT, st);
      const t = TARGETS[S.targetIndex];
      if (st.y < t.y - 2.5) S.cutAt = S.flightT;
    }
    const tEnd = S.cutAt ?? f.time;
    if (S.flightT < tEnd) {
      stateAt(f, S.flightT, st);
      // A little life: a gentle roll wobble, more for the floaty planes.
      const wob = f.planeKey === 'glider' ? 0.12 : f.planeKey === 'dart' ? 0.04 : 0.08;
      const roll = Math.sin(S.flightT * 2.3) * wob + Math.sin(S.flightT * 5.1) * wob * 0.3;
      posePlane(flyingPlane, st.x, st.y, st.z, st.heading, st.pitch, roll);
      shadow.update(st.x, st.y, st.z, islands);
      locator.update(flyingPlane.position, camera, PLANE_COLORS[f.planeKey]);
      if (!S.replay || currentTrail) currentTrail?.update(S.flightT, camera);
    } else {
      // After the flight proper: settle, tumble or drop out of sight.
      S.flightDone += dt * speed;
      const e = f.end;
      const k = Math.min(1, S.flightDone / 0.5);
      if (e.type === 'landed') {
        const ease = 1 - Math.pow(1 - k, 3);
        const x = e.touchX + (e.x - e.touchX) * ease;
        const z = e.touchZ + (e.z - e.touchZ) * ease;
        stateAt(f, tEnd, st);
        posePlane(flyingPlane, x, e.y + 0.06, z, st.heading, st.pitch * (1 - ease), 0);
        shadow.mesh.visible = false;
      } else {
        // Crashed or fell: keep dropping and spinning for a moment.
        stateAt(f, tEnd, st);
        const tt = S.flightDone;
        flyingPlane.position.set(st.x, st.y - 2.6 * tt * tt - tt * 1.5, st.z);
        flyingPlane.rotation.x += dt * 5;
        flyingPlane.rotation.z += dt * 3;
        shadow.mesh.visible = false;
      }
      currentTrail?.update(tEnd, camera);
      locator.update(flyingPlane.position, camera, PLANE_COLORS[f.planeKey]);
      if (S.flightDone > (e.type === 'landed' ? 0.6 : 1.2)) {
        locator.hide();
        if (e.type === 'landed') {
          restingPlanes.push(flyingPlane);
          if (restingPlanes.length > 16) scene.remove(restingPlanes.shift());
        } else {
          scene.remove(flyingPlane);
        }
        flyingPlane = null;
        if (S.replay) {
          S.replay = false;
          finishFlightAgain();
        } else finishFlight();
      }
    }
  }

  // Keep ghost trails facing the camera as it moves.
  for (const t of trails) if (t !== currentTrail || S.phase !== 'flight') t.update(t.flight.time, camera);

  updateCamera(dt);
  thrower.update(dt, camera);
  rimFlag.update(elapsed, wind, dt);
  for (const h of islandHandles) {
    const isl = h.island;
    const d = Math.hypot(camera.position.x - isl.x, camera.position.y - isl.y, camera.position.z - isl.z);
    // No beam once the throw's been made: it's for finding the target.
    h.update(elapsed, wind, dt, S.phase === 'flight' || S.phase === 'result' ? 0 : d);
  }
  windFx.update(dt, elapsed, wind);
  world.update(dt, camera, wind);
  updateWindUI();

  renderer.render(scene, camera);
}

/** After a replay, put the same result card back up. */
function finishFlightAgain() {
  const t = TARGETS[S.targetIndex];
  t.windVec = targetWind();
  const r = describeThrow(t, S.flight, islands, S.ghostEnds.slice(0, -1));
  S.phase = 'result';
  ui.setHint('');
  const done = (S.best[S.targetIndex] || 0) === 3 || S.throwsUsed >= THROWS_PER_ISLAND;
  const last = S.targetIndex === TARGETS.length - 1;
  const btns = [];
  if (!done) btns.push({ label: 'Throw again', primary: true, onClick: () => startAngle() });
  btns.push({ label: last ? 'Finish ▶' : 'Next island ▶', primary: done, onClick: () => nextIsland() });
  btns.push({ label: '▶ Replay', onClick: () => replay() });
  S.cardSide = cardSideFor(r);
  ui.showResult(r, btns, S.cardSide);
}

// ------------------------------------------------------------------ start

manager.onProgress = (_u, loaded, total) => ui.setLoading(loaded / total);
let started = false;
const begin = () => {
  if (started) return;
  started = true;
  buildIslands();
  if (settings.plane) S.plane = null;
  startIntro();
};
manager.onLoad = begin;
world.templeReady.then(() => {
  /* the rim is placed; nothing else waits on it */
});
onResize();
frame();

// ------------------------------------------------------------------ dev hooks

if (import.meta.env.DEV) {
  window.__pg = {
    THREE,
    S,
    scene,
    camera,
    renderer,
    settings,
    world,
    islands,
    /** Throw with a given aim (degrees, 0..1, degrees right of straight out). */
    throwWith(angleDeg, power, turnDeg, plane = S.plane || 'allrounder') {
      if (!S.plane) {
        S.plane = plane;
        ui.setPlane(plane);
        ui.showPicker(false);
        makeHandPlane();
      }
      S.angle = (angleDeg * Math.PI) / 180;
      S.turn = (turnDeg * Math.PI) / 180;
      S.power = power;
      throwNow();
    },
    pick(key) {
      ui.cards[key].click();
    },
    /** Jump to island n (1-based). */
    setTarget(n) {
      S.targetIndex = n - 2;
      nextIsland();
    },
    lockAngle,
    shot: async () => {
      renderer.render(scene, camera);
      const url = renderer.domElement.toDataURL('image/png');
      const r = await fetch('/__shot', { method: 'POST', body: url });
      return r.text();
    },
    /** Run the game forward `seconds` in 1/30 s steps, right now (testing in a hidden pane). */
    advance(seconds, hold = true) {
      manualSteps = hold;
      const n = Math.round(seconds * 30);
      for (let i = 0; i < n; i++) step(1 / 30);
      return S.phase;
    },
    release() {
      manualSteps = false;
      clock.getDelta();
    },
    info() {
      return { calls: renderer.info.render.calls, tris: renderer.info.render.triangles, phase: S.phase };
    },
    /** Average ms to simulate and render one frame, over n frames (GPU-synced). */
    timeFrames(n = 60) {
      const gl = renderer.getContext();
      const px = new Uint8Array(4);
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        step(1 / 60);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      return +((performance.now() - t0) / n).toFixed(2);
    },
  };
}
