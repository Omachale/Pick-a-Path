/**
 * Paper-plane flight: the one source of truth for how a throw flies.
 *
 * Pure maths, no three.js and no DOM, so the game and the headless proof
 * (scripts/planeGameSim.mjs) run literally the same code. The brief asks for
 * "a simple, stable, deterministic model with clear, separate stats per
 * plane" over realism, so every number that makes the planes different lives
 * in PLANES below, named for what it does to the flight rather than for any
 * aerodynamic quantity.
 *
 * The shape of the model (one plane, flying along a fixed compass heading):
 *
 *  - THE THROW. Out of the hand the plane climbs like anything thrown:
 *    gravity eats its upward speed and air (`climbDrag`) eats its forward
 *    speed. A steeper or harder throw goes higher.
 *  - THE TOP. If it reaches the top of its climb with too little forward
 *    speed left (`stallSpeed`), it STALLS: the nose drops and it dives for a
 *    moment before it can glide again, losing height and so distance. So a
 *    throw can be too steep as well as too flat, and each plane has its own
 *    best angle. A stall is a visible event, so the result can name it.
 *  - THE GLIDE. After the top it noses over and glides: forward speed eases
 *    to the plane's `cruise`, and it sinks at its own `sink` rate. A fast
 *    plane carried over the top swoops a little (`swoop`). Sink rate is the
 *    biggest difference between the planes: a dart drops quickly, a glider
 *    hangs in the air for a long time.
 *  - Wind does not just nudge the plane at launch. It catches it over time:
 *    the plane's sideways/forward drift relaxes toward the wind's own speed
 *    (times `windCatch`, how much of the wind this plane takes), at rate
 *    `windGrip`. Fresh out of the hand a throw goes where it was aimed; the
 *    longer it's in the air, the more it goes where the wind goes. A glider
 *    is slow AND long-lived AND light, so it bends a long way downwind; a
 *    dart is quick, short-lived and barely held, so it hardly bends.
 *
 * Everything is integrated at a fixed step, so the same throw always gives
 * the same flight, on any device and in Node.
 *
 * World frame: x right, y up, z toward the player; "out" (away from the
 * Temple Island) is -z. A heading of 0 points out, positive turns right.
 */

export const GRAVITY = 5.2; // world units/s² — slower than real, so flights are long enough to watch
export const STEP = 1 / 120; // integration step (s)
export const SAMPLE_EVERY = 4; // keep every 4th step (30 per second) for playback
export const MAX_TIME = 30; // s; a flight still going after this is called off
export const KILL_Y = -15; // below this a plane has gone into the clouds

/**
 * The three planes. The comments say what each number DOES; the sim prints
 * the resulting flights (time, range, drift) so the differences are checked,
 * not assumed.
 */
export const PLANES = {
  dart: {
    key: 'dart',
    name: 'Dart',
    blurb: 'Fast and straight. The wind hardly moves it.',
    throwMin: 5, // launch speed at lowest power (units/s)
    throwMax: 13, // ...and at full power
    climbDrag: 0.25, // how fast forward speed bleeds away while climbing (1/s)
    stallSpeed: 3.2, // forward speed needed at the top to avoid a stall
    stallSink: 7, // how fast it dives while stalled
    stallTime: 0.7, // ...and for how long (s)
    cruise: 5.5, // forward speed once gliding
    sink: 2.6, // how fast it comes down once gliding
    noseOver: 2.2, // how quickly it settles from the top into its glide (1/s)
    swoop: 0.35, // extra lift from surplus speed after the top
    windCatch: 0.3, // share of the wind's speed it ends up drifting at
    windGrip: 0.45, // how quickly the wind takes hold (1/s)
  },
  allrounder: {
    key: 'allrounder',
    name: 'Classic',
    blurb: 'A bit of everything. Easy to fly.',
    throwMin: 3.5,
    throwMax: 9.5,
    climbDrag: 0.5,
    stallSpeed: 2.2,
    stallSink: 4.5,
    stallTime: 0.8,
    cruise: 3.6,
    sink: 1.35,
    noseOver: 2.0,
    swoop: 0.3,
    windCatch: 0.65,
    windGrip: 0.7,
  },
  glider: {
    key: 'glider',
    name: 'Glider',
    blurb: 'Slow and floaty. Goes far, but the wind carries it.',
    throwMin: 2.5,
    throwMax: 7.5,
    climbDrag: 0.9,
    stallSpeed: 1.6,
    stallSink: 3,
    stallTime: 1.0,
    cruise: 2.4,
    sink: 0.95,
    noseOver: 1.6,
    swoop: 0.25,
    windCatch: 1.0,
    windGrip: 0.9,
  },
};
export const PLANE_ORDER = ['dart', 'allrounder', 'glider'];

