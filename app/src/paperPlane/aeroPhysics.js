/**
 * Aerodynamics model for the shape-comparison prototype (2026-09-28).
 * See TODO.md's aerodynamics-planning entry for the design discussion this
 * implements. Core idea, per Luke: lift/drag/side-force are each proportional
 * to the plane's PROJECTED profile area along a different axis —
 *   - lift   <- "vertical profile": area as seen looking along world up/down
 *   - drag   <- "forward profile": area as seen looking along the direction of travel
 *   - "wind" <- "lateral profile": area as seen looking along the sideways axis
 * A flat panel with area A and (unit, sign-irrelevant) normal n, viewed along
 * axis v, presents a foreshortened area of A*|dot(n,v)| — that's the entire
 * per-panel calculation; summed over a plane's few panels this is trivial to
 * compute every frame (no polygon clipping, no occlusion testing — see
 * TODO.md for why real dynamic occlusion was deliberately scoped out).
 *
 * Orientation: rather than simulating real rigid-body rotation (torque,
 * inertia tensor — explicitly rejected as too complex/twitchy for a mostly-
 * flat object, see TODO.md), the plane's `root` orientation simply eases
 * toward "nose points along current (ground) velocity" every frame, at a
 * capped turn rate. This alone produces the arcing, nose-drops-over-time
 * behavior Luke described, for free — the nose direction IS the flight-path
 * direction, with a lag so it doesn't snap instantly.
 *
 * Wind: modeled as a constant world-space vector subtracted from the plane's
 * velocity to get an "apparent"/relative air velocity, which is what actually
 * drives lift/drag/side-force magnitude and direction — not a bolted-on
 * fourth force. A steady crosswind's main visible effect is therefore drift
 * (it directly shifts the ground track via the velocity/wind difference) plus
 * a transient turning moment right after launch, while orientation is still
 * easing toward the new apparent-wind direction — NOTE this is a real,
 * deliberate consequence of orientation tracking GROUND (not apparent-air)
 * velocity: a real glider would weathervane into the apparent wind instead,
 * giving a sustained sideways force rather than a fading one. Flagged as an
 * easy thing to flip later if the fading effect reads as too weak in testing.
 */
import * as THREE from 'three';

export const AERO_DEFAULTS = {
  gravity: 3.0,
  liftCoef: 0.05,
  dragCoef: 0.03,
  windCoef: 0.04,
  turnRateDegPerSec: 220,
  groundY: 0,
};

const WORLD_UP = new THREE.Vector3(0, 1, 0);

function computeAxes(relVel) {
  const speed = relVel.length();
  if (speed < 1e-4) return null;
  const forward = relVel.clone().multiplyScalar(1 / speed);
  let lateral = new THREE.Vector3().crossVectors(WORLD_UP, forward);
  if (lateral.lengthSq() < 1e-6) lateral.set(1, 0, 0);
  else lateral.normalize();
  return { forward, lateral, speed };
}

// Each panel only counts toward the profiles its `roles` list names (set in
// planeShapes.js), NOT every axis its current normal happens to dot with.
// Found the hard way: a panel's LOCAL normal being perpendicular to the axis
// it's "meant" for (e.g. the nose facing forward, zero contribution to lift
// at level flight) only holds AT THAT ONE ATTITUDE — once the plane pitches,
// a big enough "wrong-axis" panel starts contributing real foreshortened
// area to axes it was never meant to represent (a big flat nose panel
// pitched into a climb starts acting like an accessory wing). That's an
// unprincipled side effect, not real lift, and it can be large enough to
// destabilize the whole simulation once a panel's area is significant NOT
// just cosmetic — confirmed directly: growing the nose panel to carry a
// plane's drag budget caused genuine runaway (never-lands) flights purely
// from this leakage, before roles were added.
function computeProfiles(panels, root, axes) {
  let vertical = 0;
  let fwd = 0;
  let lat = 0;
  const worldNormal = new THREE.Vector3();
  for (const p of panels) {
    worldNormal.copy(p.localNormal).applyQuaternion(root.quaternion).normalize();
    if (p.roles.includes('lift')) vertical += p.area * Math.abs(worldNormal.dot(WORLD_UP));
    if (p.roles.includes('drag')) fwd += p.area * Math.abs(worldNormal.dot(axes.forward));
    if (p.roles.includes('lateral')) lat += p.area * Math.abs(worldNormal.dot(axes.lateral));
  }
  return { vertical, fwd, lat };
}

