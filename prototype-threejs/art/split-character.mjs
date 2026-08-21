/**
 * Splits a die-cut "cardboard standee" character image into two layers:
 *
 *   {name}.png          the character cutout, backing made transparent
 *   {name}-backing.png   the backing board's shape alone, in grayscale
 *                        (so its natural fold/shadow shading survives),
 *                        with alpha matching that same shape
 *
 * The split works because the backing board is a single distinct hue
 * (whatever the artwork uses) while the character art — skin, clothing,
 * outlines — sits in a very different part of the hue wheel. The backing's
 * *reference* hue is auto-detected from the image's own border pixels
 * (which are reliably backing, never character), so nothing about a
 * specific piece of art is hardcoded here.
 *
 * At runtime the two layers are stacked as one rig (see makeCharacterRig in
 * main.js) with the backing's flat white multiplied by whatever colour the
 * player picks — since the backing texture already carries the original
 * lightness variation, the recolour keeps the folds and shadows.
 *
 * Usage: node art/split-character.mjs "path/to/source.png" output-name
 */

import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'textures');

const [, , srcPath, outName] = process.argv;
if (!srcPath || !outName) {
  console.error('Usage: node art/split-character.mjs <source.png> <output-name>');
  process.exit(1);
}

// ---------------------------------------------------------------- colour helpers

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

/** Shortest distance between two hues on the 360° wheel. */
function hueDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------- main

const { data, info } = await sharp(srcPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H, channels } = info; // channels === 4

// Detect the backing's reference hue by histogram mode across the whole
// image, weighted by saturation. The backing board occupies more area than
// the character on every standee of this style, so its hue bucket wins
// regardless of how much margin the die-cut leaves around the edges (which
// rules out just sampling the image border — on this art that margin is
// transparent, not backing).
const HUE_BUCKETS = 72; // 5° each
const hist = new Float64Array(HUE_BUCKETS);
let sumL = 0, lCount = 0;
for (let i = 0; i < W * H; i++) {
  const o = i * channels;
  const a = data[o + 3];
  if (a < 200) continue;
  const { h, s, l } = rgbToHsl(data[o], data[o + 1], data[o + 2]);
  if (s < 0.15) continue; // achromatic — not informative for hue
  hist[Math.floor(h / 5) % HUE_BUCKETS] += s;
  sumL += l;
  lCount++;
}
if (lCount < 1) {
  console.error('Could not find enough saturated pixels to detect the backing hue.');
  process.exit(1);
}
let peakBucket = 0;
for (let i = 1; i < HUE_BUCKETS; i++) if (hist[i] > hist[peakBucket]) peakBucket = i;
// Refine with a saturation-weighted circular mean of pixels near the peak
// bucket, rather than trusting the bucket centre alone.
const peakHue = peakBucket * 5 + 2.5;
let sumSin = 0, sumCos = 0, weightTotal = 0;
for (let i = 0; i < W * H; i++) {
  const o = i * channels;
  const a = data[o + 3];
  if (a < 200) continue;
  const { h, s } = rgbToHsl(data[o], data[o + 1], data[o + 2]);
  if (s < 0.15) continue;
  if (hueDist(h, peakHue) > 20) continue;
  const rad = (h * Math.PI) / 180;
  sumSin += Math.sin(rad) * s;
  sumCos += Math.cos(rad) * s;
  weightTotal += s;
}
const refHue = (Math.atan2(sumSin, sumCos) * 180) / Math.PI;
const refHueNorm = refHue < 0 ? refHue + 360 : refHue;
const refLightness = sumL / lCount;

// Hue-distance band for the backing/character split. Inside HUE_IN it's
// fully backing, outside HUE_OUT it's fully character, feathered between —
// that feather is what keeps the character's outline anti-aliasing clean
// instead of a hard stair-step edge.
const HUE_IN = 28;
const HUE_OUT = 55;
const SAT_MIN = 0.12; // below this, a pixel is achromatic (outline/highlight) — never backing

const charOut = Buffer.alloc(W * H * 4);
const backOut = Buffer.alloc(W * H * 4);

let backingPixelCount = 0;
for (let i = 0; i < W * H; i++) {
  const o = i * 4;
  const r = data[o], g = data[o + 1], b = data[o + 2], a = data[o + 3];
  const { h, s, l } = rgbToHsl(r, g, b);

  let bgWeight = 0;
  if (a > 0 && s >= SAT_MIN) {
    const d = hueDist(h, refHueNorm);
    bgWeight = 1 - smoothstep(HUE_IN, HUE_OUT, d);
  }

  charOut[o] = r; charOut[o + 1] = g; charOut[o + 2] = b;
  charOut[o + 3] = Math.round(a * (1 - bgWeight));

  const gray = Math.round(l * 255);
  backOut[o] = gray; backOut[o + 1] = gray; backOut[o + 2] = gray;
  backOut[o + 3] = Math.round(a * bgWeight);
  if (bgWeight > 0.5) backingPixelCount++;
}

const charBuf = await sharp(charOut, { raw: { width: W, height: H, channels: 4 } })
  .png({ compressionLevel: 9, palette: true })
  .toBuffer();
const backBuf = await sharp(backOut, { raw: { width: W, height: H, channels: 4 } })
  .png({ compressionLevel: 9, palette: true })
  .toBuffer();

writeFileSync(join(outDir, `${outName}.png`), charBuf);
writeFileSync(join(outDir, `${outName}-backing.png`), backBuf);

console.log(`detected backing hue: ${refHueNorm.toFixed(1)}°  reference lightness: ${refLightness.toFixed(2)}`);
console.log(`backing pixels: ${backingPixelCount} / ${W * H} (${((backingPixelCount / (W * H)) * 100).toFixed(1)}%)`);
console.log(`wrote ${outName}.png (${(charBuf.length / 1024).toFixed(0)} KB) and ${outName}-backing.png (${(backBuf.length / 1024).toFixed(0)} KB)`);
