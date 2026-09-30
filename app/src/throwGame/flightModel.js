/**
 * Flight model for the island-throwing minigame (2026-09-29).
 *
 * Deliberately NOT the profile-area model from aeroPhysics.js. That one
 * derived every plane's behaviour from panel geometry, and every attempt to
 * tune it ran into a side effect of the geometry: identical drag across
 * designs, cos(dihedral) barely separating shallow angles, panels leaking into
 * axes they shouldn't feed, and lift pumping energy into runaway never-land
 * flights (see TODO.md, aerodynamics entries). Luke, 2026-09-29: "worry a lot
 * less about realism... make it clean, with the plane types meaningfully
 * different... modular."
 *
 * So each plane type is a handful of explicit, directly-tunable stats, and the
 * physics is a point mass:
 *
 *   accel = gravity + lift + drag (+ direct wind push) (+ gusts)
 *
 * Lift acts PERPENDICULAR to the airflow by default. That single choice is
 * what makes this model safe to tune aggressively: a force perpendicular to
 * velocity does no work, so lift can bend the path (swoops, flattening into a
 * glide) but can never add energy. Only drag changes the energy, and it only
 * removes it, so every flight is guaranteed to come down. The old model's
 * "never lands at max lift" bug is impossible here, not merely unlikely.
 *
 * Every behavioural choice that could reasonably go another way is a LEVER
 * (see LEVER_DEFAULTS), so options can be compared in-game instead of
 * argued about.
 */
import * as THREE from 'three';

export const GRAVITY = 9.8;

/**
 * Per-plane stats. Units: world units and seconds (1 unit ~ 1.4 m, going by
 * Sky Path's figure height).
 *   speedMin/Max - launch speed at 0% / 100% power
 *   lift         - lift accel per (airspeed^2). The plane settles into a glide
 *                  near sqrt(g / lift), so higher lift = slower, floatier glide.
 *   drag         - drag accel per (airspeed^2). lift/drag is the glide ratio.
 *   windPush     - how hard the wind shoves this plane directly (push mode)
 *   guideSeconds - how much of the predicted path the aim guide shows when
 *                  the guide is in 'plane' mode. This is the "dart is easier
 *                  to aim" dial, made explicit.
 * Values tuned with scripts/throwSim.mjs; see TODO.md for the runs.
 */
export const PLANE_TYPES = {
  dart: {
    label: 'Dart',
    tagline: 'Fast and flat. Shrugs off wind, but runs out of range.',
    speedMin: 11,
    speedMax: 20,
    lift: 0.012,
    drag: 0.007,
    windPush: 0.2,
    guideSeconds: 1.6,
    color: 0xffb3a0,
  },
  middle: {
    label: 'All-rounder',
    tagline: 'A bit of everything. Forgiving in most conditions.',
    speedMin: 9,
    speedMax: 19,
    lift: 0.03,
    drag: 0.0045,
    windPush: 0.55,
    guideSeconds: 0.9,
    color: 0xf3ead9,
  },
  glider: {
    label: 'Glider',
    tagline: 'Floats a long way. At the mercy of the wind.',
    speedMin: 7,
    speedMax: 16,
    lift: 0.06,
    drag: 0.005,
    windPush: 1.0,
    guideSeconds: 0.45,
    color: 0xbfe3ff,
  },
};

export const PLANE_ORDER = ['dart', 'middle', 'glider'];

/**
 * How the physics behaves. Each is independent, so any combination is valid.
 */