// Builds the quaternion that maps local (+X,+Y,+Z) = (right,up,forward) onto
// the given world forward direction, with "up" kept as close to world-up as
// possible (standard look-at-style basis). Falls back to an arbitrary right
// vector when forward is nearly vertical (cross(forward, up) degenerates).
function basisQuaternionFromForward(forward) {
  let right = new THREE.Vector3().crossVectors(forward, WORLD_UP);
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
  else right.normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  const m = new THREE.Matrix4().makeBasis(right, up, forward);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

function rotateTowards(quat, target, maxAngleRad) {
  const angle = quat.angleTo(target);
  if (angle <= maxAngleRad || angle < 1e-6) {
    quat.copy(target);
    return;
  }
  quat.slerp(target, maxAngleRad / angle);
}

/**
 * Advances one plane's flight state by dt. `state`: { position, velocity }
 * (both THREE.Vector3, mutated in place). `planeRig`: { root, panels } from
 * planeShapes.js — root.position is synced from state.position and
 * root.quaternion is eased toward the flight direction here. `tune.wind`
 * (THREE.Vector3, world-space, defaults to zero) is the constant wind vector.
 * Returns true once the plane has reached the ground.
 */
export function stepAeroFlight(state, dt, planeRig, tune = AERO_DEFAULTS) {
  const wind = tune.wind ?? new THREE.Vector3();
  const relVel = state.velocity.clone().sub(wind);
  const axes = computeAxes(relVel);
  let profiles = { vertical: 0, fwd: 0, lat: 0 };

  if (axes) {
    profiles = computeProfiles(planeRig.panels, planeRig.root, axes);

    const liftAccel = WORLD_UP.clone().multiplyScalar(tune.liftCoef * profiles.vertical * axes.speed * axes.speed);
    const dragAccel = axes.forward
      .clone()
      .multiplyScalar(-tune.dragCoef * profiles.fwd * axes.speed * axes.speed);
    // NOT relVel.dot(axes.lateral) — axes.lateral is built perpendicular to
    // axes.forward, which IS normalize(relVel) by construction, so relVel's
    // own lateral component is mathematically zero always (found this the
    // hard way: Luke reported windCoef doing nothing regardless of value,
    // because it was scaling an always-~0 quantity). What actually drives a
    // sideways push is how much of the WIND ITSELF blows across the current
    // direction of travel — wind is generally NOT parallel to relVel, so this
    // doesn't self-cancel.
    const lateralWindComponent = wind.dot(axes.lateral);
    const sideAccel = axes.lateral
      .clone()
      .multiplyScalar(tune.windCoef * profiles.lat * lateralWindComponent * axes.speed);

    state.velocity.y -= tune.gravity * dt;
    state.velocity.addScaledVector(liftAccel, dt);
    state.velocity.addScaledVector(dragAccel, dt);
    state.velocity.addScaledVector(sideAccel, dt);

    if (state.velocity.lengthSq() > 1e-6) {
      const targetQuat = basisQuaternionFromForward(state.velocity.clone().normalize());
      const maxAngle = THREE.MathUtils.degToRad(tune.turnRateDegPerSec) * dt;
      rotateTowards(planeRig.root.quaternion, targetQuat, maxAngle);
    }
  } else {
    state.velocity.y -= tune.gravity * dt;
  }

  state.position.addScaledVector(state.velocity, dt);
  planeRig.root.position.copy(state.position);

  state.lastProfiles = profiles;
  state.lastSpeed = axes ? axes.speed : 0;

  if (state.position.y <= tune.groundY) {
    state.position.y = tune.groundY;
    planeRig.root.position.copy(state.position);
    return true;
  }
  return false;
}

export function makeLaunchVelocity(launchAngleRad, power) {
  return new THREE.Vector3(0, power * Math.sin(launchAngleRad), power * Math.cos(launchAngleRad));
}

export { basisQuaternionFromForward };
