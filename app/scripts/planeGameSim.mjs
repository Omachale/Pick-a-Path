/**
 * Headless proof for the paper-plane game (src/planeGame/).
 *
 *   node scripts/planeGameSim.mjs            full report
 *   node scripts/planeGameSim.mjs --planes   just the plane comparison
 *
 * Imports the game's own flight.js and course.js: no copied maths, so what
 * this proves is what the game does.
 *
 * Two questions:
 *
 *  1. Are the three planes really different? Calm-air range, flight time and
 *     wind drift for each, over the whole input range.
 *  2. Is every target achievable with reasonable skill, and by which plane?
 *     For every plane at every target, every intended aim on a grid of
 *     angle x power is tried, with the left/right turn solved so the throw
 *     heads for the middle. The best intents are then thrown again with
 *     human error added (angle +-5 degrees, power +-0.07, turn +-3 degrees,
 *     uniform), and the share of those wobbly throws that still score is the
 *     target's "forgiveness" for that plane. A target counts as achievable if
 *     some plane scores at least one star on 60% or more of wobbly throws.
 */

import { fly, PLANES, PLANE_ORDER, AIM, sampleAt } from '../src/planeGame/flight.js';
import { TARGETS, courseIslands, windVector, scoreThrow, floorFor, DEG } from '../src/planeGame/course.js';

const onlyPlanes = process.argv.includes('--planes');
const islands = courseIslands();

// ------------------------------------------------------------------ planes

/** Where the flight passes down through height y (from above it). */
function crossing(f, y) {
  let above = false;
  for (let i = 0; i < f.count; i++) {
    const s = sampleAt(f, i);
    if (s.y >= y) above = true;
    else if (above) return s;
  }
  return null;
}

console.log('\n=== The planes, calm air, landing level 5 below the rim ===');
console.log('range (time in s); * = stalled');
for (const k of PLANE_ORDER) {
  console.log(`\n${PLANES[k].name}      power:  0.0         0.5         1.0`);
  for (const a of [0, 15, 30, 45, 60]) {
    let row = `  angle ${String(a).padStart(2)}°        `;
    for (const p of [0, 0.5, 1]) {
      const f = fly(PLANES[k], { angle: a * DEG, turn: 0, power: p }, { x: 0, z: 0 }, []);
      const c = crossing(f, -5);
      row += `${c ? (-c.z).toFixed(1).padStart(5) : '    -'} (${c ? c.t.toFixed(1) : '-'})${f.stalled ? '*' : ' '}  `;
    }
    console.log(row);
  }
}

console.log('\n=== Sideways wind drift, 1.5 units/s crosswind, angle 25°, power 0.5 ===');
for (const k of PLANE_ORDER) {
  const f = fly(PLANES[k], { angle: 25 * DEG, turn: 0, power: 0.5 }, { x: 1.5, z: 0 }, []);
  const c = crossing(f, -5);
  console.log(`  ${PLANES[k].name.padEnd(8)} blown ${c.x.toFixed(1)} sideways over ${(-c.z).toFixed(1)} out, ${c.t.toFixed(1)}s in the air`);
}
if (onlyPlanes) process.exit(0);

// ------------------------------------------------------------------ targets

/** Sideways and along misses of a throw at the target's deck height (no collisions). */
function missAt(target, plane, aim, wind) {
  const f = fly(plane, aim, wind, []);
  const c = crossing(f, target.y);
  if (!c) return null;
  const b = target.bearing * DEG;
  const dx = c.x - target.x;
  const dz = c.z - target.z;
  // right of the line out to the target, and beyond it
  return { side: dx * Math.cos(b) + dz * Math.sin(b), along: dx * Math.sin(b) - dz * Math.cos(b) };
}

/** The turn that sends this angle+power at the middle, by secant search. */
function solveTurn(target, plane, angle, power, wind) {
  let t0 = target.bearing * DEG;
  let m0 = missAt(target, plane, { angle, turn: t0, power }, wind);
  if (!m0) return null;
  let t1 = t0 - Math.atan2(m0.side, target.dist);
  for (let i = 0; i < 5; i++) {
    const m1 = missAt(target, plane, { angle, turn: t1, power }, wind);
    if (!m1) return null;
    if (Math.abs(m1.side) < 0.05) return t1;
    const slope = (m1.side - m0.side) / (t1 - t0 || 1e-6);
    const t2 = Math.abs(slope) > 1e-6 ? t1 - m1.side / slope : t1;
    t0 = t1;
    m0 = m1;
    t1 = t2;
  }
  return t1;
}

