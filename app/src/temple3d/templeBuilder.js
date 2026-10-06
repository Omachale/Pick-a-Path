// templeBuilder.js
//
// TEST COPY for temple-3d.html (2026-10-06): Luke's procedural temple (made in
// a separate chat), changed only where Sky Path's layout forces it. At Sky
// Path's scale (~2.6x, to match the flat temple's width) the original 20 m
// courtyard would reach right back over the last fork's island, so:
//  - the paved ground, processional path, side walls and gateway are gone
//    (the Temple Island's own surface is the ground);
//  - lanterns and the two huabiao pillars are pulled in beside the stairs;
//  - the single incense cauldron, which stood in the middle of the path, is
//    now two, one either side of the stairs, each with its own smoke;
//  - the central ramp's support is a wedge rather than a tall box (the box
//    stood above the sloped slab and swallowed a walker climbing it).
// Everything else is as delivered.
//
// Procedural ornate temple façade + courtyard for three.js.
// Framework-agnostic: returns a THREE.Group plus collider descriptions and a small door API.
// Units are metres. The building faces +Z; the player approaches from +Z towards the doors at z ≈ -1.6.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* ------------------------------------------------------------------ */
/*  Layout constants (exported so game code can place things sensibly) */
/* ------------------------------------------------------------------ */
export const TEMPLE_LAYOUT = {
  platformTop: 1.2,
  platformFrontZ: 4.0,
  stairsBottomZ: 6.16,
  doorZ: -1.6,
  doorHalfWidth: 1.2,
  doorwaySensorZ: -2.8, // pass this point inside the doorway → scene ends
  playerStart: [0, 0, 28],
  gateZ: 21,
};

const L = TEMPLE_LAYOUT;

/* ------------------------------------------------------------------ */
/*  Small maths / noise helpers                                         */
/* ------------------------------------------------------------------ */
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash2(x, y, s) {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
// Tileable value noise: period p (integer) in lattice units
function vnoise(x, y, p, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = smooth(x - xi), yf = smooth(y - yi);
  const m = (v) => ((v % p) + p) % p;
  const a = hash2(m(xi), m(yi), s), b = hash2(m(xi + 1), m(yi), s);
  const c = hash2(m(xi), m(yi + 1), s), d = hash2(m(xi + 1), m(yi + 1), s);
  return lerp(lerp(a, b, xf), lerp(c, d, xf), yf);
}
function fbm(u, v, base, oct, s) {
  let amp = 0.5, sum = 0, norm = 0, f = base;
  for (let o = 0; o < oct; o++) {
    sum += amp * vnoise(u * f, v * f, f, s + o * 17);
    norm += amp; amp *= 0.5; f *= 2;
  }
  return sum / norm;
}
const hex = (h) => new THREE.Color(h);

/* ------------------------------------------------------------------ */
/*  Procedural textures (canvas)                                        */
/* ------------------------------------------------------------------ */
function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}
function canvasTex(canvas, colour = true, repeat = true) {
  const t = new THREE.CanvasTexture(canvas);
  if (colour) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}
// Build a colour map + bump map from a height function h(u,v) -> 0..1 and a colour function
function heightTextures(size, heightFn, colourFn) {
  const cm = makeCanvas(size), cb = makeCanvas(size);
  const im = cm.getContext('2d').createImageData(size, size);
  const ib = cb.getContext('2d').createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const h = heightFn(u, v, x, y);
      const [r, g, b] = colourFn(h, u, v, x, y);
      const i = (y * size + x) * 4;
      im.data[i] = r; im.data[i + 1] = g; im.data[i + 2] = b; im.data[i + 3] = 255;
      const hb = Math.max(0, Math.min(255, h * 255));
      ib.data[i] = ib.data[i + 1] = ib.data[i + 2] = hb; ib.data[i + 3] = 255;
    }
  }
  cm.getContext('2d').putImageData(im, 0, 0);
  cb.getContext('2d').putImageData(ib, 0, 0);
  return { map: canvasTex(cm, true), bump: canvasTex(cb, false) };
}
const mixRGB = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// Test copy: the per-pixel noise textures below were ~88% of the whole build
// (every pixel runs several octaves of noise in plain JS). `fromFile(name)`
// loads them as pre-generated WebP files instead — see exportTempleTextures().
// Only colour maps: the bump maps only mattered under real lights, and the
// test bakes its lighting (templeInSkyPath.js). The cheap canvas drawings
// (plaque, grass, smoke, glow) are still drawn here either way.
export const FILE_TEXTURES = ['stone', 'relief', 'tiles', 'wood', 'door', 'rafter', 'scales', 'lattice'];

function makeTextures(size, seed, fromFile) {
  if (fromFile) {
    const T = {};
    for (const name of FILE_TEXTURES) T[name] = { map: fromFile(name) };
    T.flag = { map: null }; // paved the courtyard, which the test copy removes
    T.plaque = plaqueTexture(size);
    T.grass = grassTexture(256, seed);
    T.smoke = smokeTexture(128);
    T.glowCard = glowTexture(256);
    return T;
  }
  const T = {};

  // Weathered stone with lichen / moss staining
  T.stone = heightTextures(size,
    (u, v) => fbm(u, v, 6, 5, seed + 1) * 0.75 + fbm(u, v, 24, 2, seed + 2) * 0.25,
    (h, u, v) => {
      const moss = Math.max(0, fbm(u, v, 4, 3, seed + 3) - 0.56) * 3.2;
      let c = mixRGB([70, 66, 60], [150, 143, 130], h);
      c = mixRGB(c, [74, 86, 52], Math.min(0.7, moss));
      return c;
    });

  // Courtyard flagstones (running bond)
  T.flag = heightTextures(size,
    (u, v) => {
      const rows = 4, row = Math.floor(v * rows);
      const off = (row % 2) * 0.5;
      const cols = 3, cu = (u * cols + off) % cols;
      const fu = cu % 1, fv = (v * rows) % 1;
      const edge = Math.min(fu, 1 - fu, fv * (cols / rows) * 1.0, (1 - fv) * (cols / rows));
      const mortar = edge < 0.025 ? 0.0 : edge < 0.05 ? (edge - 0.025) / 0.025 : 1;
      const slab = hash2(Math.floor(cu), row, seed) * 0.25;
      return mortar * (0.55 + slab + fbm(u, v, 8, 4, seed + 4) * 0.2);
    },
    (h, u, v) => {
      const moss = Math.max(0, fbm(u, v, 5, 3, seed + 5) - 0.55) * 2.5;
      let c = mixRGB([38, 36, 32], [128, 122, 110], Math.min(1, h * 1.1));
      if (h < 0.15) c = mixRGB(c, [48, 62, 30], 0.7); // moss in joints
      c = mixRGB(c, [70, 80, 50], Math.min(0.5, moss));
      return c;
    });

  // Carved relief: cloud scrolls (drawn, then embossed)
  T.relief = reliefTextures(size, seed);

  // Roof tiles: alternating convex cover tiles and concave channel tiles
  T.tiles = heightTextures(size,
    (u, v) => {
      const pairs = 8, rows = 6;
      const ph = (u * pairs) % 1, rp = (v * rows) % 1;
      let h = ph < 0.5 ? Math.sin(Math.PI * ph / 0.5) * 0.9 + 0.1 : 0.25 - 0.15 * Math.sin(Math.PI * (ph - 0.5) / 0.5);
      h *= 0.7 + 0.3 * rp;
      if (rp < 0.035) h *= 0.35;
      return h * 0.85 + fbm(u, v, 16, 3, seed + 6) * 0.15;
    },
    (h, u, v) => {
      const moss = Math.max(0, fbm(u, v, 3, 3, seed + 7) - 0.5) * 2;
      let c = mixRGB([34, 33, 32], [104, 100, 94], h);
      if (h < 0.25) c = mixRGB(c, [56, 64, 40], Math.min(0.8, moss + 0.2));
      return c;
    });

  // Dark aged wood
  T.wood = heightTextures(size,
    (u, v) => {
      const n = fbm(u, v, 4, 4, seed + 8);
      const grain = Math.sin((u * 40 + n * 6) * Math.PI) * 0.5 + 0.5;
      return grain * 0.45 + fbm(u, v, 32, 2, seed + 9) * 0.25 + n * 0.3;
    },
    (h) => mixRGB([30, 22, 17], [92, 72, 54], h));

  // Faded lacquer for the doors
  T.door = heightTextures(size,
    (u, v) => {
      const n = fbm(u, v, 5, 4, seed + 10);
      const grain = Math.sin((u * 18 + n * 4) * Math.PI) * 0.5 + 0.5;
      return 0.35 + grain * 0.25 + fbm(u, v, 40, 2, seed + 11) * 0.4;
    },
    (h, u, v) => {
      const peel = fbm(u, v, 7, 4, seed + 12) > 0.6 ? 1 : 0;
      return peel ? mixRGB([40, 30, 22], [80, 62, 46], h) : mixRGB([58, 22, 16], [118, 52, 36], h);
    });

  // Rafter underside (round rafter ends between boards)
  T.rafter = heightTextures(size,
    (u, v) => {
      const p = (u * 10) % 1;
      const r = p < 0.45 ? Math.sin(Math.PI * p / 0.45) : 0.15;
      return r * 0.8 + fbm(u, v, 16, 3, seed + 13) * 0.2;
    },
    (h) => mixRGB([20, 15, 12], [86, 66, 48], h));

  // Dragon scales: overlapping scallops pointing along the body
  T.scales = heightTextures(size,
    (u, v) => {
      const cols = 10, rows = 10, rad = 0.62 / cols;
      let best = 0, bestY = -1;
      const r0 = Math.floor(u * rows);
      for (let r = r0 - 1; r <= r0 + 1; r++) {
        const off = (((r % 2) + 2) % 2) * 0.5;
        const cy = (r + 1) / rows;
        const c0 = Math.floor(v * cols - off);
        for (let c = c0 - 1; c <= c0 + 1; c++) {
          const cx = (c + 0.5 + off) / cols;
          let dx = v - cx; dx -= Math.round(dx);
          let dy = u - cy; dy -= Math.round(dy);
          const d = Math.hypot(dx, dy * 1.15);
          if (d < rad && cy > bestY && dy <= 0.002) { bestY = cy; best = 1 - Math.pow(d / rad, 2); }
        }
      }
      return best * 0.85 + fbm(u, v, 16, 3, seed + 40) * 0.15;
    },
    (h, u, v) => {
      const moss = Math.max(0, fbm(u, v, 4, 3, seed + 41) - 0.6) * 2.5;
      let c = mixRGB([44, 41, 37], [150, 142, 126], Math.pow(h, 0.8));
      return mixRGB(c, [66, 78, 46], Math.min(0.5, moss));
    });

  T.lattice = latticeTextures(size, seed);
  T.plaque = plaqueTexture(size);
  T.grass = grassTexture(256, seed);
  T.smoke = smokeTexture(128);
  T.glowCard = glowTexture(256);
  return T;
}

function reliefTextures(size, seed) {
  const rnd = mulberry(seed + 99);
  const c = makeCanvas(size), ctx = c.getContext('2d');
  ctx.fillStyle = '#5a5a5a'; ctx.fillRect(0, 0, size, size);
  const scrolls = [];
  for (let i = 0; i < 40; i++) scrolls.push([rnd() * size, rnd() * size, size * (0.025 + rnd() * 0.05), rnd() * Math.PI * 2, rnd() < 0.5 ? 1 : -1]);
  const drawScroll = (x, y, r, a0, dir, colour, w, dx, dy) => {
    ctx.strokeStyle = colour; ctx.lineWidth = w; ctx.lineCap = 'round';
    ctx.beginPath();
    const turns = 2.2;
    for (let t = 0; t <= 1.001; t += 0.02) {
      const a = a0 + dir * t * turns * Math.PI * 2;
      const rr = r * (1 - t * 0.85);
      const px = x + Math.cos(a) * rr + dx, py = y + Math.sin(a) * rr + dy;
      if (t === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    // tail sweeping away from the scroll
    const ta = a0 - dir * 0.6;
    ctx.moveTo(x + Math.cos(a0) * r + dx, y + Math.sin(a0) * r + dy);
    ctx.quadraticCurveTo(x + Math.cos(ta) * r * 1.8 + dx, y + Math.sin(ta) * r * 1.8 + dy,
      x + Math.cos(ta - 0.4 * dir) * r * 2.6 + dx, y + Math.sin(ta - 0.4 * dir) * r * 2.6 + dy);
    ctx.stroke();
  };
  const pass = (colour, wMul, off) => {
    for (const [x, y, r, a, d] of scrolls)
      for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size])
        drawScroll(x + ox, y + oy, r, a, d, colour, r * wMul, off, off);
  };
  pass('#2e2e2e', 0.42, size * 0.003); // shadow
  pass('#8c8c8c', 0.34, 0);             // raised scroll
  pass('#a8a8a8', 0.1, -size * 0.0015); // highlight ridge
  // carve noise into it
  const img = ctx.getImageData(0, 0, size, size);
  const cm = makeCanvas(size), im = cm.getContext('2d').createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const n = fbm(x / size, y / size, 10, 4, seed + 20);
    const h = img.data[i] / 255 * 0.8 + n * 0.2;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = h * 255;
    const moss = Math.max(0, fbm(x / size, y / size, 4, 3, seed + 21) - 0.58) * 3;
    let col = mixRGB([58, 54, 48], [138, 131, 118], h);
    col = mixRGB(col, [66, 78, 46], Math.min(0.6, moss));
    im.data[i] = col[0]; im.data[i + 1] = col[1]; im.data[i + 2] = col[2]; im.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  cm.getContext('2d').putImageData(im, 0, 0);
  return { map: canvasTex(cm, true), bump: canvasTex(c, false) };
}

