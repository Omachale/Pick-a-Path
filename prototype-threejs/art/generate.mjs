/**
 * Placeholder art generator for the sky-path diorama prototype.
 *
 * Writes SVG sources to art/svg/ and rasterises them to public/textures/.
 * Everything is deliberately flat-coloured with a painted-on dark bottom edge,
 * which is the "imply thickness without geometry" trick from the handoff.
 *
 * Deterministic: same seed produces the same art every run.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const svgDir = join(here, 'svg');
const outDir = join(here, '..', 'public', 'textures');
mkdirSync(svgDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------- palette

const C = {
  skyTop: '#1e3a63',
  skyMid: '#5b93c4',
  skyLow: '#a8cfe0',
  skyHaze: '#f2cf9a',
  sun: '#ffe9b8',
  deepMid: '#3f74a8',
  deepLow: '#1d3f66',

  cloudFar: '#c3d7ea',
  cloudFarEdge: '#a3bcd4',
  cloudMid: '#eef4fb',
  cloudMidEdge: '#b9cde2',
  cloudNear: '#ffffff',
  cloudNearEdge: '#aec4da',

  peak: '#6d84a0',
  peakEdge: '#4d6079',
  peakTop: '#8fa6bd',

  stone: '#9a9384',
  stoneAlt: '#8b8474',
  stoneEdge: '#4f4a3f',
  stoneGrout: '#6d6759',

  figure: '#3f8f8a',
  figureDark: '#2a615e',
  figureSkin: '#e8b98d',
  outline: '#22303c',

  safe: '#7ce0a0',
  safeEdge: '#2f8f5a',
  hazard: '#e2564a',
  hazardEdge: '#8f2b23',
};

// ---------------------------------------------------------------- helpers

/** mulberry32 — small deterministic PRNG so art is reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = (r, lo, hi) => lo + r() * (hi - lo);
const n = (v) => Math.round(v * 100) / 100;

function svgDoc(w, h, body, background = 'none') {
  const bg =
    background === 'none'
      ? ''
      : `<rect width="${w}" height="${h}" fill="${background}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bg}${body}</svg>`;
}

/**
 * One cloud: a cluster of overlapping ellipses.
 * Drawn twice — once offset downward in the edge colour, once in the fill —
 * so every cloud carries a painted dark underside.
 */
function cloud(r, cx, cy, w, h, fill, edge, lift = 14) {
  const puffs = [];
  const count = Math.round(rand(r, 5, 9));
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const px = cx - w / 2 + t * w + rand(r, -w * 0.04, w * 0.04);
    const bulge = Math.sin(t * Math.PI);
    const rx = (w / count) * rand(r, 0.75, 1.15);
    const ry = h * rand(r, 0.42, 0.62) * (0.45 + bulge * 0.75);
    const py = cy - ry * 0.25 + rand(r, -h * 0.06, h * 0.06);
    puffs.push({ px: n(px), py: n(py), rx: n(rx), ry: n(ry) });
  }
  // a slab along the base so the cluster reads as one solid cut-out
  const baseY = n(cy + h * 0.14);
  const slab = `<rect x="${n(cx - w / 2)}" y="${n(baseY - h * 0.3)}" width="${n(w)}" height="${n(h * 0.3)}" rx="${n(h * 0.12)}"/>`;

  const shape = (dy) =>
    `<g transform="translate(0 ${dy})">${slab}${puffs
      .map((p) => `<ellipse cx="${p.px}" cy="${p.py}" rx="${p.rx}" ry="${p.ry}"/>`)
      .join('')}</g>`;

  return `<g fill="${edge}">${shape(lift)}</g><g fill="${fill}">${shape(0)}</g>`;
}

