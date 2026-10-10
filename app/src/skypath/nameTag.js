/**
 * Builds a cardboard-cutout name-tag texture from the extracted letter art
 * (see TODO.md, "Cardboard lettering: name tags and signage" for the full
 * history of that art and why it looks the way it does).
 *
 * This is a live, in-browser port of the bash/ImageMagick reference script
 * (app/scripts/render-cardboard-text.sh) that was used to preview and tune
 * it — same four constants, same layout logic, just Canvas2D instead of
 * ImageMagick. Keep the two in sync if either changes.
 */

const LETTER_BASE = 'textures/letters';
const CARD_BG_SRC = 'textures/card-background.webp';

// -- the four constants agreed with Luke on 2026-08-29/30 via the live
// slider prototype (app/descender-tuner.html) -- do not re-tune these
// without cause; re-open that prototype instead of guessing new numbers.
const UPPER_H = 150;
const LOWER_H = Math.round(UPPER_H * 0.7); // lowercase = 70% of uppercase height
const DESC_OFFSET = 6;                     // g/j/p/q/y shift down 6px from bottom-aligned bbox
const J_SCALE = 1.15;                      // lowercase j renders 15% larger, with proportional side-gaps

const SPACING = 10;   // gap between ordinary letters
const WORD_GAP = 34;  // extra gap for a literal space, e.g. "Player One" — matches render-cardboard-text.sh's WORD_GAP
const PAD_X = 40;
const PAD_Y = 40;
const DESCENDERS = new Set(['g', 'j', 'p', 'q', 'y']);

// Per-letter size corrections, agreed with Luke 2026-08-31 after he compared
// every lowercase letter side by side in app/letter-size-tuner.html. That
// tool's "100%" meant "this letter's current baked appearance" — so these
// multiply on top of whatever a letter's height already was (LOWER_H
// normally, LOWER_H * J_SCALE for j, since the tuner's j baseline already
// included that boost). j's two multipliers are deliberately stacked, not a
// duplicate: 1.15 (below) * 1.15 (here) = j renders at ~1.32x a plain
// lowercase letter's height, which is what Luke actually approved in the
// tool, not a bug to "simplify" back to one number. Letters not listed here
// default to 1 (unchanged). Re-open the tuner rather than guessing if any
// of these need revisiting.
const LETTER_SCALE = {
  b: 1.18,
  d: 1.15,
  f: 1.14,
  g: 1.06,
  h: 1.24,
  i: 1.19,
  j: 1.15,
  k: 1.2, // Luke, 2026-09-09: read a bit small next to the other lowercase letters — 20% bigger
  l: 1.15,
  p: 1.12,
  q: 1.05,
  t: 1.15,
  u: 0.9,
};

// Outline/glow, added 2026-08-30 because the letters read poorly at the
// small on-screen size a name tag actually renders at. Built from each
// glyph's ALPHA channel only (via canvas shadow, which shadows the drawn
// image's alpha regardless of its RGB) — the corrugation stripe detail
// lives entirely in RGB, so this can't trace the internal stripes even in
// principle, only the true letter silhouette. Default color is a warm
// cream that reads well against the tan cardboard; pass `glowColor` to
// override (wired to the character-select colour palette — see skyPath.js).
// Cream (#fff3d6) was the first attempt and turned out too close in
// lightness to the cardboard to read as an outline at all once shrunk to
// actual name-tag size — tested side by side with white, gold, cyan and
// near-black at both full res and a simulated small size, gold was the
// clear winner for reading at a glance without looking like a neon sign.
// Blur/passes are exposed as tunable params (see the bottom-right "name tag"
// slider panel behind ?tune=1) rather than fixed here — 2026-08-30, Luke
// found the first pass "still not very visible" and asked for live
// thickness/brightness sliders before settling on final numbers, the same
// process used for the descender/j-size constants above. These are the
// starting defaults the sliders open at, already pushed up from the
// original (blur 7, 2 passes) since that was confirmed too subtle.
export const GLOW_BLUR_DEFAULT = 12;     // canvas px, at the UPPER_H=150 scale above — "thickness"
export const GLOW_PASSES_DEFAULT = 4;    // repeated shadow draws re-saturate the blurred edge; more = "brighter"/more solid, not just thicker