function latticeTextures(size, seed) {
  const c = makeCanvas(size), ctx = c.getContext('2d');
  const b = makeCanvas(size), bx = b.getContext('2d');
  ctx.fillStyle = '#0b0807'; ctx.fillRect(0, 0, size, size);
  bx.fillStyle = '#000'; bx.fillRect(0, 0, size, size);
  const n = 4, cell = size / n, w = size * 0.018;
  const bars = (g, col) => {
    g.strokeStyle = col; g.lineWidth = w; g.lineCap = 'square';
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const x = i * cell, y = j * cell;
      g.strokeRect(x, y, cell, cell);
      // nested fret (rotated square + inner square) for an ornate lattice
      g.beginPath();
      g.moveTo(x + cell / 2, y); g.lineTo(x + cell, y + cell / 2);
      g.lineTo(x + cell / 2, y + cell); g.lineTo(x, y + cell / 2); g.closePath(); g.stroke();
      g.strokeRect(x + cell * 0.32, y + cell * 0.32, cell * 0.36, cell * 0.36);
      g.beginPath();
      g.moveTo(x + cell * 0.32, y + cell * 0.5); g.lineTo(x, y + cell * 0.5);
      g.moveTo(x + cell * 0.68, y + cell * 0.5); g.lineTo(x + cell, y + cell * 0.5);
      g.moveTo(x + cell * 0.5, y + cell * 0.32); g.lineTo(x + cell * 0.5, y);
      g.moveTo(x + cell * 0.5, y + cell * 0.68); g.lineTo(x + cell * 0.5, y + cell);
      g.stroke();
    }
  };
  bars(ctx, '#5a4634');
  bars(bx, '#ffffff');
  // subtle wood variation
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i] > 40) {
      const p = i / 4, n2 = fbm((p % size) / size, Math.floor(p / size) / size, 12, 3, seed + 30);
      const k = 0.6 + n2 * 0.7;
      img.data[i] *= k; img.data[i + 1] *= k; img.data[i + 2] *= k;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { map: canvasTex(c, true), bump: canvasTex(b, false) };
}

function plaqueTexture(size) {
  const c = makeCanvas(size), ctx = c.getContext('2d');
  ctx.fillStyle = '#1a1210'; ctx.fillRect(0, 0, size, size);
  const gold = '#a88a4c';
  ctx.strokeStyle = gold; ctx.lineWidth = size * 0.025;
  ctx.strokeRect(size * 0.05, size * 0.05, size * 0.9, size * 0.9);
  ctx.lineWidth = size * 0.008;
  ctx.strokeRect(size * 0.09, size * 0.09, size * 0.82, size * 0.82);
  // three abstract seal-like glyphs built from square spirals
  const glyph = (cx, cy, s, seed) => {
    const r = mulberry(seed);
    ctx.lineWidth = s * 0.09; ctx.lineCap = 'square';
    ctx.beginPath();
    let x = cx - s / 2, y = cy - s / 2, len = s;
    ctx.moveTo(x, y);
    for (let k = 0; k < 7; k++) {
      const d = k % 4;
      if (d === 0) x += len; else if (d === 1) y += len; else if (d === 2) x -= len; else y -= len;
      ctx.lineTo(x, y);
      if (k % 2 === 1) len *= 0.72;
    }
    ctx.stroke();
    for (let k = 0; k < 3; k++) {
      const yy = cy - s / 2 + r() * s;
      ctx.beginPath(); ctx.moveTo(cx - s * 0.6, yy); ctx.lineTo(cx - s * (0.2 + r() * 0.3), yy); ctx.stroke();
    }
  };
  ctx.strokeStyle = gold;
  glyph(size * 0.5, size * 0.27, size * 0.2, 3);
  glyph(size * 0.5, size * 0.52, size * 0.2, 8);
  glyph(size * 0.5, size * 0.77, size * 0.2, 13);
  const t = canvasTex(c, true, false);
  return { map: t };
}