function cloudBand(opts) {
  const { w, h, seed, count, fill, edge, minScale, maxScale, yJitter, lift } = opts;
  const r = rng(seed);
  const parts = [];
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const cx = t * w + rand(r, -w / count / 3, w / count / 3);
    const s = rand(r, minScale, maxScale);
    const cw = (w / count) * 2.1 * s;
    const ch = h * 0.62 * s;
    const cy = h * 0.55 + rand(r, -yJitter, yJitter);
    parts.push(cloud(r, cx, cy, cw, ch, fill, edge, lift));
  }
  return svgDoc(w, h, parts.join(''));
}

// ---------------------------------------------------------------- sky

function makeSky() {
  const w = 2048;
  const h = 1024;
  const body = `
    <defs>
      <!--
        Top half is sky above the horizon. Below the pale horizon band the
        gradient darkens again — that is the view *downwards* into depth, and
        it is what makes the path feel high up rather than laid on a white floor.
      -->
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"   stop-color="${C.skyTop}"/>
        <stop offset="30%"  stop-color="${C.skyMid}"/>
        <stop offset="52%"  stop-color="${C.skyLow}"/>
        <stop offset="58%"  stop-color="${C.skyHaze}"/>
        <stop offset="66%"  stop-color="${C.skyLow}"/>
        <stop offset="82%"  stop-color="${C.deepMid}"/>
        <stop offset="100%" stop-color="${C.deepLow}"/>
      </linearGradient>
      <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0%"   stop-color="${C.sun}" stop-opacity="0.95"/>
        <stop offset="45%"  stop-color="${C.sun}" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="${C.sun}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#sky)"/>
    <circle cx="${w * 0.66}" cy="${h * 0.56}" r="${h * 0.30}" fill="url(#glow)"/>
    <circle cx="${w * 0.66}" cy="${h * 0.56}" r="${h * 0.032}" fill="${C.sun}"/>
  `;
  return svgDoc(w, h, body, C.skyMid);
}

// ---------------------------------------------------------------- peaks

/** Distant floating islands: jagged top, tapering spike below. */
function makePeaks() {
  const w = 2048;
  const h = 640;
  const r = rng(9182);
  const parts = [];
  const count = 7;

  for (let i = 0; i < count; i++) {
    const cx = ((i + 0.5) / count) * w + rand(r, -70, 70);
    const topW = rand(r, 150, 340);
    const topY = rand(r, h * 0.30, h * 0.52);
    const depth = rand(r, 150, 300);

    // ragged upper silhouette
    const steps = Math.round(rand(r, 4, 7));
    const top = [];
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = cx - topW / 2 + t * topW;
      const py = topY - Math.sin(t * Math.PI) * rand(r, 30, 90) - rand(r, 0, 22);
      top.push(`${n(px)},${n(py)}`);
    }
    const rightBase = `${n(cx + topW / 2)},${n(topY + 26)}`;
    const tip = `${n(cx + rand(r, -40, 40))},${n(topY + depth)}`;
    const leftBase = `${n(cx - topW / 2)},${n(topY + 26)}`;

    parts.push(
      `<polygon points="${top.join(' ')} ${rightBase} ${tip} ${leftBase}" fill="${C.peak}"/>`,
      // lit cap along the top edge
      `<polyline points="${top.join(' ')}" fill="none" stroke="${C.peakTop}" stroke-width="9" stroke-linejoin="round" stroke-linecap="round"/>`,
      // dark underside rim
      `<polygon points="${rightBase} ${tip} ${leftBase}" fill="${C.peakEdge}" opacity="0.55"/>`
    );
  }
  return svgDoc(w, h, parts.join(''));
}

// ---------------------------------------------------------------- path

/**
 * Top-down cobbled path with a fork, drawn into a square texture that gets
 * laid flat on the ground plane. v=1 (bottom) is nearest the camera.
 */
