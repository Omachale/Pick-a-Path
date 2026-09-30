/**
 * The wind indicator: a plain, neutral flag on a pole beside the throw point.
 * Luke, 2026-09-29: "we will use a windsock or flag of some kind (a neutral
 * flag) to indicate wind strength and direction." It's the player's primary
 * way of reading the wind. The aim guide ignores wind by default
 * (LEVER_DEFAULTS.guideIncludesWind), and the HUD numbers are off by default.
 *
 * How it reads, in order of how quickly the eye picks it up:
 *   direction - the cloth streams toward where the wind blows
 *   strength  - droop: calm hangs almost straight down the pole, a gale
 *               flies flat out; plus ripple speed and size
 * No simulation, just vertex displacement each frame. It only needs to read
 * clearly, not behave like cloth.
 */
import * as THREE from 'three';

const POLE_H = 3.2;
const FLAG_L = 1.5; // length along the wind
const FLAG_H = 0.9; // height along the pole
const SEG_L = 16;
const SEG_H = 6;
const FULL_STRENGTH = 7; // wind strength at which the flag flies fully flat out

export function createWindFlag() {
  const group = new THREE.Group();

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.05, POLE_H, 8),
    new THREE.MeshBasicMaterial({ color: 0x6b5a44 })
  );
  pole.position.y = POLE_H / 2;
  group.add(pole);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), new THREE.MeshBasicMaterial({ color: 0xc9a86a }));
  knob.position.y = POLE_H + 0.05;
  group.add(knob);

  const geo = new THREE.PlaneGeometry(1, 1, SEG_L, SEG_H);
  // cream with a faint darker hem stripe, so the ripple is readable at a distance
  const colors = [];
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const v = pos.getY(i) + 0.5;
    const hem = v < 0.12 || v > 0.88;
    const c = new THREE.Color(hem ? 0xd8cdb4 : 0xf1ead8);
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  // Remember each vertex's (u, v) in [0,1]: u is along the flag, v up the pole.
  const uv01 = [];
  for (let i = 0; i < pos.count; i++) uv01.push(pos.getX(i) + 0.5, pos.getY(i) + 0.5);
  const cloth = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  cloth.frustumCulled = false; // vertices move every frame, so the bounding sphere is never current
  group.add(cloth);

  const attachTop = POLE_H - 0.08;
  const windDirH = new THREE.Vector3(1, 0, 0); // last known horizontal wind direction
  let strength = 0;
  let t = 0;

  const along = new THREE.Vector3();
  const side = new THREE.Vector3();
  const p = new THREE.Vector3();

  return {
    group,
    setWind(windVec) {
      strength = windVec.length();
      if (strength > 1e-3) windDirH.set(windVec.x, 0, windVec.z).normalize();
    },
    update(dt) {
      const s = THREE.MathUtils.clamp(strength / FULL_STRENGTH, 0, 1);
      t += dt * (1.5 + 7 * s); // ripple speed rises with strength
      // Droop: angle of the flag's length below horizontal. 78 deg in calm
      // (hanging down the pole with a slight lift, so it never vanishes edge-on
      // into the pole), 4 deg in a full gale.
      const droop = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(78, 4, Math.pow(s, 0.75)));
      along.copy(windDirH).multiplyScalar(Math.cos(droop)).addScaledVector(THREE.Object3D.DEFAULT_UP, -Math.sin(droop));
      side.crossVectors(along, THREE.Object3D.DEFAULT_UP).normalize(); // normal to the cloth, for ripple
      const amp = 0.04 + 0.12 * s;
      for (let i = 0; i < pos.count; i++) {
        const u = uv01[i * 2];
        const v = uv01[i * 2 + 1];
        const wave = Math.sin(u * 7 - t) * amp * u + Math.sin(u * 13 - t * 1.7 + v * 2) * amp * 0.35 * u;
        p.set(0, attachTop - (1 - v) * FLAG_H, 0) // hem runs down the pole
          .addScaledVector(along, u * FLAG_L)
          .addScaledVector(side, wave);
        // the free edge sags a little under its own weight in lighter winds
        p.y -= u * u * 0.18 * (1 - s);
        pos.setXYZ(i, p.x, p.y, p.z);
      }
      pos.needsUpdate = true;
    },
  };
}