// FINAL, agreed with Luke 2026-08-31 via the same bottom-right slider panel
// (?tune=1) — gamma slightly below 1 darkens the midtones a touch, contrast
// and saturation both pushed up meaningfully, together doing more for
// readability than the glow alone (see TODO.md). Re-open the tuner rather
// than guessing if these need revisiting.
export const GAMMA_DEFAULT = 0.85;
export const CONTRAST_DEFAULT = 1.4;
export const SATURATION_DEFAULT = 1.3;

const imageCache = new Map();
function loadImage(src) {
  if (imageCache.has(src)) return imageCache.get(src);
  const p = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`nameTag: failed to load ${src}`));
    img.src = src;
  });
  imageCache.set(src, p);
  return p;
}

function letterSrc(ch) {
  return /[A-Z]/.test(ch) ? `${LETTER_BASE}/upper-v2/${ch}.webp` : `${LETTER_BASE}/lower/${ch}.webp`;
}

// Gamma/contrast/saturation, added 2026-08-30 as the alternative to chasing
// the glow further: Luke found in a still-image photo viewer that adjusting
// these on the raw cardboard photo made the lettering noticeably more
// readable, gamma most of all. Applied once to the fully-composited canvas
// (background + letters + glow together) rather than to any one layer,
// since that's what a "whole image" edit in a photo viewer does. All three
// default to a no-op (1) so a name tag with untouched sliders looks exactly
// like it did before this existed.
//
// Contrast/saturation are native canvas filter primitives — cheap, one
// draw call. Gamma is not a canvas filter primitive (there's no
// `ctx.filter` keyword for it), so it needs a manual per-pixel remap via
// getImageData/putImageData; still trivial at this canvas's size (well
// under a millisecond) and it only runs once per name, not per frame.
function applyPostFX(canvas, { gamma = 1, contrast = 1, saturation = 1 } = {}) {
  if (gamma === 1 && contrast === 1 && saturation === 1) return canvas;

  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const octx = out.getContext('2d');

  octx.filter = `contrast(${contrast * 100}%) saturate(${saturation * 100}%)`;
  octx.drawImage(canvas, 0, 0);
  octx.filter = 'none';

  if (gamma !== 1) {
    const imgData = octx.getImageData(0, 0, out.width, out.height);
    const data = imgData.data;
    const invGamma = 1 / gamma;
    // 256-entry lookup table so each pixel is an array read, not a Math.pow
    // call — the loop below runs 3x per pixel across the whole canvas.
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = Math.round(255 * Math.pow(i / 255, invGamma));
    for (let i = 0; i < data.length; i += 4) {
      data[i] = lut[data[i]];
      data[i + 1] = lut[data[i + 1]];
      data[i + 2] = lut[data[i + 2]];
      // alpha (data[i + 3]) is untouched -- gamma is a brightness curve, not a transparency one
    }
    octx.putImageData(imgData, 0, 0);
  }

  return out;
}

/**
 * Renders `name` onto an offscreen canvas: the stretched cardboard
 * background with each letter stamped on top, soft-shadowed, laid out
 * left-to-right at the tuned sizes/offsets. Returns the canvas plus its
 * aspect ratio (height/width) so the caller can size a world-space plane
 * without distorting it.
 */
