/**
 * ==========================================================================
 * CARDBOARD UI — the alien screen's growth, as a shared module
 * ==========================================================================
 * Read `dialProto.js`'s header first (the cardboard UI's own design doc).
 * This factors out the constants/maths that `alienInterfaceProto.js`,
 * `alienLowerProto.js`, and `alienTargetPickerProto.js` had each been
 * carrying their OWN copy of (their own headers all flagged this — by the
 * time a 5th consumer needed the same numbers, for the real in-game
 * integration, copying a 5th time stopped being the safer choice). Those
 * three prototype files are UNCHANGED — still their own copies, still
 * correct — this is only for whatever's written from here on; repointing
 * them at this module instead is a pure no-behaviour-change refactor,
 * available whenever it's wanted, not done as part of this change.
 *
 * FINAL_WIDTH/FINAL_CENTRE are the values Luke settled on live (2026-09-16:
 * "860 x 438 · x 86-946 · y 93-531", against the untrimmed art — see
 * INTERFACE_ASPECT's own note for why the trimmed art's rect comes out
 * slightly shorter while still landing the glowing frame in "the same
 * area"). GROWTH's default timings are the values from the same tuning
 * pass (start height 5, widen 0.6s, hold 0.05s, open 0.6s).
 */

export const INTERFACE_SRC = 'textures/alien-interface-trimmed.jpg';

// Trimmed art's own aspect (992x487 = 2.037) differs from the untrimmed
// version (1024x522 = 1.962) FINAL_WIDTH/FINAL_CENTRE were originally tuned
// against — see this file's header. Kept as the trimmed value since that's
// the asset actually in use everywhere now.
export const INTERFACE_ASPECT = 992 / 487;

export const FINAL_WIDTH = 860;
export const FINAL_CENTRE = { x: 516, y: 312 };

/** The finished screen's rect — height always derived from INTERFACE_ASPECT, so FINAL_WIDTH is the only thing that can ever resize it (never stretched). */
export function finalRect() {
  const w = FINAL_WIDTH;
  const h = w / INTERFACE_ASPECT;
  return { x: FINAL_CENTRE.x - w / 2, y: FINAL_CENTRE.y - h / 2, w, h };
}

/**
 * Default growth timing — a live control in alien-interface.html; treat as
 * a fixed constant everywhere else unless a caller has its own reason to
 * override one field (none currently do).
 */
export const GROWTH_DEFAULTS = { widenDuration: 0.6, holdBetween: 0.05, openDuration: 0.6, startWidth: 130, startHeight: 5 };

/** When each step starts/ends, in seconds from the start of the sequence, for a given growth-timing object (defaults to GROWTH_DEFAULTS). */
export function growthTimeline(growth = GROWTH_DEFAULTS) {
  const widenEnd = growth.widenDuration;
  const openStart = widenEnd + growth.holdBetween;
  return { widenEnd, openStart, total: openStart + growth.openDuration };
}

/** The rect at `elapsed` seconds into the sequence — see alienInterfaceProto.js's header for the two-step widen-then-open idea. */
export function currentInterfaceRect(elapsed, growth = GROWTH_DEFAULTS) {
  const end = finalRect();
  const { widenEnd, openStart } = growthTimeline(growth);
  const easeOut = (u) => 1 - (1 - u) * (1 - u) * (1 - u);
  const clamp01 = (u) => Math.max(0, Math.min(1, u));
  const widenU = easeOut(clamp01(elapsed / Math.max(0.01, widenEnd)));
  const openU = easeOut(clamp01((elapsed - openStart) / Math.max(0.01, growth.openDuration)));
  const w = growth.startWidth + (end.w - growth.startWidth) * widenU;
  const h = growth.startHeight + (end.h - growth.startHeight) * openU;
  return { x: FINAL_CENTRE.x - w / 2, y: FINAL_CENTRE.y - h / 2, w, h };
}

/** How much of step 2 fades the squashed version out from under the revealed one — see alienInterfaceProto.js's header on why the two drawing modes need a handover at all. */
export const REVEAL_CROSSFADE = 0.18;

/** Draws the alien screen at `elapsed` seconds into `growth`'s timeline — the exact composite alienInterfaceProto.js's own draw() uses for this layer. */
export function drawInterfaceGrowth(ctx, interfaceImg, elapsed, growth = GROWTH_DEFAULTS) {
  const r = currentInterfaceRect(elapsed, growth);
  const end = finalRect();
  const { openStart } = growthTimeline(growth);
  const openU = Math.max(0, Math.min(1, (elapsed - openStart) / Math.max(0.01, growth.openDuration)));

  if (elapsed < openStart) {
    ctx.drawImage(interfaceImg, r.x, r.y, r.w, r.h);
  } else {
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    ctx.drawImage(interfaceImg, end.x, end.y, end.w, end.h);
    ctx.restore();

    const fade = REVEAL_CROSSFADE > 0 ? 1 - Math.min(1, openU / REVEAL_CROSSFADE) : 0;
    if (fade > 0) {
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.drawImage(interfaceImg, r.x, r.y, r.w, r.h);
      ctx.restore();
    }
  }
}
