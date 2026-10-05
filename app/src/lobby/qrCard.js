/**
 * The join QR code, coloured onto Luke's hand-held cardboard square
 * (`textures/qr-backing.png`, from his `Desktop/QR Code Backing.png`).
 *
 * Luke, 2026-10-05: "generate the QR code on this piece of cardboard. Use a
 * slight margin around the edge of the code so it doesn't reach the edge and
 * doesn't get covered by (or cover) the woman's thumb in the corner." Of four
 * styles tried (stamp, marker, crayon, scorched), he picked CRAYON: each dark
 * module hatched in by hand in two directions, with the card showing through
 * where the wax skipped. Then he asked for replacements for the three big
 * corner squares (the finder patterns), "six options... at least half of
 * them highly unusual. Push the limits" (target, wobbly, cog, eye, heart,
 * spiral), and chose the COG: a toothed gear ring with a five-petal flower
 * in the middle. The others were deleted.
 *
 * Generated at runtime rather than baked into an image, so the URL can
 * change (a session code, a different host) without anyone remaking art.
 *
 * SCANNABILITY. Error correction is level Q (25% of the code can be lost
 * and it still reads). The crayon's gaps stay well inside that. The FINDERS
 * are different: a scanner finds the code by them, looking for
 * dark-light-dark rings in roughly a 1:1:3:1:1 ratio along any line through
 * their centre. Error correction doesn't cover them. The cog keeps that
 * ring / gap / centre structure, in the 7-module box with its light border:
 * its teeth only thicken the ring, and the flower's petals stop well short
 * of it, so the light gap stays clear. Phone-test after any change to it.
 */
import QRCode from 'qrcode';

export const QR_CARD = {
  backingSrc: 'textures/qr-backing.png',
  // Where the code sits on the backing, in backing-image px (811x586). The
  // card spans x 274-789, y 65-567. The first version left 96/95/59/47 px of
  // card (left/top/right/bottom). Halved, that's 48/48/30/24, but the thumb
  // covers the card's top-left corner out to about x 324 at y 113, so the
  // left edge stops at x 340 rather than 322. Result: 66/48/30/35.
  code: { x0: 340, y0: 113, size: 419 },
  ink: '#20140e',
};

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function mulberry32(seed) {
  return function rand() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function blank(W, H) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  return c;
}

// A closed polar outline r(θ) around (cx, cy), added to the current path.
function polar(ctx, cx, cy, r, steps = 160) {
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const rr = r(a);
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/**
 * Adds the cog finder to the path, for the 7-module box at (x, y) with
 * module size m, to be filled even-odd. In modules: ten squarish teeth with
 * tips at radius 3.5 and roots at 3.0, a hole of radius 2.4, and a flower of
 * radius up to 1.55 (the standard pattern's ring and centre are 3.5/2.5/1.5).
 */
function cogFinderPath(ctx, x, y, m) {
  const cx = x + 3.5 * m;
  const cy = y + 3.5 * m;
  polar(ctx, cx, cy, (a) => m * (3.0 + 0.5 * Math.min(1, Math.max(0, Math.cos(10 * a) * 2.2 + 0.4))), 400);
  ctx.moveTo(cx + m * 2.4, cy);
  ctx.arc(cx, cy, m * 2.4, 0, Math.PI * 2);
  polar(ctx, cx, cy, (a) => m * (0.65 + 0.9 * Math.abs(Math.cos(2.5 * a))), 300);
}

/**
 * Wax-crayon fill inside whatever clip is set: hatching in two directions
 * across the box (x, y, w, h), strokes spaced by module size m.
 */
function hatch(mctx, x, y, w, h, m, rand) {
  const gap = Math.max(1.6, m * 0.17);
  const span = w + h;
  for (const dir of [1, -1]) {
    const strokes = Math.ceil(span / gap);
    for (let i = 0; i <= strokes; i++) {
      const t = i * gap + (rand() - 0.5) * gap * 0.4;
      mctx.globalAlpha = 0.55 + rand() * 0.45;
      mctx.lineWidth = Math.max(1, m * (0.09 + rand() * 0.05));
      mctx.beginPath();
      if (dir > 0) {
        mctx.moveTo(x + t - h, y + h);
        mctx.lineTo(x + t, y);
      } else {
        mctx.moveTo(x + t - h, y);
        mctx.lineTo(x + t, y + h);
      }
      mctx.stroke();
    }
  }
}

/** Builds the card with `url` on it. Resolves to a canvas the size of the backing. */
export async function buildQrCard(url, opts = QR_CARD) {
  const backing = await loadImage(opts.backingSrc);
  const W = backing.width;
  const H = backing.height;
  const qr = QRCode.create(url, { errorCorrectionLevel: 'Q' });
  const n = qr.modules.size;
  const { x0, y0, size } = opts.code;
  const m = size / n;
  const rand = mulberry32(n * 7919 + url.length);
  const finders = [
    [0, 0],
    [0, n - 7],
    [n - 7, 0],
  ]; // [row, col] of each finder's top-left module
  const inFinder = (r, c) => finders.some(([fr, fc]) => r >= fr && r < fr + 7 && c >= fc && c < fc + 7);

  const mask = blank(W, H);
  const mctx = mask.getContext('2d');
  mctx.lineCap = 'round';

  // Data modules: each hatched within its own square.
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.modules.get(r, c) || inFinder(r, c)) continue;
      const x = x0 + c * m;
      const y = y0 + r * m;
      mctx.save();
      mctx.beginPath();
      mctx.rect(x - m * 0.05, y - m * 0.05, m * 1.1, m * 1.1);
      mctx.clip();
      hatch(mctx, x, y, m, m, m, rand);
      mctx.restore();
    }
  }
  // Finders: each shape hatched as one piece, clipped to its own outline.
  for (const [fr, fc] of finders) {
    const x = x0 + fc * m;
    const y = y0 + fr * m;
    mctx.save();
    mctx.beginPath();
    cogFinderPath(mctx, x, y, m);
    mctx.clip('evenodd');
    hatch(mctx, x - m, y - m, m * 9, m * 9, m, rand);
    mctx.restore();
  }
  // Wax skips on the card's raised grain: little gaps through everything.
  mctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < n * n * 3; i++) {
    mctx.globalAlpha = 0.5 + rand() * 0.5;
    mctx.fillRect(x0 + rand() * size, y0 + rand() * size, m * 0.12, m * 0.05);
  }

  const ink = blank(W, H);
  const ictx = ink.getContext('2d');
  ictx.drawImage(mask, 0, 0);
  ictx.globalCompositeOperation = 'source-in';
  ictx.fillStyle = opts.ink;
  ictx.fillRect(0, 0, W, H);

  const out = blank(W, H);
  const ctx = out.getContext('2d');
  ctx.drawImage(backing, 0, 0);
  ctx.globalAlpha = 0.97;
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(ink, 0, 0);
  return out;
}
