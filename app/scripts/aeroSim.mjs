/**
 * Headless aero-model analysis tool (2026-09-28), per Luke's ask: "run the
 * maths, much faster" instead of eyeballing the real-time prototype. Reuses
 * the exact same modules the prototype uses (planeShapes.js, aeroPhysics.js)
 * so results here are guaranteed to match what the graphical tool would show
 * — this is not a re-derivation of the model, just the same code run
 * thousands of times per second with no rendering.
 *
 * Run from the app/ directory: node scripts/aeroSim.mjs
 */
import * as THREE from 'three';
import { buildTestPlane, AERO_TEST_PLANES } from '../src/paperPlane/planeShapes.js';
import { AERO_DEFAULTS, stepAeroFlight, makeLaunchVelocity } from '../src/paperPlane/aeroPhysics.js';

const DT = 1 / 240;
const KINDS = Object.keys(AERO_TEST_PLANES);

function simulate(kind, { angleDeg, power, tune }) {
  const rig = buildTestPlane(kind);
  const spawn = new THREE.Vector3(0, 1.5, 0);
  rig.root.position.copy(spawn);
  const velocity = makeLaunchVelocity(THREE.MathUtils.degToRad(angleDeg), power);
  rig.root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), velocity.clone().normalize());
  const state = { position: spawn.clone(), velocity };

  let t = 0;
  let vertMin = Infinity, vertMax = -Infinity, vertSum = 0, steps = 0;
  let maxLateralDisplacement = 0;
  let maxHeight = 0;
  let maxSpeed = 0;
  let avgSpeedSum = 0;
  for (let i = 0; i < 100000; i++) {
    const landed = stepAeroFlight(state, DT, rig, tune);
    t += DT;
    if (state.lastProfiles) {
      vertMin = Math.min(vertMin, state.lastProfiles.vertical);
      vertMax = Math.max(vertMax, state.lastProfiles.vertical);
      vertSum += state.lastProfiles.vertical;
      steps++;
    }
    maxHeight = Math.max(maxHeight, state.position.y);
    maxSpeed = Math.max(maxSpeed, state.lastSpeed ?? 0);
    avgSpeedSum += state.lastSpeed ?? 0;
    maxLateralDisplacement = Math.max(maxLateralDisplacement, Math.abs(state.position.x - spawn.x));
    if (landed) break;
  }
  const distance = Math.hypot(state.position.x - spawn.x, state.position.z - spawn.z);
  return {
    distance, time: t, vertMin, vertMax, vertAvg: vertSum / steps, maxLateralDisplacement,
    maxHeight, maxSpeed, avgSpeed: avgSpeedSum / steps,
  };
}

console.log('=== Static panel data (no motion — level-flight-equivalent check) ===');
for (const kind of KINDS) {
  const rig = buildTestPlane(kind);
  const cfg = AERO_TEST_PLANES[kind];
  let vertAtLevel = 0, fwdAtLevel = 0;
  for (const p of rig.panels) {
    if (p.roles.includes('lift')) vertAtLevel += p.area * Math.abs(p.localNormal.dot(new THREE.Vector3(0, 1, 0)));
    if (p.roles.includes('drag')) fwdAtLevel += p.area * Math.abs(p.localNormal.dot(new THREE.Vector3(0, 0, 1)));
  }
  console.log(
    `${kind.padEnd(7)} dihedral=${cfg.dihedralDeg}\xb0  cos(dihedral)=${Math.cos(THREE.MathUtils.degToRad(cfg.dihedralDeg)).toFixed(3)}  ` +
    `vertProfile@level=${vertAtLevel.toFixed(3)}  fwdProfile@level=${fwdAtLevel.toFixed(3)}  totalArea=${rig.totalArea.toFixed(3)}`
  );
}

console.log('\n=== Flight comparison at default coefficients, angle=45, power=6 & 9 ===');
for (const power of [6, 9]) {
  for (const kind of KINDS) {
    const r = simulate(kind, { angleDeg: 45, power, tune: { ...AERO_DEFAULTS, wind: new THREE.Vector3() } });
    console.log(
      `power=${power} ${kind.padEnd(7)} distance=${r.distance.toFixed(2)} time=${r.time.toFixed(2)}s ` +
      `vert[min/avg/max]=${r.vertMin.toFixed(3)}/${r.vertAvg.toFixed(3)}/${r.vertMax.toFixed(3)}`
    );
  }
}

