/**
 * Fireworks over the winning team(s) at the end of the reveal. Luke,
 * 2026-10-06: "add fireworks above the winning team(s)".
 *
 * Model-sized, like everything on the table: a rocket climbs from the
 * platform trailing sparks, then bursts into a sphere of coloured stars that
 * slow, droop under gravity, twinkle and fade. One pool of points, drawn in
 * a single call. Colours are well over white so main.js's bloom gives them
 * their glow (the room itself never gets that bright, so it doesn't bloom).
 */
import * as THREE from 'three';

const MAX = 4000;
const GRAVITY = -0.35; // m/s², gentle: the stars hang a little before falling
const DRAG = 1.6; // per second, how fast a burst's stars slow
const PALETTE = [0xff4a6a, 0xffd23a, 0x4ad8ff, 0x8aff6a, 0xd06aff, 0xffffff, 0xff8a3a];

// A soft round dot, so each point reads as a spark rather than a square.
function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export function createFireworks(scene, rand = Math.random) {
  const pos = new Float32Array(MAX * 3);
  const col = new Float32Array(MAX * 3);
  const p = Array.from({ length: MAX }, () => ({ alive: false, v: new THREE.Vector3(), age: 0, life: 1, base: new THREE.Color(), kind: 'star', drag: DRAG, twinkle: 0 }));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const points = new THREE.Points(
    geo,
    new THREE.PointsMaterial({ size: 0.02, map: dotTexture(), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
  );
  points.frustumCulled = false;
  scene.add(points);
  const rockets = [];
  let next = 0;

  function spawn(x, y, z, vx, vy, vz, colour, life, kind, drag = DRAG) {
    for (let k = 0; k < MAX; k++) {
      const i = (next + k) % MAX;
      if (p[i].alive) continue;
      next = (i + 1) % MAX;
      const q = p[i];
      q.alive = true;
      q.age = 0;
      q.life = life;
      q.kind = kind;
      q.drag = drag;
      q.twinkle = rand() * 10;
      q.v.set(vx, vy, vz);
      q.base.copy(colour);
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      return;
    }
  }

  /** Fire one rocket from `from`, bursting `height` metres up. */
  function launch(from, height) {
    const colour = new THREE.Color(PALETTE[Math.floor(rand() * PALETTE.length)]);
    const second = rand() < 0.4 ? new THREE.Color(PALETTE[Math.floor(rand() * PALETTE.length)]) : colour;
    rockets.push({
      p: from.clone(),
      v: new THREE.Vector3((rand() - 0.5) * 0.08, 0.9 + rand() * 0.25, (rand() - 0.5) * 0.08),
      burstY: from.y + height,
      colour,
      second,
      size: 0.5 + rand() * 0.25, // burst speed, m/s
    });
  }

  const tmp = new THREE.Color();
  return {
    launch,
    update(dt) {
      // Rockets climb, shedding sparks, then burst.
      for (let r = rockets.length - 1; r >= 0; r--) {
        const k = rockets[r];
        k.p.addScaledVector(k.v, dt);
        k.v.y += GRAVITY * 0.5 * dt;
        spawn(k.p.x, k.p.y, k.p.z, (rand() - 0.5) * 0.03, -0.05, (rand() - 0.5) * 0.03, tmp.set(0xffd9a0).multiplyScalar(3), 0.35, 'trail', 3);
        if (k.p.y >= k.burstY || k.v.y <= 0.1) {
          const n = 180;
          for (let s = 0; s < n; s++) {
            // Even directions over a sphere, then a touch of randomness.
            const u = (s + 0.5) / n;
            const phi = Math.acos(1 - 2 * u);
            const th = s * 2.39996;
            const sp = k.size * (0.85 + rand() * 0.3);
            const c = (s % 2 ? k.colour : k.second).clone().multiplyScalar(6);
            spawn(k.p.x, k.p.y, k.p.z, Math.sin(phi) * Math.cos(th) * sp, Math.cos(phi) * sp, Math.sin(phi) * Math.sin(th) * sp, c, 1.6 + rand() * 0.8, 'star');
          }
          spawn(k.p.x, k.p.y, k.p.z, 0, 0, 0, tmp.set(0xffffff).multiplyScalar(12), 0.15, 'flash', 0);
          rockets.splice(r, 1);
        }
      }
      // Every spark: move, slow, fall, fade (stars twinkle as they go).
      for (let i = 0; i < MAX; i++) {
        const q = p[i];
        if (!q.alive) {
          col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0;
          continue;
        }
        q.age += dt;
        if (q.age >= q.life) {
          q.alive = false;
          col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0;
          continue;
        }
        q.v.multiplyScalar(Math.exp(-q.drag * dt));
        q.v.y += GRAVITY * dt;
        pos[i * 3] += q.v.x * dt;
        pos[i * 3 + 1] += q.v.y * dt;
        pos[i * 3 + 2] += q.v.z * dt;
        const k = q.age / q.life;
        let a = (1 - k) * (1 - k);
        if (q.kind === 'star' && k > 0.5) a *= 0.55 + 0.45 * Math.sin(q.twinkle + q.age * 40);
        col[i * 3] = q.base.r * a;
        col[i * 3 + 1] = q.base.g * a;
        col[i * 3 + 2] = q.base.b * a;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
    },
  };
}