function grassTexture(size, seed) {
  const r = mulberry(seed + 50);
  const c = makeCanvas(size), ctx = c.getContext('2d');
  for (let i = 0; i < 90; i++) {
    const x = size * (0.1 + r() * 0.8), h = size * (0.35 + r() * 0.6);
    const bend = (r() - 0.5) * size * 0.4;
    const g = 70 + r() * 70;
    ctx.strokeStyle = `rgb(${g * 0.5 | 0},${g | 0},${g * 0.35 | 0})`;
    ctx.lineWidth = 2 + r() * 3;
    ctx.beginPath(); ctx.moveTo(x, size);
    ctx.quadraticCurveTo(x + bend * 0.3, size - h * 0.6, x + bend, size - h);
    ctx.stroke();
  }
  // a few fern fronds
  for (let i = 0; i < 4; i++) {
    const x0 = size * (0.2 + r() * 0.6);
    ctx.strokeStyle = '#3d5a24'; ctx.lineWidth = 2;
    const dir = r() < 0.5 ? -1 : 1;
    for (let t = 0; t < 1; t += 0.08) {
      const px = x0 + dir * t * size * 0.35, py = size - t * size * 0.7;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px - 12, py - 6); ctx.moveTo(px, py); ctx.lineTo(px + 12, py - 6); ctx.stroke();
    }
  }
  return canvasTex(c, true, false);
}
function smokeTexture(size) {
  const c = makeCanvas(size), ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(200,195,185,0.55)'); g.addColorStop(0.5, 'rgba(160,155,150,0.2)'); g.addColorStop(1, 'rgba(120,120,120,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  return canvasTex(c, true, false);
}
function glowTexture(size) {
  const c = makeCanvas(size), ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size * 0.75, 0, size / 2, size * 0.75, size * 0.7);
  g.addColorStop(0, 'rgba(255,170,90,0.85)'); g.addColorStop(0.4, 'rgba(160,80,30,0.35)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  return canvasTex(c, true, false);
}

/* ------------------------------------------------------------------ */
/*  Materials                                                           */
/* ------------------------------------------------------------------ */
function makeMaterials(T) {
  const std = (o) => new THREE.MeshStandardMaterial(o);
  const M = {
    stone: std({ map: T.stone.map, bumpMap: T.stone.bump, bumpScale: 3, roughness: 0.95 }),
    carved: std({ map: T.relief.map, bumpMap: T.relief.bump, bumpScale: 6, roughness: 0.92 }),
    flag: std({ map: T.flag.map, bumpMap: T.flag.bump, bumpScale: 3, roughness: 0.95 }),
    wood: std({ map: T.wood.map, bumpMap: T.wood.bump, bumpScale: 2, roughness: 0.85 }),
    carvedWood: std({ map: T.relief.map, bumpMap: T.relief.bump, bumpScale: 5, roughness: 0.85, color: hex('#8a6f58') }),
    roof: std({ map: T.tiles.map, bumpMap: T.tiles.bump, bumpScale: 6, roughness: 0.9 }),
    rafter: std({ map: T.rafter.map, bumpMap: T.rafter.bump, bumpScale: 3, roughness: 0.9, side: THREE.DoubleSide }),
    lattice: std({ map: T.lattice.map, bumpMap: T.lattice.bump, bumpScale: 4, roughness: 0.85 }),
    door: std({ map: T.door.map, bumpMap: T.door.bump, bumpScale: 2, roughness: 0.75 }),
    scales: std({ map: T.scales.map, bumpMap: T.scales.bump, bumpScale: 3, roughness: 0.8, color: hex('#b9b0a0') }),
    scalesWood: std({ map: T.scales.map, bumpMap: T.scales.bump, bumpScale: 3, roughness: 0.75, color: hex('#c2a888') }),
    tilecap: std({ color: hex('#5c5852'), roughness: 0.9, bumpMap: T.stone.bump, bumpScale: 2 }),
    bronze: std({ color: hex('#7a6440'), roughness: 0.45, metalness: 0.75, bumpMap: T.stone.bump, bumpScale: 1.5 }),
    plaque: std({ map: T.plaque.map, roughness: 0.6, metalness: 0.2 }),
    glow: new THREE.MeshBasicMaterial({ color: hex('#ffb060') }),
    interior: new THREE.MeshBasicMaterial({ color: hex('#050403'), side: THREE.BackSide }),
    grass: std({ map: T.grass, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1 }),
    smoke: new THREE.SpriteMaterial({ map: T.smoke, transparent: true, depthWrite: false, opacity: 0.5 }),
    glowCard: new THREE.MeshBasicMaterial({ map: T.glowCard, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  };
  return M;
}

/* ------------------------------------------------------------------ */
/*  Geometry helpers                                                    */
/* ------------------------------------------------------------------ */
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _p = new THREE.Vector3(), _s = new THREE.Vector3();
function xf(g, p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1]) {
  _e.set(r[0], r[1], r[2]); _q.setFromEuler(_e);
  _m.compose(_p.set(p[0], p[1], p[2]), _q, _s.set(s[0], s[1], s[2]));
  g.applyMatrix4(_m);
  return g;
}
function scaleUV(g, su, sv) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return g;
}
function box(w, h, d, ts = 1.5) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let i = 0; i < 4; i++) {
    const k = f * 4 + i;
    uv.setXY(k, uv.getX(k) * dims[f][0] / ts, uv.getY(k) * dims[f][1] / ts);
  }
  return g;
}
function cyl(rt, rb, h, seg = 16, ts = 1.5, open = false) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
  return scaleUV(g, Math.max(1, Math.round((2 * Math.PI * Math.max(rt, rb)) / ts)), h / ts);
}
function sphere(r, ws = 10, hs = 8, ts = 1.0) {
  return scaleUV(new THREE.SphereGeometry(r, ws, hs), Math.max(1, Math.round((2 * Math.PI * r) / ts)), (Math.PI * r) / ts);
}
function cone(r, h, seg = 6) { return new THREE.ConeGeometry(r, h, seg); }
// Orient geometry whose "up" is +Y so that +Y points along dir
function alignY(g, dir) {
  _q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  _m.makeRotationFromQuaternion(_q);
  g.applyMatrix4(_m);
  return g;
}
function prep(g) {
  for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  if (!g.index) {
    const n = g.attributes.position.count;
    const idx = new (n > 65535 ? Uint32Array : Uint16Array)(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  g.morphAttributes = {};
  g.clearGroups();
  return g;
}
// Parametric grid: pt(u,v) -> [x,y,z,uvx,uvy]; expectDir(x,y,z) gives the direction normals should face
function grid(nu, nv, pt, expectDir) {
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    const r = pt(i / nu, j / nv);
    pos.push(r[0], r[1], r[2]); uv.push(r[3], r[4]);
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
    idx.push(a, b, d, a, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  if (expectDir) {
    // check winding on a middle triangle and flip if needed
    const t = Math.floor(idx.length / 6) * 3;
    const A = new THREE.Vector3().fromArray(pos, idx[t] * 3), B = new THREE.Vector3().fromArray(pos, idx[t + 1] * 3), C = new THREE.Vector3().fromArray(pos, idx[t + 2] * 3);
    const n = B.clone().sub(A).cross(C.clone().sub(A));
    if (n.dot(expectDir(A.x, A.y, A.z)) < 0) {
      for (let k = 0; k < idx.length; k += 3) { const tmp = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = tmp; }
      g.setIndex(idx);
    }
  }
  g.computeVertexNormals();
  return g;
}
// Tube with varying radius r(t) along points
function varTube(points, radiusFn, radial = 10, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points, closed);
  const nS = points.length * 3;
  const frames = curve.computeFrenetFrames(nS, closed);
  const pos = [], uv = [], idx = [];
  const len = curve.getLength();
  const P = new THREE.Vector3();
  for (let i = 0; i <= nS; i++) {
    const t = i / nS;
    curve.getPointAt(t, P);
    const N = frames.normals[i], B = frames.binormals[i];
    const r = radiusFn(t);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const cx = Math.cos(a), sy = Math.sin(a);
      pos.push(P.x + r * (cx * N.x + sy * B.x), P.y + r * (cx * N.y + sy * B.y), P.z + r * (cx * N.z + sy * B.z));
      uv.push(t * len / 0.8, j / radial);
    }
  }
  for (let i = 0; i < nS; i++) for (let j = 0; j < radial; j++) {
    const a = i * (radial + 1) + j, b = a + radial + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return { geo: g, curve, frames, nS };
}

// Collects geometries per material key then merges into a few meshes
class Batch {
  constructor() { this.groups = new Map(); }
  add(key, g) { prep(g); if (!this.groups.has(key)) this.groups.set(key, []); this.groups.get(key).push(g); return g; }
  addAll(key, list) { for (const g of list) this.add(key, g); }
  build(M, parent, shadows) {
    const meshes = [];
    for (const [key, list] of this.groups) {
      if (!list.length) continue;
      const merged = mergeGeometries(list, false);
      list.forEach((g) => g.dispose());
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, M[key]);
      mesh.name = 'temple_' + key;
      mesh.castShadow = shadows && key !== 'grass' && key !== 'glow';
      mesh.receiveShadow = shadows;
      mesh.matrixAutoUpdate = false; mesh.updateMatrix();
      parent.add(mesh); meshes.push(mesh);
    }
    this.groups.clear();
    return meshes;
  }
}
// Transform every geometry in a list
function xfAll(list, p, r = [0, 0, 0], s = [1, 1, 1]) { list.forEach((g) => xf(g, p, r, s)); return list; }
// A "kit" is {key: [geometries]} so a composite object can span several materials
function kitAdd(batch, kit) { for (const k in kit) batch.addAll(k, kit[k]); }
function kitXf(kit, p, r, s) { for (const k in kit) xfAll(kit[k], p, r, s); return kit; }
function kitClone(kit) { const o = {}; for (const k in kit) o[k] = kit[k].map((g) => g.clone()); return o; }
function kitMerge(a, b) { for (const k in b) (a[k] ||= []).push(...b[k]); return a; }

/* ------------------------------------------------------------------ */
/*  Curved hip roof with upturned corners                               */
/* ------------------------------------------------------------------ */
function roofKit(o) {
  const {
    hw, hd, cx = 0, cz = 0, eaveY, ridgeY, ridgeHalf = Math.max(0, hw - hd),
    curve = 1.7, upturn = 0.6, flare = 0.4, thick = 0.3, segU = 24, segV = 10,
    vMax = 1, ridge = true, ornaments = true, beasts = true, caps = true, capStep = 0.45, tileSize = 3,
  } = o;
  const kit = { roof: [], rafter: [], wood: [], stone: [] };
  const slopeLen = Math.hypot(hd, ridgeY - eaveY);
  // point on roof; face: 'F','B' (u along x) or 'R','Lf' (u along z)
  const rp = (face, u, v, yOff = 0) => {
    const w = Math.pow(Math.abs(u), 4) * (1 - v) * (1 - v);
    const y = lerp(eaveY, ridgeY, Math.pow(v, curve)) + upturn * w + yOff;
    let x, z;
    if (face === 'F' || face === 'B') {
      const sz = face === 'F' ? 1 : -1;
      x = u * lerp(hw, ridgeHalf, v); z = sz * hd * (1 - v);
      x += Math.sign(u) * flare * w; z += sz * flare * w;
    } else {
      const sx = face === 'R' ? 1 : -1;
      x = sx * lerp(hw, ridgeHalf, v); z = u * hd * (1 - v);
      x += sx * flare * w; z += Math.sign(u) * flare * w;
    }
    return [x + cx, y, z + cz];
  };
  const faces = ['F', 'B', 'R', 'Lf'];
  for (const f of faces) {
    const along = f === 'F' || f === 'B';
    const su = along ? segU : Math.max(6, Math.round(segU * hd / hw));
    const outward = (x, y, z) => new THREE.Vector3(along ? 0 : x - cx, 0, along ? z - cz : 0);
    // top surface
    kit.roof.push(grid(su, segV, (u, v) => {
      const uu = u * 2 - 1, vv = v * vMax;
      const p = rp(f, uu, vv);
      return [...p, (along ? p[0] : p[2]) / (tileSize * 1.2), (vv * slopeLen) / tileSize];
    }, (x, y, z) => outward(x, y, z).add(new THREE.Vector3(0, 1, 0))));
    // underside (rafters)
    kit.rafter.push(grid(su, Math.max(3, segV >> 1), (u, v) => {
      const uu = u * 2 - 1, vv = v * vMax;
      const p = rp(f, uu, vv, -thick);
      return [...p, (along ? p[0] : p[2]) / 3.5, (vv * slopeLen) / 3];
    }, () => new THREE.Vector3(0, -1, 0)));
    // fascia between the two along the eave
    kit.wood.push(grid(su, 1, (u, v) => {
      const uu = u * 2 - 1;
      const p = rp(f, uu, 0, -thick * v);
      return [...p, (along ? p[0] : p[2]) / 1.5, v * thick / 1.5];
    }, (x, y, z) => outward(x, y, z)));
  }
  // hip ridges: tubes following the face edges, with upturned curling tip
  const hipR = Math.max(0.06, thick * 0.45);
  if (vMax >= 1 || o.hips !== false) {
    for (const [f, uu] of [['F', 1], ['F', -1], ['B', 1], ['B', -1]]) {
      const pts = [];
      const v1 = vMax;
      // tip beyond the eave
      const e0 = new THREE.Vector3(...rp(f, uu, 0, hipR)), e1 = new THREE.Vector3(...rp(f, uu, 0.06, hipR));
      const outv = e0.clone().sub(e1).setY(0).normalize();
      pts.push(e0.clone().addScaledVector(outv, hipR * 3).add(new THREE.Vector3(0, hipR * 3.5, 0)));
      pts.push(e0.clone().addScaledVector(outv, hipR * 1.2).add(new THREE.Vector3(0, hipR * 0.8, 0)));
      for (let k = 0; k <= 10; k++) pts.push(new THREE.Vector3(...rp(f, uu, (k / 10) * v1, hipR * 0.9)));
      const t = varTube(pts, (t) => hipR * (t < 0.1 ? lerp(0.6, 1, t / 0.1) : 1), 6);
      kit.roof.push(t.geo);
      // ridge beasts on each hip near the eave
      if (beasts) {
        for (let k = 0; k < 4; k++) {
          const v = 0.05 + k * 0.045;
          const p = new THREE.Vector3(...rp(f, uu, v, hipR * 2.2));
          const s = hipR * 1.6;
          kit.stone.push(xf(box(s * 0.9, s * 0.9, s * 1.3, 0.5), [p.x, p.y, p.z]));
          kit.stone.push(xf(sphere(s * 0.5, 6, 5), [p.x, p.y + s * 0.7, p.z]));
        }
      }
    }
    if (vMax >= 1) {
      // also hip edges coming down the side faces are the same lines, already covered
    }
  }
  // main ridge
  if (ridge && vMax >= 1) {
    const rl = ridgeHalf * 2 + hipR * 4;
    const rh = Math.max(0.25, thick * 1.4);
    kit.roof.push(xf(box(rl, rh, rh * 0.9, 1), [cx, ridgeY + rh * 0.45, cz]));
    kit.stone.push(xf(box(rl * 0.98, rh * 0.35, rh * 0.6, 1), [cx, ridgeY + rh * 1.05, cz])); // carved ridge band
    if (ornaments && ridgeHalf > 0.5) {
      for (const sx of [-1, 1]) kitMerge(kit, kitXf(ridgeBeast(rh * 3.2), [cx + sx * ridgeHalf, ridgeY + rh * 0.9, cz], [0, sx > 0 ? 0 : Math.PI, 0]));
    }
  }
  // Tile end caps (wadang) along the eave of all faces
  const capsList = [];
  if (caps) {
    for (const f of faces) {
      const along = f === 'F' || f === 'B';
      const span = along ? hw * 2 : hd * 2;
      const n = Math.max(2, Math.floor(span / capStep));
      for (let i = 1; i < n; i++) {
        const uu = (i / n) * 2 - 1;
        const p = rp(f, uu, 0, -thick * 0.1);
        const nrm = along ? new THREE.Vector3(0, 0, f === 'F' ? 1 : -1) : new THREE.Vector3(f === 'R' ? 1 : -1, 0, 0);
        capsList.push({ p: new THREE.Vector3(...p), n: nrm });
      }
    }
  }
  return { kit, caps: capsList, rp };
}

// Chiwen-like ridge-end ornament: curling fish-dragon tail, built facing +X (outward)
function ridgeBeast(s) {
  const kit = { roof: [], stone: [] };
  // body block
  kit.roof.push(xf(box(s * 0.35, s * 0.5, s * 0.25, 1), [0, s * 0.25, 0]));
  // curling tail rising and folding inward
  const pts = [];
  for (let t = 0; t <= 1.0001; t += 0.1) {
    const a = t * Math.PI * 1.35;
    pts.push(new THREE.Vector3(s * 0.15 - Math.sin(a) * s * 0.35 * (1 - t * 0.3), s * 0.4 + (1 - Math.cos(a)) * s * 0.42, 0));
  }
  kit.roof.push(varTube(pts, (t) => s * 0.12 * (1 - t * 0.6), 8).geo);
  // fins
  for (let k = 0; k < 4; k++) kit.stone.push(xf(cone(s * 0.05, s * 0.22, 4), [-s * 0.05 - k * s * 0.06, s * (0.55 + k * 0.12), 0], [0, 0, 0.6]));
  // head with open jaws gripping the ridge (pointing inward)
  kit.stone.push(xf(sphere(s * 0.16, 8, 6), [-s * 0.15, s * 0.2, 0], [0, 0, 0], [1.3, 1, 0.9]));
  kit.stone.push(xf(box(s * 0.25, s * 0.06, s * 0.16, 1), [-s * 0.33, s * 0.12, 0], [0, 0, -0.25]));
  kit.stone.push(xf(box(s * 0.25, s * 0.06, s * 0.16, 1), [-s * 0.33, s * 0.26, 0], [0, 0, 0.3]));
  // a sword hilt standing in its back
  kit.stone.push(xf(box(s * 0.04, s * 0.3, s * 0.04, 1), [s * 0.02, s * 0.62, 0]));
  kit.stone.push(xf(box(s * 0.12, s * 0.03, s * 0.05, 1), [s * 0.02, s * 0.5, 0]));
  return kit;
}

/* ------------------------------------------------------------------ */
/*  Dragon coiled around a column                                       */
/* ------------------------------------------------------------------ */
function dragonKit({ R, h, turns = 2.4, body = 0.25, y0 = 0, phase = 0, dir = 1, seg = 90, radial = 10, key = 'carved', claws = true, skin = 'scales', headAngle }) {
  if (headAngle !== undefined) phase = headAngle - dir * turns * Math.PI * 2;
  const kit = { [key]: [], [skin]: [], stone: [], bronze: [] };
  const off = R + body * 0.75;
  const pts = [];
  const N = Math.max(30, Math.round(turns * 18));
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const a = phase + dir * turns * Math.PI * 2 * t;
    const wob = 1 + 0.12 * Math.sin(t * Math.PI * 9);
    const y = y0 + h * (0.04 + 0.86 * t) + Math.sin(t * Math.PI * 7) * body * 0.4;
    pts.push(new THREE.Vector3(Math.cos(a) * off * wob, y, Math.sin(a) * off * wob));
  }
  const rFn = (t) => {
    const taper = t < 0.25 ? lerp(0.03, 1, smooth(t / 0.25)) : t > 0.93 ? lerp(1, 0.85, (t - 0.93) / 0.07) : 1;
    return body * taper;
  };
  const tube = varTube(pts, rFn, radial);
  // varTube uv: x = along body (m / 0.8), y = around 0..1 → remap so 8 scales wrap the body
  scaleUV(tube.geo, 0.8 / (Math.PI * 2 * body), 1);
  kit[skin].push(tube.geo);
  const P = new THREE.Vector3(), Tn = new THREE.Vector3();
  // dorsal spines pointing away from the column axis
  const spines = Math.round(turns * 14);
  for (let k = 2; k < spines - 1; k++) {
    const t = k / spines;
    tube.curve.getPointAt(t, P);
    const out = new THREE.Vector3(P.x, 0, P.z).normalize();
    const d = out.clone().multiplyScalar(0.8).add(new THREE.Vector3(0, 0.6, 0)).normalize();
    const g = alignY(cone(body * 0.22, body * 0.75 * (0.6 + 0.4 * Math.sin(t * Math.PI)), 4), d);
    kit.stone.push(xf(g, [P.x + d.x * rFn(t) * 0.9, P.y + d.y * rFn(t) * 0.9, P.z + d.z * rFn(t) * 0.9]));
  }
  // legs with claws gripping the column
  if (claws) {
    for (const t of [0.3, 0.45, 0.68, 0.84]) {
      tube.curve.getPointAt(t, P); tube.curve.getTangentAt(t, Tn);
      const inward = new THREE.Vector3(-P.x, 0, -P.z).normalize();
      const down = new THREE.Vector3(0, -1, 0);
      const footDir = inward.clone().multiplyScalar(0.4).add(down.clone().multiplyScalar(0.5)).add(Tn.clone().multiplyScalar(0.4)).normalize();
      const foot = P.clone().addScaledVector(footDir, body * 2.1);
      const elbow = P.clone().addScaledVector(footDir, body * 1.0).add(new THREE.Vector3(0, body * 0.55, 0)).addScaledVector(inward, -body * 0.3);
      kit[skin].push(varTube([P.clone(), elbow, foot], (tt) => body * lerp(0.42, 0.22, tt), 6).geo);
      kit[skin].push(xf(sphere(body * 0.42, 7, 5), [elbow.x, elbow.y, elbow.z]));
      kit[skin].push(xf(sphere(body * 0.28, 7, 5), [foot.x, foot.y, foot.z]));
      for (let c = -1; c <= 1; c++) {
        const side = new THREE.Vector3().crossVectors(footDir, inward).normalize();
        const cd = footDir.clone().addScaledVector(side, c * 0.6).add(new THREE.Vector3(0, -0.3, 0)).normalize();
        kit.bronze.push(xf(alignY(cone(body * 0.07, body * 0.45, 4), cd), [foot.x + cd.x * body * 0.2, foot.y + cd.y * body * 0.2, foot.z + cd.z * body * 0.2]));
      }
    }
  }
  // head at the top end, facing outward and slightly down
  tube.curve.getPointAt(1, P); tube.curve.getTangentAt(1, Tn);
  const out = new THREE.Vector3(P.x, 0, P.z).normalize();
  const fwd = out.clone().multiplyScalar(0.75).addScaledVector(Tn, 0.45).add(new THREE.Vector3(0, -0.25, 0)).normalize();
  const head = dragonHead(body * 2.0, key);
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(up, fwd).normalize();
  const realUp = new THREE.Vector3().crossVectors(fwd, right).normalize();
  _m.makeBasis(right, realUp, fwd).setPosition(P.clone().addScaledVector(fwd, body * 0.6));
  for (const k in head) { kit[k] ||= []; for (const g of head[k]) { g.applyMatrix4(_m); kit[k].push(g); } }
  // cloud puffs on the column surface
  const rnd = mulberry(Math.round(R * 1000 + phase * 100));
  for (let c = 0; c < Math.round(h * 1.4); c++) {
    const a = rnd() * Math.PI * 2, y = y0 + rnd() * h * 0.9;
    for (let k = 0; k < 3; k++) {
      const aa = a + (k - 1) * 0.18 / R;
      kit[key].push(xf(sphere(R * 0.16 * (k === 1 ? 1.25 : 1), 7, 5), [Math.cos(aa) * R * 0.98, y + (k === 1 ? R * 0.07 : 0), Math.sin(aa) * R * 0.98], [0, -aa, 0], [0.45, 0.8, 1]));
    }
  }
  return kit;
}
// Dragon head in local space: forward = +Z, up = +Y, size ~ s
function dragonHead(s, key) {
  const k = { [key]: [], stone: [], bronze: [] };
  k[key].push(xf(sphere(s * 0.5, 10, 8), [0, 0, 0], [0, 0, 0], [0.9, 0.75, 1.1]));      // skull
  k[key].push(xf(box(s * 0.62, s * 0.36, s * 0.75, 0.6), [0, s * 0.02, s * 0.55]));    // upper snout
  k[key].push(xf(sphere(s * 0.22, 8, 6), [0, s * 0.12, s * 0.95], [0, 0, 0], [1.3, 0.8, 0.8])); // nose
  k[key].push(xf(box(s * 0.5, s * 0.14, s * 0.7, 0.6), [0, -s * 0.3, s * 0.45], [0.42, 0, 0])); // open lower jaw
  // teeth
  for (let i = -2; i <= 2; i++) k.stone.push(xf(cone(s * 0.04, s * 0.14, 4), [i * s * 0.11, -s * 0.18, s * 0.86], [Math.PI, 0, 0]));
  // bulging eyes
  for (const sx of [-1, 1]) {
    k.bronze.push(xf(sphere(s * 0.12, 8, 6), [sx * s * 0.26, s * 0.24, s * 0.3]));
    k[key].push(xf(box(s * 0.26, s * 0.08, s * 0.2, 0.6), [sx * s * 0.25, s * 0.36, s * 0.28], [0.2, 0, sx * 0.3])); // brow
    // antler horns sweeping back
    const hp = [new THREE.Vector3(sx * s * 0.2, s * 0.3, -s * 0.1), new THREE.Vector3(sx * s * 0.35, s * 0.7, -s * 0.5), new THREE.Vector3(sx * s * 0.3, s * 0.85, -s * 1.0)];
    k[key].push(varTube(hp, (t) => s * lerp(0.09, 0.03, t), 5).geo);
    k.stone.push(xf(alignY(cone(s * 0.04, s * 0.3, 4), new THREE.Vector3(sx * 0.3, 1, 0.4)), [sx * s * 0.34, s * 0.75, -s * 0.55]));
    // whiskers
    const wp = [new THREE.Vector3(sx * s * 0.3, s * 0.05, s * 0.9), new THREE.Vector3(sx * s * 0.7, -s * 0.1, s * 0.8), new THREE.Vector3(sx * s * 1.0, -s * 0.45, s * 0.5)];
    k.bronze.push(varTube(wp, (t) => s * lerp(0.035, 0.012, t), 4).geo);
  }
  // mane spikes
  for (let i = 0; i < 7; i++) {
    const a = (i / 6 - 0.5) * 2.4;
    k.stone.push(xf(alignY(cone(s * 0.08, s * 0.5, 4), new THREE.Vector3(Math.sin(a) * 0.8, 0.5, -1)), [Math.sin(a) * s * 0.35, s * 0.15 + Math.cos(a) * s * 0.2, -s * 0.45]));
  }
  // flaming pearl held before the mouth
  k.bronze.push(xf(sphere(s * 0.16, 10, 8), [0, -s * 0.05, s * 1.35]));
  return k;
}