/** The input limits, shared by the UI and the sim. */
export const AIM = {
  minAngle: 0, // radians above level
  maxAngle: (65 * Math.PI) / 180,
  maxTurn: (45 * Math.PI) / 180, // furthest left/right of straight out
  minPower: 0.08, // below this a release cancels instead of throwing
};

/**
 * Where the plane leaves the hand, relative to the thrower's feet: held up
 * in the right hand, a little forward (and so visible beside the thrower
 * from behind, not hidden by them).
 */
export const HAND = { up: 1.12, out: 0.3, side: 0.42 };

/**
 * Islands are simple solids for collision: a flat round deck (`r` around
 * x/z at height `y`) on a rocky body that narrows to a point `depth` below.
 * The look of an island is built to match exactly this outline (see
 * islands.js), so what you see is what the plane hits.
 */
/**
 * The rock's outline: its radius, as a share of the deck's, at `f` of the
 * way from the deck (0) down to the tip (1). islands.js builds the visible
 * rock from this same function, so the two can't disagree.
 */
export function bodyProfile(f) {
  // Full width for a short lip under the deck, then a rounded taper.
  return Math.pow(Math.max(0, 1 - f), 0.45);
}

function bodyRadiusAt(island, y) {
  const below = island.y - y;
  if (below < 0 || below > island.depth) return -1;
  return island.r * bodyProfile(below / island.depth);
}

/**
 * Flies one throw to its end.
 *
 * @param {object} plane     one of PLANES
 * @param {{angle:number, turn:number, power:number}} aim
 *   angle: radians above level; turn: radians right of straight out;
 *   power: 0..1
 * @param {{x:number, z:number}} wind  world units/s, horizontal
 * @param {Array} islands    {x, y, z, r, depth, id}
 * @param {{x:number,y:number,z:number}} [start]  the thrower's feet
 * @param {{floorY?: number}} [opts]  floorY: end the flight as a miss once it
 *   sinks below this (the game passes "under the target's rock"), so a miss
 *   doesn't glide on for ten more seconds down to the clouds
 * @returns {{samples: Float32Array, count: number, end: object, stalled: boolean, peak: number, time: number, windDrift: {x:number,z:number}}}
 *   samples: [t, x, y, z, heading, pitch] per sample.
 */
export function fly(plane, aim, wind, islands, start = { x: 0, y: 0, z: 0 }, opts = {}) {
  const floorY = Math.max(KILL_Y, opts.floorY ?? KILL_Y);
  const heading = aim.turn;
  const dirX = Math.sin(heading);
  const dirZ = -Math.cos(heading);
  let x = start.x + dirX * HAND.out - dirZ * HAND.side;
  let y = start.y + HAND.up;
  let z = start.z + dirZ * HAND.out + dirX * HAND.side;
  const power = Math.min(1, Math.max(0, aim.power));
  const v0 = plane.throwMin + (plane.throwMax - plane.throwMin) * power;
  let vh = v0 * Math.cos(aim.angle); // forward airspeed
  let vy = v0 * Math.sin(aim.angle); // upward speed
  let gamma = aim.angle; // flight-path angle, kept for the nose's pitch
  let pastTop = false;
  let stallLeft = 0;
  let driftX = 0;
  let driftZ = 0;
  let windDriftX = 0; // how far the wind alone has moved it, for feedback
  let windDriftZ = 0;
  let stalled = false;
  let peak = y;

  const maxSamples = Math.ceil(MAX_TIME / STEP / SAMPLE_EVERY) + 2;
  const samples = new Float32Array(maxSamples * 6);
  let count = 0;
  const push = (t) => {
    const o = count * 6;
    samples[o] = t;
    samples[o + 1] = x;
    samples[o + 2] = y;
    samples[o + 3] = z;
    samples[o + 4] = heading;
    samples[o + 5] = gamma;
    count++;
  };
  push(0);

  let t = 0;
  let step = 0;
  let end = null;
  while (!end) {
    if (!pastTop) {
      // --- the throw: climbing like anything thrown
      vy -= GRAVITY * STEP;
      vh -= plane.climbDrag * vh * STEP;
      if (vy <= 0) {
        pastTop = true;
        if (vh < plane.stallSpeed) {
          // Graded: only just too slow is a short dip, far too slow the
          // full dive. A cliff edge here made one degree of angle the
          // difference between a good throw and a terrible one.
          stalled = true;
          stallLeft = plane.stallTime * Math.min(1, 0.25 + (1.5 * (plane.stallSpeed - vh)) / plane.stallSpeed);
        }
      }
    } else if (stallLeft > 0) {
      // --- the stall: nose down, diving, barely going forward
      stallLeft -= STEP;
      vy += (-plane.stallSink - vy) * (1 - Math.exp(-5 * STEP));
      vh += (plane.cruise - vh) * (1 - Math.exp(-0.8 * STEP));
    } else {
      // --- the glide: settle to cruise speed and the plane's own sink rate;
      // surplus speed lifts it a little (the swoop after a hard throw)
      const e = 1 - Math.exp(-plane.noseOver * STEP);
      const surplus = Math.max(0, vh - plane.cruise);
      vy += (-plane.sink + plane.swoop * surplus - vy) * e;
      vh += (plane.cruise - vh) * e;
    }
    gamma = Math.atan2(vy, Math.max(vh, 0.05));

    // --- the wind catching hold over time
    const k = 1 - Math.exp(-plane.windGrip * STEP);
    driftX += (wind.x * plane.windCatch - driftX) * k;
    driftZ += (wind.z * plane.windCatch - driftZ) * k;

    const horiz = vh;
    const px = x;
    const py = y;
    const pz = z;
    x += (dirX * horiz + driftX) * STEP;
    z += (dirZ * horiz + driftZ) * STEP;
    y += vy * STEP;
    windDriftX += driftX * STEP;
    windDriftZ += driftZ * STEP;
    t += STEP;
    step++;
    if (y > peak) peak = y;

    // --- what did it hit?
    for (let i = 0; i < islands.length && !end; i++) {
      const isl = islands[i];
      if (isl.solid === false) continue;
      const dx = x - isl.x;
      const dz = z - isl.z;
      const d = Math.hypot(dx, dz);
      if (py >= isl.y && y < isl.y) {
        // Crossed the deck's height this step: on the deck if inside its rim
        // at the crossing point.
        const f = (py - isl.y) / (py - y);
        const cx = px + (x - px) * f;
        const cz = pz + (z - pz) * f;
        if (Math.hypot(cx - isl.x, cz - isl.z) <= isl.r) {
          x = cx;
          z = cz;
          y = isl.y;
          end = landOn(isl, x, z, dirX * horiz + driftX, dirZ * horiz + driftZ, i);
        }
      } else if (y < isl.y) {
        const br = bodyRadiusAt(isl, y);
        if (br > 0 && d < br) end = { type: 'crashed', island: i, x, y, z };
      }
    }
    if (!end && y < floorY) end = { type: 'fell', island: -1, x, y, z };
    if (!end && t >= MAX_TIME) end = { type: 'fell', island: -1, x, y, z };
    if (end || step % SAMPLE_EVERY === 0) push(t);
  }

  return {
    samples,
    count,
    end,
    stalled,
    peak,
    time: t,
    windDrift: { x: windDriftX, z: windDriftZ },
  };
}

