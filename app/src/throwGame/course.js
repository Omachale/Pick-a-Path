/**
 * Courses for the island-throwing minigame: where the target island is, how
 * big it is, what the wind is doing, and which other islands sit around it.
 * Pure data and maths, with no meshes, so scripts/throwSim.mjs can load
 * exactly the same courses and collision the game uses.
 *
 * Coordinates: the throw line is the temple island's front edge at z = 0,
 * the temple island's top is y = 0, and the player faces -z. Bearings are in
 * degrees: 0 is straight ahead and positive is to the right. Wind `dir` is
 * the direction the wind blows TOWARD, on the same bearing scheme, so
 * dir 0 is a tailwind (blowing out, away from the player) and dir 180 is a
 * headwind.
 */
import * as THREE from 'three';
import { mulberry } from './flightModel.js';

export const THROW_ORIGIN = new THREE.Vector3(0, 1.4, 0);
export const LOST_Y = -17; // the top of Sky Path's dense cloud sheet — below this a plane is gone
const DEPTH_PER_RADIUS = 0.9; // the rock under a deck reaches ~0.9r below it (island-basic-v2's proportions)

/**
 * The hand-authored challenges. Each one is built so that a particular plane
 * is the natural pick; `intended` is a design note checked by throwSim.mjs,
 * not shown to players. Decor islands are extra scenery that can also be
 * landed on, or crashed into, by mistake.
 */
export const CHALLENGES = [
  {
    id: 'first',
    name: 'First throw',
    intended: 'any',
    target: { distance: 22, bearing: 0, height: -3, radius: 4.5 },
    wind: { dir: 0, strength: 0 },
    decor: [
      { distance: 34, bearing: -28, height: -6, radius: 3.5 },
      { distance: 40, bearing: 24, height: 1, radius: 3 },
    ],
  },
  {
    id: 'far',
    name: 'The far island',
    intended: 'glider',
    target: { distance: 104, bearing: 6, height: -6, radius: 5 },
    wind: { dir: 20, strength: 1 },
    decor: [
      { distance: 26, bearing: -18, height: -8, radius: 3.5 },
      { distance: 44, bearing: 20, height: -2, radius: 3 },
    ],
  },
  {
    id: 'gap',
    name: 'Across the gap',
    intended: 'middle',
    target: { distance: 52, bearing: -6, height: -5, radius: 4.5 },
    wind: { dir: 80, strength: 5 },
    decor: [
      { distance: 24, bearing: 16, height: -7, radius: 3.5 },
      { distance: 70, bearing: 14, height: -8, radius: 3.5 },
    ],
  },
  {
    id: 'crosswind',
    name: 'Crosswind',
    intended: 'dart',
    target: { distance: 26, bearing: -8, height: -5, radius: 3.5 },
    wind: { dir: 95, strength: 6.5 },
    decor: [
      { distance: 30, bearing: 26, height: -7, radius: 3.5 },
      { distance: 45, bearing: -2, height: -3, radius: 3 },
    ],
  },
  // Reaching UP is a launch-energy problem: lift here can bend a path but
  // never add energy, so the plane thrown fastest (the dart) climbs best. So
  // high ground is dart territory, and it has to be near, since nothing
  // climbs far.
  {
    id: 'high',
    name: 'High ground',
    intended: 'dart',
    target: { distance: 22, bearing: 12, height: 5, radius: 4.5 },
    wind: { dir: 120, strength: 2.5 },
    decor: [
      { distance: 20, bearing: -20, height: -6, radius: 3.5 },
      { distance: 44, bearing: -6, height: -2, radius: 3 },
    ],
  },
  {
    id: 'headwind',
    name: 'Into the wind',
    intended: 'dart',
    target: { distance: 26, bearing: -4, height: -8, radius: 4.5 },
    wind: { dir: 180, strength: 4.5 },
    decor: [
      { distance: 22, bearing: 18, height: -4, radius: 3 },
      { distance: 50, bearing: 10, height: -6, radius: 3.5 },
    ],
  },
  {
    id: 'tailwind',
    name: 'Riding the wind',
    intended: 'glider',
    target: { distance: 128, bearing: -10, height: -2, radius: 5 },
    wind: { dir: 355, strength: 4 },
    decor: [
      { distance: 30, bearing: 14, height: -5, radius: 3.5 },
      { distance: 48, bearing: -24, height: -8, radius: 3 },
    ],
  },
];