export async function buildNameTagCanvas(name, options = {}) {
  const {
    glowColor = GLOW_COLOR_DEFAULT,
    glowBlur = GLOW_BLUR_DEFAULT,
    glowPasses = GLOW_PASSES_DEFAULT,
    gamma = GAMMA_DEFAULT,
    contrast = CONTRAST_DEFAULT,
    saturation = SATURATION_DEFAULT,
  } = options;
  const chars = [...name];
  // Spaces (e.g. "Player One", added 2026-08-30 alongside the "Player One"
  // default) have no glyph art — skip loading one and lay them out as a
  // plain gap below, matching render-cardboard-text.sh's WORD_GAP.
  const [glyphs, cardImg] = await Promise.all([
    Promise.all(chars.map((ch) => (ch === ' ' ? null : loadImage(letterSrc(ch))))),
    loadImage(CARD_BG_SRC),
  ]);

  const laid = chars.map((ch, i) => {
    if (ch === ' ') return { img: null, ch, h: 0, w: 0, gapLeft: 0, gapRight: WORD_GAP, isSpace: true };
    const img = glyphs[i];
    const isUpper = /[A-Z]/.test(ch);
    let h = isUpper ? UPPER_H : LOWER_H;
    if (ch === 'j') h *= J_SCALE;
    h = Math.round(h * (isUpper ? 1 : (LETTER_SCALE[ch] ?? 1)));
    const w = img.width * (h / img.height);
    // Extra side-gap grows with how much taller than a normal lowercase
    // letter this glyph ends up (generalises the old j-only rule to every
    // letter in LETTER_SCALE) — letters at or below normal height (u, most
    // of the alphabet) get the plain fixed gap, no shrinking.
    const totalRatio = isUpper ? 1 : h / LOWER_H;
    const gapLeft = totalRatio > 1 ? SPACING * (totalRatio - 1) : 0;
    const gapRight = totalRatio > 1 ? SPACING * totalRatio : SPACING;
    return { img, ch, h, w, gapLeft, gapRight };
  });

  const baselineY = PAD_Y + UPPER_H;
  const contentW = laid.reduce((sum, l) => sum + l.gapLeft + l.w + l.gapRight, 0);
  const totalW = Math.max(1, Math.round(PAD_X * 2 + contentW));
  const totalH = PAD_Y + UPPER_H + PAD_Y + 20; // +20 slack for the deepened descenders

  const canvas = document.createElement('canvas');
  canvas.width = totalW;
  canvas.height = totalH;
  const ctx = canvas.getContext('2d');

  // background: cover-crop (scale + center-crop, no distortion) — see
  // TODO.md, this is still the simple version; a proper 3-slice/tileable
  // background for very long names is flagged there as not yet built.
  const scale = Math.max(totalW / cardImg.width, totalH / cardImg.height);
  const bw = cardImg.width * scale;
  const bh = cardImg.height * scale;
  ctx.drawImage(cardImg, (totalW - bw) / 2, (totalH - bh) / 2, bw, bh);

  let x = PAD_X;
  for (const l of laid) {
    x += l.gapLeft;
    if (l.isSpace) { x += l.gapRight; continue; }
    let y = baselineY - l.h;
    if (DESCENDERS.has(l.ch)) y += DESC_OFFSET;
    // 1. drop shadow — dark, offset, faint: a subtle depth cue, unrelated
    // to the new glow below.
    ctx.save();
    ctx.globalAlpha = 0.35;
    if ('filter' in ctx) ctx.filter = 'blur(3px)';
    ctx.drawImage(l.img, x + 2, y + 4, l.w, l.h);
    ctx.restore();

    // 2. glow — colored, centered, blurred: this is what fixes readability
    // at small size. Drawing with shadowBlur set also draws the source
    // image itself (crisp, on top of its own shadow), so this one call
    // produces "glow behind + real letter on top" together; repeated
    // glowPasses times because a single native-shadow pass reads as thin
    // and semi-transparent rather than a solid outline — each extra pass
    // re-saturates the already-blurred edge toward opaque, which is what
    // "brighter" actually means here (the shadow color itself is already
    // fully opaque; there's no alpha left to raise directly).
    ctx.save();
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = glowBlur;
    for (let pass = 0; pass < glowPasses; pass++) {
      ctx.drawImage(l.img, x, y, l.w, l.h);
    }
    ctx.restore();

    x += l.w + l.gapRight;
  }

  const finalCanvas = applyPostFX(canvas, { gamma, contrast, saturation });
  return { canvas: finalCanvas, aspect: totalH / totalW };
}

/**
 * "Alice" -> "Alice", "BOB" -> "Bob", "  al ex 99" -> "Al ex" — strips
 * anything that isn't a letter or space (the extracted art only covers
 * A-Z/a-z, plus a plain gap for a literal space — see WORD_GAP above) and
 * capitalizes the first letter of each word, lower-casing the rest. Spaces
 * added 2026-08-30 so names like "Player One" (the empty-input default, see
 * skyPath.js) render as two words rather than being stripped to one.
 * Truncates to 10 characters after stripping, matching the input's own
 * maxlength (kept here too since callers other than the one input field
 * shouldn't have to remember the limit).
 */
export function normalizePlayerName(raw) {
  const cleaned = (raw || '').replace(/[^a-zA-Z ]/g, '').replace(/\s+/g, ' ').slice(0, 10).trim();
  if (!cleaned) return '';
  return cleaned
    .split(' ')
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
