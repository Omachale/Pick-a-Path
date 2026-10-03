/**
 * The Lava Cavern's islands and bridges: obsidian islands with a riveted iron
 * deck, joined by forged-iron chain bridges.
 *
 * How this was chosen: the cavern first borrowed Sky Path's grassy island
 * and rope bridges, which would burn in a lava cave. Luke asked for a few
 * volcano-viable styles to switch between (2026-10-03); three were built
 * (basalt columns, iron chain, natural rock arch) and he chose iron, then
 * asked for the others to be removed. See TODO.md, "Lava Cavern: volcanic
 * island and bridge styles", for what the others were and why they lost.
 *
 * Iron because it is the rope bridge's fireproof twin: it keeps the sag and
 * the walk-on-planks feel. The look then went through two rounds of Luke
 * asking for less uniformity: first surface (rust, tread, scratches, plate
 * stock), then SHAPE: "Some rivets missing, a panel here and there displaced
 * or missing ... handholds missing or displaced, planks imperfect, broken,
 * displaced." So the damage here is real geometry where it can be: snapped
 * chains with dangling ends, torn-loose hangers, broken and warped plates,
 * and deck panels lifted out of their holes.
 *
 * House style is unlit (MeshBasicMaterial) with shading painted in: vertex
 * colours from a fixed fake key light, plus an orange glow on anything facing
 * down (the lava below is the main light in a lava cave). Deck textures are
 * drawn on a canvas at runtime and are the finished art, not placeholders:
 * Luke, 2026-10-03, "I don't think we need art assets for this".
 *
 * Cost: every island is two or three meshes and every bridge is one merged
 * mesh with a shared material. Both are cached: three island variants and
 * six bridge variants per route side, placed with transforms, since every gap
 * in the cavern is the same length. A full rebuild is a few hundred ms the
 * first time and near-instant after.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Must stay >= the cavern's ISLAND_RADIUS (4): BRIDGE_ANCHORS puts each bridge
 * end 3.56 from the island centre, and the walker stands on the deck there.
 */
const DECK_RADIUS = 4.25;
const DISC_RADIUS = DECK_RADIUS * 1.005; // the textured deck disc, a hair wider than the rock rim
const DECK_Y = 0.03;
const ISLAND_VARIANTS = 3;
const BRIDGE_VARIANTS = 6;
/**
 * Where along a bridge a fall happens and its plates give way: the deck's low
 * point, as in Sky Path (BRIDGE_WRONG_GAP_T there). The cavern stops a
 * falling walker at exactly this fraction.
 */
export const IRON_BREAK_T = 0.5;

// ---------------------------------------------------------------- helpers

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Hash of a POSITION to [-1, 1]. Keyed on position rather than vertex index,
 * so two vertices at the same spot always agree, which is what keeps a
 * LatheGeometry's duplicated seam closed after roughening.
 */
function hashPos(x, y, z, salt) {
  let h = Math.imul(Math.round(x * 512), 0x27d4eb2d) ^ Math.imul(Math.round(y * 512), 0x165667b1) ^ Math.imul(Math.round(z * 512), 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

/**
 * Smooth 3D value noise in [-1, 1], built on the same position hash. Gives
 * coherent lumps and patches; independent per-vertex jitter read as big flat
 * facets at low density and would read as static at high density.
 */
function vnoise(x, y, z, salt) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fy = y - yi;
  const fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const sz = fz * fz * (3 - 2 * fz);
  // Written out rather than through a helper closure: this runs a few hundred
  // thousand times per cold build, and the closure version made a full
  // cavern build take ~3 s.
  const a000 = hashPos(xi, yi, zi, salt);
  const a100 = hashPos(xi + 1, yi, zi, salt);
  const a010 = hashPos(xi, yi + 1, zi, salt);
  const a110 = hashPos(xi + 1, yi + 1, zi, salt);
  const a001 = hashPos(xi, yi, zi + 1, salt);
  const a101 = hashPos(xi + 1, yi, zi + 1, salt);
  const a011 = hashPos(xi, yi + 1, zi + 1, salt);
  const a111 = hashPos(xi + 1, yi + 1, zi + 1, salt);
  const x00 = a000 + (a100 - a000) * sx;
  const x10 = a010 + (a110 - a010) * sx;
  const x01 = a001 + (a101 - a001) * sx;
  const x11 = a011 + (a111 - a011) * sx;
  const y0 = x00 + (x10 - x00) * sy;
  const y1 = x01 + (x11 - x01) * sy;
  return y0 + (y1 - y0) * sz;
}

/** Octaves of vnoise, normalised back to roughly [-1, 1]: big lumps first, grain last. */
function fbm(x, y, z, salt, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * vnoise(x * f, y * f, z * f, salt + o * 31);
    norm += amp;
    amp *= 0.5;
    f *= 2.07;
  }
  return sum / norm;
}

function pickWeighted(rand, list) {
  let r = rand() * list.reduce((s, e) => s + e.weight, 0);
  for (const e of list) if ((r -= e.weight) <= 0) return e;
  return list[list.length - 1];
}

/** `count` distinct indices from [0, n). */
function pickDistinct(rand, n, count) {
  const pool = [...Array(n).keys()];
  const out = [];
  while (out.length < count && pool.length) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return out;
}

// Colours are built through THREE.Color, so hex values are sRGB as written and
// the maths below happens in linear space, matching how three treats vertex
// colours on output.
const LIGHT = new THREE.Vector3(0.45, 0.8, 0.35).normalize();
const GLOW = new THREE.Color(0xff5a14);
const _c = new THREE.Color();

/** Returns a shade(p, n, out) function: fake key light for form, plus lava glow on anything facing down. */
function shader({ base, sheen = null, sheenPower = 10, ambient = 0.32, underGlow = 0.45 }) {
  const baseC = new THREE.Color(base);
  const sheenC = sheen === null ? null : new THREE.Color(sheen);
  return (p, n, out) => {
    const lambert = Math.max(0, n.dot(LIGHT));
    out.copy(baseC).multiplyScalar(ambient + (1 - ambient) * lambert);
    if (sheenC) out.add(_c.copy(sheenC).multiplyScalar(Math.pow(lambert, sheenPower)));
    out.add(_c.copy(GLOW).multiplyScalar(Math.max(0, -n.y) * underGlow));
    return out;
  };
}

/**
 * Writes a `color` attribute from shade(p, n, out, vertexIndex) and strips
 * normal/uv so everything painted merges with everything else. Uses the
 * geometry's own normals if it has them (box and torus parts do, kept right
 * through applyMatrix4), otherwise derives them from the winding: on
 * non-indexed geometry that is the face normal, which gives rock its facets.
 */
function paint(geo, shade) {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nor, i);
    shade(p, n, c, i);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  return geo;
}

/** A box between two points (a beam, a strap, a rod), `up` fixing its roll. */
function beam(a, b, width, height, up = new THREE.Vector3(0, 1, 0)) {
  const len = a.distanceTo(b);
  const geo = boxGeo(len, height, width);
  const x = b.clone().sub(a).normalize();
  const z = new THREE.Vector3().crossVectors(x, up).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  const m = new THREE.Matrix4().makeBasis(x, y, z).setPosition(a.clone().add(b).multiplyScalar(0.5));
  geo.applyMatrix4(m);
  return geo;
}

/**
 * A box, cloned from a cached unit box (per segment layout) and scaled.
 * A bridge has ~700 small parts, and constructing each as a fresh
 * BoxGeometry was ~55 ms of every bridge build; cloning a plain
 * BufferGeometry is a few array copies.
 */
const unitBoxes = new Map();
function boxGeo(w, h, d, ws = 1, hs = 1, ds = 1) {
  const key = `${ws},${hs},${ds}`;
  if (!unitBoxes.has(key)) {
    const box = new THREE.BoxGeometry(1, 1, 1, ws, hs, ds);
    unitBoxes.set(key, new THREE.BufferGeometry().copy(box));
    box.dispose();
  }
  return unitBoxes.get(key).clone().scale(w, h, d);
}

/** Same catenary as bridgeGen.js: 0 at both anchors, exactly -sag at midspan. */
function catenaryY(u, sag, k) {
  const ck = Math.cosh(k);
  return -sag * ((ck - Math.cosh(k * u)) / (ck - 1));
}

// ---------------------------------------------------------------- iron

/**
 * Plate stock: most plain iron, some rusted through, some newer replacements
 * still dark, some heat-blued.
 */
const IRON_PLATES = [
  { weight: 0.6, base: 0x34363a, sheen: 0x4c3a2e, rust: -0.05 },
  { weight: 0.17, base: 0x47342a, sheen: 0x6a4026, rust: 0.3 },
  { weight: 0.13, base: 0x242528, sheen: 0x3a3a40, rust: -0.3 },
  { weight: 0.1, base: 0x2c3242, sheen: 0x46506e, rust: -0.15 },
];
const RUST = 0x5e3520;

