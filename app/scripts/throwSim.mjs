/**
 * Headless validator for the island-throwing minigame (2026-09-29). It runs
 * the game's own flightModel.js and course.js with no rendering, so its
 * results are exactly what the game would do.
 *
 * For every challenge and every plane, it brute-forces a grid of throws
 * (yaw x pitch x power) and reports:
 *   hits   - how many throws land on the target (a proxy for forgiveness:
 *            more hits = a wider window of good throws = easier)
 *   3pt    - how many of those land a bullseye
 *   best   - the plane with the most hits, i.e. the right tool for this course
 * plus each plane's maximum range on flat, calm ground.
 *
 * Run from app/:  node scripts/throwSim.mjs
 * A lever override is a JSON string of LEVER_DEFAULTS keys, for example:
 *   node scripts/throwSim.mjs '{"liftDirection":"vertical"}'
 */
import * as THREE from 'three';
import { PLANE_TYPES, PLANE_ORDER, LEVER_DEFAULTS, launchVelocity, throwVelocity, simulateThrow } from '../src/throwGame/flightModel.js';
import { CHALLENGES, THROW_ORIGIN, buildCourse, testSegment } from '../src/throwGame/course.js';

const levers = { ...LEVER_DEFAULTS, ...(process.argv[2] ? JSON.parse(process.argv[2]) : {}) };
const DT = 1 / 60;
const deg = THREE.MathUtils.degToRad;

function sweep(course, type) {
  const target = course.challenge.target;
  let hits = 0, bulls = 0, total = 0;
  for (let yawD = target.bearing - 16; yawD <= target.bearing + 16; yawD += 1) {
    for (let pitchD = -15; pitchD <= 65; pitchD += 2.5) {
      for (let power = 0; power <= 1.0001; power += 0.05) {
        total++;
        const velocity = throwVelocity(type, { yaw: deg(yawD), pitch: deg(pitchD), power }, course.wind, levers);
        const { outcome } = simulateThrow({
          origin: THROW_ORIGIN, velocity, type, levers, wind: course.wind, dt: DT, maxTime: 14,
          testSegment: (a, b) => testSegment(course, a, b),
        });
        if (outcome.type === 'target') {
          hits++;
          if (outcome.points === 3) bulls++;
        }
      }
    }
  }
  return { hits, bulls, total };
}

function maxRange(type) {
  // flat calm: how far can it get before dropping 3 units below the throw line?
  const flat = { islands: [], wind: new THREE.Vector3() };
  let best = 0, bestPitch = 0;
  for (let pitchD = -5; pitchD <= 60; pitchD += 1) {
    const velocity = launchVelocity(type, { yaw: 0, pitch: deg(pitchD), power: 1 });
    const { outcome, time } = simulateThrow({
      origin: THROW_ORIGIN, velocity, type, levers, wind: flat.wind, dt: DT, maxTime: 30,
      testSegment: (a, b) => (b.y < -3 ? { type: 'floor', point: b.clone() } : null),
    });
    const d = -outcome.point.z;
    if (d > best) { best = d; bestPitch = pitchD; }
    void time;
  }
  return { best, bestPitch };
}

console.log('levers:', JSON.stringify(levers));
console.log('\n=== Max range, calm, landing 3 below the throw line, full power ===');
for (const k of PLANE_ORDER) {
  const r = maxRange(PLANE_TYPES[k]);
  console.log(`${k.padEnd(7)} ${r.best.toFixed(1)} units (best pitch ${r.bestPitch}\xb0)`);
}

console.log('\n=== Challenges: target hits per plane over the same grid of throws ===');
let matched = 0;
for (const ch of CHALLENGES) {
  const course = buildCourse(ch);
  const res = {};
  for (const k of PLANE_ORDER) res[k] = sweep(course, PLANE_TYPES[k]);
  const best = PLANE_ORDER.reduce((a, b) => (res[b].hits > res[a].hits ? b : a));
  const ok = ch.intended === 'any' || ch.intended === best;
  if (ok) matched++;
  const cells = PLANE_ORDER.map((k) => `${k}: ${String(res[k].hits).padStart(4)} hits ${String(res[k].bulls).padStart(3)} 3pt`).join('  |  ');
  console.log(`${ch.name.padEnd(17)} intended=${ch.intended.padEnd(6)} best=${best.padEnd(6)} ${ok ? 'OK ' : 'XX '} ${cells}`);
}
console.log(`\n${matched}/${CHALLENGES.length} challenges favour their intended plane`);