/* ------------------------------------------------------------------ */
/*  Columns                                                             */
/* ------------------------------------------------------------------ */
function columnBase(r, key = 'carved') {
  const k = { stone: [], [key]: [] };
  k.stone.push(xf(cyl(r * 1.55, r * 1.65, r * 0.35, 8), [0, r * 0.175, 0]));          // octagonal plinth
  k[key].push(xf(cyl(r * 1.35, r * 1.5, r * 0.45, 8), [0, r * 0.55, 0]));             // carved drum
  k.stone.push(xf(cyl(r * 1.2, r * 1.38, r * 0.15, 16), [0, r * 0.85, 0]));
  // lotus petals
  const n = 14;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    k.stone.push(xf(sphere(r * 0.32, 6, 5), [Math.cos(a) * r * 1.08, r * 1.02, Math.sin(a) * r * 1.08], [0, -a, 0.0], [0.5, 0.8, 0.35]));
  }
  return k;
}
function columnCapital(r) {
  const k = { wood: [], carvedWood: [], bronze: [] };
  k.carvedWood.push(xf(cyl(r * 1.25, r * 1.05, r * 0.5, 12), [0, r * 0.25, 0]));
  k.wood.push(xf(box(r * 2.8, r * 0.45, r * 2.8, 1), [0, r * 0.72, 0]));
  k.bronze.push(xf(cyl(r * 1.08, r * 1.08, r * 0.12, 16), [0, -r * 0.05, 0]));
  return k;
}
function dragonColumn({ R = 0.72, h = 7.4, phase = 0, dir = 1, headAngle, quality }) {
  const kit = columnBase(R);
  kitMerge(kit, { carved: [xf(cyl(R, R * 1.03, h, quality.colSeg, 2.2), [0, h / 2, 0])] });
  kitMerge(kit, dragonKit({ R, h, turns: 2.6, body: R * 0.5, y0: R * 0.8, phase, dir, headAngle, radial: quality.tubeRadial }));
  kitMerge(kit, kitXf(columnCapital(R), [0, h, 0]));
  return kit;
}
function carvedColumn({ R = 0.36, h = 6.4, phase = 0, dir = 1, headAngle, quality }) {
  const kit = columnBase(R);
  kitMerge(kit, { carvedWood: [xf(cyl(R, R, h, quality.colSeg, 1.4), [0, h / 2, 0])] });
  kitMerge(kit, dragonKit({ R, h: h * 0.92, turns: 2.3, body: R * 0.55, y0: R, phase, dir, headAngle, key: 'carvedWood', skin: 'scalesWood', claws: quality.level > 0, radial: Math.max(6, quality.tubeRadial - 2) }));
  kitMerge(kit, kitXf(columnCapital(R), [0, h, 0]));
  return kit;
}
function plainColumn({ R = 0.34, h = 6.4, quality }) {
  const kit = columnBase(R, 'stone');
  kitMerge(kit, { wood: [xf(cyl(R * 0.95, R, h, quality.colSeg, 1.4), [0, h / 2, 0])] });
  // bronze bands
  kitMerge(kit, { bronze: [xf(cyl(R * 1.03, R * 1.03, 0.1, 16), [0, h * 0.25, 0]), xf(cyl(R * 1.03, R * 1.03, 0.1, 16), [0, h * 0.75, 0])] });
  kitMerge(kit, kitXf(columnCapital(R), [0, h, 0]));
  return kit;
}

/* ------------------------------------------------------------------ */
/*  Dougong bracket set (for instancing)                                */
/* ------------------------------------------------------------------ */
function bracketGeometry(s = 1) {
  const parts = [
    box(0.36, 0.18, 0.36, 0.6).translate(0, 0.09, 0),
    box(1.0, 0.12, 0.16, 0.6).translate(0, 0.24, 0),
    box(0.16, 0.12, 0.95, 0.6).translate(0, 0.24, 0.2),
    box(0.2, 0.12, 0.2, 0.6).translate(0.45, 0.36, 0), box(0.2, 0.12, 0.2, 0.6).translate(-0.45, 0.36, 0),
    box(0.2, 0.12, 0.2, 0.6).translate(0, 0.36, 0.6),
    box(1.45, 0.12, 0.16, 0.6).translate(0, 0.48, 0.35),
    box(0.16, 0.12, 0.9, 0.6).translate(0, 0.48, 0.75),
    box(0.2, 0.12, 0.2, 0.6).translate(0.66, 0.6, 0.35), box(0.2, 0.12, 0.2, 0.6).translate(-0.66, 0.6, 0.35),
    box(0.2, 0.12, 0.2, 0.6).translate(0, 0.6, 1.1),
    xf(box(0.14, 0.14, 1.1, 0.6), [0, 0.7, 0.85], [-0.35, 0, 0]),  // slanted cantilever (ang)
    box(1.8, 0.14, 0.18, 0.6).translate(0, 0.73, 1.05),
  ];
  parts.forEach(prep);
  const g = mergeGeometries(parts);
  g.scale(s, s, s);
  return g;
}

