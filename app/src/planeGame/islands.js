/**
 * Target islands, built in code.
 *
 * The rock body is a lathe whose outline is EXACTLY the solid the flight
 * model collides with (flight.js, bodyRadiusAt): a flat deck of radius r on
 * a body that narrows to a point `depth` below. Small bumps are added on top
 * of that outline but never push it outward by more than a few percent, so a
 * plane that visibly clips the rock is a plane the game says hit it.
 *
 * Two looks, switchable in the page (Luke picks):
 *  - 'skypath': Sky Path's own cobbled deck (island-circle.png) on an earthy,
 *    mossy rock: these read as the same family as the islands the players
 *    have just walked across.
 *  - 'stone': a carved target: a deck of pale flagstones laid in rings, with
 *    the scoring bands built into the stone itself (a raised gold centre
 *    and a dark stone band), on darker rock with lanterns at the rim.
 *
 * Both are lit (Lambert, the cheapest lit material), so they turn with the
 * sun and their sides fall into shade, which is a lot of what makes a small
 * island read as a solid object at a distance.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RINGS } from './course.js';
import { bodyProfile } from './flight.js';

// ------------------------------------------------------------------ noise

function hash3(x, y, z) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise3(x, y, z) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const s = (t) => t * t * (3 - 2 * t);
  const u = s(xf);
  const v = s(yf);
  const w = s(zf);
  const L = (a, b, t) => a + (b - a) * t;
  const c = (i, j, k) => hash3(xi + i, yi + j, zi + k);
  return L(
    L(L(c(0, 0, 0), c(1, 0, 0), u), L(c(0, 1, 0), c(1, 1, 0), u), v),
    L(L(c(0, 0, 1), c(1, 0, 1), u), L(c(0, 1, 1), c(1, 1, 1), u), v),
    w
  );
}
function fbm(x, y, z) {
  return noise3(x, y, z) * 0.55 + noise3(x * 2.1, y * 2.1, z * 2.1) * 0.3 + noise3(x * 4.3, y * 4.3, z * 4.3) * 0.15;
}
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 4294967295;
}

// ------------------------------------------------------------------ rock

const ROCK_STYLES = {
  skypath: {
    top: new THREE.Color(0x6f7d3e), // moss and grass on the lip
    upper: new THREE.Color(0x8a7058), // warm earth
    lower: new THREE.Color(0x5c4b45),
    tip: new THREE.Color(0x3d3236),
    band: new THREE.Color(0x9b8468),
  },
  stone: {
    top: new THREE.Color(0x7b7f6a),
    upper: new THREE.Color(0x7a746e),
    lower: new THREE.Color(0x4f4a4c),
    tip: new THREE.Color(0x2f2b30),
    band: new THREE.Color(0x968e85),
  },
};

/**
 * The body: deck radius r at y = 0 down to a point at -depth, following the
 * collision outline, with noise that bites INTO it (and only barely out).
 */