export const LEVER_DEFAULTS = {
  // 'perpendicular': lift is at right angles to the airflow. It can't add
  //   energy, and it produces glides and swoops.
  // 'vertical': lift pushes straight up (the old model's choice). It feels
  //   floatier and more arcade-like. The cap below keeps it bounded.
  liftDirection: 'perpendicular',
  // Luke's "vertical profile" idea: lift scales with cos(flight-path angle)^n,
  // so a steep climb or dive presents less wing and gets less lift, and
  // levelling out restores it. 0 disables it.
  profileExponent: 1,
  // Maximum lift as a multiple of gravity. It stops loop-the-loops from hard,
  // fast throws (perpendicular mode) and runaway climbs (vertical mode).
  // 0 means uncapped.
  liftCapG: 1.6,
  // Damps the swoops, i.e. the phugoid: a glider thrown faster than its glide
  // speed trades speed for height and back again, like a swing. Undamped,
  // most of the launch energy goes into porpoising rather than distance, and
  // the landing point swings wildly with tiny changes in the throw. Adds
  // `stability * dV/dt` to lift, which theory puts at near-critical damping
  // around 2. 0 gives the raw swooping behaviour.
  stability: 2,
  // 'air': forces act on air-relative velocity. A headwind costs slow planes
  //   far more than fast ones, and a crosswind drags a plane along in
  //   proportion to its drag.
  // 'push': a direct shove of wind * windPush. Simple, and planes differ only
  //   by their windPush stat.
  // 'both': both effects at once.
  windMode: 'both',
  windScale: 1, // multiplies the course's wind vector, everywhere
  // Adds the wind's component ALONG the horizontal throw direction to the
  // launch, so a throw leaves the hand at its intended AIRspeed. Without it
  // (the physically stricter choice), throwing with a tailwind lowers the
  // plane's airspeed at release, which costs a glider its zoom climb. It then
  // lands SHORTER in a tailwind than in calm air (111 -> 93 units, measured
  // by scripts/glideProbe.mjs), the opposite of what any player expects. The
  // crosswind component is deliberately NOT added, so sideways drift still
  // depends on each plane's own wind susceptibility rather than every plane
  // starting at full drift.
  launchWithWind: true,
  pushStrength: 0.6, // global multiplier on the direct-push part
  // Smooth random wind fluctuation, as a fraction of the wind strength and
  // scaled by windPush. Seeded per throw, so the SAME throw with the SAME seed
  // is repeatable.
  gusts: 0,
  // 'arrow': a straight arrow along the launch direction only, no trajectory.
  // 'plane': the predicted path, drawn live during the swipe, with its length
  //   per PLANE_TYPES.guideSeconds.
  // 'full': the whole predicted path, live during the swipe.
  // 'off': nothing.
  // 'arrow' is the default since the swipe input (2026-09-29). A live
  // trajectory lets the player adjust the swipe until the line lands on the
  // island, which does exactly the work Luke wants the player to do ("too
  // easy, as it does too much of the work for the player").
  guide: 'arrow',
  // Whether the aim guide accounts for wind. False means the flag is the only
  // way to read it.
  guideIncludesWind: false,
};

const UP = new THREE.Vector3(0, 1, 0);

export function launchVelocity(type, { yaw, pitch, power }) {
  const speed = type.speedMin + (type.speedMax - type.speedMin) * THREE.MathUtils.clamp(power, 0, 1);
  const cp = Math.cos(pitch);
  // yaw 0 = straight ahead (-z), positive = to the player's right (+x)
  return new THREE.Vector3(Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp).multiplyScalar(speed);
}

/** The launch velocity the flight actually starts with, after levers.launchWithWind. */
export function throwVelocity(type, aim, wind, levers) {
  const v = launchVelocity(type, aim);
  if (levers.launchWithWind) {
    const h = new THREE.Vector3(Math.sin(aim.yaw), 0, -Math.cos(aim.yaw)); // horizontal throw direction
    v.addScaledVector(h, wind.dot(h) * levers.windScale);
  }
  return v;
}

function gustVector(state, strength, out) {
  const t = state.t;
  const p = state.gustPhase;
  out.set(
    Math.sin(1.3 * t + p[0]) + 0.6 * Math.sin(3.1 * t + p[1]),
    0.4 * Math.sin(2.2 * t + p[2]),
    Math.sin(1.7 * t + p[3]) + 0.6 * Math.sin(2.7 * t + p[4])
  );
  return out.multiplyScalar(strength * 0.5);
}

const _air = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _liftDir = new THREE.Vector3();
const _accel = new THREE.Vector3();
const _gust = new THREE.Vector3();

/**
 * Advances `state` ({ pos, vel, t, gustPhase }) by dt. `wind` is the course's
 * world-space wind vector, before levers.windScale. Writes the forces it used
 * onto state.debug so the HUD can show what is actually happening.
 */