/**
 * Iron with weathering: rust blooms where coherent noise says so, so it gathers
 * in patches rather than speckle, and `rustBias` pushes a part toward more of
 * it. A fine grain on top means no face is ever one flat colour.
 */
function ironShader(base, sheen, salt, { rustBias = 0, rustScale = 2.2, underGlow = 0.65 } = {}) {
  const metal = shader({ base, sheen, sheenPower: 8, ambient: 0.42, underGlow });
  const rust = shader({ base: RUST, ambient: 0.45, underGlow: 0.6 });
  const tmp = new THREE.Color();
  return (p, n, out) => {
    metal(p, n, out);
    const r = fbm(p.x * rustScale, p.y * rustScale, p.z * rustScale, salt, 2) + rustBias;
    const amt = THREE.MathUtils.smoothstep(r, 0.05, 0.45) * 0.85;
    if (amt > 0) out.lerp(rust(p, n, tmp), amt);
    out.multiplyScalar(0.88 + 0.12 * (hashPos(p.x * 8, p.y * 8, p.z * 8, salt + 5) + 1));
    return out;
  };
}

// ---------------------------------------------------------------- materials and caches

let solidMat = null;
let plateEdgeMat = null;
const deckMats = new Map(); // variant -> { deck, loose } materials (loose = intact art, for lifted plates)
const islandCache = new Map(); // variant -> [{ geometry, material }]
const bridgeCache = new Map(); // see buildIronBridge

function getSolidMat() {
  solidMat ??= new THREE.MeshBasicMaterial({ vertexColors: true });
  return solidMat;
}

function canvasTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Speckle, so a flat fill doesn't read as plastic. */
function grain(ctx, S, rand, count, light, dark) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = rand() < 0.5 ? light : dark;
    ctx.fillRect(rand() * S, rand() * S, 1 + rand() * 2, 1 + rand() * 2);
  }
}

/**
 * Fine speckle over the whole canvas, as a repeating 256px noise tile made
 * once and laid down as a pattern. Two slower versions came first: tens of
 * thousands of grain() rects, then a per-pixel pass over getImageData, which
 * cost ~270 ms per deck (the readback alone was ~100 ms) and was most of a
 * cold cavern build.
 */
let noiseTile = null;
function grainPass(ctx, S, rand, alpha) {
  if (!noiseTile) {
    noiseTile = document.createElement('canvas');
    noiseTile.width = noiseTile.height = 256;
    const tctx = noiseTile.getContext('2d');
    const img = tctx.createImageData(256, 256);
    const r = mulberry32(4242);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = r() < 0.5 ? 255 : 0;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = Math.floor(r() * 255);
    }
    tctx.putImageData(img, 0, 0);
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = ctx.createPattern(noiseTile, 'repeat');
  // Offset per deck, so the tile doesn't line up identically on every island.
  ctx.translate(Math.floor(rand() * 256), Math.floor(rand() * 256));
  ctx.fillRect(-256, -256, S + 256, S + 256);
  ctx.restore();
}

// ---------------------------------------------------------------- deck

/**
 * The deck's plate layout, shared by the texture painter and the loose-plate
 * geometry so a lifted plate is cut from exactly where it was painted. A
 * central boss, eight smooth plates, sixteen outer plates with tread, and a
 * rim band. Angles are canvas angles, which map straight onto the island's
 * local x/z (see loosePlate()).
 */
const DECK_RINGS = [
  { f0: 0, f1: 0.2, n: 1 },
  { f0: 0.2, f1: 0.62, n: 8 },
  { f0: 0.62, f1: 0.92, n: 16 },
];
const DECK_PLATES = DECK_RINGS.flatMap((ring) => {
  const off = ring.n === 1 ? 0 : (Math.PI * 2) / ring.n / 2;
  return Array.from({ length: ring.n }, (_, i) => ({
    ...ring,
    a0: off + (i / ring.n) * Math.PI * 2,
    a1: off + ((i + 1) / ring.n) * Math.PI * 2,
  }));
});
/** Indices of plates that may go missing or work loose: not the central boss. */
const LOOSE_CANDIDATES = DECK_PLATES.map((p, i) => i).filter((i) => DECK_PLATES[i].n > 1);

/**
 * Paints the deck. Returns two canvases: `intact`, the plates all present
 * (what a lifted plate shows on its top face), and `deck`, the same with the
 * damaged plates' sockets cut out as dark holes onto the joists and the
 * ember-lit rock beneath.
 */
