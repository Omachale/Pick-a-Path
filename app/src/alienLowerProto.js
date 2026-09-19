/**
 * ==========================================================================
 * CARDBOARD UI — lowered into the game (one full in-game moment, staged)
 * ==========================================================================
 * Read `src/dialProto.js`'s header first (the cardboard UI's own design
 * doc) and `src/alienInterfaceProto.js`'s header (the alien screen's growth
 * animation, which this reuses). `src/cardboardPanel.js` is the shared
 * backing both draw on. TODO.md points at all of these.
 *
 * What this is: the moment Luke described, 2026-09-16 — "when a player has
 * picked up the Alien device and presses the button to choose their target,
 * I want this UI to be lowered down from the top of the screen... This UI
 * should fill most of the screen, and should be in front of anything else
 * on the screen." A full-viewport prototype (not scoped to the panel's own
 * 1024x546 art like the other two pages) simulating that: a placeholder
 * "game" behind a button, and pressing it lowers the cardboard panel — on
 * two strings, from off-screen — into view, then plays the alien interface
 * growth automatically once it settles.
 *
 * THE STRINGS, per Luke: "Here is a string image that I want you to attach
 * to the string ends at the top of this UI image. I think it should be
 * enough to make sure the top of the string disappears off the top of the
 * player's view." Two consequences of that:
 *   1. The string art (hanging-string.png, a single ~13px-wide twisted
 *      cord — matched almost exactly to the panel's own built-in stub
 *      width, so no rescale was needed) is tiled vertically, anchored so
 *      its BOTTOM tile ends exactly where the panel's own short stub
 *      begins (the panel already has ~13px of visible cord right at its
 *      own top edge — see cardboardPanel.js's PANEL_HOLES — this continues
 *      it, not replaces it).
 *   2. "Enough to disappear off the top" is achieved geometrically, not by
 *      tracking a real anchor point: STRING_LEN (canvas-internal px) is
 *      picked generously (see its own comment) and the whole hanging group
 *      — strings + panel — is rendered onto ONE tall canvas that never
 *      redraws its own layout, then that single element is slid into place
 *      with a CSS transform. Because the string is picked long enough that
 *      it's still off-screen even once the PANEL has reached its final
 *      resting position, and the panel never moves further down than that
 *      resting position (no overshoot in the easing), the string's top can
 *      never be on-screen at any point during the descent either — the
 *      resting case is the worst case, and it's covered by construction.
 *
 * THE GROWTH TIMING/FINAL-SIZE CONSTANTS ARE DUPLICATED from
 * alienInterfaceProto.js rather than imported — that file runs its own
 * `main()` against its own DOM (sliders, #c, #readout) as a side effect of
 * being loaded, so it isn't set up to be imported as a library, and it
 * wasn't rearranged to allow it (same reasoning as dialProto.js being left
 * untouched when the alien interface was first added — see this project's
 * own precedent). If these values drift out of sync, alienInterfaceProto.js
 * is the source of truth; consolidating into a shared module is available
 * whenever that's worth doing, not done unasked here.
 *
 * NOT BUILT YET: any real trigger (this is a button standing in for
 * "picked up the device and pressed use"); how the panel LEAVES again;
 * the target-picking menu this is eventually FOR; a real game scene behind
 * it (the placeholder here is flat colour); resize handling mid-animation
 * (a resize while playing snaps rather than re-eases).
 */

import { PANEL_SRC, PANEL_SIZE, PANEL_HOLES, loadImage, drawPanel } from './cardboardPanel.js';

const STRING_SRC = 'textures/hanging-string.png';
const STRING_TILE_SIZE = { w: 67, h: 526 };
// The rope's own opaque pixels sit centred around local x=35 in that 67px
// canvas (measured off the source art), not x=33.5 — used so the string's
// visual centre, not the sprite's bounding box centre, lines up with each
// hole.
const STRING_OPAQUE_CENTER_X = 35;

// Generous on purpose — see this file's header for why "generous" is the
// whole safety margin. 2400px of cord, in the same coordinate space as the
// 546px-tall panel, is roughly 4.4 panel-heights: comfortably more than any
// panel-fill-fraction/top-margin combination below could ever need.
const STRING_LEN = 2400;