/**
 * Touching down: the plane skids a little way along its ground track, more
 * for a fast landing, and stops. It never skids off the edge: a plane that
 * touched the deck counts as on it (falling off after a touchdown felt unfair
 * in testing and is hard to read on a small screen).
 */
function landOn(isl, x, z, vx, vz, index) {
  const sp = Math.hypot(vx, vz);
  const slide = Math.min(1.2, sp * 0.12);
  let ex = x + (sp > 1e-6 ? (vx / sp) * slide : 0);
  let ez = z + (sp > 1e-6 ? (vz / sp) * slide : 0);
  const d = Math.hypot(ex - isl.x, ez - isl.z);
  const lim = isl.r * 0.95;
  if (d > lim) {
    ex = isl.x + ((ex - isl.x) / d) * lim;
    ez = isl.z + ((ez - isl.z) / d) * lim;
  }
  return { type: 'landed', island: index, x: ex, y: isl.y, z: ez, touchX: x, touchZ: z };
}

/** Reads one sample back out of a flight. */
export function sampleAt(flight, i, out = {}) {
  const o = Math.min(i, flight.count - 1) * 6;
  const s = flight.samples;
  out.t = s[o];
  out.x = s[o + 1];
  out.y = s[o + 2];
  out.z = s[o + 3];
  out.heading = s[o + 4];
  out.pitch = s[o + 5];
  return out;
}

/** The plane's state at time t, interpolated between samples. */
export function stateAt(flight, t, out = {}) {
  const s = flight.samples;
  const n = flight.count;
  if (t <= 0) return sampleAt(flight, 0, out);
  if (t >= s[(n - 1) * 6]) return sampleAt(flight, n - 1, out);
  // Samples are evenly spaced except the last; a short search from the even guess.
  const dtS = STEP * SAMPLE_EVERY;
  let i = Math.min(n - 2, Math.floor(t / dtS));
  while (i > 0 && s[i * 6] > t) i--;
  while (i < n - 2 && s[(i + 1) * 6] < t) i++;
  const a = i * 6;
  const b = a + 6;
  const f = (t - s[a]) / Math.max(1e-6, s[b] - s[a]);
  out.t = t;
  out.x = s[a + 1] + (s[b + 1] - s[a + 1]) * f;
  out.y = s[a + 2] + (s[b + 2] - s[a + 2]) * f;
  out.z = s[a + 3] + (s[b + 3] - s[a + 3]) * f;
  out.heading = s[a + 4];
  out.pitch = s[a + 5] + (s[b + 5] - s[a + 5]) * f;
  return out;
}