function makePath() {
  const S = 1024;
  const r = rng(4471);
  const stones = [];
  const edges = [];

  const trunkTop = 560;
  const fork = { x: 512, y: trunkTop };

  const segments = [
    { from: { x: 512, y: 1040 }, to: fork, width: 196 },
    { from: fork, to: { x: 172, y: 96 }, width: 168 },
    { from: fork, to: { x: 852, y: 96 }, width: 168 },
  ];

  for (const seg of segments) {
    const dx = seg.to.x - seg.from.x;
    const dy = seg.to.y - seg.from.y;
    const len = Math.hypot(dx, dy);
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;

    const rows = Math.max(3, Math.round(len / 48));
    for (let i = 0; i < rows; i++) {
      const t = (i + 0.5) / rows;
      const bx = seg.from.x + dx * t;
      const by = seg.from.y + dy * t;
      const cols = 4;
      for (let c = 0; c < cols; c++) {
        const off = (c - (cols - 1) / 2) * (seg.width / cols);
        const jitterN = rand(r, -6, 6);
        const jitterU = rand(r, -8, 8);
        const px = bx + nx * (off + jitterN) + ux * jitterU;
        const py = by + ny * (off + jitterN) + uy * jitterU;
        const sw = (seg.width / cols) * rand(r, 0.82, 0.98);
        const sh = 48 * rand(r, 0.66, 0.88);
        const rot = (Math.atan2(uy, ux) * 180) / Math.PI + 90 + rand(r, -7, 7);
        const fill = r() > 0.5 ? C.stone : C.stoneAlt;

        edges.push(
          `<rect x="${n(-sw / 2)}" y="${n(-sh / 2)}" width="${n(sw)}" height="${n(sh)}" rx="${n(sh * 0.22)}" fill="${C.stoneEdge}" transform="translate(${n(px)} ${n(py + 9)}) rotate(${n(rot)})"/>`
        );
        stones.push(
          `<rect x="${n(-sw / 2)}" y="${n(-sh / 2)}" width="${n(sw)}" height="${n(sh)}" rx="${n(sh * 0.22)}" fill="${fill}" transform="translate(${n(px)} ${n(py)}) rotate(${n(rot)})"/>`
        );
      }
    }
  }

  const body = `<g>${edges.join('')}</g><g>${stones.join('')}</g>`;
  return svgDoc(S, S, body);
}

// ---------------------------------------------------------------- figure

/** Simple robed cut-out figure, flat colours, heavy outline. */
function makeFigure() {
  const w = 320;
  const h = 560;
  const body = `
    <g stroke="${C.outline}" stroke-width="10" stroke-linejoin="round">
      <!-- robe -->
      <path d="M160 190 C 214 190 236 250 246 420 L 258 494 L 62 494 L 74 420 C 84 250 106 190 160 190 Z" fill="${C.figure}"/>
      <!-- shaded left side, painted-on form -->
      <path d="M160 190 C 106 190 84 250 74 420 L 62 494 L 138 494 L 132 420 C 128 280 138 214 160 190 Z" fill="${C.figureDark}" stroke="none"/>
      <!-- arms -->
      <path d="M96 250 C 68 292 62 344 70 386" fill="none" stroke-linecap="round"/>
      <path d="M224 250 C 252 292 258 344 250 386" fill="none" stroke-linecap="round"/>
      <!-- head -->
      <circle cx="160" cy="132" r="62" fill="${C.figureSkin}"/>
      <!-- hood brim -->
      <path d="M92 118 C 104 62 216 62 228 118 C 200 92 120 92 92 118 Z" fill="${C.figureDark}"/>
    </g>
    <g fill="${C.outline}">
      <circle cx="139" cy="140" r="8"/>
      <circle cx="184" cy="140" r="8"/>
    </g>
  `;
  return svgDoc(w, h, body);
}

// ---------------------------------------------------------------- markers