/* ------------------------------------------------------------------ */
/*  Guardian lion on a pedestal (faces +Z)                              */
/* ------------------------------------------------------------------ */
function lionKit(variant = 1) {
  const k = { stone: [], carved: [], bronze: [] };
  // pedestal
  k.stone.push(xf(box(1.3, 0.22, 1.7), [0, 0.11, 0]));
  k.carved.push(xf(box(1.05, 0.5, 1.45, 1), [0, 0.47, 0]));
  k.stone.push(xf(box(1.2, 0.14, 1.6), [0, 0.79, 0]));
  k.stone.push(xf(box(1.12, 0.06, 1.5), [0, 0.89, 0]));
  const y = 0.92;
  // body
  k.stone.push(xf(sphere(0.5, 10, 8), [0, y + 0.38, -0.25], [0, 0, 0], [0.95, 0.75, 1.1]));   // haunches
  k.stone.push(xf(sphere(0.45, 10, 8), [0, y + 0.85, 0.0], [-0.3, 0, 0], [0.85, 1.25, 0.8]));  // chest
  for (const sx of [-1, 1]) {
    k.stone.push(xf(sphere(0.25, 8, 6), [sx * 0.36, y + 0.32, -0.25], [0, 0, 0], [0.6, 1, 1.4])); // hind thigh
    k.stone.push(xf(sphere(0.12, 6, 5), [sx * 0.38, y + 0.06, 0.12], [0, 0, 0], [1, 0.6, 1.5]));  // hind paw
  }
  // front legs: one rests on a ball (variant 1) or a cub (variant -1, represented as small sphere head)
  const raised = variant;
  for (const sx of [-1, 1]) {
    const up = sx === raised;
    k.stone.push(xf(cyl(0.11, 0.13, up ? 0.62 : 0.85, 8, 1), [sx * 0.22, y + (up ? 0.6 : 0.43), up ? 0.32 : 0.22], [up ? 0.35 : 0, 0, 0]));
    k.stone.push(xf(sphere(0.14, 7, 5), [sx * 0.22, y + (up ? 0.36 : 0.06), up ? 0.45 : 0.3], [0, 0, 0], [1, 0.6, 1.3]));
    if (up) k.carved.push(xf(sphere(0.2, 10, 8), [sx * 0.24, y + 0.18, 0.45]));
  }
  // head
  const hy = y + 1.5, hz = 0.18;
  k.stone.push(xf(sphere(0.36, 10, 8), [0, hy, hz]));
  // mane curls: rings of knobs around the face
  for (let ring = 0; ring < 2; ring++) {
    const n = ring ? 14 : 18, rr = ring ? 0.36 : 0.44;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      k.carved.push(xf(sphere(0.11, 6, 5), [Math.cos(a) * rr, hy + Math.sin(a) * rr, hz - 0.08 - ring * 0.1]));
    }
  }
  for (let i = 0; i < 9; i++) { // mane down the back
    k.carved.push(xf(sphere(0.12, 6, 5), [((i % 3) - 1) * 0.2, hy - 0.35 - Math.floor(i / 3) * 0.17, hz - 0.35]));
  }
  k.stone.push(xf(box(0.36, 0.2, 0.22, 0.6), [0, hy - 0.08, hz + 0.36]));               // muzzle
  k.stone.push(xf(sphere(0.09, 6, 5), [0, hy - 0.02, hz + 0.48], [0, 0, 0], [1.4, 1, 1]));// nose
  k.stone.push(xf(box(0.3, 0.07, 0.2, 0.6), [0, hy - 0.24, hz + 0.32], [0.3, 0, 0]));    // jaw
  for (const sx of [-1, 1]) {
    k.bronze.push(xf(sphere(0.075, 7, 5), [sx * 0.14, hy + 0.12, hz + 0.31]));            // bulging eyes
    k.stone.push(xf(box(0.18, 0.06, 0.1, 0.6), [sx * 0.14, hy + 0.22, hz + 0.3], [0, 0, sx * -0.3]));
    k.stone.push(xf(cone(0.08, 0.16, 5), [sx * 0.28, hy + 0.3, hz + 0.05], [0, 0, sx * -0.5])); // ears
  }
  // bell collar
  k.bronze.push(xf(new THREE.TorusGeometry(0.33, 0.04, 6, 18), [0, hy - 0.38, hz - 0.05], [Math.PI / 2 - 0.3, 0, 0]));
  k.bronze.push(xf(sphere(0.08, 7, 5), [0, hy - 0.5, hz + 0.25]));
  // tail curling up the back
  const tp = [new THREE.Vector3(0, y + 0.3, -0.75), new THREE.Vector3(0, y + 0.7, -0.85), new THREE.Vector3(0, y + 1.0, -0.6)];
  k.stone.push(varTube(tp, (t) => lerp(0.08, 0.13, t), 6).geo);
  return k;
}

/* ------------------------------------------------------------------ */
/*  Stone lantern                                                        */
/* ------------------------------------------------------------------ */
function lanternKit() {
  const k = { stone: [], carved: [], glow: [], roof: [], rafter: [], wood: [] };
  k.stone.push(xf(box(0.75, 0.16, 0.75), [0, 0.08, 0]));
  k.carved.push(xf(cyl(0.25, 0.3, 0.3, 8, 1), [0, 0.31, 0]));
  k.stone.push(xf(cyl(0.12, 0.14, 1.0, 8, 1), [0, 0.96, 0]));
  k.carved.push(xf(cyl(0.3, 0.18, 0.18, 8, 1), [0, 1.54, 0]));
  k.stone.push(xf(box(0.62, 0.1, 0.62), [0, 1.68, 0]));
  for (const [x, z] of [[-0.23, -0.23], [0.23, -0.23], [-0.23, 0.23], [0.23, 0.23]]) k.stone.push(xf(box(0.09, 0.45, 0.09), [x, 1.95, z]));
  k.glow.push(xf(box(0.3, 0.32, 0.3), [0, 1.93, 0]));
  const r = roofKit({ hw: 0.48, hd: 0.48, eaveY: 2.2, ridgeY: 2.62, ridgeHalf: 0, curve: 1.5, upturn: 0.1, flare: 0.06, thick: 0.08, segU: 6, segV: 4, beasts: false, ornaments: false, caps: false, ridge: false, tileSize: 1.2 });
  kitMerge(k, r.kit);
  k.stone.push(xf(sphere(0.09, 8, 6), [0, 2.68, 0]));
  k.stone.push(xf(cone(0.06, 0.2, 6), [0, 2.82, 0]));
  return k;
}

/* ------------------------------------------------------------------ */
/*  Huabiao: free-standing ornamental dragon column                    */
/* ------------------------------------------------------------------ */
function huabiaoKit(quality) {
  const k = { stone: [], carved: [], bronze: [] };
  k.stone.push(xf(box(2.0, 0.25, 2.0), [0, 0.125, 0]));
  k.carved.push(xf(cyl(0.65, 0.75, 0.5, 8, 1), [0, 0.5, 0]));
  // little balustrade around the base
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    k.stone.push(xf(box(0.12, 0.55, 0.12), [Math.cos(a) * 0.9, 0.52, Math.sin(a) * 0.9]));
    k.stone.push(xf(sphere(0.08, 6, 5), [Math.cos(a) * 0.9, 0.84, Math.sin(a) * 0.9]));
  }
  const R = 0.3, h = 5.2;
  k.carved.push(xf(cyl(R, R * 1.05, h, 8, 1.2), [0, 0.75 + h / 2, 0]));
  kitMerge(k, dragonKit({ R, h: h * 0.85, turns: 2.6, body: R * 0.6, y0: 0.9, phase: 0.5, dir: 1, key: 'carved', claws: quality.level > 0, radial: 7 }));
  // cloud wing plate
  k.carved.push(xf(box(1.7, 0.55, 0.08, 1), [0, 0.75 + h * 0.86, 0], [0, 0, 0.08]));
  for (const sx of [-1, 1]) k.carved.push(xf(sphere(0.2, 7, 5), [sx * 0.85, 0.75 + h * 0.86 + 0.05, 0], [0, 0, 0], [1, 1, 0.4]));
  // capital disc and seated beast
  const top = 0.75 + h;
  k.carved.push(xf(cyl(0.55, 0.4, 0.22, 16, 1), [0, top + 0.11, 0]));
  k.stone.push(xf(cyl(0.5, 0.55, 0.08, 16, 1), [0, top + 0.26, 0]));
  k.stone.push(xf(sphere(0.25, 8, 6), [0, top + 0.5, -0.05], [0, 0, 0], [0.8, 1.1, 1]));
  k.stone.push(xf(sphere(0.2, 8, 6), [0, top + 0.82, 0.08]));
  k.stone.push(xf(box(0.16, 0.1, 0.14, 0.5), [0, top + 0.78, 0.25]));
  for (const sx of [-1, 1]) k.stone.push(xf(cone(0.05, 0.14, 4), [sx * 0.1, top + 1.0, 0.05]));
  return k;
}

/* ------------------------------------------------------------------ */
/*  Bronze incense cauldron (ding)                                      */
/* ------------------------------------------------------------------ */
function cauldronKit() {
  const k = { stone: [], carved: [], bronze: [], glow: [], roof: [], rafter: [], wood: [] };
  // round stone dais
  k.stone.push(xf(cyl(2.1, 2.2, 0.2, 24, 2), [0, 0.1, 0]));
  k.carved.push(xf(cyl(1.6, 1.8, 0.3, 24, 2), [0, 0.35, 0]));
  // legs
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
    k.bronze.push(xf(cyl(0.12, 0.17, 0.75, 8, 1), [Math.cos(a) * 0.6, 0.85, Math.sin(a) * 0.6]));
    k.bronze.push(xf(sphere(0.2, 8, 6), [Math.cos(a) * 0.6, 1.2, Math.sin(a) * 0.6], [0, 0, 0], [1, 0.7, 1]));
  }
  // bowl via lathe
  const prof = [];
  const pts = [[0, 0], [0.55, 0.02], [0.85, 0.2], [0.98, 0.5], [1.0, 0.75], [1.08, 0.82], [1.08, 0.9], [0.95, 0.9], [0.92, 0.78]];
  for (const [r, yy] of pts) prof.push(new THREE.Vector2(r, yy));
  k.bronze.push(xf(new THREE.LatheGeometry(prof, 24), [0, 1.15, 0]));
  // decorative bands of bosses
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    k.bronze.push(xf(sphere(0.06, 6, 4), [Math.cos(a) * 0.99, 1.75, Math.sin(a) * 0.99]));
  }
  // upright handles
  for (const sx of [-1, 1]) {
    k.bronze.push(xf(box(0.08, 0.5, 0.35, 0.5), [sx * 0.95, 2.25, 0]));
    k.bronze.push(xf(box(0.08, 0.08, 0.35, 0.5), [sx * 0.95, 2.5, 0]));
  }
  // glowing embers
  k.glow.push(xf(cyl(0.85, 0.85, 0.05, 20), [0, 1.95, 0]));
  // small pagoda lid raised on posts
  for (const [x, z] of [[-0.45, -0.45], [0.45, -0.45], [-0.45, 0.45], [0.45, 0.45]]) k.bronze.push(xf(cyl(0.04, 0.04, 0.6, 6), [x, 2.3, z]));
  const r = roofKit({ hw: 0.85, hd: 0.85, eaveY: 2.6, ridgeY: 3.25, ridgeHalf: 0, curve: 1.4, upturn: 0.18, flare: 0.08, thick: 0.08, segU: 8, segV: 4, beasts: false, ornaments: false, caps: false, ridge: false, tileSize: 1.2 });
  r.kit.bronze = r.kit.roof; delete r.kit.roof;
  kitMerge(k, r.kit);
  k.bronze.push(xf(sphere(0.12, 8, 6), [0, 3.32, 0]));
  return k;
}

/**
 * Test copy: generates FILE_TEXTURES the slow way, once, and returns each as a
 * WebP data URL for saving into public/textures/temple3d/. Re-run only if a
 * texture's generator or the seed changes — see temple3d/exportTextures.js.
 */
export function exportTempleTextures({ seed = 7, quality = 'mobile', webpQuality = 0.85 } = {}) {
  const T = makeTextures(QUALITY[quality].texSize, seed);
  return FILE_TEXTURES.map((name) => ({ name, dataUrl: T[name].map.image.toDataURL('image/webp', webpQuality) }));
}

/* ------------------------------------------------------------------ */
/*  Main build                                                           */
/* ------------------------------------------------------------------ */
const QUALITY = {
  mobile: { level: 0, texSize: 512, colSeg: 14, tubeRadial: 8, roofSegU: 20, roofSegV: 8, grass: 70, shadows: false, smoke: 14 },
  high: { level: 1, texSize: 1024, colSeg: 24, tubeRadial: 12, roofSegU: 36, roofSegV: 14, grass: 160, shadows: true, smoke: 24 },
};

/**
 * Build the temple.
 * @param {object} [opts]
 * @param {'mobile'|'high'} [opts.quality='mobile']
 * @param {boolean} [opts.shadows] override shadow casting (defaults per quality)
 * @param {boolean} [opts.lights=true] add a few warm point lights at the doorway and lanterns
 * @param {number} [opts.seed=7]
 * @param {{base: string, manager?: THREE.LoadingManager}} [opts.textureFiles]
 *   test copy: load FILE_TEXTURES as `${base}${name}.webp` (through `manager`,
 *   so a loading screen waits for them) instead of generating them.
 */
