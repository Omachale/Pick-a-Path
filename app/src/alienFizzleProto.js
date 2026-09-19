/**
 * ==========================================================================
 * CARDBOARD UI — six candidates for the avatar's "appearance" effect
 * ==========================================================================
 * Read `src/dialProto.js`'s header first (cardboard UI design doc), then
 * `src/alienTargetPickerProto.js`'s (the screen this effect will eventually
 * play on — this page does NOT integrate it there yet). TODO.md points at
 * all the cardboard UI files.
 *
 * What this is: Luke, 2026-09-17 — "add a very quick animation with a
 * green sci-fi static fizzle that starts at the bottom and works its way
 * up, to show the appearance of the player's avatars. In fact, show me six
 * different prototypes for this effect before doing anything else, and
 * I'll pick the best one." Deliberately NOT wired into the real target
 * picker — this is only for comparing the six, side by side, on demand.
 *
 * All six share the same two facts (bottom-to-top, green) and differ in
 * HOW the boundary between hidden and revealed actually reads:
 *   1. Hard wipe + static band   — a clean cut, with a flickering band of
 *      green TV-static noise riding the edge as it rises.
 *   2. Glitch slices             — a band of thin horizontal slices just
 *      above the clean edge, randomly shifted sideways and green-tinted,
 *      like a signal struggling to lock on (VHS tracking error).
 *   3. Scanline sweep            — a clean wipe, PLUS moving green scanlines
 *      washing over the whole avatar for the duration, fading out as the
 *      reveal finishes; a bright line rides the edge itself.
 *   4. Particle dissolve         — no hard edge at all: a scattered field of
 *      green dots, denser near the boundary and sparser above it, so the
 *      avatar reads as condensing out of static rather than being wiped.
 *   5. CRT flicker + jitter      — the revealed part itself judders a few
 *      px sideways (settling out as the reveal completes) and irregular
 *      bright bars flash near the edge, like an unstable picture tube.
 *   6. Organic threshold reveal  — the ONLY non-straight edge: a fixed grid
 *      of cells, each given a random reveal threshold biased (not fixed)
 *      toward "lower thresholds nearer the bottom," so cells still
 *      overwhelmingly fill in bottom-to-top but the boundary itself is
 *      ragged, not a ruler-straight line; each cell flashes green briefly
 *      the instant it reveals.
 *
 * All six are pure Canvas2D drawImage/fillRect — no per-pixel ImageData
 * work, so they stay cheap even though this avatar art is a photo, not a
 * flat colour.
 *
 * NOT BUILT YET: which one Luke picks going into alienTargetPickerProto.js
 * at all; combining this with the spin that file already has (a natural
 * next question — does the fizzle play before the spin starts, or does the
 * avatar reveal WHILE already spinning?); real timing off a genuine trigger
 * rather than a button.
 */

import { PANEL_SRC, PANEL_SIZE, loadImage, drawPanel } from './cardboardPanel.js';

// --- duplicated from alienInterfaceProto.js (a FOURTH copy now — see that
// file's header; this project really does want a shared module for these
// four numbers at this point) ---
const INTERFACE_SRC = 'textures/alien-interface-trimmed.jpg';
const INTERFACE_ASPECT = 992 / 487;
const FINAL_WIDTH = 860;
const FINAL_CENTRE = { x: 516, y: 312 };
function finalRect() {
  const w = FINAL_WIDTH;
  const h = w / INTERFACE_ASPECT;
  return { x: FINAL_CENTRE.x - w / 2, y: FINAL_CENTRE.y - h / 2, w, h };
}
// --- end duplicated block ---

// Same avatar geometry alienTargetPickerProto.js bakes in, so this preview
// is at true in-context scale.
const AVATAR_HEIGHT = 224;
const AVATAR_CENTER_Y = 343;
const AVATAR_SRC = 'textures/figure-indy.png';

const GREEN = { r: 120, g: 255, b: 160 };
function greenRgba(a, boost = 0) {
  return `rgba(${Math.min(255, GREEN.r + boost)}, 255, ${Math.min(255, GREEN.g + boost)}, ${a})`;
}

function avatarRect(img) {
  const aspect = img.naturalWidth / img.naturalHeight;
  const w = AVATAR_HEIGHT * aspect;
  return { x: FINAL_CENTRE.x - w / 2, y: AVATAR_CENTER_Y - AVATAR_HEIGHT / 2, w, h: AVATAR_HEIGHT };
}