// --- duplicated from alienInterfaceProto.js — see this file's header ---
const INTERFACE_SRC = 'textures/alien-interface-trimmed.jpg';
const INTERFACE_ASPECT = 992 / 487;
const REVEAL_CROSSFADE = 0.18;
const FINAL_WIDTH = 860;
const FINAL_CENTRE = { x: 516, y: 312 };
const GROWTH = { widenDuration: 0.6, holdBetween: 0.05, openDuration: 0.6, startWidth: 130, startHeight: 5 };
// --- end duplicated block ---

function finalRect() {
  const w = FINAL_WIDTH;
  const h = w / INTERFACE_ASPECT;
  return { x: FINAL_CENTRE.x - w / 2, y: FINAL_CENTRE.y - h / 2, w, h };
}
function growthTimeline() {
  const widenEnd = GROWTH.widenDuration;
  const openStart = widenEnd + GROWTH.holdBetween;
  return { widenEnd, openStart, total: openStart + GROWTH.openDuration };
}
function currentInterfaceRect(elapsed) {
  const end = finalRect();
  const { widenEnd, openStart } = growthTimeline();
  const easeOut = (u) => 1 - (1 - u) * (1 - u) * (1 - u);
  const clamp01 = (u) => Math.max(0, Math.min(1, u));
  const widenU = easeOut(clamp01(elapsed / Math.max(0.01, widenEnd)));
  const openU = easeOut(clamp01((elapsed - openStart) / Math.max(0.01, GROWTH.openDuration)));
  const w = GROWTH.startWidth + (end.w - GROWTH.startWidth) * widenU;
  const h = GROWTH.startHeight + (end.h - GROWTH.startHeight) * openU;
  return { x: FINAL_CENTRE.x - w / 2, y: FINAL_CENTRE.y - h / 2, w, h };
}

// Defaults for the variables THIS staging has (the lower-in itself; the
// panel's own final size on screen) — separate from the growth timing
// above, which is the alien screen's own settled behaviour.
const DEFAULTS = {
  lowerDuration: 0.9,
  fillFraction: 0.92, // the panel's rendered size, as a fraction of the smaller viewport dimension
  topMargin: 0.05, // gap above the panel's resting position, as a fraction of viewport height — where the string reads as still attached to something
};
const state = { ...DEFAULTS };