export function buildTemple(opts = {}) {
  const quality = { ...QUALITY[opts.quality || 'mobile'] };
  if (opts.shadows !== undefined) quality.shadows = opts.shadows;
  const seed = opts.seed ?? 7;
  const rnd = mulberry(seed);
  const _t0 = performance.now(); // test copy: timings, see api.timings
  let fromFile = null;
  if (opts.textureFiles) {
    const loader = new THREE.TextureLoader(opts.textureFiles.manager);
    // Same settings canvasTex() gives the generated versions.
    fromFile = (name) => {
      const t = loader.load(`${opts.textureFiles.base}${name}.webp`);
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 4;
      return t;
    };
  }
  const T = makeTextures(quality.texSize, seed, fromFile);
  const _t1 = performance.now();
  const M = makeMaterials(T);

  const root = new THREE.Group();
  root.name = 'Temple';
  const B = new Batch();
  const colliders = [];
  const solid = (position, size, extra = {}) => colliders.push({ type: 'box', position, size, rotation: [0, 0, 0], ...extra });
  const pillar = (position, radius, height) => colliders.push({ type: 'cylinder', position, radius, height });

  const PT = L.platformTop;

  // (Test copy: the courtyard ground, path and side walls are removed — see
  // the header.)

  /* ---------- platform ---------- */
  const pz0 = -7.5, pz1 = L.platformFrontZ, pw = 28;
  const pd = pz1 - pz0, pcz = (pz0 + pz1) / 2;
  B.add('stone', xf(box(pw, PT, pd, 2), [0, PT / 2, pcz]));
  B.add('carved', xf(box(pw - 0.6, PT * 0.5, 0.06, 1.2), [0, PT * 0.5, pz1 + 0.03]));   // carved front frieze
  B.add('stone', xf(box(pw + 0.5, 0.18, pd + 0.5, 2), [0, 0.09, pcz]));                // base moulding
  B.add('stone', xf(box(pw + 0.3, 0.14, pd + 0.3, 2), [0, PT - 0.07, pcz]));           // top moulding
  solid([0, PT / 2, pcz], [pw, PT, pd]);

  /* ---------- stairs with central carved dragon ramp ---------- */
  const steps = 6, rise = PT / steps, run = 0.36, sw = 7.2;
  for (let s = 0; s < steps; s++) {
    const h = rise * (s + 1);
    const zc = pz1 + run * (steps - 1 - s) + run / 2;
    for (const sx of [-1, 1]) B.add('stone', xf(box(2.5, h, run, 1.5), [sx * 2.35, h / 2, zc]));
  }
  // dragon ramp (yudao): sloped carved slab between the flights
  const rampLen = Math.hypot(steps * run, PT);
  const rampAng = Math.atan2(PT, steps * run);
  B.add('carved', xf(box(2.2, 0.12, rampLen, 1.8), [0, PT / 2, pz1 + steps * run / 2], [rampAng, 0, 0]));
  // (Test copy: the ramp's support was a flat-topped box nearly as tall as
  // the platform, so it stood proud of the sloped slab and a walker climbing
  // the slope disappeared inside it. Now a wedge under the slab.)
  {
    const w = 2.2 * 0.98, len = steps * run, h = PT - 0.08;
    const sh = new THREE.Shape();
    sh.moveTo(0, 0); sh.lineTo(len, 0); sh.lineTo(0, h); sh.closePath();
    const g = new THREE.ExtrudeGeometry(sh, { depth: w, bevelEnabled: false });
    scaleUV(g, 1 / 1.5, 1 / 1.5);
    xf(g, [0, 0, 0], [0, -Math.PI / 2, 0]); // shape x → world +z, depth → world −x
    xf(g, [w / 2, 0, pz1]);
    B.add('stone', g);
  }
  // sloped cheek walls
  for (const sx of [-1, 1]) {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0); shape.lineTo(steps * run + 0.25, 0); shape.lineTo(0.25, PT + 0.35); shape.lineTo(0, PT + 0.35); shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.4, bevelEnabled: false });
    scaleUV(g, 1 / 1.2, 1 / 1.2);
    // shape x → world +z, depth → world x
    xf(g, [0, 0, 0], [0, -Math.PI / 2, 0]);
    xf(g, [sx * 3.6 + (sx > 0 ? 0.4 : 0), 0, pz1]);
    B.add('carved', g);
    // newel post with lion-head finial at the bottom of each cheek
    B.add('stone', xf(box(0.45, 0.9, 0.45), [sx * 3.8, 0.45, pz1 + steps * run + 0.1]));
    B.add('stone', xf(sphere(0.2, 8, 6), [sx * 3.8, 1.05, pz1 + steps * run + 0.1]));
  }
  // ramp collider so characters walk up smoothly
  colliders.push({ type: 'box', position: [0, PT / 2 - 0.1 * Math.cos(rampAng), pz1 + steps * run / 2 + 0.1 * Math.sin(rampAng)], size: [sw + 0.8, 0.2, rampLen], rotation: [rampAng, 0, 0], ramp: true });

  /* ---------- balustrade along the platform edge ---------- */
  const balY = PT;
  const bal = (x0, x1, z, alongX = true) => {
    const len = Math.abs(x1 - x0);
    const n = Math.max(1, Math.round(len / 1.5));
    for (let i = 0; i <= n; i++) {
      const t = lerp(x0, x1, i / n);
      const p = alongX ? [t, balY, z] : [z, balY, t];
      B.add('stone', xf(box(0.22, 1.0, 0.22, 0.8), [p[0], balY + 0.5, p[2]]));
      B.add('carved', xf(cyl(0.13, 0.09, 0.22, 8, 0.6), [p[0], balY + 1.11, p[2]]));
      B.add('stone', xf(sphere(0.1, 6, 5), [p[0], balY + 1.27, p[2]]));
    }
    const mid = (x0 + x1) / 2;
    const pos = alongX ? [mid, balY + 0.45, z] : [z, balY + 0.45, mid];
    const size = alongX ? [len, 0.55, 0.08] : [0.08, 0.55, len];
    B.add('carved', xf(box(size[0], size[1], size[2], 1.2), pos));
    const rail = alongX ? [len, 0.1, 0.16] : [0.16, 0.1, len];
    B.add('stone', xf(box(rail[0], rail[1], rail[2], 1.5), [pos[0], balY + 0.85, pos[2]]));
    B.add('stone', xf(box(rail[0], 0.12, rail[2], 1.5), [pos[0], balY + 0.12, pos[2]]));
    solid([pos[0], balY + 0.6, pos[2]], alongX ? [len, 1.2, 0.3] : [0.3, 1.2, len]);
  };
  bal(-13.8, -4.0, pz1 - 0.2); bal(4.0, 13.8, pz1 - 0.2);
  bal(pz1 - 0.2, pz0 + 1, -13.8, false); bal(pz1 - 0.2, pz0 + 1, 13.8, false);

  /* ---------- façade columns ---------- */
  const colZ = 1.4, colH = 6.4;
  const dragonZ = 3.0, dragonH = 7.15;
  for (const sx of [-1, 1]) {
    // great dragon columns
    const dk = dragonColumn({ R: 0.72, h: dragonH, dir: sx, headAngle: Math.PI / 2 + sx * 0.55, quality });
    kitXf(dk, [sx * 5.2, PT, dragonZ]);
    kitAdd(B, dk);
    pillar([sx * 5.2, PT + dragonH / 2, dragonZ], 1.25, dragonH);
    // carved columns flanking the door
    const ck = carvedColumn({ R: 0.36, h: colH, dir: -sx, headAngle: Math.PI / 2 + sx * 0.7, quality });
    kitXf(ck, [sx * 2.35, PT, colZ]);
    kitAdd(B, ck);
    pillar([sx * 2.35, PT + colH / 2, colZ], 0.65, colH);
    // plain outer columns
    for (const x of [8.6, 12.8]) {
      const pk = plainColumn({ R: 0.34, h: colH, quality });
      kitXf(pk, [sx * x, PT, colZ]);
      kitAdd(B, pk);
      pillar([sx * x, PT + colH / 2, colZ], 0.5, colH);
    }
  }

  /* ---------- door wall with arched doorway ---------- */
  const dz = L.doorZ, dw = L.doorHalfWidth, wallT = 0.5;
  const rectH = 2.8, archR = dw;
  const wallTop = PT + colH;
  {
    const sh = new THREE.Shape();
    sh.moveTo(-2.35, PT); sh.lineTo(2.35, PT); sh.lineTo(2.35, wallTop); sh.lineTo(-2.35, wallTop); sh.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-dw, PT); hole.lineTo(dw, PT); hole.lineTo(dw, PT + rectH);
    hole.absarc(0, PT + rectH, archR, 0, Math.PI, false);
    hole.lineTo(-dw, PT);
    sh.holes.push(hole);
    const g = new THREE.ExtrudeGeometry(sh, { depth: wallT, bevelEnabled: false, curveSegments: 16 });
    scaleUV(g, 1 / 1.6, 1 / 1.6);
    xf(g, [0, 0, dz - wallT / 2]);
    B.add('carved', g);
    // heavy stone door surround (architrave) following the arch
    const surround = new THREE.Shape();
    const o = 0.32;
    surround.moveTo(-dw - o, PT); surround.lineTo(dw + o, PT); surround.lineTo(dw + o, PT + rectH);
    surround.absarc(0, PT + rectH, archR + o, 0, Math.PI, false); surround.closePath();
    const sh2 = new THREE.Path();
    sh2.moveTo(-dw, PT); sh2.lineTo(dw, PT); sh2.lineTo(dw, PT + rectH); sh2.absarc(0, PT + rectH, archR, 0, Math.PI, false); sh2.closePath();
    surround.holes.push(sh2);
    const sg = new THREE.ExtrudeGeometry(surround, { depth: 0.2, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.05, bevelSegments: 2, curveSegments: 16 });
    scaleUV(sg, 1 / 1.0, 1 / 1.0);
    xf(sg, [0, 0, dz + wallT / 2 - 0.02]);
    B.add('stone', sg);
    // keystone ornament
    B.add('carved', xf(sphere(0.25, 8, 6), [0, PT + rectH + archR + 0.25, dz + wallT / 2 + 0.2], [0, 0, 0], [1, 1.2, 0.5]));
    // threshold
    B.add('stone', xf(box(dw * 2 + 0.2, 0.18, wallT + 0.3, 1), [0, PT + 0.09, dz]));
  }
  // side bays: dado + lattice + frames
  const bays = [[2.35, 5.2], [5.2, 8.6], [8.6, 12.8]];
  for (const sx of [-1, 1]) for (const [a, b] of bays) {
    const x0 = sx * a, x1 = sx * b, cx = (x0 + x1) / 2, w = Math.abs(x1 - x0);
    B.add('carvedWood', xf(box(w, 1.3, 0.3, 1.2), [cx, PT + 0.65, dz]));
    B.add('lattice', xf(box(w - 0.3, 3.3, 0.14, 1.65), [cx, PT + 1.3 + 1.75, dz]));
    B.add('wood', xf(box(w, 0.2, 0.4, 1.2), [cx, PT + 1.4, dz]));
    B.add('wood', xf(box(w, 0.2, 0.4, 1.2), [cx, PT + 4.7, dz]));
    B.add('carvedWood', xf(box(w, wallTop - (PT + 4.8), 0.3, 1.2), [cx, (wallTop + PT + 4.8) / 2, dz]));
    for (const xx of [x0, x1]) B.add('wood', xf(box(0.22, colH, 0.42), [xx, PT + colH / 2, dz]));
    // mid mullion
    B.add('wood', xf(box(0.12, 3.3, 0.24), [cx, PT + 3.05, dz]));
    solid([cx, PT + colH / 2, dz], [w, colH, wallT]);
  }
  for (const sx of [-1, 1]) solid([sx * (dw + 1.15 / 2), PT + colH / 2, dz], [2.35 - dw, colH, wallT]);
  solid([0, PT + rectH + archR + (colH - rectH - archR) / 2, dz], [dw * 2, colH - rectH - archR, wallT]);

  // name plaque above the door, with a carved frame and little brackets
  {
    const py = PT + rectH + archR + 0.55, pzz = dz + wallT / 2 + 0.12;
    B.add('plaque', scaleUV(xf(box(1.0, 1.0, 0.1, 1), [0, py + 0.1, pzz], [0, 0, 0], [2.0, 0.75, 1]), 1, 1));
    B.add('bronze', xf(box(2.25, 0.1, 0.16), [0, py + 0.5, pzz]));
    B.add('bronze', xf(box(2.25, 0.1, 0.16), [0, py - 0.3, pzz]));
    for (const sx of [-1, 1]) B.add('bronze', xf(box(0.1, 0.9, 0.16), [sx * 1.08, py + 0.1, pzz]));
  }

  /* ---------- doors (separate, animated) ---------- */
  const doors = { group: new THREE.Group(), left: null, right: null, progress: 0, target: 0, duration: 2.6, maxAngle: THREE.MathUtils.degToRad(100) };
  doors.group.name = 'TempleDoors';
  root.add(doors.group);
  const leafKit = (fz) => {
    const sh = new THREE.Shape();
    sh.moveTo(0, 0); sh.lineTo(dw, 0); sh.lineTo(dw, rectH + archR);
    sh.absarc(dw, rectH, archR, Math.PI / 2, Math.PI, false);
    sh.closePath();
    const thick = 0.14;
    const g = new THREE.ExtrudeGeometry(sh, { depth: thick, bevelEnabled: false, curveSegments: 12 });
    scaleUV(g, 1 / 1.4, 1 / 1.4);
    g.translate(0.01, 0, -thick / 2);
    const kd = { door: [g], bronze: [] };
    // door studs (9 rows x 5 cols), both faces
    for (let r = 0; r < 9; r++) for (let c = 0; c < 5; c++) {
      const x = 0.15 + c * (dw - 0.3) / 4;
      const y = 0.3 + r * (rectH - 0.35) / 8;
      for (const fz of [1, -1]) kd.bronze.push(xf(new THREE.SphereGeometry(0.045, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2), [x, y, fz * thick / 2], [fz * Math.PI / 2, 0, 0]));
    }
    // iron straps at the hinge side
    for (const y of [0.35, rectH - 0.2]) for (const fz of [1, -1]) kd.bronze.push(xf(box(dw * 0.6, 0.09, 0.03), [dw * 0.3, y, fz * (thick / 2 + 0.015)]));
    // knocker: beast-face plate with ring, near the meeting edge
    const kx = dw - 0.22, ky = 1.45, kz = fz * thick / 2;
    kd.bronze.push(xf(cyl(0.16, 0.16, 0.05, 16), [kx, ky, kz + fz * 0.025], [Math.PI / 2, 0, 0]));
    kd.bronze.push(xf(sphere(0.08, 8, 6), [kx, ky + 0.02, kz + fz * 0.07], [0, 0, 0], [1.1, 1, 0.6]));
    for (const sx of [-1, 1]) kd.bronze.push(xf(sphere(0.03, 5, 4), [kx + sx * 0.06, ky + 0.07, kz + fz * 0.08]));
    kd.bronze.push(xf(new THREE.TorusGeometry(0.11, 0.018, 6, 16), [kx, ky - 0.13, kz + fz * 0.06]));
    return kd;
  };
  const makeLeaf = (side) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * -dw, PT, dz + 0.05);
    const inner = new THREE.Group();
    if (side < 0) inner.rotation.y = Math.PI; // right leaf mirrored by rotation, not negative scale
    const kd = leafKit(side);
    for (const key in kd) {
      kd[key].forEach(prep);
      const mesh = new THREE.Mesh(mergeGeometries(kd[key]), M[key]);
      mesh.castShadow = quality.shadows; mesh.receiveShadow = quality.shadows;
      inner.add(mesh);
      kd[key].forEach((g) => g.dispose());
    }
    pivot.add(inner);
    doors.group.add(pivot);
    return pivot;
  };
  doors.left = makeLeaf(1);   // hinge at -dw, leaf extends +x
  doors.right = makeLeaf(-1); // hinge at +dw, leaf extends -x
  const doorCollider = { type: 'box', position: [0, PT + (rectH + archR) / 2, dz], size: [dw * 2, rectH + archR, 0.3], rotation: [0, 0, 0] };

  /* ---------- building body behind the wall + dark entry passage ---------- */
  const bz0 = dz - wallT / 2, bz1 = -7.2, bodyH = colH;
  const bodyD = bz0 - bz1, bodyCz = (bz0 + bz1) / 2;
  for (const sx of [-1, 1]) B.add('wood', xf(box(12.8 - dw, bodyH, bodyD, 2), [sx * (dw + (12.8 - dw) / 2), PT + bodyH / 2, bodyCz - 0.01]));
  B.add('wood', xf(box(dw * 2, bodyH - rectH - archR + 0.1, bodyD, 2), [0, PT + rectH + archR + (bodyH - rectH - archR) / 2, bodyCz - 0.01]));
  {
    const corridor = new THREE.BoxGeometry(dw * 2 - 0.02, rectH + archR, 4.5);
    xf(corridor, [0, PT + (rectH + archR) / 2, bz0 - 2.25]);
    B.add('interior', corridor);
    // a faint warm glow deep inside, beckoning
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(dw * 2, rectH + archR), M.glowCard);
    glow.position.set(0, PT + (rectH + archR) / 2, bz0 - 4.4);
    root.add(glow);
  }
  solid([0, PT + bodyH / 2, bz0 - 4.7], [dw * 2, bodyH, 0.3]); // back of passage
  for (const sx of [-1, 1]) solid([sx * (dw + (12.8 - dw) / 2), PT + bodyH / 2, bodyCz], [12.8 - dw, bodyH, bodyD]);

  /* ---------- beams, friezes and bracket sets (lower storey) ---------- */
  const beamY = wallTop;            // top of columns
  B.add('carvedWood', xf(box(27.2, 0.55, 0.45, 1.6), [0, beamY + 0.27, colZ]));            // main carved lintel
  B.add('wood', xf(box(27.4, 0.18, 0.55, 1.6), [0, beamY + 0.63, colZ]));
  // hanging carved spandrels (que ti) under the lintel at each column
  for (const x of [-12.8, -8.6, -2.35, 2.35, 8.6, 12.8]) for (const s of [-1, 1]) {
    const sh = new THREE.Shape();
    sh.moveTo(0, 0); sh.lineTo(1.1, 0); sh.quadraticCurveTo(0.5, -0.2, 0.25, -0.75); sh.lineTo(0, -0.75); sh.closePath();
    const g = new THREE.ExtrudeGeometry(sh, { depth: 0.12, bevelEnabled: false, curveSegments: 6 });
    scaleUV(g, 1, 1);
    if (s < 0) xf(g, [0, 0, 0], [0, Math.PI, 0]);
    xf(g, [x + s * 0.3, beamY, colZ - (s < 0 ? -0.06 : 0.06)]);
    B.add('carvedWood', g);
  }
  const lowerRoof = { hw: 15.6, hd: 8.1, cz: -2.4, eaveY: 8.75, ridgeY: 13.2, vMax: 0.5 };
  // brackets along the front and down the sides
  const bracketXforms = [];
  const brY = beamY + 0.72;
  for (let x = -12.8; x <= 12.81; x += 1.0) bracketXforms.push({ p: [x, brY, colZ], ry: 0, s: 0.85 });
  for (const sx of [-1, 1]) for (let z = colZ - 1.2; z >= -6.8; z -= 1.1) bracketXforms.push({ p: [sx * 13.0, brY, z], ry: sx * Math.PI / 2, s: 0.85 });
  // eave purlins
  B.add('wood', xf(box(28.4, 0.24, 0.3, 1.6), [0, brY + 0.75, colZ + 1.0]));
  B.add('carvedWood', xf(box(28.4, 0.3, 0.12, 1.6), [0, brY + 0.6, colZ + 1.16]));

  /* ---------- lower roof (skirt) ---------- */
  const lr = roofKit({ ...lowerRoof, upturn: 0.85, flare: 0.5, thick: 0.32, segU: quality.roofSegU, segV: quality.roofSegV, ridge: false, tileSize: 3 });
  kitAdd(B, lr.kit);
  const capInstances = [...lr.caps];

  /* ---------- upper storey ---------- */
  const innerHalfX = lerp(lowerRoof.hw, Math.max(0, lowerRoof.hw - lowerRoof.hd), lowerRoof.vMax);
  const innerHalfZ = lowerRoof.hd * (1 - lowerRoof.vMax);
  const usY0 = lerp(lowerRoof.eaveY, lowerRoof.ridgeY, Math.pow(lowerRoof.vMax, 1.7)) - 0.35;
  const usFrontZ = lowerRoof.cz + innerHalfZ;
  const usTop = usY0 + 3.0;
  B.add('wood', xf(box(innerHalfX * 2 - 0.2, usTop - usY0, innerHalfZ * 2 - 0.2, 2), [0, (usY0 + usTop) / 2, lowerRoof.cz]));
  // façade of upper storey: columns + lattice panels + rail
  const usCols = 9;
  for (let i = 0; i < usCols; i++) {
    const x = lerp(-innerHalfX + 0.4, innerHalfX - 0.4, i / (usCols - 1));
    B.add('wood', xf(cyl(0.18, 0.18, usTop - usY0, 10, 1.2), [x, (usY0 + usTop) / 2, usFrontZ + 0.05]));
    if (i < usCols - 1) {
      const x2 = lerp(-innerHalfX + 0.4, innerHalfX - 0.4, (i + 1) / (usCols - 1));
      B.add('lattice', xf(box(x2 - x - 0.3, 1.7, 0.08, 1.6), [(x + x2) / 2, usY0 + 1.5, usFrontZ - 0.06]));
    }
  }
  B.add('carvedWood', xf(box(innerHalfX * 2, 0.45, 0.4, 1.4), [0, usTop - 0.1, usFrontZ + 0.1]));
  B.add('carvedWood', xf(box(innerHalfX * 2, 0.4, 0.3, 1.4), [0, usY0 + 0.45, usFrontZ + 0.1]));
  // sides of upper storey
  for (const sx of [-1, 1]) B.add('lattice', xf(box(0.08, 1.7, innerHalfZ * 2 - 1.2, 1.6), [sx * (innerHalfX - 0.06), usY0 + 1.5, lowerRoof.cz]));
  // upper brackets
  const ubY = usTop + 0.12;
  for (let x = -innerHalfX + 0.4; x <= innerHalfX - 0.39; x += 0.95) bracketXforms.push({ p: [x, ubY, usFrontZ + 0.1], ry: 0, s: 0.75 });
  for (const sx of [-1, 1]) for (let z = usFrontZ - 1.0; z >= lowerRoof.cz - innerHalfZ + 0.5; z -= 1.0) bracketXforms.push({ p: [sx * (innerHalfX - 0.1), ubY, z], ry: sx * Math.PI / 2, s: 0.75 });
  B.add('wood', xf(box(innerHalfX * 2 + 1.4, 0.22, 0.28, 1.6), [0, ubY + 0.66, usFrontZ + 0.95]));
  // vertical name board hanging between the roofs
  B.add('plaque', scaleUV(xf(box(1, 1, 0.12, 1), [0, usY0 + 1.6, usFrontZ + 0.55], [0, 0, 0], [1.1, 2.0, 1]), 1, 1));
  B.add('bronze', xf(box(1.35, 2.3, 0.08), [0, usY0 + 1.6, usFrontZ + 0.47]));
  for (const sx of [-1, 1]) B.add('carvedWood', xf(sphere(0.22, 8, 6), [sx * 0.7, usY0 + 2.7, usFrontZ + 0.55], [0, 0, 0], [1, 1, 0.5]));

  /* ---------- upper roof (full hip) ---------- */
  const upperRoof = { hw: innerHalfX + 2.6, hd: innerHalfZ + 2.5, cz: lowerRoof.cz, eaveY: usTop + 0.85, ridgeY: usTop + 4.6 };
  const ur = roofKit({ ...upperRoof, upturn: 0.95, flare: 0.55, thick: 0.34, segU: quality.roofSegU, segV: quality.roofSegV, tileSize: 3 });
  kitAdd(B, ur.kit);
  capInstances.push(...ur.caps);
  // flaming pearl on the ridge centre
  {
    const ry = upperRoof.ridgeY + 0.75;
    B.add('carved', xf(cyl(0.4, 0.55, 0.35, 12), [0, ry - 0.2, upperRoof.cz]));
    B.add('bronze', xf(sphere(0.38, 12, 10), [0, ry + 0.3, upperRoof.cz]));
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      B.add('bronze', xf(alignY(cone(0.09, 0.55, 5), new THREE.Vector3(Math.cos(a) * 0.5, 1, 0)), [Math.cos(a) * 0.32, ry + 0.45 + Math.abs(Math.sin(a)) * 0.15, upperRoof.cz]));
    }
  }
  // wind bells hanging from the upturned corners
  const bellRp = [];
  for (const [r, f, u] of [[lr, 'F', 1], [lr, 'F', -1], [ur, 'F', 1], [ur, 'F', -1], [lr, 'B', 1], [lr, 'B', -1], [ur, 'B', 1], [ur, 'B', -1]]) bellRp.push(r.rp(f, u, 0.02, -0.4));
  for (const p of bellRp) {
    B.add('bronze', xf(cyl(0.015, 0.015, 0.5, 4), [p[0], p[1] - 0.05, p[2]]));
    B.add('bronze', xf(cyl(0.06, 0.14, 0.28, 8), [p[0], p[1] - 0.42, p[2]]));
    B.add('bronze', xf(box(0.12, 0.18, 0.01), [p[0], p[1] - 0.68, p[2]]));
  }

  /* ---------- courtyard props ---------- */
  // Great guardian lions at the foot of the stairs
  for (const sx of [-1, 1]) {
    const lk = lionKit(sx);
    kitXf(lk, [sx * 5.0, 0, 6.6], [0, -sx * 0.15, 0], [1.25, 1.25, 1.25]);
    kitAdd(B, lk);
    solid([sx * 5.0, 1.4, 6.6], [1.7, 2.8, 2.2]);
  }
  // Smaller lions on the platform, by the dragon columns
  for (const sx of [-1, 1]) {
    const lk = lionKit(-sx);
    kitXf(lk, [sx * 7.3, PT, 2.7], [0, 0, 0], [0.75, 0.75, 0.75]);
    kitAdd(B, lk);
    solid([sx * 7.3, PT + 0.9, 2.7], [1.0, 1.8, 1.3]);
  }
  // Stone lanterns lining the path
  // (Test copy: a row beside the stairs, in front of the platform, instead
  // of down a 20 m path.)
  const lanternPos = [];
  for (const x of [7.0, 12.0]) for (const sx of [-1, 1]) lanternPos.push([sx * x, 5.0]);
  for (const [x, z] of lanternPos) {
    const lk = lanternKit();
    kitXf(lk, [x, 0, z]);
    kitAdd(B, lk);
    solid([x, 1.4, z], [0.7, 2.8, 0.7]);
  }
  // Huabiao pillars (test copy: pulled in to flank the front, from z 15.5)
  const HUABIAO = [[-14.5, 7.0], [14.5, 7.0]];
  for (const [x, z] of HUABIAO) {
    const hk = huabiaoKit(quality);
    kitXf(hk, [x, 0, z], [0, Math.sign(x) * 0.4, 0]);
    kitAdd(B, hk);
    pillar([x, 3.2, z], 1.0, 6.4);
  }
  // Incense cauldrons — test copy: two, either side of the stairs, in place
  // of the one that stood in the middle of the path (Luke, 2026-10-06:
  // "Move the brazier into two, split left and right").
  const CAULDRONS = [[-9.5, 8.0], [9.5, 8.0]];
  for (const [x, z] of CAULDRONS) {
    const ck = cauldronKit();
    kitXf(ck, [x, 0, z]);
    kitAdd(B, ck);
    pillar([x, 1.6, z], 1.25, 3.2);
    pillar([x, 0.25, z], 2.2, 0.5);
  }

  /* ---------- paifang gateway (test copy: removed) ---------- */
  if (false) {
    const gz = L.gateZ;
    const posts = [[-2.3, 5.2], [2.3, 5.2], [-5.8, 4.1], [5.8, 4.1]];
    for (const [x, h] of posts) {
      B.add('stone', xf(box(0.55, h, 0.55, 1.6), [x, h / 2, gz]));
      B.add('carved', xf(box(0.75, 0.9, 0.75, 1), [x, 0.45, gz]));
      // drum-shaped clamping stones
      for (const sz of [-1, 1]) {
        B.add('carved', xf(cyl(0.45, 0.45, 0.25, 16, 1), [x, 0.95, gz + sz * 0.55], [0, 0, Math.PI / 2]));
        B.add('stone', xf(box(0.4, 0.6, 0.6), [x, 0.3, gz + sz * 0.55]));
      }
      solid([x, h / 2, gz], [0.8, h, 2.2]);
    }
    // centre bay: lintels, plaque, brackets, roof
    B.add('carved', xf(box(5.2, 0.45, 0.5, 1.2), [0, 4.05, gz]));
    B.add('plaque', scaleUV(xf(box(1, 1, 0.1, 1), [0, 4.62, gz + 0.12], [0, 0, 0], [2.2, 0.65, 1]), 1, 1));
    B.add('plaque', scaleUV(xf(box(1, 1, 0.1, 1), [0, 4.62, gz - 0.12], [0, Math.PI, 0], [2.2, 0.65, 1]), 1, 1));
    B.add('carved', xf(box(5.2, 0.4, 0.5, 1.2), [0, 5.2, gz]));
    for (const sx of [-1, 1]) B.add('stone', xf(box(0.3, 0.75, 0.4), [sx * 1.25, 4.62, gz]));
    for (let x = -2.1; x <= 2.11; x += 0.7) bracketXforms.push({ p: [x, 5.4, gz], ry: 0, s: 0.45 }, { p: [x, 5.4, gz], ry: Math.PI, s: 0.45 });
    const cr = roofKit({ hw: 3.4, hd: 1.25, cz: gz, eaveY: 5.85, ridgeY: 6.95, curve: 1.5, upturn: 0.45, flare: 0.25, thick: 0.18, segU: 16, segV: 6, tileSize: 2, capStep: 0.35 });
    kitAdd(B, cr.kit); capInstances.push(...cr.caps);
    // side bays
    for (const sx of [-1, 1]) {
      const cx = sx * 4.05;
      B.add('carved', xf(box(3.5, 0.4, 0.45, 1.2), [cx, 3.2, gz]));
      B.add('lattice', xf(box(3.0, 0.45, 0.08, 1), [cx, 3.65, gz]));
      B.add('carved', xf(box(3.5, 0.35, 0.45, 1.2), [cx, 4.05, gz]));
      for (let x = -1.3; x <= 1.31; x += 0.65) bracketXforms.push({ p: [cx + x, 4.2, gz], ry: 0, s: 0.4 }, { p: [cx + x, 4.2, gz], ry: Math.PI, s: 0.4 });
      const sr = roofKit({ hw: 2.2, hd: 1.05, cx, cz: gz, eaveY: 4.6, ridgeY: 5.5, curve: 1.5, upturn: 0.35, flare: 0.2, thick: 0.15, segU: 12, segV: 5, tileSize: 2, capStep: 0.35 });
      kitAdd(B, sr.kit); capInstances.push(...sr.caps);
    }
  }

  /* ---------- build merged static meshes ---------- */
  const staticGroup = new THREE.Group();
  staticGroup.name = 'TempleStatic';
  root.add(staticGroup);
  B.build(M, staticGroup, quality.shadows);
  const _t2 = performance.now();

  /* ---------- instanced: bracket sets ---------- */
  {
    const g = bracketGeometry(1);
    const im = new THREE.InstancedMesh(g, M.wood, bracketXforms.length);
    const mat = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    bracketXforms.forEach((b, i) => {
      q.setFromEuler(new THREE.Euler(0, b.ry, 0));
      mat.compose(new THREE.Vector3(...b.p), q, s.set(b.s, b.s, b.s));
      im.setMatrixAt(i, mat);
    });
    im.castShadow = quality.shadows; im.receiveShadow = quality.shadows;
    im.computeBoundingSphere();
    im.name = 'temple_brackets';
    staticGroup.add(im);
  }
  /* ---------- instanced: roof tile end caps ---------- */
  {
    const g = new THREE.CylinderGeometry(0.085, 0.085, 0.07, 8);
    g.rotateX(Math.PI / 2);
    const im = new THREE.InstancedMesh(g, M.tilecap, capInstances.length);
    const mat = new THREE.Matrix4(), q = new THREE.Quaternion();
    capInstances.forEach((c, i) => {
      q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), c.n);
      mat.compose(c.p, q, new THREE.Vector3(1, 1, 1));
      im.setMatrixAt(i, mat);
    });
    im.computeBoundingSphere();
    im.name = 'temple_tilecaps';
    staticGroup.add(im);
  }
  /* ---------- instanced: grass & fern clumps ---------- */
  {
    const quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    const quad2 = quad.clone().rotateY(Math.PI / 2);
    const g = mergeGeometries([quad, quad2]);
    const spots = [];
    const near = (x, z, r, n) => { for (let i = 0; i < n; i++) { const a = rnd() * Math.PI * 2, d = rnd() * r; spots.push([x + Math.cos(a) * d, 0, z + Math.sin(a) * d]); } };
    // along the platform base, stair cheeks, lion pedestals, lanterns, walls
    for (let i = 0; i < quality.grass * 0.35; i++) spots.push([lerp(-14, 14, rnd()), 0, pz1 + 0.15 + rnd() * 0.5]);
    for (const sx of [-1, 1]) { near(sx * 5.0, 6.6, 1.5, 6); near(sx * 3.9, 6.3, 0.6, 4); }
    for (const [x, z] of HUABIAO) near(x, z, 1.4, 5);
    for (const [x, z] of lanternPos) near(x, z, 0.6, 2);
    // (test copy: the clumps along the removed side walls are gone)
    // grass on the platform edge near the columns (as in the reference)
    for (const sx of [-1, 1]) { for (let i = 0; i < 5; i++) spots.push([sx * (4.2 + rnd() * 2.2), PT, 3.0 + rnd() * 0.8]); }
    const im = new THREE.InstancedMesh(g, M.grass, spots.length);
    const mat = new THREE.Matrix4(), q = new THREE.Quaternion();
    spots.forEach((p, i) => {
      const s = 0.35 + rnd() * 0.5;
      q.setFromEuler(new THREE.Euler(0, rnd() * Math.PI, 0));
      mat.compose(new THREE.Vector3(...p), q, new THREE.Vector3(s * 1.2, s, s * 1.2));
      im.setMatrixAt(i, mat);
    });
    im.computeBoundingSphere();
    im.name = 'temple_grass';
    staticGroup.add(im);
  }

  /* ---------- smoke from the cauldron ---------- */
  const smoke = [];
  const smokeGroup = new THREE.Group();
  smokeGroup.name = 'TempleSmoke';
  root.add(smokeGroup);
  // Test copy: one plume per cauldron, the sprites split between them.
  for (let i = 0; i < quality.smoke; i++) {
    const sp = new THREE.Sprite(M.smoke.clone());
    sp.userData.t = i / quality.smoke;
    sp.userData.at = CAULDRONS[i % CAULDRONS.length];
    sp.userData.seed = rnd() * 10;
    smokeGroup.add(sp); smoke.push(sp);
  }

  /* ---------- optional warm lights ---------- */
  const lights = [];
  if (opts.lights !== false) {
    const doorLight = new THREE.PointLight(0xffa860, 6, 9, 1.6);
    doorLight.position.set(0, PT + 2.4, dz + 1.6);
    root.add(doorLight); lights.push(doorLight);
    const cauldronLight = new THREE.PointLight(0xff9040, 5, 9, 1.6);
    cauldronLight.position.set(0, 2.6, 12.8);
    root.add(cauldronLight); lights.push(cauldronLight);
  }

  /* ---------- runtime API ---------- */
  let time = 0;
  const glowBase = M.glow.color.clone();
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const listeners = { opened: [], closed: [] };

  const api = {
    root,
    colliders,
    /** Box blocking the doorway while the doors are shut (remove it once they open). */
    doorCollider,
    layout: TEMPLE_LAYOUT,
    doors,
    materials: M,
    /** Start opening the doors (inwards). */
    openDoors() { doors.target = 1; },
    /** Start closing the doors. */
    closeDoors() { doors.target = 0; },
    /** Snap doors to open/closed without animation. */
    setDoorsOpen(open) { doors.target = doors.progress = open ? 1 : 0; applyDoors(); },
    get doorsOpen() { return doors.progress >= 1; },
    get doorsClosed() { return doors.progress <= 0; },
    get doorsMoving() { return doors.progress !== doors.target; },
    on(evt, fn) { listeners[evt]?.push(fn); return () => { listeners[evt] = listeners[evt].filter((f) => f !== fn); }; },
    /** Height of the walkable floor at (x, z) in temple-local space (useful without physics). */
    floorHeightAt(x, z) {
      const stairEnd = pz1 + steps * run;
      if (Math.abs(x) <= pw / 2 && z >= pz0 && z <= pz1) return PT;
      if (Math.abs(x) <= sw / 2 + 0.4 && z > pz1 && z <= stairEnd) return PT * (1 - (z - pz1) / (stairEnd - pz1));
      return 0;
    },
    /** Advance animations. Call every frame with delta seconds. */
    update(dt) {
      dt = Math.min(dt, 0.1);
      time += dt;
      if (doors.progress !== doors.target) {
        const dir = Math.sign(doors.target - doors.progress);
        doors.progress = THREE.MathUtils.clamp(doors.progress + dir * dt / doors.duration, 0, 1);
        applyDoors();
        if (doors.progress === doors.target) (doors.target === 1 ? listeners.opened : listeners.closed).forEach((f) => f());
      }
      // lantern flicker
      const f = 0.9 + 0.06 * Math.sin(time * 7.3) + 0.04 * Math.sin(time * 13.1 + 1.7);
      M.glow.color.copy(glowBase).multiplyScalar(f);
      if (lights[1]) lights[1].intensity = 5 * f;
      // smoke drift
      for (const sp of smoke) {
        const t = (sp.userData.t + time * 0.06) % 1;
        const sd = sp.userData.seed;
        const [cx, cz] = sp.userData.at;
        sp.position.set(cx + Math.sin(t * 6 + sd) * 0.3 * t + t * 0.6, 2.2 + t * 5.5, cz + Math.cos(t * 5 + sd) * 0.3 * t);
        const s = 0.5 + t * 2.4;
        sp.scale.set(s, s, s);
        sp.material.opacity = Math.sin(t * Math.PI) * 0.35;
      }
    },
    /** Free GPU resources. */
    dispose() {
      root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      for (const k in M) { const m = M[k]; for (const p of ['map', 'bumpMap']) m[p]?.dispose(); m.dispose(); }
      smoke.forEach((s) => s.material.dispose());
    },
    stats() {
      let tris = 0, draws = 0;
      root.traverse((o) => {
        if (!o.isMesh || o.isSprite) return;
        draws++;
        const g = o.geometry, n = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
        tris += n * (o.isInstancedMesh ? o.count : 1);
      });
      return { triangles: Math.round(tris), drawCalls: draws };
    },
  };
  function applyDoors() {
    const a = doors.maxAngle * ease(doors.progress);
    doors.left.rotation.y = a;
    doors.right.rotation.y = -a;
  }
  applyDoors();
  api.timings = { textures: _t1 - _t0, geometry: _t2 - _t1 }; // test copy
  return api;
}
