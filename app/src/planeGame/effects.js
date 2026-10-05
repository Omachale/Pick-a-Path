/**
 * The bits of the world that move with play: the flight trail, the plane's
 * shadow on the decks, the thrower, and the wind made visible.
 */

import * as THREE from 'three';
import { stateAt } from './flight.js';

// ------------------------------------------------------------------ trail

/**
 * Trail patterns, so the three planes' paths differ by more than colour:
 * the dart's is solid, the classic's dashed, the glider's dotted.
 */
const PATTERN = { dart: 'solid', allrounder: 'dash', glider: 'dot' };
const patternCache = new Map();
function patternTexture(kind) {
  if (patternCache.has(kind)) return patternCache.get(kind);
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 16;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  if (kind === 'solid') g.fillRect(0, 2, 64, 12);
  else if (kind === 'dash') g.fillRect(0, 2, 40, 12);
  else {
    g.beginPath();
    g.arc(16, 8, 7, 0, Math.PI * 2);
    g.arc(48, 8, 7, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  patternCache.set(kind, t);
  return t;
}

/**
 * A camera-facing ribbon along the flight so far. Its width keeps a
 * minimum on-screen size however far away it is, so a distant path is
 * still a line, not a hair.
 */
export class Trail {
  constructor(scene, flight, planeKey, color) {
    this.flight = flight;
    this.n = flight.count + 1;
    const n = this.n;
    this.pos = new Float32Array(n * 2 * 3);
    this.uv = new Float32Array(n * 2 * 2);
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    g.setDrawRange(0, 0);
    this.mat = new THREE.MeshBasicMaterial({
      color,
      map: patternTexture(PATTERN[planeKey]),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
    scene.add(this.mesh);
    this.scene = scene;
    // Precompute the path's own points and lengths along it.
    this.pts = [];
    let len = 0;
    for (let i = 0; i < flight.count; i++) {
      const o = i * 6;
      const s = flight.samples;
      const p = new THREE.Vector3(s[o + 1], s[o + 2], s[o + 3]);
      if (i) len += p.distanceTo(this.pts[i - 1].p);
      this.pts.push({ t: s[o], p, len });
    }
  }

  setOpacity(o) {
    this.mat.opacity = o;
  }

  /** Rebuilds the ribbon up to time t, facing `camera`. */
  update(t, camera) {
    const pts = this.pts;
    let k = 0;
    while (k < pts.length && pts[k].t <= t) k++;
    // k samples fully behind the plane, plus the plane's own point now.
    const head = stateAt(this.flight, t);
    const list = pts.slice(0, k).map((q) => q);
    const hp = new THREE.Vector3(head.x, head.y, head.z);
    const lastLen = k ? pts[k - 1].len + pts[k - 1].p.distanceTo(hp) : 0;
    list.push({ p: hp, len: lastLen });
    const m = list.length;
    if (m < 2) {
      this.mesh.geometry.setDrawRange(0, 0);
      return;
    }
    const cam = camera.position;
    const T = new THREE.Vector3();
    const V = new THREE.Vector3();
    const S = new THREE.Vector3();
    for (let i = 0; i < m; i++) {
      const a = list[Math.max(0, i - 1)].p;
      const b = list[Math.min(m - 1, i + 1)].p;
      T.subVectors(b, a);
      const p = list[i].p;
      V.subVectors(cam, p);
      const dist = V.length();
      S.crossVectors(T, V).normalize();
      // Width: a constant few pixels on screen at any distance (so it
      // neither vanishes far away nor balloons right by the camera),
      // tapering to a point at the tail.
      const w = THREE.MathUtils.clamp(dist * 0.0042, 0.012, 0.3) * Math.min(1, (i + 1) / 6);
      S.multiplyScalar(w);
      const o = i * 6;
      this.pos[o] = p.x + S.x;
      this.pos[o + 1] = p.y + S.y;
      this.pos[o + 2] = p.z + S.z;
      this.pos[o + 3] = p.x - S.x;
      this.pos[o + 4] = p.y - S.y;
      this.pos[o + 5] = p.z - S.z;
      const u = list[i].len / 0.9;
      this.uv[i * 4] = u;
      this.uv[i * 4 + 1] = 0;
      this.uv[i * 4 + 2] = u;
      this.uv[i * 4 + 3] = 1;
    }
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.uv.needsUpdate = true;
    g.setDrawRange(0, (m - 1) * 6);
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

// ------------------------------------------------------------------ shadow

/**
 * A soft dark spot on whichever island deck the plane is over: the single
 * best cue for "how high above the target is it", which a plane against the
 * sky otherwise can't show.
 */
export function makePlaneShadow(scene) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(0,0,0,0.75)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
  mesh.renderOrder = 2;
  mesh.visible = false;
  scene.add(mesh);
  return {
    mesh,
    /** Places it under (x, y, z) if over a deck in `islands`, else hides it. */
    update(x, y, z, islands) {
      let best = null;
      for (const isl of islands) {
        if (y < isl.y) continue;
        if (Math.hypot(x - isl.x, z - isl.z) > isl.r) continue;
        if (!best || isl.y > best.y) best = isl;
      }
      if (!best) {
        mesh.visible = false;
        return;
      }
      const h = y - best.y;
      mesh.visible = true;
      mesh.position.set(x, best.y + 0.05, z);
      const s = 0.7 + h * 0.08;
      mesh.scale.set(s, 1, s);
      mesh.material.opacity = Math.max(0.15, 1 - h / 14);
    },
  };
}

// ------------------------------------------------------------------ locator

/**
 * A ring in the plane's own colour around the flying plane, a constant size
 * on screen, that fades in as the plane gets far away (small on screen) and
 * out when it's close and big enough to see for itself. A paper plane a
 * long way off is a few pixels; this keeps it findable at a glance.
 */
export function makeLocator(scene) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.lineWidth = 9;
  g.strokeStyle = 'rgba(30,20,28,0.55)';
  g.beginPath();
  g.arc(64, 64, 50, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 6;
  g.strokeStyle = '#fff';
  g.beginPath();
  g.arc(64, 64, 50, 0, Math.PI * 2);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, fog: false });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 20;
  sprite.visible = false;
  scene.add(sprite);
  return {
    update(pos, camera, color) {
      const d = camera.position.distanceTo(pos);
      const f = THREE.MathUtils.clamp((d - 7) / 6, 0, 1);
      sprite.visible = f > 0.01;
      sprite.position.copy(pos);
      mat.color.set(color);
      mat.opacity = f * 0.9;
      sprite.scale.setScalar(0.075);
    },
    hide() {
      sprite.visible = false;
    },
  };
}

// ------------------------------------------------------------------ thrower

/**
 * The thrower: a character card, as in Sky Path (same art, same size),
 * turned to face the camera about its upright axis. A throw leans it
 * forward for a moment.
 */
export function makeThrower(scene, loader, figure = 'woman1') {
  const ext = figure === 'indy' ? 'png' : 'webp';
  const tex = loader.load(`textures/figure-${figure}.${ext}`);
  tex.colorSpace = THREE.SRGBColorSpace;
  const H = 2.2 * 0.8 * 0.72; // Sky Path's FIGURE_H
  const W = H * (400 / 563);
  const geo = new THREE.PlaneGeometry(W, H);
  geo.translate(0, H / 2, 0);
  const card = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide }));
  const pivot = new THREE.Group();
  pivot.add(card);
  scene.add(pivot);
  // A soft contact shadow so it stands on the deck rather than floating.
  const sh = makeBlob(0.9, 0.45);
  sh.position.y = 0.02;
  pivot.add(sh);
  let lean = 0;
  let leanT = -1;
  return {
    pivot,
    height: H,
    throwLean() {
      leanT = 0;
    },
    update(dt, camera) {
      // Face the camera, upright.
      const dx = camera.position.x - pivot.position.x;
      const dz = camera.position.z - pivot.position.z;
      card.rotation.y = Math.atan2(dx, dz);
      if (leanT >= 0) {
        leanT += dt;
        lean = leanT < 0.12 ? leanT / 0.12 : Math.max(0, 1 - (leanT - 0.12) / 0.35);
        if (leanT > 0.5) leanT = -1;
      }
      card.rotation.x = -lean * 0.25;
    },
  };
}