function toXZ(distance, bearingDeg) {
  const b = THREE.MathUtils.degToRad(bearingDeg);
  return { x: Math.sin(b) * distance, z: -Math.cos(b) * distance };
}

export function windVector({ dir, strength }) {
  const b = THREE.MathUtils.degToRad(dir);
  return new THREE.Vector3(Math.sin(b) * strength, 0, -Math.cos(b) * strength);
}

/**
 * A random course. Seeded, so a seed shared between players gives everyone the
 * same course.
 */
export function randomChallenge(seed) {
  const rnd = mulberry(seed);
  const r = (lo, hi) => lo + (hi - lo) * rnd();
  const target = { distance: r(18, 68), bearing: r(-25, 25), height: r(-10, 7), radius: r(3.2, 4.8) };
  const decor = [];
  for (let tries = 0; decor.length < 3 && tries < 40; tries++) {
    const d = { distance: r(16, 60), bearing: r(-40, 40), height: r(-9, 4), radius: r(2.8, 4) };
    // keep decor out of the direct line to the target, and away from its deck
    const a = toXZ(d.distance, d.bearing);
    const t = toXZ(target.distance, target.bearing);
    if (Math.hypot(a.x - t.x, a.z - t.z) < d.radius + target.radius + 8) continue;
    if (Math.abs(d.bearing - target.bearing) < 10 && d.distance < target.distance) continue;
    decor.push(d);
  }
  return {
    id: `random-${seed}`,
    name: `Random #${seed}`,
    intended: '?',
    target,
    wind: { dir: r(0, 360), strength: rnd() < 0.2 ? 0 : r(1, 7) },
    decor,
  };
}

/** Turns a challenge definition into world-space islands plus wind. */
export function buildCourse(challenge) {
  const islands = [];
  const add = (spec, isTarget) => {
    const { x, z } = toXZ(spec.distance, spec.bearing);
    islands.push({ x, y: spec.height, z, r: spec.radius, depth: spec.radius * DEPTH_PER_RADIUS, isTarget });
  };
  add(challenge.target, true);
  for (const d of challenge.decor ?? []) add(d, false);
  return { challenge, islands, wind: windVector(challenge.wind) };
}

/**
 * Scores a landing on the target deck: 3 in the inner quarter, 2 inside 60%,
 * 1 anywhere else on the deck.
 */
export function scoreLanding(island, point) {
  const d = Math.hypot(point.x - island.x, point.z - island.z);
  const f = d / island.r;
  const points = f < 0.25 ? 3 : f < 0.6 ? 2 : 1;
  return { points, dist: d, label: points === 3 ? 'Bullseye!' : points === 2 ? 'Good landing' : 'On the edge' };
}

const _p = new THREE.Vector3();

/**
 * Collision for one step of a flight, from `a` to `b`. Returns null to keep
 * flying, or an outcome with its `type`:
 *   'target' - landed on the target deck (and includes the score)
 *   'island' - landed on some other island's deck
 *   'crash'  - hit the rock under a deck
 *   'short'  - came back down onto the temple island
 *   'lost'   - fell into the clouds
 * Islands are a flat deck disc on top of a cone of rock. That's cheap and
 * forgiving, and close enough to the real mesh at gameplay distances.
 */
export function testSegment(course, a, b) {
  for (const isl of course.islands) {
    // landing on the deck: the step crossed the deck plane going down, inside its radius
    if (a.y >= isl.y && b.y < isl.y) {
      const t = (a.y - isl.y) / (a.y - b.y);
      _p.lerpVectors(a, b, t);
      if (Math.hypot(_p.x - isl.x, _p.z - isl.z) <= isl.r) {
        const point = _p.clone();
        point.y = isl.y;
        if (isl.isTarget) return { type: 'target', island: isl, point, ...scoreLanding(isl, point) };
        return { type: 'island', island: isl, point };
      }
    }
    // the rock: a cone narrowing from the deck radius to a point `depth` below it
    const below = isl.y - b.y;
    if (below > 0 && below < isl.depth) {
      const rockR = isl.r * (1 - below / isl.depth);
      if (Math.hypot(b.x - isl.x, b.z - isl.z) < rockR) return { type: 'crash', island: isl, point: b.clone() };
    }
  }
  // The temple island itself is everything behind the throw line.
  if (a.y >= 0 && b.y < 0 && b.z > -0.5) return { type: 'short', point: b.clone() };
  if (b.y < LOST_Y) return { type: 'lost', point: b.clone() };
  return null;
}
