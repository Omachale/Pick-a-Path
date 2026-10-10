/**
 * ==========================================================================
 * CARDBOARD UI — the shared backing panel
 * ==========================================================================
 * The cardboard sign itself, with nothing on it. Luke, 2026-09-16: "this
 * will be one use for the cardboard background, not the only use" — so the
 * panel lives here, on its own, and each THING that sits on it (a dial and
 * its housing, the alien interface screen, lettering later) is a separate
 * module that draws on top. Nothing in this file knows about any of them.
 *
 * Read `src/dialProto.js`'s header first for the full cardboard UI design
 * notes (the malleable-position idea, the alpha-compositing technique, and
 * why the panel art needed a real alpha channel rather than PNG colour-key
 * transparency). That header is the design doc; this file is just the one
 * piece every use of it shares.
 *
 * NOTE, deliberately: dialProto.js predates this module and still carries
 * its own copy of PANEL_SRC/PANEL_SIZE/loadImage. It was left untouched on
 * purpose — Luke, on adding the alien interface: "use the UI we just worked
 * on, but don't alter its base code, as it will be used elsewhere without
 * this addition." Switching it to import from here would be a pure
 * no-behaviour-change refactor whenever that's wanted, but it hasn't been
 * done unasked.
 */

export const PANEL_SRC = 'textures/cardboard-panel.webp';

/** The panel art's own pixel size — every layout coordinate in the cardboard UI is in this space. */
export const PANEL_SIZE = { w: 1024, h: 546 };

/**
 * The two punched string holes, measured off the panel's own alpha channel
 * (a flood fill from outside the card, so only the INTERIOR transparent
 * blobs count as holes). Anything laid over the panel is meant to keep
 * clear of these — Luke, on sizing the alien interface: "don't touch the
 * holes." `keepClearBelow` is the useful number in practice: the lowest
 * edge of either hole, so a full-width overlay just has to start below it.
 */
export const PANEL_HOLES = [
  { x: 251, y: 74, r: 13 },
  { x: 783, y: 72, r: 13 },
];
export const PANEL_HOLE_KEEP_CLEAR_BELOW = 85;

/** Loads one image, rejecting (rather than silently drawing nothing) if the file is missing. */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`cardboardPanel: failed to load ${src}`));
    img.src = src;
  });
}

/** Sizes a canvas to the panel's own pixel space, so callers can work in panel coordinates directly. */
export function fitCanvasToPanel(canvas) {
  canvas.width = PANEL_SIZE.w;
  canvas.height = PANEL_SIZE.h;
  return canvas.getContext('2d');
}

/** Clears and draws the bare panel. Whatever sits on it draws afterwards, on top. */
export function drawPanel(ctx, panelImg) {
  ctx.clearRect(0, 0, PANEL_SIZE.w, PANEL_SIZE.h);
  ctx.drawImage(panelImg, 0, 0, PANEL_SIZE.w, PANEL_SIZE.h);
}

/** True if `rect` ({x, y, w, h}, panel coordinates) would cover either string hole — see PANEL_HOLES. */
export function overlapsHoles(rect) {
  return PANEL_HOLES.some((h) => {
    const nearestX = Math.max(rect.x, Math.min(h.x, rect.x + rect.w));
    const nearestY = Math.max(rect.y, Math.min(h.y, rect.y + rect.h));
    return Math.hypot(h.x - nearestX, h.y - nearestY) <= h.r;
  });
}