export function stepFlight(state, dt, type, levers, wind) {
  const { pos, vel } = state;
  const scaledWindLen = wind.length() * levers.windScale;
  const useAir = levers.windMode === 'air' || levers.windMode === 'both';
  const usePush = levers.windMode === 'push' || levers.windMode === 'both';

  _accel.set(0, -GRAVITY, 0);

  _air.copy(vel);
  if (useAir) _air.addScaledVector(wind, -levers.windScale);
  const speed = _air.length();

  let liftMag = 0;
  let dragMag = 0;
  if (speed > 1e-4) {
    _fwd.copy(_air).multiplyScalar(1 / speed);
    const cosGamma = Math.hypot(_fwd.x, _fwd.z); // 1 = level, 0 = vertical
    const profile = levers.profileExponent > 0 ? Math.pow(cosGamma, levers.profileExponent) : 1;
    liftMag = type.lift * profile * speed * speed;
    // Phugoid damping: more lift while speeding up (in a dive), less while
    // slowing (in a climb). This is what makes the swing die away instead of
    // repeating. Linearising the glide shows damping ratio ~ stability / 2.8.
    if (levers.stability > 0 && state.prevAirspeed != null && dt > 0) {
      liftMag += levers.stability * profile * ((speed - state.prevAirspeed) / dt);
    }
    liftMag = Math.max(0, liftMag);
    if (levers.liftCapG > 0) liftMag = Math.min(liftMag, levers.liftCapG * GRAVITY);

    if (levers.liftDirection === 'vertical') {
      _liftDir.copy(UP);
    } else {
      // The part of world-up that is perpendicular to the airflow. At level
      // flight this is plain up; in a climb it tips back, in a dive forward.
      _liftDir.copy(UP).addScaledVector(_fwd, -_fwd.y);
      const l = _liftDir.length();
      if (l > 1e-4) _liftDir.multiplyScalar(1 / l);
      else _liftDir.set(0, 0, 0); // flying straight up/down: no defined "up", and profile is ~0 anyway
    }
    _accel.addScaledVector(_liftDir, liftMag);

    dragMag = type.drag * speed * speed;
    _accel.addScaledVector(_fwd, -dragMag);
  }

  // Direct push: accelerates the plane along the wind only until its own
  // velocity along the wind matches the wind speed. It never pulls back. The
  // first version was a plain constant acceleration, which has no speed
  // limit: over a 12 s glider flight a modest tailwind added ~170 units of
  // drift (found by scripts/throwSim.mjs). This version gives a crosswind a
  // natural terminal drift speed, and gives a tailwind nothing once the plane
  // outruns it. `windPush * pushStrength` is the rate (1/s) at which a plane
  // is brought up to wind speed, i.e. how "light" it is.
  if (usePush && scaledWindLen > 1e-4) {
    _gust.copy(wind).multiplyScalar(levers.windScale / scaledWindLen); // unit wind direction (reusing a scratch vector)
    const along = vel.dot(_gust);
    const deficit = scaledWindLen - along;
    if (deficit > 0) _accel.addScaledVector(_gust, deficit * type.windPush * levers.pushStrength);
  }

  if (levers.gusts > 0 && scaledWindLen > 0) {
    gustVector(state, levers.gusts * scaledWindLen * type.windPush, _gust);
    _accel.add(_gust);
  }

  // Semi-implicit Euler: velocity first, then position with the new velocity.
  // It stays stable at the step sizes used here, where plain Euler slowly
  // gains energy in a swoop.
  vel.addScaledVector(_accel, dt);
  pos.addScaledVector(vel, dt);
  state.t += dt;
  state.prevAirspeed = speed;
  state.debug = { airspeed: speed, lift: liftMag, drag: dragMag };
}

export function makeFlightState(origin, velocity, seed = 1) {
  const rnd = mulberry(seed);
  return {
    pos: origin.clone(),
    vel: velocity.clone(),
    t: 0,
    prevAirspeed: null,
    gustPhase: [0, 1, 2, 3, 4].map(() => rnd() * Math.PI * 2),
    debug: null,
  };
}

export function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Runs a whole throw with no rendering. Used for the in-game aim guide and
 * by scripts/throwSim.mjs, so both see exactly the flight the player gets.
 * `testSegment(a, b)` returns an outcome object to stop the flight, or null.
 * `maxTime` also limits the guide's length.
 * Returns { outcome, path (if recordPath), time }.
 */
export function simulateThrow({ origin, velocity, type, levers, wind, testSegment, dt = 1 / 120, maxTime = 20, recordPath = false, seed = 1, recordEvery = 1 }) {
  const state = makeFlightState(origin, velocity, seed);
  const prev = new THREE.Vector3();
  const path = recordPath ? [state.pos.clone()] : null;
  let step = 0;
  while (state.t < maxTime) {
    prev.copy(state.pos);
    stepFlight(state, dt, type, levers, wind);
    step++;
    if (path && step % recordEvery === 0) path.push(state.pos.clone());
    const hit = testSegment ? testSegment(prev, state.pos) : null;
    if (hit) {
      if (path) path.push(hit.point.clone());
      return { outcome: hit, path, time: state.t };
    }
  }
  return { outcome: { type: 'timeout', point: state.pos.clone() }, path, time: state.t };
}