function rockBody(r, depth, seed, style) {
  const radial = 40;
  const rings = 16;
  const pos = [];
  const col = [];
  const idx = [];
  const tmp = new THREE.Color();
  const sx = seed * 7.13;
  for (let j = 0; j <= rings; j++) {
    const f = j / rings; // 0 at the deck, 1 at the tip
    const y = -depth * f;
    const base = r * bodyProfile(f);
    for (let i = 0; i <= radial; i++) {
      const a = (i / radial) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // Noise on the unit circle (seamless) and down the height.
      const n = fbm(ca * 1.6 + sx, f * 3.2, sa * 1.6 + sx);
      // Vertical crevices: a sharper, higher-frequency noise around the rim.
      const crev = Math.pow(noise3(ca * 4.5 + sx, f * 1.2, sa * 4.5 - sx), 3);
      const bite = (n - 0.5) * 0.36 - crev * 0.22;
      const out = Math.min(0.03, bite); // never more than 3% outward
      let rr = base * (1 + (j === 0 ? 0 : bite < 0 ? bite : out));
      if (j === rings) rr = 0;
      // A lip: the first ring sits just under the deck edge, slightly in.
      if (j === 1) rr = Math.min(rr, base * 0.98);
      pos.push(ca * rr, y + (j === 0 ? 0 : (n - 0.5) * depth * 0.05), sa * rr);
      // Colour: moss at the top, earth, darker rock, near-black tip, with
      // a couple of paler strata.
      if (f < 0.12) tmp.copy(style.top).lerp(style.upper, f / 0.12);
      else if (f < 0.55) tmp.copy(style.upper).lerp(style.lower, (f - 0.12) / 0.43);
      else tmp.copy(style.lower).lerp(style.tip, (f - 0.55) / 0.45);
      const strata = Math.sin(f * 22 + n * 6) > 0.82 ? 0.5 : 0;
      tmp.lerp(style.band, strata);
      const shade = (0.8 + n * 0.4) * (1 - crev * 0.6);
      col.push(tmp.r * shade, tmp.g * shade, tmp.b * shade);
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < radial; i++) {
      const a = j * (radial + 1) + i;
      const b = a + radial + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Paints one flat colour onto a geometry (for merging into the vertex-coloured rock). */
function tint(g, c, jitter = 0, rand = Math.random) {
  const n = g.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = 1 + (rand() - 0.5) * jitter;
    colors[i * 3] = c.r * v;
    colors[i * 3 + 1] = c.g * v;
    colors[i * 3 + 2] = c.b * v;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.deleteAttribute('uv');
  return g;
}

/**
 * Loose rocks clinging to the underside, so the bottom isn't a clean
 * spinning-top shape: lumpy, faceted chunks hugging the body, inside its
 * outline (they can't make the rock bigger than what the plane collides
 * with). Plus grass tufts along the lip, leaning out, which is what makes
 * the top edge read as ground at a distance.
 */
function rockDetail(r, depth, seed, style) {
  const rand = rng(seed * 31 + 7);
  const parts = [];
  const n = 5 + Math.floor(rand() * 4);
  for (let k = 0; k < n; k++) {
    const f = 0.35 + rand() * 0.5;
    const a = rand() * Math.PI * 2;
    const base = r * bodyProfile(f);
    const size = r * (0.12 + rand() * 0.12);
    const g = new THREE.IcosahedronGeometry(size, 0);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const j = 0.75 + hash3(Math.round(p.getX(i) * 50) + k * 7, Math.round(p.getY(i) * 50), Math.round(p.getZ(i) * 50) + seed) * 0.5;
      p.setXYZ(i, p.getX(i) * j, p.getY(i) * j * 1.5, p.getZ(i) * j);
    }
    g.computeVertexNormals();
    const d = Math.max(0, base - size * 0.9);
    g.translate(Math.cos(a) * d, -depth * f - size * 0.4, Math.sin(a) * d);
    parts.push(tint(g.toNonIndexed(), new THREE.Color().copy(style.lower).lerp(style.tip, rand() * 0.7), 0.15, rand));
  }
  const grass = new THREE.Color(0x6e8a3c);
  const tufts = Math.round(18 + r * 6);
  for (let k = 0; k < tufts; k++) {
    const a = rand() * Math.PI * 2;
    const h = 0.18 + rand() * 0.3;
    const g = new THREE.ConeGeometry(0.07 + rand() * 0.06, h, 4, 1);
    g.translate(0, h / 2, 0);
    g.rotateZ(-(0.4 + rand() * 0.5)); // lean outward (local +x)
    g.rotateY(-a);
    const rr = r * (0.97 + rand() * 0.02);
    g.translate(Math.cos(a) * rr, -0.02, Math.sin(a) * rr);
    parts.push(tint(g.toNonIndexed(), new THREE.Color().copy(grass).lerp(style.top, rand() * 0.5), 0.25, rand));
  }
  return parts;
}

// ------------------------------------------------------------------ decks

let cobbleTex = null;
function getCobbleTex(loader) {
  if (!cobbleTex) {
    cobbleTex = loader.load('textures/island-circle.png');
    cobbleTex.colorSpace = THREE.SRGBColorSpace;
    cobbleTex.anisotropy = 4;
  }
  return cobbleTex;
}

/**
 * The carved stone deck, drawn once to a canvas: flagstones in concentric
 * courses, with the scoring bands laid in different stone. Shared by every
 * 'stone' island (the rings are proportional, so one texture fits all).
 */
let stoneDeckTex = null;
function getStoneDeckTex() {
  if (stoneDeckTex) return stoneDeckTex;
  const S = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const R = S / 2;
  const rand = rng(99);
  g.translate(R, R);
  // Ground: mossy joints.
  g.fillStyle = '#4d5a3a';
  g.beginPath();
  g.arc(0, 0, R, 0, Math.PI * 2);
  g.fill();
  // Courses of stones, each band its own stone colour.
  const bands = [
    { from: RINGS.inner, to: 1.0, base: [196, 186, 168], courses: 3 },
    { from: RINGS.bull, to: RINGS.inner, base: [104, 100, 112], courses: 2 },
    { from: 0, to: RINGS.bull, base: [222, 178, 82], courses: 2 },
  ];
  for (const band of bands) {
    const step = (band.to - band.from) / band.courses;
    for (let k = 0; k < band.courses; k++) {
      const r0 = (band.from + step * k) * R;
      const r1 = (band.from + step * (k + 1)) * R;
      const mid = (r0 + r1) / 2;
      const count = Math.max(1, Math.round((Math.PI * 2 * mid) / ((r1 - r0) * 1.3)));
      const off = rand() * Math.PI * 2;
      for (let s = 0; s < count; s++) {
        const a0 = off + (s / count) * Math.PI * 2 + 0.012;
        const a1 = off + ((s + 1) / count) * Math.PI * 2 - 0.012;
        const v = 0.86 + rand() * 0.22;
        const [cr, cg, cb] = band.base;
        g.fillStyle = `rgb(${cr * v | 0},${cg * v | 0},${cb * v | 0})`;
        g.beginPath();
        if (r0 < 2) {
          g.arc(0, 0, r1 - 3, 0, Math.PI * 2);
        } else {
          g.arc(0, 0, r1 - 3, a0, a1);
          g.arc(0, 0, r0 + 3, a1, a0, true);
        }
        g.closePath();
        g.fill();
        // A highlight along each stone's top edge and grime along the bottom.
        g.strokeStyle = 'rgba(255,255,255,0.18)';
        g.lineWidth = 3;
        g.stroke();
      }
    }
  }
  // Weathering: speckle and moss creeping in at the edge.
  for (let i = 0; i < 2600; i++) {
    const a = rand() * Math.PI * 2;
    const rr = Math.sqrt(rand()) * R;
    const edge = rr / R;
    g.fillStyle = edge > 0.85 && rand() < 0.6 ? 'rgba(70,96,48,0.55)' : `rgba(0,0,0,${0.05 + rand() * 0.08})`;
    g.beginPath();
    g.arc(Math.cos(a) * rr, Math.sin(a) * rr, 1 + rand() * (edge > 0.85 ? 5 : 2.5), 0, Math.PI * 2);
    g.fill();
  }
  // A dark ring around the gold centre and the band edges, so the bands read
  // by shape and contrast too, not only by colour.
  g.strokeStyle = 'rgba(30,24,20,0.85)';
  for (const f of [RINGS.bull, RINGS.inner]) {
    g.lineWidth = 9;
    g.beginPath();
    g.arc(0, 0, f * R, 0, Math.PI * 2);
    g.stroke();
  }
  stoneDeckTex = new THREE.CanvasTexture(c);
  stoneDeckTex.colorSpace = THREE.SRGBColorSpace;
  stoneDeckTex.anisotropy = 4;
  return stoneDeckTex;
}

/**
 * Painted target rings for the cobbled look: whitewash, a little rough, so
 * they read as paint on stone rather than a UI overlay. The bands differ in
 * form as well as colour (an outline ring, a filled gold centre with a dark
 * edge), so they read without colour vision.
 */
let paintRingTex = null;
function getPaintRingTex() {
  if (paintRingTex) return paintRingTex;
  const S = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const R = S / 2;
  const rand = rng(5);
  g.translate(R, R);
  const roughRing = (radius, width, style) => {
    g.strokeStyle = style;
    for (let pass = 0; pass < 3; pass++) {
      g.lineWidth = width * (0.8 + rand() * 0.3);
      g.beginPath();
      for (let i = 0; i <= 180; i++) {
        const a = (i / 180) * Math.PI * 2;
        const rr = radius + (rand() - 0.5) * width * 0.25;
        if (i === 0) g.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
        else g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      g.stroke();
    }
  };
  // Outer edge of the island: a thin ring, so "on the island" has a line too.
  roughRing(R * 0.965, 14, 'rgba(255,248,232,0.55)');
  // Inner band edge.
  roughRing(R * RINGS.inner, 26, 'rgba(255,250,238,0.92)');
  // Gold centre, filled, with a dark edge.
  g.fillStyle = 'rgba(240,184,60,0.95)';
  g.beginPath();
  g.arc(0, 0, R * RINGS.bull, 0, Math.PI * 2);
  g.fill();
  roughRing(R * RINGS.bull, 16, 'rgba(70,40,20,0.9)');
  // Scuff the paint: little gaps where the cobbles show through.
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 1400; i++) {
    const a = rand() * Math.PI * 2;
    const rr = rand() * R;
    g.fillStyle = `rgba(0,0,0,${0.25 + rand() * 0.5})`;
    g.beginPath();
    g.arc(Math.cos(a) * rr, Math.sin(a) * rr, 2 + rand() * 7, 0, Math.PI * 2);
    g.fill();
  }
  paintRingTex = new THREE.CanvasTexture(c);
  paintRingTex.colorSpace = THREE.SRGBColorSpace;
  paintRingTex.anisotropy = 4;
  return paintRingTex;
}

// ------------------------------------------------------------------ flag

/**
 * The target's flag: a pole on the island's far rim (behind the rings, as
 * seen from the thrower) and a pennant that streams the way the wind blows
 * and flaps faster the harder it blows; in still air it hangs limp. It is
 * both "this is the one" and a wind sock at the place the wind matters.
 */
export function buildFlag(number) {
  const group = new THREE.Group();
  const poleH = 3.2;
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.07, poleH, 8),
    new THREE.MeshLambertMaterial({ color: 0x5b4632 })
  );
  pole.position.y = poleH / 2;
  group.add(pole);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), new THREE.MeshLambertMaterial({ color: 0xe8c060 }));
  knob.position.y = poleH + 0.06;
  group.add(knob);

  // Pennant: a tapered strip, number painted on both sides. Two paints:
  // bright for the island you're aiming at now, pale for the rest, so the
  // current one stands out by contrast as well as colour.
  const paint = (bg, stripe, ink) => {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = bg;
    g.fillRect(0, 0, 256, 128);
    g.fillStyle = stripe;
    g.fillRect(0, 0, 256, 14);
    g.fillRect(0, 114, 256, 14);
    g.font = '900 92px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = ink;
    if (number !== '') g.fillText(String(number), 92, 70);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const texOn = number === '' ? paint('#f3ead8', '#5b8fd0', '#5b8fd0') : paint('#d9483b', '#f6e7c8', '#fff6e4');
  const texOff = number === '' ? texOn : paint('#e9e2d4', '#b9ae9a', '#8a7e6c');
  const tex = texOn;
  const W = 1.9;
  const H = 1.0;
  const geo = new THREE.PlaneGeometry(W, H, 16, 4);
  geo.translate(W / 2, 0, 0);
  // Taper to a swallowtail-free point: narrow the far end.
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = p.getX(i) / W;
    p.setY(i, p.getY(i) * (1 - 0.55 * t));
  }
  const uniforms = { uTime: { value: 0 }, uFlap: { value: 0 } };
  const mat = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uFlap;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float along = position.x / ${W.toFixed(2)};
        float wave = sin(along * 7.0 - uTime * (4.0 + uFlap * 9.0)) * along;
        transformed.z += wave * (0.06 + uFlap * 0.22);
        transformed.y += sin(along * 5.0 - uTime * 6.0) * along * 0.04 * uFlap;`
      );
  };
  mat.customProgramCacheKey = () => 'pgFlag';
  const cloth = new THREE.Mesh(geo, mat);
  // A hinge at the pole top: yaw follows the wind, droop is how limp it is.
  const hinge = new THREE.Group();
  hinge.position.y = poleH - H / 2 - 0.05;
  const droop = new THREE.Group();
  hinge.add(droop);
  droop.add(cloth);
  group.add(hinge);

  const state = { yaw: 0, droop: 1.2 };
  return {
    group,
    setActive(on) {
      mat.map = on ? texOn : texOff;
      mat.needsUpdate = true;
    },
    update(t, wind, dt) {
      uniforms.uTime.value = t;
      const speed = Math.hypot(wind.x, wind.z);
      const strength = Math.min(1, speed / 2.4);
      uniforms.uFlap.value = strength;
      // The pennant streams downwind: its +x (away from the pole) points
      // along the wind. A light breeze lifts it partway; calm hangs it.
      const targetYaw = speed > 0.05 ? Math.atan2(-wind.z, wind.x) : state.yaw;
      let dy = targetYaw - state.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      state.yaw += dy * Math.min(1, dt * 2.5);
      const targetDroop = (1 - Math.pow(strength, 0.6)) * 1.35;
      state.droop += (targetDroop - state.droop) * Math.min(1, dt * 2);
      hinge.rotation.y = state.yaw;
      droop.rotation.z = -state.droop;
    },
  };
}

// ------------------------------------------------------------------ builder

/**
 * One island. `island` is a course entry (x, y, z, r, depth). Returns the
 * group plus handles the game uses: setCurrent (is this the target now?),
 * setStars (best result so far), update(t, wind, dt).
 */
export function buildIsland(island, { look = 'skypath', number = null, seed = 1, loader, towardThrower = null }) {
  const group = new THREE.Group();
  group.position.set(island.x, island.y, island.z);
  const style = ROCK_STYLES[look];

  const body = rockBody(island.r, island.depth, seed, style);
  const parts = [body.toNonIndexed(), ...rockDetail(island.r, island.depth, seed, style)];
  // Normals kept from each part (the body's are smooth, computed indexed);
  // recomputing them on the merged, non-indexed result would facet it.
  const rockGeo = mergeGeometries(parts);
  const rock = new THREE.Mesh(rockGeo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: false }));
  group.add(rock);

  // Deck.
  const deckGeo = new THREE.CircleGeometry(island.r, 64);
  deckGeo.rotateX(-Math.PI / 2);
  const deckMat =
    look === 'stone'
      ? new THREE.MeshLambertMaterial({ map: getStoneDeckTex() })
      : new THREE.MeshLambertMaterial({ map: getCobbleTex(loader) });
  const deck = new THREE.Mesh(deckGeo, deckMat);
  deck.position.y = 0.01;
  group.add(deck);

  // A low kerb around the deck edge: gives the disc a visible thickness
  // from the throwing height, where a flat disc would vanish edge-on.
  const kerb = new THREE.Mesh(
    new THREE.TorusGeometry(island.r * 0.985, Math.max(0.07, island.r * 0.025), 6, 64),
    new THREE.MeshLambertMaterial({ color: look === 'stone' ? 0xb8ad9c : 0x8f8a7c })
  );
  kerb.rotation.x = Math.PI / 2;
  kerb.position.y = 0.02;
  group.add(kerb);

  let rings = null;
  let flag = null;
  if (number !== null) {
    if (look === 'skypath') {
      const rg = new THREE.CircleGeometry(island.r, 64);
      rg.rotateX(-Math.PI / 2);
      rings = new THREE.Mesh(
        rg,
        new THREE.MeshLambertMaterial({ map: getPaintRingTex(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 })
      );
      rings.position.y = 0.03;
      rings.renderOrder = 1;
      group.add(rings);
    }
    flag = buildFlag(number);
    // On the far rim, behind the rings as the thrower sees it.
    const away = towardThrower ? Math.atan2(-towardThrower.z, -towardThrower.x) : 0;
    const fx = Math.cos(away) * island.r * 0.86;
    const fz = Math.sin(away) * island.r * 0.86;
    flag.group.position.set(fx, 0, fz);
    group.add(flag.group);

    if (look === 'stone') {
      // Lanterns either side of the flag: warm points of light that mark the
      // island at a distance (emissive-looking, but just bright unlit paint).
      for (const side of [-1, 1]) {
        const a = away + side * 0.9;
        const lantern = new THREE.Group();
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.7, 0.18), new THREE.MeshLambertMaterial({ color: 0x6b6058 }));
        post.position.y = 0.35;
        const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshBasicMaterial({ color: 0xffd27a }));
        lamp.position.y = 0.85;
        const cap = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.22, 4), new THREE.MeshLambertMaterial({ color: 0x4a3f3a }));
        cap.position.y = 1.1;
        cap.rotation.y = Math.PI / 4;
        lantern.add(post, lamp, cap);
        lantern.position.set(Math.cos(a) * island.r * 0.9, 0, Math.sin(a) * island.r * 0.9);
        group.add(lantern);
      }
    }
  }

  // Stars earned here, floating over the island once it's been tried.
  const starGroup = new THREE.Group();
  starGroup.position.y = 3.9;
  group.add(starGroup);

  let beam = null;
  const handle = {
    group,
    island,
    deck,
    rings,
    flag,
    setCurrent(on) {
      if (rings) rings.material.opacity = on ? 1 : 0.55;
      flag?.setActive(on);
      if (on && !beam) {
        beam = makeBeam(island.r);
        group.add(beam);
      }
      if (beam) beam.visible = on;
    },
    setStars(n, starTex) {
      starGroup.clear();
      for (let i = 0; i < 3; i++) {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: starTex, color: i < n ? 0xffffff : 0x555566, transparent: true, depthWrite: false, opacity: i < n ? 1 : 0.6 }));
        s.scale.setScalar(1.0);
        s.position.x = (i - 1) * 1.05;
        starGroup.add(s);
      }
    },
    /** `camDist`: how far the camera is; the beam fades out up close, where it would wash the view white. */
    update(t, wind, dt, camDist = 100) {
      flag?.update(t, wind, dt);
      if (beam?.visible) {
        const near = THREE.MathUtils.clamp((camDist - 9) / 10, 0, 1);
        beam.material.opacity = (0.3 + Math.sin(t * 2.2) * 0.07) * near;
      }
    },
  };
  return handle;
}

/**
 * A soft column of warm light rising from the island you're aiming at: the
 * one thing on screen that says "this one" from any distance, at a glance.
 * Additive and depth-tested but not depth-writing, so it glows over the sky
 * without hiding anything behind it.
 */
let beamTex = null;
function makeBeam(r) {
  if (!beamTex) {
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 128, 0, 0);
    grad.addColorStop(0, 'rgba(255,220,140,0.85)');
    grad.addColorStop(0.15, 'rgba(255,200,110,0.4)');
    grad.addColorStop(0.6, 'rgba(255,190,100,0.08)');
    grad.addColorStop(1, 'rgba(255,190,100,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 128);
    beamTex = new THREE.CanvasTexture(c);
  }
  const H = 16;
  const geo = new THREE.CylinderGeometry(r * 0.92, r * 0.98, H, 40, 1, true);
  geo.translate(0, H / 2, 0);
  const mat = new THREE.MeshBasicMaterial({
    map: beamTex,
    transparent: true,
    opacity: 0.45,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = 9;
  return m;
}

/** A star drawn once for the result sprites. */
export function makeStarTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.translate(64, 64);
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 24 : 56;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
  g.fillStyle = '#ffd34d';
  g.fill();
  g.lineWidth = 7;
  g.strokeStyle = '#7a4b12';
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