/** Clips to the already-revealed band (below `revealY`) and draws the avatar cleanly — every variant's baseline. */
function drawRevealedPart(ctx, img, r, revealY, xJitter = 0) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, revealY, r.w, r.y + r.h - revealY);
  ctx.clip();
  ctx.drawImage(img, r.x + xJitter, r.y, r.w, r.h);
  ctx.restore();
}

// ---------------------------------------------------------------- variant 1
function effect1(ctx, img, r, p) {
  const revealY = r.y + r.h * (1 - p);
  drawRevealedPart(ctx, img, r, revealY);
  if (p <= 0 || p >= 1) return;
  const bandH = 20;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, revealY - bandH / 2, r.w, bandH);
  ctx.clip();
  const blockW = 5;
  for (let x = r.x; x < r.x + r.w; x += blockW) {
    const bright = Math.random();
    ctx.fillStyle = greenRgba(0.35 + bright * 0.55, bright * 40);
    ctx.fillRect(x, revealY - bandH / 2, blockW, bandH * Math.random());
  }
  ctx.restore();
}

// ---------------------------------------------------------------- variant 2
function effect2(ctx, img, r, p) {
  const revealY = r.y + r.h * (1 - p);
  drawRevealedPart(ctx, img, r, revealY);
  if (p <= 0 || p >= 1) return;
  const glitchH = 46;
  const top = Math.max(r.y, revealY - glitchH);
  const sliceH = 4;
  for (let y = top; y < revealY; y += sliceH) {
    if (Math.random() < 0.35) continue; // gaps read as signal drop-outs
    const offset = (Math.random() - 0.5) * 26;
    const srcY = ((y - r.y) / r.h) * img.naturalHeight;
    const srcH = (sliceH / r.h) * img.naturalHeight;
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, y, r.w, sliceH);
    ctx.clip();
    ctx.drawImage(img, 0, srcY, img.naturalWidth, srcH, r.x + offset, y, r.w, sliceH);
    ctx.fillStyle = greenRgba(0.32);
    ctx.fillRect(r.x, y, r.w, sliceH);
    ctx.restore();
  }
}

// ---------------------------------------------------------------- variant 3
function effect3(ctx, img, r, p, t) {
  const revealY = r.y + r.h * (1 - p);
  drawRevealedPart(ctx, img, r, revealY);

  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.globalAlpha = Math.max(0, 1 - p) * 0.55;
  ctx.strokeStyle = greenRgba(0.9, 60);
  ctx.lineWidth = 1;
  const spacing = 6;
  const offset = (t * 140) % spacing;
  for (let y = r.y - spacing + offset; y < r.y + r.h; y += spacing) {
    ctx.beginPath();
    ctx.moveTo(r.x, y);
    ctx.lineTo(r.x + r.w, y);
    ctx.stroke();
  }
  ctx.restore();

  if (p > 0 && p < 1) {
    ctx.fillStyle = greenRgba(0.85, 80);
    ctx.fillRect(r.x, revealY - 2, r.w, 4);
  }
}

// ---------------------------------------------------------------- variant 4
function effect4(ctx, img, r, p) {
  const revealY = r.y + r.h * (1 - p);
  drawRevealedPart(ctx, img, r, revealY);
  if (p <= 0 || p >= 1) return;
  const zoneH = 80;
  const top = Math.max(r.y, revealY - zoneH);
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, top, r.w, Math.max(0, revealY - top));
  ctx.clip();
  for (let i = 0; i < 220; i++) {
    const y = top + Math.random() * (revealY - top);
    const density = 1 - (revealY - y) / zoneH; // nearer the edge = denser
    if (Math.random() > density * 0.9 + 0.05) continue;
    const x = r.x + Math.random() * r.w;
    const size = 1.5 + Math.random() * 3.5;
    ctx.fillStyle = greenRgba(0.35 + Math.random() * 0.55, Math.random() * 40);
    ctx.fillRect(x, y, size, size);
  }
  ctx.restore();
}

// ---------------------------------------------------------------- variant 5
function effect5(ctx, img, r, p) {
  const revealY = r.y + r.h * (1 - p);
  const jitter = p > 0 && p < 1 ? (1 - p) * (Math.random() - 0.5) * 8 : 0;
  drawRevealedPart(ctx, img, r, revealY, jitter);
  if (p <= 0 || p >= 1) return;
  for (let i = 0; i < 3; i++) {
    if (Math.random() < 0.45) continue;
    const by = revealY - Math.random() * 26;
    if (by < r.y) continue;
    const bh = 2 + Math.random() * 4;
    ctx.fillStyle = greenRgba(0.5 + Math.random() * 0.5, 80);
    ctx.fillRect(r.x, by, r.w, bh);
  }
}

