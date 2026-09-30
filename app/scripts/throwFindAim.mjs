// Finds a bullseye aim for a challenge and plane, using default levers. Useful
// for checking the browser game against the headless model: fire the printed
// aim in the game with window.__throw.throwWith({yaw, pitch, power}) and
// compare the distance from centre and the flight time. Both matched exactly
// when this was written (2026-09-29).
// Usage, from app/: node scripts/throwFindAim.mjs <challengeId> <plane>
import * as THREE from 'three';
import { PLANE_TYPES, LEVER_DEFAULTS, throwVelocity, simulateThrow } from '../src/throwGame/flightModel.js';
import { CHALLENGES, THROW_ORIGIN, buildCourse, testSegment } from '../src/throwGame/course.js';

const [id = 'first', kind = 'middle'] = process.argv.slice(2);
const course = buildCourse(CHALLENGES.find((c) => c.id === id));
const type = PLANE_TYPES[kind];
const deg = THREE.MathUtils.degToRad;
for (let pitchD = 0; pitchD <= 60; pitchD += 2.5) {
  for (let power = 0; power <= 1.0001; power += 0.05) {
    for (let yawD = -20; yawD <= 20; yawD += 1) {
      const aim = { yaw: deg(yawD), pitch: deg(pitchD), power };
      const { outcome, time } = simulateThrow({
        origin: THROW_ORIGIN, velocity: throwVelocity(type, aim, course.wind, LEVER_DEFAULTS), type,
        levers: LEVER_DEFAULTS, wind: course.wind, seed: 1, testSegment: (a, b) => testSegment(course, a, b),
      });
      if (outcome.type === 'target' && outcome.points === 3) {
        console.log(JSON.stringify({ yaw: aim.yaw, pitch: aim.pitch, power, dist: +outcome.dist.toFixed(3), time: +time.toFixed(3), point: outcome.point }));
        process.exit(0);
      }
    }
  }
}
console.log('no bullseye found');
