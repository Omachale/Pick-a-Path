/**
 * The default code-drawn "pencil on cardboard" border — Luke, 2026-09-24,
 * picking "Pressure variation" out of six prototypes (see the
 * `Pencil Border Prototypes` artifact from that session) and asking for it
 * to be the default for any code-drawn border, not just the one it was
 * built for. Framework-agnostic (plain canvas, no DOM/React dependency) so
 * it can be reused from imperative game code and from React UI (e.g. the
 * teacher's lobby interface) alike.
 *
 * The look: each side is drawn as many short two-point strokes rather than
 * one continuous path, each with its own randomised alpha and width —
 * mimicking uneven pencil pressure — plus a small corner overshoot, the way
 * a hand-drawn rectangle looks when the pencil doesn't lift cleanly at the
 * corner. `seed` makes a given rect's wobble stable across redraws (e.g.
 * every resize) rather than re-rolling and visibly jittering each time.
 */

export function mulberry32(seed) {
  return function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PENCIL_BORDER_DEFAULT = {
  segments: 10, // short strokes per side — more segments reads as a shakier hand
  jitter: 1.4, // px, perpendicular wobble per segment endpoint
  overshoot: 3, // px, how far each side's stroke runs past the corner
  width: 1.7,
  widthMin: 0.7, // × width — per-segment width randomises between widthMin and widthMin+widthRange
  widthRange: 0.6,
  alphaMin: 0.45, // per-segment alpha randomises between alphaMin and alphaMin+alphaRange
  alphaRange: 0.5,
  color: '#2c2a26',
};

/**
 * Draws a pencil-style rectangle border into `ctx` at `rect` ({x, y, w, h},
 * in ctx's own coordinate space — scale ctx first for device-pixel-ratio
 * sharpness, same as any other canvas draw). `seed` is any integer; the
 * same seed always produces the same wobble.
 */
export function drawPencilBorder(ctx, rect, seed = 1, style = PENCIL_BORDER_DEFAULT) {
  const rand = mulberry32((seed | 0) * 97 + 11);
  const corners = [
    [rect.x, rect.y, rect.x + rect.w, rect.y],
    [rect.x + rect.w, rect.y, rect.x + rect.w, rect.y + rect.h],
    [rect.x + rect.w, rect.y + rect.h, rect.x, rect.y + rect.h],
    [rect.x, rect.y + rect.h, rect.x, rect.y],
  ];
  ctx.save();
  ctx.lineCap = 'round';
  corners.forEach(([x1, y1, x2, y2]) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;
    const segs = style.segments;
    let prevOff = (rand() - 0.5) * 2 * style.jitter;
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs;
      const t1 = (i + 1) / segs;
      const a0 = -style.overshoot + t0 * (len + 2 * style.overshoot);
      const a1 = -style.overshoot + t1 * (len + 2 * style.overshoot);
      const off1 = (rand() - 0.5) * 2 * style.jitter;
      ctx.beginPath();
      ctx.moveTo(x1 + ux * a0 + nx * prevOff, y1 + uy * a0 + ny * prevOff);
      ctx.lineTo(x1 + ux * a1 + nx * off1, y1 + uy * a1 + ny * off1);
      ctx.strokeStyle = style.color;
      ctx.globalAlpha = style.alphaMin + rand() * style.alphaRange;
      ctx.lineWidth = style.width * (style.widthMin + rand() * style.widthRange);
      ctx.stroke();
      prevOff = off1;
    }
  });
  ctx.restore();
}