// A tiny deterministic random, so the report is the same every run.
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const ERR = { angle: 5 * DEG, power: 0.07, turn: 3 * DEG };
const clampAim = (a) => ({
  angle: Math.min(AIM.maxAngle, Math.max(AIM.minAngle, a.angle)),
  power: Math.min(1, Math.max(AIM.minPower, a.power)),
  turn: Math.min(AIM.maxTurn, Math.max(-AIM.maxTurn, a.turn)),
});

function assess(target, plane) {
  const wind = windVector(target.wind);
  const intents = [];
  for (let a = 0; a <= 65; a += 2.5) {
    for (let p = 0.1; p <= 1.0001; p += 0.05) {
      const turn = solveTurn(target, plane, a * DEG, p, wind);
      if (turn === null || Math.abs(turn) > AIM.maxTurn) continue;
      const aim = { angle: a * DEG, power: p, turn };
      const f = fly(plane, aim, wind, islands, undefined, { floorY: floorFor(target) });
      const stars = scoreThrow(target, f, islands);
      if (stars > 0) intents.push({ aim, stars, f });
    }
  }
  if (!intents.length) return { reachable: false };
  // Forgiveness: the best of the top intents under human wobble.
  intents.sort((a, b) => b.stars - a.stars);
  const candidates = intents.filter((i) => i.stars >= intents[0].stars - 1);
  // Spread the candidates over the grid rather than taking neighbours.
  const pick = candidates.filter((_, i) => i % Math.max(1, Math.floor(candidates.length / 12)) === 0).slice(0, 12);
  let best = null;
  for (const c of pick) {
    let hit = 0;
    let stars = 0;
    const N = 120;
    for (let n = 0; n < N; n++) {
      const aim = clampAim({
        angle: c.aim.angle + (rand() * 2 - 1) * ERR.angle,
        power: c.aim.power + (rand() * 2 - 1) * ERR.power,
        turn: c.aim.turn + (rand() * 2 - 1) * ERR.turn,
      });
      const s = scoreThrow(target, fly(plane, aim, wind, islands, undefined, { floorY: floorFor(target) }), islands);
      if (s > 0) hit++;
      stars += s;
    }
    const r = { aim: c.aim, hit: hit / N, stars: stars / N, time: c.f.time, drift: Math.hypot(c.f.windDrift.x, c.f.windDrift.z) };
    if (!best || r.stars + r.hit * 0.5 > best.stars + best.hit * 0.5) best = r;
  }
  const three = intents.some((i) => i.stars === 3);
  return { reachable: true, three, intents: intents.length, best };
}

console.log('\n=== Targets: forgiveness per plane ===');
console.log('hit% = share of wobbly throws (angle +-5°, power +-0.07, turn +-3°) that land on the island;');
console.log('stars = their average stars; aim = the intent that achieved it (angle°, power, turn° from the line to the target)\n');
let allOk = true;
for (const target of TARGETS) {
  const w = target.wind.speed ? `wind ${target.wind.speed} toward ${target.wind.toward}°` : 'calm';
  console.log(`${target.name.padEnd(16)} ${target.dist} out, ${target.bearing}° , ${target.y >= 0 ? '+' : ''}${target.y} high, r ${target.r}, ${w}`);
  let bestHit = 0;
  const rows = [];
  for (const k of PLANE_ORDER) {
    const r = assess(target, PLANES[k]);
    if (!r.reachable) {
      rows.push([k, 0, `  ${PLANES[k].name.padEnd(8)}  can't reach it`]);
      continue;
    }
    const b = r.best;
    bestHit = Math.max(bestHit, b.hit);
    rows.push([
      k,
      b.hit,
      `  ${PLANES[k].name.padEnd(8)}  hit ${String(Math.round(b.hit * 100)).padStart(3)}%  stars ${b.stars.toFixed(2)}  bullseye possible: ${r.three ? 'yes' : 'no '}  ` +
        `aim ${(b.aim.angle / DEG).toFixed(0).padStart(2)}°, ${b.aim.power.toFixed(2)}, ${((b.aim.turn / DEG) - target.bearing).toFixed(1).padStart(5)}°   flight ${b.time.toFixed(1)}s, wind moved it ${b.drift.toFixed(1)}`,
      b.stars,
    ]);
  }
  // Best = most stars on average under wobble (landing at all is the bar
  // for "achievable"; stars are what tell the planes apart).
  const top = Math.max(...rows.map((r) => r[3] ?? 0));
  for (const r of rows) console.log(r[2] + ((r[3] ?? 0) === top && top > 0 ? '   <- best' : ''));
  const ok = bestHit >= 0.6;
  if (!ok) allOk = false;
  console.log(ok ? '' : '  !! NOT achievable with reasonable skill by any plane\n');
}
console.log(allOk ? 'All targets achievable.' : 'Some targets need work.');
