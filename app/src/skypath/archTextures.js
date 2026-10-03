/**
 * Procedural canvas textures for the shrine archway (archGen.js).
 *
 * Painted, not lit: the game renders almost everything with MeshBasicMaterial,
 * so wear, grime and cavity darkening live in the pixels here, and archGen
 * multiplies a baked per-vertex shade over the top for form.
 *
 * All noise is periodic in whichever axis a texture wraps around (a pillar's
 * circumference, a beam's cross-section perimeter), so there is no visible seam.
 *
 * Glyphs are invented. Each one is assembled from brush strokes and always
 * includes a small circle or spiral, which no real CJK character contains.
 * That is the guarantee that nothing reads as an actual word.
 */
import * as THREE from 'three';

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNoise(seed) {
  const r = rng(seed);
  const perm = new Uint8Array(256);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  const val = new Float32Array(256);
  for (let i = 0; i < 256; i++) val[i] = r();
  const mod = (i, p) => ((i % p) + p) % p;
  const h = (i, j) => val[perm[(perm[i & 255] + j) & 255]];
  const s = (t) => t * t * (3 - 2 * t);
  const noise = (x, y, px, py) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = s(x - xi), fy = s(y - yi);
    const x0 = mod(xi, px), x1 = mod(xi + 1, px);
    const y0 = mod(yi, py), y1 = mod(yi + 1, py);
    const a = h(x0, y0), b = h(x1, y0), c = h(x0, y1), d = h(x1, y1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  /** Tileable fBm over the unit square: fu/fv are integer base frequencies. */
  return (u, v, fu, fv, oct = 5) => {
    let sum = 0, amp = 0.5, norm = 0;
    for (let o = 0; o < oct; o++) {
      sum += amp * noise(u * fu, v * fv, fu, fv);
      norm += amp;
      amp *= 0.5;
      fu *= 2;
      fv *= 2;
    }
    return sum / norm;
  };
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t, o) => {
  o[0] = a[0] + (b[0] - a[0]) * t;
  o[1] = a[1] + (b[1] - a[1]) * t;
  o[2] = a[2] + (b[2] - a[2]) * t;
  return o;
};
const ridge = (n) => 1 - Math.abs(2 * n - 1);

/**
 * Per-pixel painter. v runs bottom→top to match three's default flipY.
 * With `withMask`, fn also writes out[4] (0..255) into a second, greyscale
 * canvas — kept separate rather than in alpha, because a canvas stores
 * premultiplied colour and would destroy the RGB under a low-alpha pixel.
 */
function paint(w, h, fn, withMask = false) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const out = [0, 0, 0, 255, 0];
  let mask = null, mctx = null, mimg = null;
  if (withMask) {
    mask = document.createElement('canvas');
    mask.width = w;
    mask.height = h;
    mctx = mask.getContext('2d');
    mimg = mctx.createImageData(w, h);
  }
  for (let y = 0; y < h; y++) {
    const v = 1 - (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      out[3] = 255;
      fn((x + 0.5) / w, v, out);
      const k = (y * w + x) * 4;
      d[k] = out[0];
      d[k + 1] = out[1];
      d[k + 2] = out[2];
      d[k + 3] = out[3];
      if (mimg) {
        mimg.data[k] = mimg.data[k + 1] = mimg.data[k + 2] = out[4];
        mimg.data[k + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  if (mctx) mctx.putImageData(mimg, 0, 0);
  return { canvas: c, ctx, mask };
}

const NEUTRAL_LACQUER = [232, 232, 232];
const hexRgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];

function toTexture(canvas, repeat = false) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  if (!repeat) t.wrapS = THREE.RepeatWrapping; // u always wraps (around pillars, along perimeters)
  return t;
}

/** A data texture (lacquer mask): sampled as-is, no sRGB decode. */
function toMask(canvas, repeat = false) {
  const t = toTexture(canvas, repeat);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

// ------------------------------------------------------------------ glyphs

/**
 * One invented glyph centred on (cx, cy), roughly `s` px square, drawn with
 * the context's current strokeStyle.
 */
export function drawGlyph(ctx, r, cx, cy, s, weight = 0.085) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const snap = () => (Math.floor(r() * 5) - 2) * 0.18;
  const jit = () => (r() - 0.5) * 0.05;
  const stroke = (fn) => {
    ctx.lineWidth = weight * (0.75 + r() * 0.6);
    ctx.beginPath();
    fn();
    ctx.stroke();
  };
  const n = 3 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    const kind = r();
    if (kind < 0.3) {
      const y = snap(), x0 = -0.42 + r() * 0.2, x1 = 0.42 - r() * 0.2;
      stroke(() => { ctx.moveTo(x0, y + jit()); ctx.quadraticCurveTo(0, y - 0.04, x1, y - 0.03 + jit()); });
    } else if (kind < 0.55) {
      const x = snap(), y0 = -0.44 + r() * 0.2, y1 = 0.44 - r() * 0.15;
      const hook = r() < 0.4;
      stroke(() => {
        ctx.moveTo(x + jit(), y0);
        ctx.lineTo(x + jit(), y1);
        if (hook) ctx.lineTo(x - 0.1, y1 - 0.08);
      });
    } else if (kind < 0.7) {
      const x = snap() * 0.6, y = -0.3 + r() * 0.2;
      stroke(() => { ctx.moveTo(x, y); ctx.quadraticCurveTo(x - 0.05, y + 0.35, x - 0.38, y + 0.62); });
    } else if (kind < 0.82) {
      const x = snap() * 0.5, y = -0.05 + r() * 0.2;
      stroke(() => { ctx.moveTo(x, y); ctx.quadraticCurveTo(x + 0.1, y + 0.3, x + 0.4, y + 0.42); });
    } else if (kind < 0.92) {
      const x = snap(), y = snap();
      ctx.lineWidth = weight * 1.4;
      ctx.beginPath();
      ctx.moveTo(x - 0.03, y - 0.04);
      ctx.lineTo(x + 0.04, y + 0.05);
      ctx.stroke();
    } else {
      const x = snap() * 0.7, y = snap() * 0.7, w = 0.2 + r() * 0.15, h = 0.2 + r() * 0.15;
      stroke(() => { ctx.moveTo(x - w, y + h); ctx.lineTo(x - w, y - h); ctx.lineTo(x + w, y - h); ctx.lineTo(x + w, y + h); });
    }
  }
  // The guarantee: a circle or spiral, which never appears in real script.
  const mx = (r() - 0.5) * 0.5, my = (r() - 0.5) * 0.5;
  ctx.lineWidth = weight * 0.9;
  ctx.beginPath();
  if (r() < 0.5) {
    ctx.arc(mx, my, 0.09 + r() * 0.05, 0, Math.PI * 2);
  } else {
    for (let t = 0; t <= 1; t += 0.03) {
      const a = t * Math.PI * 3.2, rr = 0.02 + t * 0.12;
      const px = mx + Math.cos(a) * rr, py = my + Math.sin(a) * rr;
      t === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
  }
  ctx.stroke();
  ctx.restore();
}

/** A cloud-scroll spiral, for plaque corners. */
function drawScroll(ctx, x, y, s, dir) {
  ctx.beginPath();
  for (let t = 0; t <= 1; t += 0.02) {
    const a = t * Math.PI * 3, rr = s * (1 - t * 0.85);
    const px = x + dir * Math.cos(a) * rr, py = y + Math.sin(a) * rr;
    t === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.stroke();
}

// ------------------------------------------------------------------ painters

/**
 * Lacquered wood, worn through to bare grain. `along` is the UV axis the
 * grain runs in ('v' up a pillar, 'u' along a beam). `grime(u,v)` returns
 * 0..1 dirt, e.g. rising toward the ground or pooling under the beam.
 *
 * Without `o.lacquer`, the paint goes on neutral off-white and a mask of
 * where it survives comes back alongside: archGen tints only the masked
 * paint per arch, so one set of textures serves every colour scheme while
 * the bare wood, grime and cracks underneath keep their natural colour.
 */
function lacquerWood(seed, w, h, o) {
  const neutral = !o.lacquer;
  const lacquer = o.lacquer ?? NEUTRAL_LACQUER;
  const f = makeNoise(seed);
  const tmp = [0, 0, 0], wood = [0, 0, 0];
  const dk = [44, 26, 16], md = [104, 66, 38], lt = [138, 92, 54];
  const alongV = o.along === 'v';
  // frequencies (u, v): high across the grain, low along it
  const gu = alongV ? o.across : 3, gv = alongV ? 3 : o.across;
  return paint(w, h, (u, v, out) => {
    const c = alongV ? u : v;
    const g = f(u, v, gu, gv, 4);
    const ring = 0.5 + 0.5 * Math.sin(g * 40 + c * 6.283 * 3);
    mix(dk, md, ring, wood);
    mix(wood, lt, sstep(0.75, 1, ring) * 0.5, wood);
    const fine = f(u, v, gu * 4, gv * 4, 2);
    for (let i = 0; i < 3; i++) wood[i] *= 0.82 + 0.36 * fine;

    // lacquer layer with brush streaks along the grain
    const lv = 0.82 + 0.3 * f(u, v, 4, 4, 3);
    const brush = 1 + 0.08 * (f(u, v, gu * 2, gv * 2, 3) - 0.5);
    tmp[0] = lacquer[0] * lv * brush;
    tmp[1] = lacquer[1] * lv * brush;
    tmp[2] = lacquer[2] * lv * brush;

    // wear: patches where lacquer has flaked to bare wood, with a dark rim
    const wn = f(u, v, 6, 6, 5) + (o.wearBias ? o.wearBias(u, v) : 0);
    const th = 1 - o.wear;
    const worn = sstep(th, th + 0.025, wn);
    const rim = Math.exp(-(((wn - th) / 0.018) ** 2)) * 0.45;
    mix(tmp, wood, worn, out);
    for (let i = 0; i < 3; i++) out[i] *= 1 - rim;

    // splits along the grain
    const crack = sstep(0.968, 0.995, ridge(f(u, v, Math.ceil(gu * 1.5), Math.ceil(gv * 1.5), 4)));
    for (let i = 0; i < 3; i++) out[i] *= 1 - crack * 0.55;

    // grime and dust
    const gr = (o.grime ? o.grime(u, v) : 0) * (0.6 + 0.6 * f(u, v, 8, 8, 3));
    mix(out, [52, 44, 34], clamp01(gr) * 0.7, out);
    const dust = f(u, v, 96, 96, 1);
    for (let i = 0; i < 3; i++) out[i] *= 0.93 + 0.12 * dust;
    // tint only what is still paint, and less of it where grime covers it
    out[4] = 255 * (1 - worn) * (1 - clamp01(gr) * 0.7);
  }, neutral);
}

function stone(seed, w, h, moss) {
  const f = makeNoise(seed);
  const c1 = [92, 90, 84], c2 = [148, 144, 132];
  const mossA = [52, 74, 30], mossB = [110, 128, 52], lich = [178, 172, 120];
  const tmp = [0, 0, 0];
  return paint(w, h, (u, v, out) => {
    mix(c1, c2, f(u, v, 5, 5, 5), out);
    const sp = f(u, v, 80, 80, 2);
    for (let i = 0; i < 3; i++) out[i] *= 0.84 + 0.3 * sp;
    const blot = sstep(0.55, 0.75, f(u, v, 3, 3, 4));
    for (let i = 0; i < 3; i++) out[i] *= 1 - blot * 0.25;
    const cr = sstep(0.972, 0.992, ridge(f(u, v, 4, 4, 5)));
    for (let i = 0; i < 3; i++) out[i] *= 1 - cr * 0.45;
    const m = f(u, v, 9, 9, 5) * 0.75 + moss(u, v);
    const mt = sstep(0.62, 0.7, m);
    mix(mossA, mossB, f(u, v, 40, 40, 3), tmp);
    mix(out, tmp, mt, out);
    const l = f(u, v, 48, 48, 3);
    mix(out, lich, sstep(0.74, 0.77, l) * (1 - mt) * 0.6, out);
  });
}

function bronze(seed) {
  const f = makeNoise(seed);
  const base = [150, 108, 54], dark = [66, 44, 24], pat = [86, 158, 132], tmp = [0, 0, 0];
  return paint(256, 256, (u, v, out) => {
    mix(dark, base, 0.55 + 0.45 * f(u, v, 6, 6, 4), out);
    mix(out, [214, 172, 96], sstep(0.6, 0.8, f(u, v, 20, 20, 3)) * 0.4, out);
    mix(pat, [130, 190, 160], f(u, v, 30, 30, 2), tmp);
    mix(out, tmp, sstep(0.56, 0.68, f(u, v, 5, 5, 5)) * 0.9, out);
    const pit = sstep(0.78, 0.82, f(u, v, 60, 60, 2));
    for (let i = 0; i < 3; i++) out[i] *= 1 - pit * 0.5;
  });
}

// The glyph-bearing textures (talisman paper, plaque, runes) are painted in
// two layers so each arch can have its own glyphs (Luke, 2026-10-04): the
// slow per-pixel base is painted once per seed and cached; the glyphs are
// cheap canvas strokes drawn over a copy of it, per glyph seed.
const glyphBaseCache = new Map(); // seed -> { paper, plaque } canvases

function copyCanvas(src) {
  const canvas = document.createElement('canvas');
  canvas.width = src.width;
  canvas.height = src.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(src, 0, 0);
  return { canvas, ctx };
}

function glyphBases(seed) {
  let b = glyphBaseCache.get(seed);
  if (!b) {
    b = { paper: paperBase(seed + 6), plaque: plaqueBase(seed + 7) };
    glyphBaseCache.set(seed, b);
  }
  return b;
}

/** Aged paper, 5 cells across. Cells 0-3 are torn-edged talismans (glyphs
 *  added by paperAtlas); cell 4 is plain paper for the zigzag shide strips. */
function paperBase(seed) {
  const f = makeNoise(seed);
  const base = [232, 218, 182], stain = [180, 146, 92];
  const { canvas, ctx } = paint(640, 512, (u, v, out) => {
    mix(base, stain, sstep(0.55, 0.85, f(u, v, 6, 5, 5)) * 0.6, out);
    const fib = f(u, v, 60, 120, 2);
    for (let i = 0; i < 3; i++) out[i] *= 0.94 + 0.1 * fib;
    const cell = Math.min(4, Math.floor(u * 5));
    const lu = u * 5 - cell;
    const edge = Math.min(lu * 128, (1 - lu) * 128, v * 512, (1 - v) * 512);
    const darken = Math.exp(-edge / 10) * 0.35;
    for (let i = 0; i < 3; i++) out[i] *= 1 - darken;
    if (cell < 4) out[3] = edge > 2 + 10 * f(u, v, 40, 40, 3) ? 255 : 0;
    mix(out, [120, 100, 70], sstep(0.7, 0.9, f(u, v, 40, 3, 3)) * 0.35, out);
  });
  return canvas;
}

function paperAtlas(seed, glyphSeed) {
  const { canvas, ctx } = copyCanvas(glyphBases(seed).paper);
  const r = rng(glyphSeed + 6 + 11);
  for (let k = 0; k < 4; k++) {
    const cx = k * 128 + 64;
    ctx.strokeStyle = 'rgba(168,30,24,0.9)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, 62, 30, 0, Math.PI * 2);
    ctx.stroke();
    drawGlyph(ctx, r, cx, 62, 38, 0.11);
    ctx.strokeStyle = 'rgba(22,16,12,0.92)';
    const count = 3 + (k % 2);
    for (let i = 0; i < count; i++) drawGlyph(ctx, r, cx, 140 + i * (300 / count), 72, 0.1);
    ctx.strokeStyle = 'rgba(168,30,24,0.85)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(cx, 440);
    ctx.bezierCurveTo(cx + 30, 455, cx - 30, 470, cx, 490);
    ctx.stroke();
  }
  return canvas;
}

function plaqueBase(seed) {
  const { canvas, ctx } = lacquerWood(seed, 512, 224, {
    along: 'u', across: 8, lacquer: [30, 22, 18], wear: 0.12,
    grime: (u, v) => 0.3 * (1 - v),
  });
  ctx.strokeStyle = '#e2b85c';
  ctx.lineWidth = 6;
  ctx.strokeRect(14, 14, 484, 196);
  ctx.lineWidth = 2;
  ctx.strokeRect(26, 26, 460, 172);
  ctx.lineWidth = 3;
  drawScroll(ctx, 48, 48, 14, 1);
  drawScroll(ctx, 464, 48, 14, -1);
  drawScroll(ctx, 48, 176, 14, 1);
  drawScroll(ctx, 464, 176, 14, -1);
  return canvas;
}

function plaque(seed, glyphSeed) {
  const { canvas, ctx } = copyCanvas(glyphBases(seed).plaque);
  const r = rng(glyphSeed + 7 + 3);
  ctx.shadowColor = 'rgba(255,214,120,0.9)';
  ctx.shadowBlur = 14;
  ctx.strokeStyle = '#f4d27e';
  for (let i = 0; i < 3; i++) drawGlyph(ctx, r, 136 + i * 120, 112, 118, 0.1);
  ctx.shadowBlur = 0;
  // flaked gilding: knock some gold back toward the board colour (only bright
  // pixels are tested, so this stays cheap per arch)
  const f = makeNoise(seed + 7 + 9);
  const img = ctx.getImageData(0, 0, 512, 224);
  const d = img.data;
  for (let y = 0; y < 224; y++)
    for (let x = 0; x < 512; x++) {
      const k = (y * 512 + x) * 4;
      if (d[k] > 150 && f(x / 512, y / 224, 24, 12, 3) > 0.66) {
        d[k] *= 0.45; d[k + 1] *= 0.42; d[k + 2] *= 0.4;
      }
    }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Transparent strip of glowing carved runes that wraps a plinth. */
function runeBand(seed) {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 64;
  const ctx = c.getContext('2d');
  const n = 16;
  for (let pass = 0; pass < 2; pass++) {
    const r = rng(seed); // same seed both passes: core traces the halo exactly
    // White: the glow's colour comes from the material, per arch.
    ctx.shadowColor = 'rgba(255,255,255,1)';
    ctx.shadowBlur = pass ? 4 : 18;
    ctx.strokeStyle = pass ? 'rgba(255,255,255,1)' : 'rgba(235,235,235,0.85)';
    for (let i = 0; i < n; i++) drawGlyph(ctx, r, (i + 0.5) * (1024 / n), 32, 44, pass ? 0.06 : 0.12);
  }
  return c;
}

function rope(seed) {
  const f = makeNoise(seed);
  const a = [190, 162, 104], b = [112, 88, 50];
  return paint(256, 64, (u, v, out) => {
    const s = 0.5 + 0.5 * Math.sin((u * 24 + v * 3) * Math.PI * 2 + f(u, v, 16, 4, 2) * 3);
    mix(b, a, s * (0.7 + 0.3 * f(u, v, 64, 16, 2)), out);
  });
}

function tassel(seed) {
  const f = makeNoise(seed);
  return paint(64, 128, (u, v, out) => {
    const s = f(u, v, 32, 2, 2);
    out[0] = 120 + 90 * s; out[1] = 18 + 20 * s; out[2] = 22 + 18 * s;
  });
}

/**
 * Every texture the arch uses, keyed by material slot. The four lacquered
 * slots (pillar, beam, cap, trim) come with `<slot>Mask` companions for
 * per-arch tinting — unless `bake` (a palette, see ARCH_PALETTES) is given,
 * in which case its colours are painted straight in and there are no masks.
 * That is for GLB export, where the tinting shader can't travel.
 */
export function buildArchTextures(seed = 7, bake = null) {
  // A tint multiplies NEUTRAL_LACQUER, so bake at the same brightness.
  const baked = (hex) => hexRgb(hex).map((c) => (c * NEUTRAL_LACQUER[0]) / 255);
  const lac = bake ? baked(bake.lacquer) : null;
  const capLac = bake ? baked(bake.cap) : null;
  const tex = {};
  const lacquered = (slot, painted, repeat = false) => {
    tex[slot] = toTexture(painted.canvas, repeat);
    if (painted.mask) tex[slot + 'Mask'] = toMask(painted.mask, repeat);
  };
  lacquered('pillar', lacquerWood(seed, 512, 1024, {
    along: 'v', across: 24, lacquer: lac, wear: 0.3,
    wearBias: (u, v) => 0.12 * (1 - v),
    grime: (u, v) => sstep(0.35, 0, v) + 0.4 * sstep(0.88, 1, v),
  }));
  lacquered('beam', lacquerWood(seed + 1, 1024, 256, {
    along: 'u', across: 12, lacquer: lac, wear: 0.26,
    wearBias: (u) => 0.2 * sstep(0.4, 0.5, Math.abs(u - 0.5)),
    grime: (u, v) => 0.5 * sstep(0.3, 0, Math.abs(v - 0.62)),
  }));
  lacquered('cap', lacquerWood(seed + 2, 1024, 128, {
    along: 'u', across: 10, lacquer: capLac, wear: 0.34,
    wearBias: (u) => 0.15 * sstep(0.4, 0.5, Math.abs(u - 0.5)),
  }));
  lacquered('trim', lacquerWood(seed + 3, 256, 256, { along: 'u', across: 8, lacquer: lac, wear: 0.4 }), true);
  Object.assign(tex, {
    stone: toTexture(stone(seed + 4, 512, 512, (u, v) => 0.25 * sstep(0.5, 0, v)).canvas, true),
    bronze: toTexture(bronze(seed + 5).canvas, true),
    rope: toTexture(rope(seed + 9).canvas, true),
    tassel: toTexture(tassel(seed + 10).canvas, true),
  });
  Object.assign(tex, buildGlyphTextures(seed, seed));
  return tex;
}

/**
 * The three glyph-bearing textures — talisman paper, plaque and plinth runes —
 * with glyphs from glyphSeed over the base painted for seed. Cheap after
 * the first call for a seed (the base is cached), so each arch can have its
 * own. The caller owns and disposes the returned textures.
 */
export function buildGlyphTextures(seed, glyphSeed) {
  const paper = toTexture(paperAtlas(seed, glyphSeed));
  const plaqueTex = toTexture(plaque(seed, glyphSeed));
  paper.wrapS = THREE.ClampToEdgeWrapping;
  plaqueTex.wrapS = THREE.ClampToEdgeWrapping;
  return { paper, plaque: plaqueTex, runes: toTexture(runeBand(glyphSeed + 8)) };
}