// ---------------------------------------------------------------- variant 6
const GRID_CELL = 9;
function makeGrid(r) {
  const cols = Math.ceil(r.w / GRID_CELL);
  const rows = Math.ceil(r.h / GRID_CELL);
  const cells = [];
  for (let ry = 0; ry < rows; ry++) {
    const fracFromBottom = rows > 1 ? ry / (rows - 1) : 1; // ry=0 is the TOP row (dy = r.y), so bottom-ness rises WITH ry — 1 at the bottom row, 0 at the top
    for (let rx = 0; rx < cols; rx++) {
      // Biased, not fixed: mostly bottom-up, but random enough that the
      // edge is ragged rather than a straight line.
      const threshold = Math.min(1, Math.max(0, (1 - fracFromBottom) * 0.7 + Math.random() * 0.4));
      cells.push({ rx, ry, threshold });
    }
  }
  return { cols, rows, cells };
}
function effect6(ctx, img, r, p, t, grid) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  for (const c of grid.cells) {
    if (c.threshold > p) continue;
    const dx = r.x + c.rx * GRID_CELL;
    const dy = r.y + c.ry * GRID_CELL;
    const dw = Math.min(GRID_CELL, r.x + r.w - dx);
    const dh = Math.min(GRID_CELL, r.y + r.h - dy);
    const sx = ((dx - r.x) / r.w) * img.naturalWidth;
    const sy = ((dy - r.y) / r.h) * img.naturalHeight;
    const sw = (dw / r.w) * img.naturalWidth;
    const sh = (dh / r.h) * img.naturalHeight;
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    const age = p - c.threshold;
    if (age < 0.1) ctx.fillStyle = greenRgba((1 - age / 0.1) * 0.85, 60);
    else continue;
    ctx.fillRect(dx, dy, dw, dh);
  }
  ctx.restore();
}

const VARIANTS = [effect1, effect2, effect3, effect4, effect5, effect6];

async function main() {
  const [panelImg, interfaceImg, avatarImg] = await Promise.all([
    loadImage(PANEL_SRC),
    loadImage(INTERFACE_SRC),
    loadImage(AVATAR_SRC),
  ]);

  const canvas = document.getElementById('c');
  canvas.width = PANEL_SIZE.w;
  canvas.height = PANEL_SIZE.h;
  const ctx = canvas.getContext('2d');
  const r = avatarRect(avatarImg);

  const durationInput = document.getElementById('duration');
  const durationOut = document.getElementById('durationV');
  durationInput.addEventListener('input', () => {
    durationOut.textContent = `${Number(durationInput.value).toFixed(2)}s`;
  });

  let anim = null; // { variant, startedAt, grid? }

  function drawStatic(p) {
    drawPanel(ctx, panelImg);
    const iface = finalRect();
    ctx.drawImage(interfaceImg, iface.x, iface.y, iface.w, iface.h);
    return p;
  }

  function render() {
    if (!anim) return;
    const now = performance.now();
    const t = (now - anim.startedAt) / 1000;
    const duration = Number(durationInput.value);
    const p = Math.min(1, duration > 0 ? t / duration : 1);
    drawStatic();
    const fn = VARIANTS[anim.variant - 1];
    if (anim.variant === 3) fn(ctx, avatarImg, r, p, t);
    else if (anim.variant === 6) fn(ctx, avatarImg, r, p, t, anim.grid);
    else fn(ctx, avatarImg, r, p);
    document.getElementById('label').textContent = `Variant ${anim.variant} — ${VARIANT_NAMES[anim.variant - 1]}`;
    if (p < 1) {
      requestAnimationFrame(render);
    } else {
      anim = null;
    }
  }

  function play(variant) {
    anim = { variant, startedAt: performance.now(), grid: variant === 6 ? makeGrid(r) : null };
    requestAnimationFrame(render);
  }

  for (let i = 1; i <= 6; i++) {
    document.getElementById(`play${i}`).addEventListener('click', () => play(i));
  }

  // Idle frame: avatar fully visible, so the page isn't blank before a variant is picked.
  drawStatic();
  ctx.drawImage(avatarImg, r.x, r.y, r.w, r.h);

  window.__alienFizzleState = () => ({ anim: anim ? { variant: anim.variant } : null, duration: Number(durationInput.value) });
}

const VARIANT_NAMES = [
  'Hard wipe + static band',
  'Glitch slices',
  'Scanline sweep',
  'Particle dissolve',
  'CRT flicker + jitter',
  'Organic threshold reveal',
];

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="color:#f88;position:absolute;top:10px;left:10px;z-index:999">${err.message}</pre>`
  );
});