console.log('\n=== Flight comparison at MAX lift coef (0.2), several launch angles ===');
for (const angleDeg of [20, 30, 45, 60]) {
  for (const kind of KINDS) {
    const r = simulate(kind, {
      angleDeg,
      power: 6,
      tune: { ...AERO_DEFAULTS, liftCoef: 0.2, wind: new THREE.Vector3() },
    });
    console.log(
      `angle=${angleDeg} ${kind.padEnd(7)} distance=${r.distance.toFixed(2)} time=${r.time.toFixed(2)}s ` +
      `vertAvg=${r.vertAvg.toFixed(3)} maxHeight=${r.maxHeight.toFixed(2)} maxSpeed=${r.maxSpeed.toFixed(2)} avgSpeed=${r.avgSpeed.toFixed(2)}`
    );
  }
}

console.log('\n=== Wind sensitivity: crosswind (90deg, strength 4), default coefficients ===');
for (const kind of KINDS) {
  const windVec = new THREE.Vector3(Math.sin(Math.PI / 2) * 4, 0, Math.cos(Math.PI / 2) * 4);
  const r = simulate(kind, { angleDeg: 45, power: 6, tune: { ...AERO_DEFAULTS, wind: windVec } });
  const noWind = simulate(kind, { angleDeg: 45, power: 6, tune: { ...AERO_DEFAULTS, wind: new THREE.Vector3() } });
  console.log(
    `${kind.padEnd(7)} time=${r.time.toFixed(2)}s maxLateralDisp=${r.maxLateralDisplacement.toFixed(2)} ` +
    `(no-wind time was ${noWind.time.toFixed(2)}s)`
  );
}

console.log('\n=== Wind coefficient sanity check: does it actually scale the outcome? ===');
for (const windCoef of [0, 0.02, 0.1, 0.2]) {
  const windVec = new THREE.Vector3(4, 0, 0);
  const r = simulate('middle', { angleDeg: 45, power: 6, tune: { ...AERO_DEFAULTS, windCoef, wind: windVec } });
  console.log(`windCoef=${windCoef.toString().padEnd(4)} maxLateralDisp=${r.maxLateralDisplacement.toFixed(3)}`);
}

console.log('\n=== Wind deviation angle (lateral vs forward displacement) + lateral profile ===');
for (const kind of KINDS) {
  const rig = buildTestPlane(kind);
  let latAtLevel = 0;
  for (const p of rig.panels) {
    if (p.roles.includes('lateral')) latAtLevel += p.area * Math.abs(p.localNormal.dot(new THREE.Vector3(1, 0, 0)));
  }

  const windVec = new THREE.Vector3(4, 0, 0); // pure crosswind, easiest to read x=lateral, z=forward
  const spawn = new THREE.Vector3(0, 1.5, 0);
  const velocity = makeLaunchVelocity(THREE.MathUtils.degToRad(45), 6);
  const rig2 = buildTestPlane(kind);
  rig2.root.position.copy(spawn);
  rig2.root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), velocity.clone().normalize());
  const state = { position: spawn.clone(), velocity };
  const tune = { ...AERO_DEFAULTS, wind: windVec };
  let t = 0;
  for (let i = 0; i < 100000; i++) {
    const landed = stepAeroFlight(state, DT, rig2, tune);
    t += DT;
    if (landed) break;
  }
  const lateral = state.position.x - spawn.x;
  const forward = state.position.z - spawn.z;
  const deviationDeg = THREE.MathUtils.radToDeg(Math.atan2(lateral, forward));
  console.log(
    `${kind.padEnd(7)} lateralProfile@level=${latAtLevel.toFixed(3)}  forward=${forward.toFixed(2)} lateral=${lateral.toFixed(2)} ` +
    `deviationAngle=${deviationDeg.toFixed(1)}\xb0 time=${t.toFixed(2)}s`
  );
}