/** A weathered stone marker post to stand beside the path and cast a shadow. */
function makePillar() {
  const w = 256;
  const h = 640;
  const r = rng(7733);
  const chunks = [];
  let y = 610;
  while (y > 90) {
    const bh = rand(r, 54, 96);
    const bw = rand(r, 132, 176) * (0.72 + (y / 610) * 0.34);
    const skew = rand(r, -7, 7);
    chunks.push(
      `<rect x="${n(128 - bw / 2)}" y="${n(y - bh + 8)}" width="${n(bw)}" height="${n(bh)}" rx="9" fill="${C.stoneEdge}" transform="rotate(${n(skew)} 128 ${n(y)})"/>`,
      `<rect x="${n(128 - bw / 2)}" y="${n(y - bh)}" width="${n(bw)}" height="${n(bh)}" rx="9" fill="${r() > 0.5 ? C.stone : C.stoneAlt}" transform="rotate(${n(skew)} 128 ${n(y)})"/>`
    );
    y -= bh + rand(r, 2, 7);
  }
  const cap = `<path d="M56 96 L 200 96 L 176 44 L 80 44 Z" fill="${C.stoneGrout}" stroke="${C.stoneEdge}" stroke-width="8" stroke-linejoin="round"/>`;
  return svgDoc(w, h, chunks.join('') + cap);
}

function makeSafeMarker() {
  const w = 256;
  const h = 256;
  const body = `
    <g stroke="${C.safeEdge}" stroke-width="12" stroke-linejoin="round" stroke-linecap="round">
      <path d="M128 26 L 226 128 L 170 128 L 170 230 L 86 230 L 86 128 L 30 128 Z" fill="${C.safe}"/>
    </g>`;
  return svgDoc(w, h, body);
}

function makeHazardMarker() {
  const w = 256;
  const h = 256;
  const body = `
    <g stroke="${C.hazardEdge}" stroke-width="12" stroke-linejoin="round">
      <path d="M128 22 L 240 224 L 16 224 Z" fill="${C.hazard}"/>
    </g>
    <g fill="${C.hazardEdge}">
      <rect x="114" y="96" width="28" height="70" rx="12"/>
      <circle cx="128" cy="192" r="16"/>
    </g>`;
  return svgDoc(w, h, body);
}

// ---------------------------------------------------------------- build

const assets = [
  { name: 'sky', svg: makeSky() },
  {
    name: 'clouds-far',
    svg: cloudBand({
      w: 2048, h: 384, seed: 101, count: 6,
      fill: C.cloudFar, edge: C.cloudFarEdge,
      minScale: 0.75, maxScale: 1.05, yJitter: 26, lift: 9,
    }),
  },
  { name: 'peaks', svg: makePeaks() },
  {
    name: 'clouds-mid',
    svg: cloudBand({
      w: 2048, h: 512, seed: 202, count: 5,
      fill: C.cloudMid, edge: C.cloudMidEdge,
      minScale: 0.9, maxScale: 1.25, yJitter: 44, lift: 16,
    }),
  },
  {
    name: 'clouds-near',
    svg: cloudBand({
      w: 2048, h: 512, seed: 303, count: 4,
      fill: C.cloudNear, edge: C.cloudNearEdge,
      minScale: 1.05, maxScale: 1.5, yJitter: 52, lift: 22,
    }),
  },
  { name: 'path', svg: makePath() },
  { name: 'figure', svg: makeFigure() },
  { name: 'pillar', svg: makePillar() },
  { name: 'marker-safe', svg: makeSafeMarker() },
  { name: 'marker-hazard', svg: makeHazardMarker() },
];

let total = 0;
for (const a of assets) {
  const svgPath = join(svgDir, `${a.name}.svg`);
  writeFileSync(svgPath, a.svg, 'utf8');

  const pngPath = join(outDir, `${a.name}.png`);
  const buf = await sharp(Buffer.from(a.svg)).png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(pngPath, buf);
  total += buf.length;
  const meta = await sharp(buf).metadata();
  console.log(
    `  ${a.name.padEnd(14)} ${String(meta.width).padStart(4)}x${String(meta.height).padEnd(4)}  ${(buf.length / 1024).toFixed(0)} KB`
  );
}
console.log(`\n  total texture payload: ${(total / 1024).toFixed(0)} KB`);