async function main() {
  const [panelImg, interfaceImg, stringImg] = await Promise.all([
    loadImage(PANEL_SRC),
    loadImage(INTERFACE_SRC),
    loadImage(STRING_SRC),
  ]);

  // The hanging group's own canvas: strings on top, panel at the bottom,
  // laid out ONCE in a fixed internal coordinate space (this file's header
  // explains why a large fixed STRING_LEN makes that safe). Only the panel
  // band is ever redrawn afterwards, for the growth animation — the string
  // tiling above it is static art, not touched per frame.
  const groupCanvas = document.createElement('canvas');
  groupCanvas.width = PANEL_SIZE.w;
  groupCanvas.height = STRING_LEN + PANEL_SIZE.h;
  const groupCtx = groupCanvas.getContext('2d');

  function drawStrings() {
    for (const hole of PANEL_HOLES) {
      const x = hole.x - STRING_OPAQUE_CENTER_X;
      // Tiled bottom-up so the SEAM against the panel's own built-in stub
      // (which starts right at the panel's top edge) always lands exactly
      // on a tile boundary, never mid-tile.
      for (let y = STRING_LEN; y > 0; y -= STRING_TILE_SIZE.h) {
        const tileTop = y - STRING_TILE_SIZE.h;
        groupCtx.drawImage(stringImg, x, tileTop, STRING_TILE_SIZE.w, STRING_TILE_SIZE.h);
      }
    }
  }

  function drawGroup(elapsed) {
    groupCtx.clearRect(0, 0, groupCanvas.width, groupCanvas.height);
    drawStrings();
    groupCtx.save();
    groupCtx.translate(0, STRING_LEN); // panel-local (0,0) is now at canvas (0, STRING_LEN)
    drawPanel(groupCtx, panelImg);
    drawInterfaceGrowth(groupCtx, interfaceImg, elapsed);
    groupCtx.restore();
  }

  const stage = document.getElementById('stage');
  const wrap = document.getElementById('hangWrap');
  wrap.appendChild(groupCanvas);
  groupCanvas.style.display = 'block';

  /** Sizes/positions the group canvas via plain CSS (width/height, not transform-scale, so it stays crisp) for the CURRENT viewport, and returns the translateY needed to rest the panel at its target spot. */
  function layout() {
    const vw = stage.clientWidth;
    const vh = stage.clientHeight;
    const scale = Math.min((vw * state.fillFraction) / PANEL_SIZE.w, (vh * state.fillFraction) / PANEL_SIZE.h);
    const cssW = PANEL_SIZE.w * scale;
    const cssH = groupCanvas.height * scale;
    groupCanvas.style.width = `${cssW}px`;
    groupCanvas.style.height = `${cssH}px`;
    groupCanvas.style.left = `${(vw - cssW) / 2}px`;
    const restingPanelTop = vh * state.topMargin;
    const restY = restingPanelTop - STRING_LEN * scale; // canvas's own top edge, once the panel band is at restingPanelTop
    const startY = -cssH; // fully above the viewport, panel included
    return { startY, restY, scale };
  }

  let anim = null; // { startedAt, startY, restY, phase: 'lowering' | 'growing' | 'done' }

  function render() {
    const now = performance.now();
    if (!anim) return;
    if (anim.phase === 'lowering') {
      const t = Math.min(1, (now - anim.startedAt) / (state.lowerDuration * 1000));
      const eased = 1 - (1 - t) * (1 - t) * (1 - t); // ease-out: fast off the mark, settles into place — never overshoots restY, see header
      const y = anim.startY + (anim.restY - anim.startY) * eased;
      groupCanvas.style.transform = `translateY(${y}px)`;
      drawGroup(0); // interface still at its start size throughout the descent
      if (t >= 1) {
        anim.phase = 'growing';
        anim.growStartedAt = now;
      }
      requestAnimationFrame(render);
    } else if (anim.phase === 'growing') {
      const elapsed = (now - anim.growStartedAt) / 1000;
      drawGroup(elapsed);
      if (elapsed < growthTimeline().total) {
        requestAnimationFrame(render);
      } else {
        anim.phase = 'done';
        useBtn.disabled = false;
        useBtn.textContent = '↺ Replay';
      }
    }
  }

  function play() {
    const { startY, restY } = layout();
    groupCanvas.style.transform = `translateY(${startY}px)`;
    drawGroup(0);
    useBtn.disabled = true;
    useBtn.textContent = '…';
    anim = { startedAt: performance.now(), startY, restY, phase: 'lowering' };
    requestAnimationFrame(render);
  }

  const useBtn = document.getElementById('useBtn');
  useBtn.addEventListener('click', play);

  function bindSlider(id, key, format = (v) => String(v)) {
    const input = document.getElementById(id);
    const out = document.getElementById(`${id}V`);
    input.addEventListener('input', () => {
      state[key] = Number(input.value);
      out.textContent = format(state[key]);
      // Re-lay-out live even mid-animation, for a prototype tuning pass —
      // snaps rather than re-easing (see this file's header).
      if (anim && anim.phase !== 'lowering') {
        const { restY } = layout();
        groupCanvas.style.transform = `translateY(${restY}px)`;
      } else if (!anim) {
        const { startY } = layout();
        groupCanvas.style.transform = `translateY(${startY}px)`;
      } else {
        layout();
      }
    });
    out.textContent = format(state[key]);
  }
  bindSlider('lowerDuration', 'lowerDuration', (v) => `${v.toFixed(2)}s`);
  bindSlider('fillFraction', 'fillFraction', (v) => `${Math.round(v * 100)}%`);
  bindSlider('topMargin', 'topMargin', (v) => `${Math.round(v * 100)}%`);

  window.addEventListener('resize', () => {
    if (!anim || anim.phase === 'done') {
      const { startY } = layout();
      groupCanvas.style.transform = `translateY(${startY}px)`;
    } else {
      layout();
    }
  });

  // Initial state: off-screen above, nothing playing yet.
  const { startY } = layout();
  groupCanvas.style.transform = `translateY(${startY}px)`;
  drawGroup(0);

  window.__alienLowerState = () => ({ ...state, anim: anim ? { ...anim } : null });
}

/** Exactly alienInterfaceProto.js's own draw() body for the interface layer — see this file's header on why it's duplicated rather than imported. */
function drawInterfaceGrowth(ctx, interfaceImg, elapsed) {
  const r = currentInterfaceRect(elapsed);
  const end = finalRect();
  const { openStart } = growthTimeline();
  const openU = Math.max(0, Math.min(1, (elapsed - openStart) / Math.max(0.01, GROWTH.openDuration)));

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

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="color:#f88;position:absolute;top:10px;left:10px;z-index:999">${err.message}</pre>`
  );
});
