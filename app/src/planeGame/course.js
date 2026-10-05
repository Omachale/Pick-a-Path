/**
 * The course: where the target islands float and what the wind does at each.
 *
 * Pure data, shared by the game and the headless proof
 * (scripts/planeGameSim.mjs). Every number here was checked with that
 * script, which flies thousands of throws per target with every plane and
 * reports how forgiving each target is and which plane suits it. Re-run it
 * after changing anything here or in flight.js:
 *
 *   node scripts/planeGameSim.mjs
 *
 * Coordinates are relative to the thrower's feet on the Temple Island's rim:
 * x right, y up, -z straight out. Islands are placed by `dist` (straight-line
 * distance out) and `bearing` (degrees right of straight out) because that's
 * how a player sees them; `toWorld` turns that into x/z.
 *
 * Wind is given the same way: `wind.speed` in units/s and `wind.toward` in
 * degrees, where 0 blows straight out (a tailwind), 180 blows back at the
 * thrower (a headwind), +90 blows to the right and -90 to the left.
 *
 * The set is meant to be played in order and to teach as it goes: a calm
 * first throw, then one idea at a time (a light crosswind, a far target
 * that wants the floaty plane, a high one that wants the fast plane, a
 * headwind...), finishing with targets that need two ideas at once. Each
 * target is best suited by at least one plane, and no plane is best
 * everywhere; the sim's table says which.
 */

export const DEG = Math.PI / 180;

/** Distance-and-bearing to world x/z. */
export function toWorld(dist, bearingDeg) {
  const b = bearingDeg * DEG;
  return { x: Math.sin(b) * dist, z: -Math.cos(b) * dist };
}

/** Wind speed-and-direction to a world vector. */
export function windVector(w) {
  if (!w || !w.speed) return { x: 0, z: 0 };
  const b = w.toward * DEG;
  return { x: Math.sin(b) * w.speed, z: -Math.cos(b) * w.speed };
}

/**
 * Score bands, as fractions of a target island's deck radius. The middle
 * band is generous on purpose: "on the island, near the middle" should feel
 * like a good throw, not a near miss.
 */
export const RINGS = { bull: 0.3, inner: 0.62 };

/** Stars for a finished throw at this target. */
export function scoreThrow(target, flight, islands) {
  const end = flight.end;
  if (end.type !== 'landed') return 0;
  const isl = islands[end.island];
  if (isl.id !== target.id) return 0;
  const d = Math.hypot(end.x - isl.x, end.z - isl.z) / isl.r;
  if (d <= RINGS.bull) return 3;
  if (d <= RINGS.inner) return 2;
  return 1;
}

const T = (id, name, dist, bearing, y, r, wind, extra = {}) => {
  const p = toWorld(dist, bearing);
  return { id, name, dist, bearing, x: p.x, y, z: p.z, r, depth: r * 1.25, wind, ...extra };
};

export const TARGETS = [
  // Calm, close, big: any plane, any sensible throw.
  T('first', 'First flight', 18, 0, -4, 3.6, { speed: 0, toward: 0 }),
  // The first wind: light, across. Slow planes need aiming a little upwind.
  T('breeze', 'A little breeze', 16, -32, -3, 3.2, { speed: 1.0, toward: 90 }),
  // A long way, wind behind: the floaty glider rides it there.
  T('faraway', 'Far away', 50, 6, -10, 3.6, { speed: 1.7, toward: 0 }),
  // Above the rim: only a hard, steep throw climbs that high. The dart.
  T('high', 'Up high', 18, 30, 3.2, 2.9, { speed: 0, toward: 0 }),
  // Strong headwind: slow planes are stopped dead; the dart cuts through.
  T('headwind', 'Into the wind', 28, -14, -5, 3.0, { speed: 2.4, toward: 180 }),
  // Strong crosswind: the dart barely bends; the others need aiming upwind.
  T('crosswind', 'Crosswind', 32, 14, -6, 3.0, { speed: 2.2, toward: 90 }),
  // Further right than anyone can aim. The wind has to carry it there.
  T('ride', 'Ride the wind', 44, 56, -8, 3.2, { speed: 1.8, toward: 90 }),
  // Far, a long drop, and a quartering wind: everything at once.
  T('last', 'The last one', 46, -30, -10, 3.0, { speed: 1.4, toward: -60 }),
];

/**
 * Islands that are part of the view but never a target: they fill the sky
 * the way Sky Path's are, and they are solid (a plane can land on one, which
 * the result reads as "the wrong island"). Kept low and off to the sides so
 * they never sit in the way of a sensible throw.
 */
export const SCENERY = [
  { id: 's1', x: -46, y: -12, z: -16, r: 4.2, depth: 7 },
  { id: 's2', x: 24, y: -13, z: -70, r: 4.6, depth: 7.5 },
  { id: 's3', x: -52, y: -11, z: -60, r: 3.8, depth: 6.5 },
  { id: 's4', x: 52, y: -14, z: -52, r: 4.0, depth: 7 },
].map((s) => ({ ...s, scenery: true }));

/** Where a throw at this target is called off as a miss (under its rock). */
export function floorFor(target) {
  return target.y - target.depth - 0.5;
}

/** Every solid island in the course, targets first, in a fixed order. */
export function courseIslands() {
  return [...TARGETS, ...SCENERY];
}