function makeBlob(w, d) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(0,0,0,0.45)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const geo = new THREE.PlaneGeometry(w, d);
  geo.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  m.renderOrder = 2;
  return m;
}

// ------------------------------------------------------------------ wind

/**
 * The wind, made visible in the air itself (one of the switchable looks):
 *
 *  - 'streaks': pale streaks of moving air, like wind lines in a cartoon,
 *    travelling with the wind (faster than it, so they read from a
 *    distance), longer and more of them the stronger it blows.
 *  - 'petals': blossom petals from the temple's trees drifting at the
 *    wind's TRUE speed. A glider drifts about as much as a petal does, so
 *    this one is literally showing what the wind will do to a light plane.
 *  - 'flags': nothing extra in the air; the flags (on every target and on
 *    the thrower's rim) carry it alone.
 *
 * Particles live in a box spanning the thrower and the current target and
 * wrap around inside it, so they're always where the player is looking.
 */
export function makeWindParticles(scene) {
  const MAX = 160;
  // Streaks: thin quads, instanced.
  const streakGeo = new THREE.PlaneGeometry(1, 0.07);
  const streakMat = new THREE.MeshBasicMaterial({ color: 0xeef8ff, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const streaks = new THREE.InstancedMesh(streakGeo, streakMat, MAX);
  streaks.frustumCulled = false;
  streaks.renderOrder = 6;
  scene.add(streaks);
  // Petals: small pink diamonds, instanced, lit so they twinkle as they turn.
  const petalGeo = new THREE.CircleGeometry(0.15, 5);
  petalGeo.scale(1, 0.6, 1);
  const petalMat = new THREE.MeshLambertMaterial({ color: 0xffc3d6, side: THREE.DoubleSide, emissive: 0x5a2a3a });
  const petals = new THREE.InstancedMesh(petalGeo, petalMat, MAX);
  petals.frustumCulled = false;
  scene.add(petals);

  const parts = Array.from({ length: MAX }, (_, i) => ({
    u: Math.random(),
    v: Math.random(),
    w: Math.random(),
    phase: Math.random() * Math.PI * 2,
    spin: (Math.random() - 0.5) * 6,
    life: Math.random(),
  }));
  const box = { min: new THREE.Vector3(-20, -8, -40), size: new THREE.Vector3(40, 14, 44) };
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  let mode = 'streaks';

  return {
    setMode(m2) {
      mode = m2;
      streaks.visible = mode === 'streaks';
      petals.visible = mode === 'petals';
    },
    /** Spans the box over the thrower and the target, with a margin. */
    setBox(a, b) {
      const minX = Math.min(a.x, b.x) - 14;
      const maxX = Math.max(a.x, b.x) + 14;
      const minZ = Math.min(a.z, b.z) - 10;
      const maxZ = Math.max(a.z, b.z) + 8;
      const minY = Math.min(a.y, b.y) - 4;
      const maxY = Math.max(a.y, b.y) + 7;
      box.min.set(minX, minY, minZ);
      box.size.set(maxX - minX, maxY - minY, maxZ - minZ);
    },
    update(dt, t, wind) {
      const speed = Math.hypot(wind.x, wind.z);
      if (mode === 'flags' || speed < 0.05) {
        streaks.count = 0;
        petals.count = 0;
        return;
      }
      const dirX = wind.x / speed;
      const dirZ = wind.z / speed;
      const yaw = Math.atan2(-dirZ, dirX);
      if (mode === 'streaks') {
        const n = Math.round(Math.min(MAX, 30 + speed * 45));
        const vel = speed * 4.5;
        for (let i = 0; i < n; i++) {
          const pt = parts[i];
          pt.u += (dirX * vel * dt) / box.size.x;
          pt.w += (dirZ * vel * dt) / box.size.z;
          pt.u -= Math.floor(pt.u);
          pt.w -= Math.floor(pt.w);
          p.set(box.min.x + pt.u * box.size.x, box.min.y + pt.v * box.size.y + Math.sin(t * 1.3 + pt.phase) * 0.25, box.min.z + pt.w * box.size.z);
          // Fade in and out near the box edges so wrapping doesn't pop.
          const edge = Math.min(pt.u, 1 - pt.u, pt.w, 1 - pt.w) * 8;
          const len = (1.2 + speed * 1.6) * Math.min(1, edge);
          // Lying flat (so a camera above sees it from any side), along the wind.
          e.set(-Math.PI / 2, yaw, 0, 'YXZ');
          q.setFromEuler(e);
          s.set(Math.max(0.01, len), 1 + speed * 0.4, 1);
          m.compose(p, q, s);
          streaks.setMatrixAt(i, m);
        }
        streaks.count = n;
        streaks.instanceMatrix.needsUpdate = true;
      } else {
        const n = Math.round(Math.min(MAX, 60 + speed * 40));
        for (let i = 0; i < n; i++) {
          const pt = parts[i];
          // True wind speed, plus a little flutter.
          pt.u += ((dirX * speed + Math.sin(t * 2 + pt.phase) * 0.25) * dt) / box.size.x;
          pt.w += ((dirZ * speed + Math.cos(t * 1.7 + pt.phase) * 0.25) * dt) / box.size.z;
          pt.v -= (0.12 * dt) / box.size.y;
          pt.u -= Math.floor(pt.u);
          pt.w -= Math.floor(pt.w);
          pt.v -= Math.floor(pt.v);
          p.set(box.min.x + pt.u * box.size.x, box.min.y + pt.v * box.size.y, box.min.z + pt.w * box.size.z);
          e.set(t * pt.spin + pt.phase, t * pt.spin * 0.7, pt.phase, 'XYZ');
          q.setFromEuler(e);
          const edge = Math.min(1, Math.min(pt.u, 1 - pt.u, pt.w, 1 - pt.w) * 8);
          s.setScalar(1.6 * edge);
          m.compose(p, q, s);
          petals.setMatrixAt(i, m);
        }
        petals.count = n;
        petals.instanceMatrix.needsUpdate = true;
      }
    },
  };
}
