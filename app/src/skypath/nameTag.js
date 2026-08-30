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
const CARD_BG_SRC = 'textures/card-background.png';

// -- the four constants agreed with Luke on 2026-08-29/30 via the live
// slider prototype (app/descender-tuner.html) -- do not re-tune these
// without cause; re-open that prototype instead of guessing new numbers.
const UPPER_H = 150;
const LOWER_H = Math.round(UPPER_H * 0.7); // lowercase = 70% of uppercase height
const DESC_OFFSET = 6;                     // g/j/p/q/y shift down 6px from bottom-aligned bbox
const J_SCALE = 1.15;                      // lowercase j renders 15% larger, with proportional side-gaps

const SPACING = 10;   // gap between ordinary letters
const PAD_X = 40;
const PAD_Y = 40;
const DESCENDERS = new Set(['g', 'j', 'p', 'q', 'y']);

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
  return /[A-Z]/.test(ch) ? `${LETTER_BASE}/upper-v2/${ch}.png` : `${LETTER_BASE}/lower/${ch}.png`;
}

/**
 * Renders `name` onto an offscreen canvas: the stretched cardboard
 * background with each letter stamped on top, soft-shadowed, laid out
 * left-to-right at the tuned sizes/offsets. Returns the canvas plus its
 * aspect ratio (height/width) so the caller can size a world-space plane
 * without distorting it.
 */
export async function buildNameTagCanvas(name) {
  const chars = [...name];
  const [glyphs, cardImg] = await Promise.all([
    Promise.all(chars.map((ch) => loadImage(letterSrc(ch)))),
    loadImage(CARD_BG_SRC),
  ]);

  const laid = chars.map((ch, i) => {
    const img = glyphs[i];
    let h = /[A-Z]/.test(ch) ? UPPER_H : LOWER_H;
    if (ch === 'j') h = Math.round(h * J_SCALE);
    const w = img.width * (h / img.height);
    const gapLeft = ch === 'j' ? SPACING * (J_SCALE - 1) : 0;
    const gapRight = ch === 'j' ? SPACING * J_SCALE : SPACING;
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
    let y = baselineY - l.h;
    if (DESCENDERS.has(l.ch)) y += DESC_OFFSET;
    ctx.save();
    ctx.globalAlpha = 0.35;
    if ('filter' in ctx) ctx.filter = 'blur(3px)';
    ctx.drawImage(l.img, x + 2, y + 4, l.w, l.h);
    ctx.restore();
    ctx.drawImage(l.img, x, y, l.w, l.h);
    x += l.w + l.gapRight;
  }

  return { canvas, aspect: totalH / totalW };
}

/**
 * "Alice" -> "Alice", "BOB" -> "Bob", "  al ex 99" -> "Alex" — strips
 * anything that isn't a letter (the extracted art only covers A-Z/a-z) and
 * applies "first letter capital, the rest lower case" per Luke's spec.
 * Truncates to 10 characters after stripping, matching the input's own
 * maxlength (kept here too since callers other than the one input field
 * shouldn't have to remember the limit).
 */
export function normalizePlayerName(raw) {
  const letters = (raw || '').replace(/[^a-zA-Z]/g, '').slice(0, 10);
  if (!letters) return '';
  return letters[0].toUpperCase() + letters.slice(1).toLowerCase();
}