function paintIronDeck(S, seed, damage) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  const rand = mulberry32(seed);
  const c = S / 2;
  const R = S / 2;
  const px = S / 1024; // everything below was sized at 1024
  const blob = (x, y, r, inner, outer = 'rgba(0,0,0,0)') => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, inner);
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };
  const polar = (a, f) => [c + Math.cos(a) * R * f, c + Math.sin(a) * R * f];
  const sectorPath = (a0, a1, f0, f1) => {
    ctx.beginPath();
    ctx.arc(c, c, R * f1, a0, a1);
    if (f0 > 0) ctx.arc(c, c, R * f0, a1, a0, true);
    else ctx.lineTo(c, c);
    ctx.closePath();
  };

  // Base iron, mottled at a large scale.
  ctx.fillStyle = '#383634';
  ctx.fillRect(0, 0, S, S);
  const mottles = ['rgba(72,66,60,0.35)', 'rgba(24,23,23,0.4)', 'rgba(50,56,68,0.22)', 'rgba(92,56,32,0.22)'];
  for (let i = 0; i < 46; i++) blob(rand() * S, rand() * S, (60 + rand() * 200) * px, mottles[Math.floor(rand() * mottles.length)]);

  // Plates: each its own tone; the outer ring gets raised tread lozenges.
  for (const plate of DECK_PLATES) {
    const { a0, a1, f0, f1, n } = plate;
    ctx.save();
    sectorPath(a0, a1, f0, f1);
    ctx.clip();
    ctx.fillStyle = rand() < 0.5 ? `rgba(255,245,235,${0.02 + rand() * 0.07})` : `rgba(0,0,0,${0.04 + rand() * 0.16})`;
    ctx.fillRect(0, 0, S, S);
    if (rand() < 0.22) {
      ctx.fillStyle = `rgba(110,60,30,${0.12 + rand() * 0.14})`; // a rustier plate
      ctx.fillRect(0, 0, S, S);
    }
    if (n === 16) {
      // Diamond tread: short raised bars in alternating directions on a grid
      // aligned to the plate, each with a light top edge and dark bottom; worn
      // flat in places.
      const mid = (a0 + a1) / 2;
      ctx.translate(c, c);
      ctx.rotate(mid);
      const step = 22 * px;
      const wornSalt = Math.floor(rand() * 1000);
      for (let rr = R * f0; rr < R * f1; rr += step) {
        for (let tt = -R; tt < R; tt += step) {
          const worn = fbm(rr / 60, tt / 60, 0, wornSalt, 2);
          if (worn > 0.3) continue;
          const k = (Math.round(rr / step) + Math.round(tt / step)) % 2 === 0 ? 1 : -1;
          ctx.save();
          ctx.translate(rr, tt);
          ctx.rotate((k * Math.PI) / 4);
          ctx.fillStyle = 'rgba(0,0,0,0.28)';
          ctx.fillRect(-7 * px, 0, 14 * px, 3 * px);
          ctx.fillStyle = `rgba(215,205,195,${worn > 0.1 ? 0.08 : 0.16})`;
          ctx.fillRect(-7 * px, -1.5 * px, 14 * px, 2.5 * px);
          ctx.restore();
        }
      }
    } else {
      // Smooth plates show long faint brushing marks.
      ctx.strokeStyle = 'rgba(230,220,210,0.035)';
      ctx.lineWidth = 1 * px;
      for (let k = 0; k < 40; k++) {
        const rr = R * (f0 + rand() * (f1 - f0));
        const a = a0 + rand() * (a1 - a0);
        ctx.beginPath();
        ctx.arc(c, c, rr, a, a + 0.05 + rand() * 0.25);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Heat bluing: a few soft straw -> purple -> blue temper rings.
  for (let i = 0; i < 3; i++) {
    const [x, y] = polar(rand() * Math.PI * 2, rand() * 0.8);
    const r = (50 + rand() * 90) * px;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(160,130,70,0.14)');
    g.addColorStop(0.45, 'rgba(110,60,120,0.12)');
    g.addColorStop(0.8, 'rgba(50,80,150,0.12)');
    g.addColorStop(1, 'rgba(50,80,150,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Dents: a shadow with a highlight offset toward the light.
  for (let i = 0; i < 18; i++) {
    const [x, y] = polar(rand() * Math.PI * 2, Math.sqrt(rand()) * 0.9);
    const r = (10 + rand() * 30) * px;
    blob(x + r * 0.25, y + r * 0.25, r, 'rgba(0,0,0,0.35)');
    blob(x - r * 0.3, y - r * 0.3, r * 0.6, 'rgba(255,240,225,0.10)');
  }

  // Scuffs and scratches, densest toward the middle where everyone walks.
  for (let i = 0; i < 800; i++) {
    const [x, y] = polar(rand() * Math.PI * 2, Math.pow(rand(), 1.6) * 0.92);
    const a = rand() * Math.PI * 2;
    const len = (4 + rand() * 38) * px;
    ctx.strokeStyle = rand() < 0.75 ? `rgba(225,215,205,${0.05 + rand() * 0.12})` : `rgba(0,0,0,${0.12 + rand() * 0.15})`;
    ctx.lineWidth = (0.6 + rand() * 1.2) * px;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + Math.cos(a + 0.4) * len * 0.5, y + Math.sin(a + 0.4) * len * 0.5, x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }

  // Seams, with a weld bead along some, rust bleeding out of them, and here
  // and there a plate edge sprung proud (a bright lip with a shadow beside it).
  const seam = (draw, weld) => {
    ctx.strokeStyle = '#15110e';
    ctx.lineWidth = (4 + rand() * 3) * px;
    ctx.beginPath();
    draw();
    ctx.stroke();
    ctx.strokeStyle = weld ? 'rgba(150,135,120,0.35)' : 'rgba(255,220,190,0.08)';
    ctx.lineWidth = (weld ? 3 : 1.5) * px;
    if (weld) ctx.setLineDash([2.5 * px, 3 * px]);
    ctx.stroke();
    ctx.setLineDash([]);
  };
  for (const f of [0.2, 0.62]) {
    seam(() => ctx.arc(c, c, R * f, 0, Math.PI * 2), rand() < 0.5);
    for (let i = 0; i < 12; i++) blob(...polar(rand() * Math.PI * 2, f), (14 + rand() * 30) * px, 'rgba(120,62,24,0.3)');
  }
  for (const ring of DECK_RINGS.slice(1)) {
    for (let i = 0; i < ring.n; i++) {
      const a = (ring.n === 16 ? Math.PI / 16 : Math.PI / 8) + (i / ring.n) * Math.PI * 2;
      seam(() => {
        ctx.moveTo(...polar(a, ring.f0));
        ctx.lineTo(...polar(a, ring.f1));
      }, rand() < 0.3);
      if (rand() < 0.5) blob(...polar(a, ring.f0 + rand() * (ring.f1 - ring.f0)), (12 + rand() * 24) * px, 'rgba(120,62,24,0.28)');
      if (rand() < 0.25) {
        const s0 = ring.f0 + rand() * (ring.f1 - ring.f0) * 0.6;
        const s1 = s0 + (0.06 + rand() * 0.12);
        const side = rand() < 0.5 ? -1 : 1;
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.lineWidth = 5 * px;
        ctx.beginPath();
        ctx.moveTo(...polar(a + side * 0.012, s0));
        ctx.lineTo(...polar(a + side * 0.012, Math.min(ring.f1, s1)));
        ctx.stroke();
        ctx.strokeStyle = 'rgba(235,220,205,0.25)';
        ctx.lineWidth = 1.5 * px;
        ctx.beginPath();
        ctx.moveTo(...polar(a + side * 0.004, s0));
        ctx.lineTo(...polar(a + side * 0.004, Math.min(ring.f1, s1)));
        ctx.stroke();
      }
    }
  }

  // Soot toward the rim.
  for (let i = 0; i < 26; i++) blob(...polar(rand() * Math.PI * 2, 0.8 + rand() * 0.15), (30 + rand() * 60) * px, 'rgba(8,6,5,0.28)');

  // Rim band.
  ctx.strokeStyle = '#201d1b';
  ctx.lineWidth = R * 0.09;
  ctx.beginPath();
  ctx.arc(c, c, R * 0.955, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 30; i++) blob(...polar(rand() * Math.PI * 2, 0.955), (10 + rand() * 26) * px, 'rgba(115,58,24,0.35)');

  // Patch plates: a riveted square or two bolted over damage.
  for (let i = 0; i < 1 + Math.floor(rand() * 2); i++) {
    const [x, y] = polar(rand() * Math.PI * 2, 0.3 + rand() * 0.5);
    const w = (60 + rand() * 50) * px;
    const h = (45 + rand() * 40) * px;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rand() * Math.PI);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(-w / 2 + 3 * px, -h / 2 + 3 * px, w, h);
    ctx.fillStyle = rand() < 0.5 ? '#423e3a' : '#2e2d2c';
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = 'rgba(230,220,210,0.12)';
    ctx.lineWidth = 1.5 * px;
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      if (rand() < 0.2) continue;
      ctx.fillStyle = '#5c554f';
      ctx.beginPath();
      ctx.arc(u * (w / 2 - 7 * px), v * (h / 2 - 7 * px), 3.5 * px, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Rivets, each its own tone and a touch off its line; about one in eight
  // gone (sheared to a hole, or with a rust ring where it used to be), some
  // rusted, some standing proud.
  const rivet = (x, y) => {
    const roll = rand();
    if (roll < 0.07) {
      ctx.fillStyle = '#0c0a09';
      ctx.beginPath();
      ctx.arc(x, y, 3 * px, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    if (roll < 0.12) {
      blob(x, y, 9 * px, 'rgba(125,64,26,0.5)');
      return;
    }
    if (roll < 0.3) blob(x, y, 11 * px, 'rgba(125,64,26,0.45)');
    const proud = roll > 0.93;
    const r = (proud ? 5.2 : 4.3) * px;
    ctx.fillStyle = '#1a1714';
    ctx.beginPath();
    ctx.arc(x + (proud ? 2.2 : 1.2) * px, y + (proud ? 2.2 : 1.2) * px, r + 0.7 * px, 0, Math.PI * 2);
    ctx.fill();
    const v = 70 + Math.floor(rand() * 40);
    ctx.fillStyle = roll < 0.3 ? `rgb(${v + 30},${v - 10},${v - 35})` : `rgb(${v},${v - 6},${v - 12})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,240,220,0.3)';
    ctx.beginPath();
    ctx.arc(x - 1.2 * px, y - 1.2 * px, 1.5 * px, 0, Math.PI * 2);
    ctx.fill();
  };
  for (const [f, n] of [[0.13, 8], [0.2, 16], [0.62, 32], [0.955, 48]]) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (rand() - 0.5) * 0.02;
      rivet(...polar(a, f + (rand() - 0.5) * 0.006));
    }
  }

  grainPass(ctx, S, rand, 0.09);

  // The intact deck is done: copy it for the lifted plates' top faces, then
  // cut the damaged plates' sockets out of the deck itself.
  const intact = document.createElement('canvas');
  intact.width = intact.height = S;
  intact.getContext('2d').drawImage(canvas, 0, 0);

  for (const i of [...damage.missing, ...damage.loose.map((l) => l.plate)]) {
    const { a0, a1, f0, f1 } = DECK_PLATES[i];
    ctx.save();
    sectorPath(a0, a1, f0, f1);
    ctx.clip();
    // Down in the hole: dark, with the lava's glow coming up off the rock.
    ctx.fillStyle = '#0b0807';
    ctx.fillRect(0, 0, S, S);
    for (let k = 0; k < 6; k++) {
      blob(...polar(a0 + rand() * (a1 - a0), f0 + rand() * (f1 - f0)), (20 + rand() * 40) * px, 'rgba(255,90,20,0.16)');
    }
    grain(ctx, S, rand, 2500, 'rgba(255,120,60,0.08)', 'rgba(0,0,0,0.3)');
    // The joists the plate sat on, crossing the hole.
    const mid = (a0 + a1) / 2;
    for (const off of [-0.32, 0.32]) {
      const a = mid + off * (a1 - a0);
      ctx.strokeStyle = '#26211e';
      ctx.lineWidth = 14 * px;
      ctx.beginPath();
      ctx.moveTo(...polar(a, f0 - 0.02));
      ctx.lineTo(...polar(a, f1 + 0.02));
      ctx.stroke();
      ctx.strokeStyle = 'rgba(200,150,110,0.18)';
      ctx.lineWidth = 2 * px;
      ctx.stroke();
    }
    // Shadow just inside the cut edge, and the bright cut edge itself.
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = 16 * px;
    sectorPath(a0, a1, f0, f1);
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = 'rgba(230,215,200,0.3)';
    ctx.lineWidth = 2 * px;
    sectorPath(a0, a1, f0, f1);
    ctx.stroke();
  }

  return { deck: canvas, intact };
}

/**
 * Which plates each island variant has lost or had work loose. One or two
 * gone, one to three lifted: enough that every island looks used, not so many
 * that it looks wrecked.
 */
function deckDamage(variant) {
  const rand = mulberry32(7000 + variant * 101);
  const picks = pickDistinct(rand, LOOSE_CANDIDATES.length, 2 + Math.floor(rand() * 3)).map((k) => LOOSE_CANDIDATES[k]);
  const missingCount = 1 + Math.floor(rand() * 2);
  return {
    missing: picks.slice(0, missingCount),
    loose: picks.slice(missingCount).map((plate) => ({ plate, how: rand() < 0.5 ? 'lifted' : 'slid', r: [rand(), rand(), rand(), rand()] })),
  };
}

function getDeckMats(variant, damage) {
  if (!deckMats.has(variant)) {
    const { deck, intact } = paintIronDeck(1024, variant * 977 + 1, damage);
    deckMats.set(variant, {
      deck: new THREE.MeshBasicMaterial({ map: canvasTexture(deck) }),
      loose: new THREE.MeshBasicMaterial({ map: canvasTexture(intact) }),
    });
  }
  return deckMats.get(variant);
}

/**
 * One loose deck plate as a solid: its sector shape extruded 4 cm, top face
 * textured from the intact deck art at exactly the spot it was painted, so it
 * reads as the same plate that left the hole. Then knocked out of place:
 * 'lifted' tips it up off one radial edge like a hatch; 'slid' shoves it
 * sideways and twists it so it rides up over its neighbour.
 *
 * Coordinates: a canvas angle `a` at radius fraction `f` is UV
 * (0.5 + cos(a) f / 2, 0.5 - sin(a) f / 2) under the texture's default flipY,
 * and the shape below is laid out with y = -sin(a), so after rotateX(-90°) the
 * plate lands at island-local (cos a, sin a) on x/z, exactly where the deck
 * disc shows that plate.
 */
function loosePlate({ plate, how, r }, mats) {
  const { a0, a1, f0, f1 } = DECK_PLATES[plate];
  const steps = 10;
  const pts = [];
  for (let k = 0; k <= steps; k++) {
    const a = a0 + ((a1 - a0) * k) / steps;
    pts.push(new THREE.Vector2(Math.cos(a) * f1 * DISC_RADIUS, -Math.sin(a) * f1 * DISC_RADIUS));
  }
  for (let k = steps; k >= 0; k--) {
    const a = a0 + ((a1 - a0) * k) / steps;
    pts.push(new THREE.Vector2(Math.cos(a) * f0 * DISC_RADIUS, -Math.sin(a) * f0 * DISC_RADIUS));
  }
  // A plate that came out is a fraction smaller than its socket, which is
  // what lets the hole's edge show round it.
  const centroid = pts.reduce((s, p) => s.add(p), new THREE.Vector2()).multiplyScalar(1 / pts.length);
  for (const p of pts) p.sub(centroid).multiplyScalar(0.96).add(centroid);
  const geo = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: 0.04, bevelEnabled: false });
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, 0.5 + pos.getX(i) / (2 * DISC_RADIUS), 0.5 + pos.getY(i) / (2 * DISC_RADIUS));
  }
  geo.rotateX(-Math.PI / 2); // extrusion depth now points up, top face at y = 0.04
  geo.translate(0, DECK_Y - 0.035, 0);

  const mid = (a0 + a1) / 2;
  const radial = new THREE.Vector3(Math.cos(mid), 0, Math.sin(mid));
  const tangent = new THREE.Vector3(-Math.sin(mid), 0, Math.cos(mid));
  const m = new THREE.Matrix4();
  if (how === 'lifted') {
    // Hinged on one radial edge, the other edge raised 10-25 degrees.
    const edgeA = r[0] < 0.5 ? a0 : a1;
    const axis = new THREE.Vector3(Math.cos(edgeA), 0, Math.sin(edgeA));
    const pivot = axis.clone().multiplyScalar(((f0 + f1) / 2) * DISC_RADIUS).setY(DECK_Y);
    const angle = (0.17 + r[1] * 0.27) * (edgeA === a0 ? -1 : 1);
    m.makeTranslation(pivot.x, pivot.y, pivot.z)
      .multiply(new THREE.Matrix4().makeRotationAxis(axis, angle))
      .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
  } else {
    // Shoved along the ring and twisted, riding up onto its neighbour.
    const c = radial.clone().multiplyScalar(((f0 + f1) / 2) * DISC_RADIUS);
    const shove = tangent.clone().multiplyScalar((r[0] < 0.5 ? -1 : 1) * (0.15 + r[1] * 0.3)).addScaledVector(radial, (r[2] - 0.5) * 0.2);
    const tilt = new THREE.Matrix4().makeRotationAxis(radial, (r[0] < 0.5 ? 1 : -1) * (0.04 + r[3] * 0.06));
    m.makeTranslation(c.x + shove.x, 0.04, c.z + shove.z)
      .multiply(new THREE.Matrix4().makeRotationY((r[3] - 0.5) * 0.4))
      .multiply(tilt)
      .multiply(new THREE.Matrix4().makeTranslation(-c.x, 0, -c.z));
  }
  geo.applyMatrix4(m);
  plateEdgeMat ??= new THREE.MeshBasicMaterial({ color: 0x1e1b19 });
  return { geometry: geo, material: [mats.loose, plateEdgeMat] };
}

// ---------------------------------------------------------------- islands

/**
 * A rock lump under a flat deck, deck surface at y=0. The profile is a spline
 * through hand-placed control points, sampled finely, then displaced by noise
 * at three scales: lumps, horizontal ledges, and chips. The top ring is left
 * exactly round, at deck radius, so the deck disc fits it. Profile runs
 * bottom-to-top, the order LatheGeometry winds outward.
 */
function rockBody(seed, depth, shade, fields = null, { sides = 64, rows = 26 } = {}) {
  const ctrl = [
    [0.0, -2.1], [0.16, -1.95], [0.38, -1.7], [0.62, -1.35], [0.82, -0.95], [0.95, -0.55], [1.03, -0.18], [1.0, 0.0],
  ].map(([r, y]) => new THREE.Vector2(r * DECK_RADIUS, (y * depth) / 2.1));
  const pts = new THREE.SplineCurve(ctrl).getPoints(rows);
  pts[pts.length - 1].set(DECK_RADIUS, 0.02);
  const geo = new THREE.LatheGeometry(pts, sides);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    if (v.y > -0.02) continue;
    const k = THREE.MathUtils.clamp(-v.y / 0.5, 0, 1); // fades in, so the rim stays round
    const depthFrac = Math.min(1, -v.y / depth);
    const big = fbm(v.x * 0.32, v.y * 0.32, v.z * 0.32, seed, 3);
    const chip = fbm(v.x * 1.5, v.y * 1.5, v.z * 1.5, seed + 99, 3);
    const ledge = fbm(v.x * 0.2, v.y * 0.9, v.z * 0.2, seed + 7, 2);
    const radial = 1 + k * (0.16 * big + 0.06 * chip + 0.06 * ledge);
    v.x *= radial;
    v.z *= radial;
    v.y += k * (0.5 * big + 0.12 * chip) * (0.35 + depthFrac);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  // Colour noise is evaluated once per lathe vertex here and carried through
  // toNonIndexed() as an attribute, rather than once per face corner in the
  // shader: the flat-faceted copy has ~6 corners per vertex, and noise was
  // most of the build time.
  if (fields) {
    const f = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) fields(v.fromBufferAttribute(pos, i), f, i * 3);
    geo.setAttribute('aField', new THREE.BufferAttribute(f, 3));
  }
  const flat = geo.toNonIndexed();
  flat.deleteAttribute('normal'); // so paint() derives face normals: the facets
  const field = flat.attributes.aField;
  paint(flat, (p, n, out, i) => shade(p, n, out, field ? [field.getX(i), field.getY(i), field.getZ(i)] : null));
  if (field) flat.deleteAttribute('aField');
  return flat;
}

/**
 * The platform's edge: a riveted band round the deck and brackets bolting it
 * down into the rock, so the deck reads as plate fixed onto the island. Like
 * the deck, not intact: rivets missing, a bracket or two gone or hanging.
 */
function ironSkirt(variant) {
  const parts = [];
  const rand = mulberry32(500 + variant);
  const shade = ironShader(0x34322f, 0x5a4030, 400 + variant, { rustBias: 0.1, rustScale: 1.6 });
  const band = new THREE.CylinderGeometry(DECK_RADIUS + 0.05, DECK_RADIUS + 0.03, 0.34, 120, 2, true);
  band.translate(0, DECK_Y - 0.17, 0);
  parts.push(paint(band, shade));
  const lip = new THREE.TorusGeometry(DECK_RADIUS + 0.04, 0.035, 4, 120);
  lip.rotateX(Math.PI / 2);
  lip.translate(0, DECK_Y + 0.005, 0);
  parts.push(paint(lip, shade));
  const m = new THREE.Matrix4();
  const place = (geo, a, r, y, tilt = 0, swing = 0) => {
    m.makeRotationY(-a).multiply(new THREE.Matrix4().makeRotationZ(tilt)).multiply(new THREE.Matrix4().makeRotationX(swing));
    m.setPosition(Math.cos(a) * r, y, Math.sin(a) * r);
    return geo.applyMatrix4(m);
  };
  const N = 72;
  for (let i = 0; i < N; i++) {
    if (rand() < 0.12) continue;
    const a = (i / N) * Math.PI * 2 + (rand() - 0.5) * 0.01;
    parts.push(paint(place(new THREE.BoxGeometry(0.05, 0.06, 0.06), a, DECK_RADIUS + 0.07, -0.09 + (rand() - 0.5) * 0.015), shade));
  }
  for (let i = 0; i < 10; i++) {
    const roll = rand();
    if (roll < 0.12) continue; // gone
    const a = (i / 10) * Math.PI * 2 + (rand() - 0.5) * 0.2;
    const len = 0.5 + rand() * 0.3;
    const hanging = roll > 0.85; // bolt at the bottom sheared: swung out on its top bolt
    const geo = new THREE.BoxGeometry(0.05, len, 0.2);
    geo.translate(0, -len / 2, 0); // pivot at its top
    parts.push(paint(place(geo, a, DECK_RADIUS + 0.08, -0.25, hanging ? 0.5 + rand() * 0.4 : 0.1, hanging ? (rand() - 0.5) * 0.6 : 0), shade));
  }
  return mergeGeometries(parts).toNonIndexed();
}

function buildIslandVariant(variant) {
  const glass = shader({ base: 0x1b181f, sheen: 0x3e3652, sheenPower: 14, ambient: 0.35, underGlow: 0.6 });
  const flake = new THREE.Color(0x6a6080);
  const weathered = new THREE.Color(0x3d3a42);
  const salt = variant * 13 + 5;
  const body = rockBody(
    salt,
    5.2,
    (p, n, out, [big, streak, skin]) => {
      glass(p, n, out);
      out.multiplyScalar(0.8 + 0.4 * (big * 0.5 + 0.5));
      // Conchoidal flake faces catch the light in streaks; obsidian's look.
      const lit = Math.max(0, n.dot(LIGHT));
      if (streak > 0.25) out.lerp(flake, Math.min(1, (streak - 0.25) * 2.5) * lit * 0.35);
      // Old surfaces weather to a dull grey skin.
      if (skin > 0.2) out.lerp(weathered, Math.min(0.45, (skin - 0.2) * 1.5) * (0.4 + 0.6 * lit));
      return out;
    },
    (p, f, o) => {
      f[o] = fbm(p.x * 0.6, p.y * 0.6, p.z * 0.6, salt + 300, 3);
      f[o + 1] = fbm(p.x * 2.2, p.y * 0.5, p.z * 2.2, salt + 310, 2);
      f[o + 2] = fbm(p.x * 0.4, p.y * 0.4, p.z * 0.4, salt + 320, 2);
    }
  );

  const damage = deckDamage(variant);
  const mats = getDeckMats(variant, damage);
  const disc = new THREE.CircleGeometry(DISC_RADIUS, 64);
  disc.rotateX(-Math.PI / 2);
  disc.translate(0, DECK_Y, 0);
  return [
    { geometry: mergeGeometries([body, ironSkirt(variant)]), material: getSolidMat() },
    { geometry: disc, material: mats.deck },
    ...damage.loose.map((l) => loosePlate(l, mats)),
  ];
}

/**
 * Builds an island centred on the origin with its deck at y=0, for the caller
 * to position. Geometry and materials are cached per variant and shared, so do
 * not dispose what this returns; call disposeIronKit() when the cavern goes.
 */
export function buildIronIsland({ seed = 0 } = {}) {
  const variant = Math.abs(seed) % ISLAND_VARIANTS;
  if (!islandCache.has(variant)) islandCache.set(variant, buildIslandVariant(variant));
  const group = new THREE.Group();
  for (const { geometry, material } of islandCache.get(variant)) group.add(new THREE.Mesh(geometry, material));
  group.rotation.y = mulberry32(seed + 77)() * Math.PI * 2;
  return group;
}

// ---------------------------------------------------------------- bridges

const CHAIN = {
  halfWidth: 0.5, // deck straps either side of the centreline
  // Default sag at midspan. Was 0.8, which over a 33-unit span barely read as
  // a hanging bridge at all; Luke, 2026-10-04: "Increase the sag of the
  // bridge". The cavern passes its own (tuner) value in; this is the fallback.
  sag: 2.4,
  sagShape: 0.2,
  deckHeight: 0.14,
  railHeight: 0.85, // handrail chain above the deck
  postHeight: 1.25,
  slabPitch: 0.44,
  slabLength: 0.36,
  linkPitch: 0.3,
  hangerEvery: 1.6,
};

/**
 * How battered a bridge is. Per plate unless noted. Luke, 2026-10-03, after
 * the surface-only pass: "still too uniform. Change not just surface detail,
 * but the shape."
 */
const WEAR = {
  plateMissing: 0.05, // gone: just a bolt stub or two left on the straps
  plateBroken: 0.07, // snapped across, the loose half hanging off its strap
  plateShifted: 0.09, // slid along or across the straps, skewed
  plateLoose: 0.06, // worked loose: tipped up off one strap
  plateWarp: 0.4, // bowed and twisted, by up to warpMax
  warpMax: 0.06,
  chainBreak: 0.3, // per handrail chain: snapped somewhere, ends dangling
  hangerMissing: 0.15, // per hanger
  hangerLoose: 0.12, // per hanger: torn from its strap, swinging off the chain
  postLean: 0.2, // per post: leaning hard rather than just off true
  capMissing: 0.15, // per post
  railExtraSag: 0.14, // each handrail chain sags a different amount, up to this
};

/** Forged-iron suspension walkway: link chains for handrails, straps and plates for the deck. */
function chainBridge(from, to, { centres, seed, sag = CHAIN.sag }) {
  const a = new THREE.Vector3(from.x, 0, from.z);
  const b = new THREE.Vector3(to.x, 0, to.z);
  const span = a.distanceTo(b);
  const dir = b.clone().sub(a).normalize();
  const side = new THREE.Vector3(-dir.z, 0, dir.x);
  const P = { ...CHAIN, sag };
  const W = WEAR;
  const up = new THREE.Vector3(0, 1, 0);
  const deckY = (t) => P.deckHeight + catenaryY(2 * t - 1, P.sag, P.sagShape);
  const at = (t, lat, lift) => a.clone().lerp(b, t).addScaledVector(side, lat).setY(deckY(t) + lift);
  const nearIsland = (p, r) => centres.some((c) => Math.hypot(p.x - c.x, p.z - c.z) < r);
  const rand = mulberry32(seed * 131 + 1);
  const plainIron = shader({ base: 0x45413d, sheen: 0x6a4a32, sheenPower: 8, ambient: 0.45, underGlow: 0.5 });
  const parts = [];
  const m = new THREE.Matrix4();
  const rot = new THREE.Matrix4();
  const euler = new THREE.Euler();

  // ---- deck plates
  // Stations are fixed first so the two plates that give way on a fall can be
  // singled out before anything is built: the plate at the deck's low point
  // (IRON_BREAK_T) and the one before it, exactly as Sky Path picks its two
  // (Luke, 2026-09-04: "the middle plank and the one before it"). Those two
  // are always sound, flat plates, and go into `breakParts`, which is merged
  // LAST, so a bridge can stop drawing them by shortening its draw range.
  const stations = [];
  for (let s = P.slabPitch / 2; s < span; s += P.slabPitch * (0.93 + rand() * 0.14)) stations.push(s);
  let mid = 0;
  stations.forEach((st, i) => {
    if (Math.abs(st / span - IRON_BREAK_T) < Math.abs(stations[mid] / span - IRON_BREAK_T)) mid = i;
  });
  const breakParts = [];
  const breakables = [];
  for (const [idx, s] of stations.entries()) {
    const role = idx === mid ? 'under' : idx === mid - 1 ? 'behind' : null;
    const out = role ? breakParts : parts;
    const t = s / span;
    const c = at(t, (rand() - 0.5) * 0.04, -0.03 + (rand() - 0.5) * 0.015);
    if (nearIsland(c, DECK_RADIUS - 0.25)) continue;
    const tangent = at(Math.min(1, t + 0.01), 0, 0).sub(at(Math.max(0, t - 0.01), 0, 0)).normalize();
    const zAx = new THREE.Vector3().crossVectors(tangent, up).normalize();
    const yAx = new THREE.Vector3().crossVectors(zAx, tangent).normalize();
    const len = P.slabLength * (0.9 + rand() * 0.18);
    const width = P.halfWidth * 2 + 0.12 + rand() * 0.08;
    const stock = pickWeighted(rand, IRON_PLATES);
    const shade = ironShader(stock.base, stock.sheen, seed * 7 + Math.floor(s * 10), { rustBias: stock.rust });

    let fate = rand();
    const fateOf = (...weights) => {
      for (let i = 0; i < weights.length; i++) {
        if (fate < weights[i]) return i;
        fate -= weights[i];
      }
      return -1;
    };
    let which = fateOf(W.plateMissing, W.plateBroken, W.plateShifted, W.plateLoose); // 0 missing, 1 broken, 2 shifted, 3 loose, -1 sound
    if (role) which = -1;

    // Placement: true to the deck, except shifted plates, which have slid.
    let along = 0;
    let across = 0;
    let yaw = (rand() - 0.5) * 0.06;
    if (which === 2) {
      along = (rand() - 0.5) * 0.3;
      across = (rand() - 0.5) * 0.24;
      yaw = (rand() - 0.5) * 0.5;
    }
    euler.set((rand() - 0.5) * 0.035, yaw, (rand() - 0.5) * 0.02);
    m.makeBasis(tangent, yAx, zAx).multiply(rot.makeRotationFromEuler(euler));
    m.setPosition(c.clone().addScaledVector(tangent, along).addScaledVector(zAx, across));

    const boltShade = (p, n, out) => plainIron(p, n, out).multiplyScalar(0.8 + 0.4 * rand());
    const bolt = (x, z) => {
      const g = boxGeo(0.045, 0.03, 0.045);
      g.translate(x, 0.035, z);
      return g;
    };

    if (which === 0) {
      // Missing: a sheared bolt left on a strap, sometimes.
      for (const w of [-1, 1]) if (rand() < 0.5) out.push(paint(bolt((rand() - 0.5) * 0.2, w * P.halfWidth).translate(0, -0.05, 0).applyMatrix4(m), boltShade));
      continue;
    }

    // Warp: bowed between the straps and twisted end to end, built into the
    // geometry before placing it.
    const warp = rand() < W.plateWarp && !role ? (rand() - 0.3) * W.warpMax : 0;
    const twist = rand() < W.plateWarp && !role ? (rand() - 0.5) * W.warpMax : 0;
    const warpGeo = (g) => {
      const gp = g.attributes.position;
      for (let i = 0; i < gp.count; i++) {
        const x = gp.getX(i);
        const z = gp.getZ(i);
        const zz = z / (width / 2);
        gp.setY(i, gp.getY(i) - warp * (1 - zz * zz) + twist * (x / len) * zz);
      }
      return g;
    };

    if (which === 1) {
      // Broken across: the near half stays bolted to its strap, the far half
      // hangs off the other strap, its snapped edge ragged.
      const cut = (rand() - 0.5) * 0.3;
      const keepSide = rand() < 0.5 ? -1 : 1;
      const pieces = [
        { z0: keepSide < 0 ? -width / 2 : cut, z1: keepSide < 0 ? cut : width / 2, hang: false },
        { z0: keepSide < 0 ? cut : -width / 2, z1: keepSide < 0 ? width / 2 : cut, hang: true },
      ];
      for (const piece of pieces) {
        const w = piece.z1 - piece.z0;
        const g = boxGeo(len, 0.05, w, 4, 1, 1);
        g.translate(0, 0, (piece.z0 + piece.z1) / 2);
        const gp = g.attributes.position;
        for (let i = 0; i < gp.count; i++) {
          if (Math.abs(gp.getZ(i) - cut) < 1e-4) gp.setZ(i, cut + 0.05 * hashPos(gp.getX(i), 0, cut, seed + Math.floor(s * 100)));
        }
        warpGeo(g);
        if (piece.hang) {
          // Hinge on the strap it still hangs from, dropped 25-60 degrees.
          const hingeZ = -keepSide * P.halfWidth;
          // Opposite sign to the loose-plate tip below: there the free edge
          // lifts, here it drops.
          const angle = (0.45 + rand() * 0.6) * (hingeZ > 0 ? -1 : 1);
          g.translate(0, 0, -hingeZ).applyMatrix4(new THREE.Matrix4().makeRotationX(angle)).translate(0, 0, hingeZ);
        }
        out.push(paint(g.applyMatrix4(m), shade));
      }
      out.push(paint(bolt(len * 0.33, keepSide * P.halfWidth).applyMatrix4(m), boltShade));
      continue;
    }

    const g = warpGeo(boxGeo(len, 0.05, width, 3, 1, 5));
    if (which === 3) {
      // Worked loose: tipped up off one strap, resting on the other.
      const hingeZ = (rand() < 0.5 ? -1 : 1) * P.halfWidth;
      const angle = (0.12 + rand() * 0.2) * (hingeZ > 0 ? 1 : -1);
      g.translate(0, 0, -hingeZ).applyMatrix4(new THREE.Matrix4().makeRotationX(angle)).translate(0, 0, hingeZ);
    }
    out.push(paint(g.applyMatrix4(m), shade));
    if (which === 3) continue; // its bolts are what let go
    const bolts = [];
    for (const u of [-1, 1]) {
      for (const w of [-1, 1]) {
        if (rand() < 0.12 && !role) continue;
        out.push(paint(bolt(u * len * 0.33, w * P.halfWidth).applyMatrix4(m), boltShade));
        bolts.push([u * len * 0.33, w * P.halfWidth]);
      }
    }
    if (role) breakables.push({ role, matrix: m.clone(), len, width, stock, salt: seed * 7 + Math.floor(s * 10), bolts });
  }

  // ---- deck straps, following the curve in short segments
  const N = 64;
  for (const sgn of [-1, 1]) {
    const shade = ironShader(0x3a3634, 0x5a4030, seed * 3 + sgn + 9, { rustBias: 0.05 });
    for (let i = 0; i < N; i++) {
      const wob = (k) => (hashPos(k, sgn, 0, seed) * 0.012);
      const g = beam(at(i / N, sgn * P.halfWidth + wob(i), -0.075 + wob(i + 50)), at((i + 1) / N, sgn * P.halfWidth + wob(i + 1), -0.075 + wob(i + 51)), 0.08, 0.06, up);
      parts.push(paint(g, shade));
    }
  }

  // ---- handrail chains
  // Each sags its own amount; some have snapped, leaving a gap with the two
  // ends hanging down. Links alternate flat and upright, as real chain hangs,
  // each twisted a little off true and toned a little differently.
  // Copied into a plain BufferGeometry before cloning ~240 times per bridge:
  // clone() constructs a fresh instance of the source's class first, and a
  // no-argument TorusGeometry builds a full-size default torus before being
  // overwritten. That alone was ~200 ms of every bridge build.
  const torus = new THREE.TorusGeometry(0.1, 0.024, 4, 8);
  const link = new THREE.BufferGeometry().copy(torus);
  torus.dispose();
  link.scale(1.45, 1, 1);
  const railCount = Math.max(2, Math.round(span / P.linkPitch));
  const placeLink = (centre, x, i, shade, tone) => {
    const ref = Math.abs(x.y) > 0.9 ? dir : up;
    const z0 = new THREE.Vector3().crossVectors(x, ref).normalize();
    const y0 = new THREE.Vector3().crossVectors(z0, x).normalize();
    // Rotating (y, z) together about x keeps the basis right-handed, so the
    // torus never comes out inside-out.
    const tw = (i % 2 ? Math.PI / 2 : 0) + (rand() - 0.5) * 0.35;
    const y = y0.clone().multiplyScalar(Math.cos(tw)).addScaledVector(z0, Math.sin(tw));
    const z = z0.clone().multiplyScalar(Math.cos(tw)).addScaledVector(y0, -Math.sin(tw));
    m.makeBasis(x, y, z).setPosition(centre);
    parts.push(paint(link.clone().applyMatrix4(m), (p, n, out) => shade(p, n, out).multiplyScalar(tone)));
  };
  const railPoint = {};
  const brokenAt = {};
  for (const sgn of [-1, 1]) {
    const extra = rand() * W.railExtraSag;
    const lat = sgn * (P.halfWidth + 0.06) + (rand() - 0.5) * 0.03;
    railPoint[sgn] = (t) => at(t, lat, P.railHeight - extra * Math.sin(Math.PI * t));
    const chainShade = ironShader(0x3c3836, 0x6a4a32, seed * 5 + sgn + 21, { rustBias: -0.08, rustScale: 1.4, underGlow: 0.3 });
    const brk = rand() < W.chainBreak ? 0.2 + rand() * 0.6 : null;
    brokenAt[sgn] = brk;
    const gapHalf = 0.012 + rand() * 0.02;
    for (let i = 0; i < railCount; i++) {
      const t = (i + 0.5) / railCount;
      if (brk !== null && Math.abs(t - brk) < gapHalf) continue;
      const p0 = railPoint[sgn](Math.max(0, t - 0.004));
      const p1 = railPoint[sgn](Math.min(1, t + 0.004));
      placeLink(p0.clone().add(p1).multiplyScalar(0.5), p1.clone().sub(p0).normalize(), i, chainShade, 0.85 + rand() * 0.3);
    }
    if (brk !== null) {
      // Both loose ends drop: a few links hanging from each side of the gap,
      // swinging a little out from the deck.
      for (const endT of [brk - gapHalf, brk + gapHalf]) {
        let p = railPoint[sgn](THREE.MathUtils.clamp(endT, 0, 1));
        const count = 2 + Math.floor(rand() * 5);
        const swing = new THREE.Vector3(0, -1, 0).addScaledVector(side, sgn * (0.1 + rand() * 0.2)).addScaledVector(dir, (rand() - 0.5) * 0.3).normalize();
        for (let k = 0; k < count; k++) {
          const next = p.clone().addScaledVector(swing, P.linkPitch * 0.95);
          placeLink(p.clone().add(next).multiplyScalar(0.5), swing, k, chainShade, 0.85 + rand() * 0.3);
          p = next;
        }
      }
    }
  }
  link.dispose();

  // ---- hangers tying each handrail chain down to its deck strap
  const hangers = Math.max(1, Math.floor(span / P.hangerEvery));
  const hangerShade = ironShader(0x383432, 0x5a4030, seed * 11 + 3, { rustBias: 0.05 });
  for (let i = 1; i < hangers; i++) {
    const t = i / hangers + (rand() - 0.5) * 0.02;
    if (nearIsland(at(t, 0, 0), DECK_RADIUS)) continue;
    for (const sgn of [-1, 1]) {
      const roll = rand();
      if (roll < W.hangerMissing) continue;
      const brk = brokenAt[sgn];
      if (brk !== null && Math.abs(t - brk) < 0.05) continue; // nothing to hang from
      const top = railPoint[sgn](t);
      let bottom = at(t, sgn * (P.halfWidth + 0.03), -0.07);
      if (roll < W.hangerMissing + W.hangerLoose) {
        // Torn from the strap: hangs off the chain, swung out and along.
        const len = top.distanceTo(bottom);
        const swing = new THREE.Vector3(0, -1, 0).addScaledVector(side, sgn * (0.3 + rand() * 0.5)).addScaledVector(dir, (rand() - 0.5) * 0.6).normalize();
        bottom = top.clone().addScaledVector(swing, len * (0.85 + rand() * 0.1));
      }
      parts.push(paint(beam(bottom, top, 0.025, 0.025, dir), hangerShade));
    }
  }

  // ---- posts at both ends
  // Base plate bolted to the deck, a collar where each chain ties on, a cap;
  // each leaning, some hard, rusting up from the foot, the odd cap gone.
  const rustShade = shader({ base: RUST, ambient: 0.45, underGlow: 0.6 });
  const tmp = new THREE.Color();
  for (const t of [0, 1]) {
    for (const sgn of [-1, 1]) {
      const base = a.clone().lerp(b, t).addScaledVector(side, sgn * (P.halfWidth + 0.06));
      const hard = rand() < W.postLean;
      const leanAmt = hard ? 0.1 + rand() * 0.08 : 0.03;
      const lean = new THREE.Matrix4()
        .makeRotationFromEuler(new THREE.Euler((rand() - 0.5) * 2 * leanAmt, 0, (rand() - 0.5) * 2 * leanAmt))
        .setPosition(base.x, 0, base.z);
      const ironish = ironShader(0x3d3a38, 0x6a4a32, seed * 13 + t * 2 + sgn, { rustBias: 0.05 });
      const shade = (p, n, out) => {
        ironish(p, n, out);
        if (p.y < 0.4) out.lerp(rustShade(p, n, tmp), ((0.4 - p.y) / 0.4) * 0.5);
        return out;
      };
      const pieces = [];
      const post = boxGeo(0.15, P.postHeight + 0.4, 0.15, 1, 6, 1);
      post.translate(0, (P.postHeight - 0.4) / 2, 0);
      pieces.push(post);
      const plate = boxGeo(0.34, 0.05, 0.34);
      plate.translate(0, 0.055, 0);
      pieces.push(plate);
      for (const [u, w] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        if (rand() < 0.15) continue;
        const bolt = boxGeo(0.045, 0.035, 0.045);
        bolt.translate(u * 0.12, 0.09, w * 0.12);
        pieces.push(bolt);
      }
      if (rand() >= W.capMissing) {
        const cap = boxGeo(0.22, 0.09, 0.22);
        cap.translate(0, P.postHeight + 0.02, 0);
        pieces.push(cap);
      }
      for (const y of [P.deckHeight, P.deckHeight + P.railHeight]) {
        const collar = new THREE.TorusGeometry(0.11, 0.028, 4, 12);
        collar.rotateX(Math.PI / 2);
        collar.translate(0, y, 0);
        pieces.push(collar);
      }
      for (const g of pieces) parts.push(paint(g.applyMatrix4(lean), shade));
    }
  }

  let breakStart = 0;
  for (const g of parts) breakStart += g.index.count;
  const geometry = mergeGeometries([...parts, ...breakParts]);
  geometry.computeBoundingSphere();
  return { geometry, breakStart, breakables, heightAt: (t) => deckY(THREE.MathUtils.clamp(t, 0, 1)) - 0.005 };
}

// ---------------------------------------------------------------- breaking

/**
 * A fall breaks the bridge under the walker. Sky Path's planks are wood, so
 * they crack in two and tumble (bridgeGen.js's breakPlank); iron fails
 * differently, so this is its own animation, on Sky Path's placement and
 * timing: the same two plates, the instant the walker reaches them, with the
 * figure falling at the same moment. Luke, 2026-10-04: "the handrails
 * shouldn't be affected", so only the two plates (and their bolts) move.
 *
 *  - The plate under the walker buckles: its middle drops and it folds into
 *    a V about its two straps, then the bolts shear (bolt heads pop off) and
 *    both halves tumble away into the lava.
 *  - The plate before it lets go a beat later on one strap only, swings down
 *    and is left dangling from the other.
 *
 * Scripted rather than physics, like Sky Path's jetpack rescue: a few pieces
 * on fixed rules, everything a function of time since the break. Pieces live
 * in a group carrying the bridge mesh's own transform, so they are built and
 * moved in the bridge's local frame (from at the origin, to along +x).
 */
const BREAK = {
  buckleSeconds: 0.16, // the V-fold under the walker, before its bolts shear
  buckleAngle: 0.55, // radians each half folds down by
  behindDelay: 0.2, // the plate before it lets go this much later
  hangAngle: 1.35, // where the dangling plate comes to rest (~77 degrees)
  gravity: 9.8,
  debrisSeconds: 6, // falling pieces are removed after this, far below by then
  // The intact plates come back after this: a stand-in for whatever repairs
  // a bridge between attempts, since in the cavern several players share it.
  restoreSeconds: 8,
};

const activeBreaks = new Set();
const _q = new THREE.Quaternion();
const _xAxis = new THREE.Vector3(1, 0, 0);

/** A plate (or part of one) as its own mesh, positioned in the bridge frame with its origin on `hingeZ`. */
function platePiece(b, z0, z1, hingeZ, jagged = null) {
  const g = boxGeo(b.len, 0.05, z1 - z0, 4, 1, 1);
  g.translate(0, 0, (z0 + z1) / 2);
  if (jagged !== null) {
    // Torn edge: the seam where the two halves pulled apart.
    const gp = g.attributes.position;
    for (let i = 0; i < gp.count; i++) {
      if (Math.abs(gp.getZ(i) - jagged) < 1e-4) gp.setZ(i, jagged + 0.04 * hashPos(gp.getX(i), 0, 1, b.salt));
    }
  }
  g.translate(0, 0, -hingeZ);
  paint(g, ironShader(b.stock.base, b.stock.sheen, b.salt, { rustBias: b.stock.rust }));
  const mesh = new THREE.Mesh(g, getSolidMat());
  const base = b.matrix.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, hingeZ));
  base.decompose(mesh.position, mesh.quaternion, mesh.scale);
  return { mesh, q0: mesh.quaternion.clone() };
}

function boltPiece(b, u, w) {
  const g = boxGeo(0.045, 0.03, 0.045);
  paint(g, shader({ base: 0x45413d, sheen: 0x6a4a32, sheenPower: 8, ambient: 0.45, underGlow: 0.5 }));
  const mesh = new THREE.Mesh(g, getSolidMat());
  mesh.position.set(u, 0.035, w).applyMatrix4(b.matrix);
  mesh.quaternion.setFromRotationMatrix(b.matrix);
  return mesh;
}

function freeFall(piece, v, spin) {
  piece.mode = 'free';
  piece.v = v;
  piece.w = spin;
}

/**
 * Starts the break on a bridge built by buildIronBridge. Returns false if it
 * is already broken (a second faller on the same bridge before it's restored
 * just falls through the gap that's already there).
 */
export function breakIronBridge(group) {
  const st = group.userData.iron;
  if (!st || st.broken) return false;
  st.broken = true;
  st.age = 0;
  st.mesh.geometry.setDrawRange(0, st.breakStart);
  st.debris = new THREE.Group();
  st.debris.position.copy(st.mesh.position);
  st.debris.rotation.copy(st.mesh.rotation);
  group.add(st.debris);
  st.pieces = [];
  const rnd = Math.random;
  const strap = CHAIN.halfWidth;
  const add = (piece) => {
    st.debris.add(piece.mesh);
    st.pieces.push(piece);
    return piece;
  };
  const zAxisOf = (b) => new THREE.Vector3().setFromMatrixColumn(b.matrix, 2);

  for (const b of st.breakables) {
    const W = b.width / 2;
    if (b.role === 'under') {
      // Two halves, each hinged on its own strap, torn apart along the middle.
      for (const sgn of [-1, 1]) {
        const p = platePiece(b, sgn < 0 ? -W : 0, sgn < 0 ? 0 : W, sgn * strap, 0);
        add({ ...p, mode: 'buckle', sgn, zAxis: zAxisOf(b) });
      }
      for (const [u, w] of b.bolts) add({ mesh: boltPiece(b, u, w), mode: 'pop', at: BREAK.buckleSeconds * (0.7 + rnd() * 0.5) });
    } else {
      // Lets go on one strap, swings down on the other.
      const keep = rnd() < 0.5 ? -1 : 1;
      const p = platePiece(b, -W, W, keep * strap);
      add({ ...p, mode: 'swing', keep });
      for (const [u, w] of b.bolts) {
        const mesh = boltPiece(b, u, w);
        if (Math.sign(w) === keep) add({ mesh, mode: 'stay' });
        else add({ mesh, mode: 'pop', at: BREAK.behindDelay });
      }
    }
  }
  activeBreaks.add(st);
  return true;
}

/** Puts a broken bridge back to whole: debris gone, its plates drawn again. */
export function restoreIronBridge(group) {
  const st = group.userData.iron;
  if (!st?.broken) return;
  for (const p of st.pieces) p.mesh.geometry.dispose();
  st.debris.removeFromParent();
  st.debris = null;
  st.pieces = [];
  st.mesh.geometry.setDrawRange(0, Infinity);
  st.broken = false;
  activeBreaks.delete(st);
}

/** Advances every bridge break in progress. Call once per frame. */
export function updateIronBreaks(dt) {
  for (const st of [...activeBreaks]) {
    st.age += dt;
    const t = st.age;
    if (t >= BREAK.restoreSeconds) {
      restoreIronBridge(st.group);
      continue;
    }
    for (const p of st.pieces) {
      if (p.gone) continue;
      if (p.mode === 'buckle') {
        if (t < BREAK.buckleSeconds) {
          const k = t / BREAK.buckleSeconds;
          p.mesh.quaternion.copy(p.q0).multiply(_q.setFromAxisAngle(_xAxis, -p.sgn * BREAK.buckleAngle * k * k));
        } else {
          // Sheared: carry on falling with the fold's own momentum, outward
          // a little, spinning.
          const v = p.zAxis.clone().multiplyScalar(p.sgn * (0.3 + Math.random() * 0.4)).setY(-1.6 - Math.random());
          freeFall(p, v, new THREE.Vector3((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 6));
        }
      } else if (p.mode === 'swing') {
        const s = Math.max(0, t - BREAK.behindDelay);
        // Damped swing to rest: overshoots once or twice, then hangs.
        const angle = BREAK.hangAngle * (1 - Math.exp(-2.6 * s) * Math.cos(7 * s));
        // Negative about +x drops the edge on the -z side of the hinge, so -keep
        // drops the free edge, which is always on the far side from the kept strap.
        p.mesh.quaternion.copy(p.q0).multiply(_q.setFromAxisAngle(_xAxis, -p.keep * angle));
      } else if (p.mode === 'pop' && t >= p.at) {
        freeFall(
          p,
          new THREE.Vector3((Math.random() - 0.5) * 1.6, 1 + Math.random() * 1.6, (Math.random() - 0.5) * 1.6),
          new THREE.Vector3((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20)
        );
      }
      if (p.mode === 'free') {
        p.v.y -= BREAK.gravity * dt;
        p.mesh.position.addScaledVector(p.v, dt);
        const wl = p.w.length();
        if (wl > 1e-6) p.mesh.quaternion.premultiply(_q.setFromAxisAngle(p.w.clone().divideScalar(wl), wl * dt));
        if (t > BREAK.debrisSeconds) {
          p.gone = true;
          p.mesh.visible = false;
        }
      }
    }
  }
}

/** Ends every break immediately (world rebuild or teardown). */
export function clearIronBreaks() {
  for (const st of [...activeBreaks]) restoreIronBridge(st.group);
}

/**
 * Builds one bridge between two deck-level points ({x, z}, y=0), in the same
 * coordinates as bridgeGen's buildBridge, and returns a Group shaped like one
 * of its bridges: `userData.bridge` carries span/length/heightAt, and the mesh
 * is flagged sharedMaterial + sharedGeometry, so bridgeGen's disposeBridge()
 * leaves both to disposeIronKit().
 *
 * Built in a local frame (from at the origin, to along +x), cached, then
 * placed with a transform: every gap in the cavern is the same length, so a
 * few variants cover all 48 bridges. Bridge by bridge, the detailed version
 * took 2.5 s to rebuild. The cache key carries the island centres in that
 * local frame, since left and right routes see them on opposite sides.
 * `centres` are the two island centres the bridge joins.
 */
export function buildIronBridge(from, to, { centres = [], seed = 0, sag = CHAIN.sag } = {}) {
  const span = Math.hypot(to.x - from.x, to.z - from.z);
  const dx = (to.x - from.x) / span;
  const dz = (to.z - from.z) / span;
  const localCentres = centres.map((c) => {
    const ox = c.x - from.x;
    const oz = c.z - from.z;
    return { x: ox * dx + oz * dz, z: -ox * dz + oz * dx };
  });
  const variant = Math.abs(seed) % BRIDGE_VARIANTS;
  const key = [span.toFixed(2), sag.toFixed(2), variant, ...localCentres.map((c) => `${c.x.toFixed(2)},${c.z.toFixed(2)}`)].join('|');
  if (!bridgeCache.has(key)) {
    bridgeCache.set(key, chainBridge({ x: 0, z: 0 }, { x: span, z: 0 }, { centres: localCentres, seed: variant + 1, sag }));
  }
  const built = bridgeCache.get(key);
  // Each bridge gets its own BufferGeometry *view* of the cached one: the same
  // attribute and index objects (so one GPU buffer between all bridges using
  // this variant) but its own draw range, which is how a broken bridge stops
  // drawing its two breakable plates without affecting any other bridge.
  const view = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(built.geometry.attributes)) view.setAttribute(name, attr);
  view.setIndex(built.geometry.index);
  view.boundingSphere = built.geometry.boundingSphere.clone();
  const mesh = new THREE.Mesh(view, getSolidMat());
  mesh.position.set(from.x, 0, from.z);
  mesh.rotation.y = Math.atan2(-dz, dx); // local +x onto the span, local +z onto its left-hand side
  mesh.userData.sharedMaterial = true;
  mesh.userData.sharedGeometry = true;
  const group = new THREE.Group();
  group.add(mesh);
  group.userData.bridge = { span, length: span, anchors: { from, to }, plankCount: 0, breakablePlanks: [], heightAt: built.heightAt };
  group.userData.iron = { group, mesh, breakStart: built.breakStart, breakables: built.breakables, broken: false };
  return group;
}

/** Frees the cached geometry, materials and textures. */
export function disposeIronKit() {
  clearIronBreaks();
  for (const parts of islandCache.values()) for (const { geometry } of parts) geometry.dispose();
  islandCache.clear();
  for (const { geometry } of bridgeCache.values()) geometry.dispose();
  bridgeCache.clear();
  for (const { deck, loose } of deckMats.values()) {
    for (const mat of [deck, loose]) {
      mat.map?.dispose();
      mat.dispose();
    }
  }
  deckMats.clear();
  solidMat?.dispose();
  solidMat = null;
  plateEdgeMat?.dispose();
  plateEdgeMat = null;
}
