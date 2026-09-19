// UI wiring for blow-arena.html. Deliberately kept separate from
// blow-arena.js: BLOW_SPEC.md asks for "a small, callable API rather than a
// page that only works via its own UI" — blow-trial.js coupled its DOM
// lookups directly into the physics module itself (fine there, it only ever
// needed to run as one tuning page), but blow-arena.js has no idea a page
// exists at all. This file is the thing that only exists for the demo page;
// a future integration would call createArena/addPlayer/blow/step directly
// and never load this file.
import {
  createArena,
  addPlayer,
  blow,
  step,
  getPlayerState,
  getArenaRadius,
} from './blow-arena.js';

const hud = document.getElementById('hud');
const addDistanceInput = document.getElementById('addDistance');
const addDistanceVal = document.getElementById('addDistanceVal');
const addAngleInput = document.getElementById('addAngle');
const addAngleVal = document.getElementById('addAngleVal');
const addBtn = document.getElementById('addBtn');
const targetSelect = document.getElementById('targetSelect');
const blowAngleInput = document.getElementById('blowAngle');
const blowAngleVal = document.getElementById('blowAngleVal');
const strengthInput = document.getElementById('strength');
const strengthVal = document.getElementById('strengthVal');
const blowBtn = document.getElementById('blowBtn');
const resetBtn = document.getElementById('resetBtn');
const panel = document.getElementById('panel');
const panelToggle = document.getElementById('panelToggle');

let logLines = ['blow arena'];
function log(line) {
  logLines.push(line);
  if (logLines.length > 10) logLines.shift();
  hud.textContent = logLines.join('\n');
}

// handle map keyed by playerId, since <select> options can only carry strings
const handles = new Map();

function addDistanceWorld() {
  const radius = getArenaRadius();
  // 0..1 maps to "just past the centre object" .. "near the edge" — lets the
  // demo place cards anywhere from close calls to easy blows without the
  // slider needing to know the exact radius number.
  return 1.6 + parseFloat(addDistanceInput.value) * (radius - 2.4);
}

function refreshTargetSelect() {
  const prev = targetSelect.value;
  targetSelect.innerHTML = '';
  for (const [id, handle] of handles) {
    const opt = document.createElement('option');
    opt.value = String(id);
    const s = getPlayerState(handle);
    opt.textContent = `Player ${id}${s.offEdge ? ' (off edge)' : ''}`;
    targetSelect.appendChild(opt);
  }
  if ([...handles.keys()].map(String).includes(prev)) targetSelect.value = prev;
}

addDistanceInput.addEventListener('input', () => {
  addDistanceVal.textContent = addDistanceWorld().toFixed(1);
});
addAngleInput.addEventListener('input', () => {
  addAngleVal.textContent = `${addAngleInput.value}°`;
});
blowAngleInput.addEventListener('input', () => {
  blowAngleVal.textContent = `${blowAngleInput.value}°`;
});
strengthInput.addEventListener('input', () => {
  strengthVal.textContent = parseFloat(strengthInput.value).toFixed(2);
});

addBtn.addEventListener('click', () => {
  const startDistance = addDistanceWorld();
  const startAngle = (parseFloat(addAngleInput.value) * Math.PI) / 180;
  const handle = addPlayer({ startDistance, startAngle });
  handles.set(handle.id, handle);
  refreshTargetSelect();
  log(`added Player ${handle.id} at d=${startDistance.toFixed(1)} angle=${addAngleInput.value}°`);
});

blowBtn.addEventListener('click', () => {
  const id = parseInt(targetSelect.value, 10);
  const handle = handles.get(id);
  if (!handle) {
    log('no target selected — add a player first');
    return;
  }
  const angleDeg = parseFloat(blowAngleInput.value);
  const strength = parseFloat(strengthInput.value);
  const directionRad = (angleDeg * Math.PI) / 180;

  log(`blowing Player ${id}: dir=${angleDeg}° strength=${strength.toFixed(2)}`);
  blow(handle, { direction: directionRad, strength }).then((outcome) => {
    if (outcome.status === 'offEdge') {
      log(`Player ${id}: WENT OFF THE EDGE`);
    } else {
      log(`Player ${id}: landed upright at (${outcome.x.toFixed(1)}, ${outcome.z.toFixed(1)})`);
    }
    refreshTargetSelect();
  });
});

resetBtn.addEventListener('click', () => {
  handles.clear();
  logLines = ['blow arena — reset'];
  hud.textContent = logLines.join('\n');
  createArena({ radius: getArenaRadius(), onWentOffEdge: handleOffEdge });
  refreshTargetSelect();
});

// Luke: "the controls cover half the screen so I can't see the effects
// properly. Add an arrow to hide them." The arrow itself flips (▼ hide / ▲
// show) so its own state always says what clicking it does next, not what
// it just did.
panelToggle.addEventListener('click', () => {
  const collapsed = panel.classList.toggle('collapsed');
  panelToggle.textContent = collapsed ? '▲' : '▼';
  panelToggle.setAttribute('aria-label', collapsed ? 'Show controls' : 'Hide controls');
});

function handleOffEdge(playerId) {
  log(`onWentOffEdge(${playerId}) fired`);
  refreshTargetSelect();
}

createArena({ onWentOffEdge: handleOffEdge });
addDistanceVal.textContent = addDistanceWorld().toFixed(1);

// Expose for manual/console testing, same pattern blow-trial.js and
// skyPath.js both use (window.__foo escape hatches).
window.__blowArena = { addPlayer, blow, step, getPlayerState, handles };

let lastT = performance.now();
function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  step(dt);
}
requestAnimationFrame(tick);

/** Same escape hatch as blow-trial.js's window.__physicsStep — lets test
 * scripts drive the simulation deterministically without waiting on
 * rAF/wall-clock timing (see TODO.md's "Testing" notes elsewhere in this
 * project for why that matters in this environment). */
window.__physicsStep = function (dt = 1 / 60) {
  step(dt);
};
