/**
 * ==========================================================================
 * CARDBOARD UI — the alien device interface (one USE of the cardboard panel)
 * ==========================================================================
 * Read `src/dialProto.js`'s header first: that's the cardboard UI's own
 * design doc (the malleable-position idea, the alpha-compositing technique,
 * the panel art's alpha-channel gotcha). `src/cardboardPanel.js` is the
 * shared backing this draws on top of. TODO.md points at all three.
 *
 * What this is: the alien device's screen, appearing ON the cardboard sign.
 * Luke, 2026-09-16: "I want to see this image starting as a small rectangle
 * in the centre and then growing to its full size. Its full size should be
 * most of the cardboard background, but don't touch the holes." He marked up
 * a reference: a green box for roughly where the finished screen sits, and a
 * small flat red bar in the middle for roughly the shape it starts from.
 *
 * THE GROWTH IS TWO SEQUENTIAL STEPS, not one — Luke, 2026-09-16: "I want
 * the initial line to spread wide first while still remaining at the same
 * height, and then expand to its full height. So the growth should have two
 * steps to it."
 *   step 1 — WIDEN: the sliver runs out to full width at its starting
 *            height, so it reads as a line being drawn across the card.
 *            The art is genuinely SQUASHED into that bar here, which Luke
 *            explicitly okayed ("stretching is fine for the first step").
 *   step 2 — OPEN: that full-width line then opens vertically — but NOT by
 *            stretching. Luke, 2026-09-16: "rather than stretch the image
 *            vertically, for the second step, would it be possible to have
 *            the height extension rather reveal the image? So that it looks
 *            like the image is being drawn in as the view widens?" So in
 *            step 2 the art is drawn at its FINAL size and clipped to an
 *            aperture that opens from the centre out — the picture never
 *            moves or scales, the opening just uncovers more of it.
 * Each step has its own duration slider, with an optional hold between them
 * (default 0 — strictly back-to-back, as asked).
 *
 * THE SEAM BETWEEN THE TWO MODES: squashed-whole-image and centre-band-of-
 * full-image are different pictures at the same height, so switching cold
 * between them at the step boundary pops (the squashed bar is mostly the
 * art's two glowing edges crushed together; the revealed centre band is the
 * dark middle of the screen). REVEAL_CROSSFADE below fades the stretched
 * version out over the first slice of step 2 so the handover is invisible.
 * Set it to 0 to see the raw switch.
 *
 * Luke's "don't deform it: maintain aspect ratio" is about the FINAL size,
 * which is why the finished rect derives its height from the art's own
 * aspect rather than being set independently — see finalRect().
 *
 * HOLE CLEARANCE is checked, not assumed: the UI warns live if the current
 * slider values would put the screen over either string hole — see
 * overlapsHoles() in cardboardPanel.js and the readout in draw().
 *
 * The art keeps its own black bezel (the source JPG is opaque, with the
 * glowing green frame inset from a black edge) — deliberately NOT keyed out
 * to transparency, since the glow bleeds into that black and keying it
 * would leave a halo. It reads as a black-bezelled screen lying on the
 * cardboard. Say so if a cut-out edge is wanted instead; that's an art-side
 * change (an alpha channel on the source), not a code one.
 *
 * NOT BUILT YET: any trigger for this other than the Play button; the
 * screen's own content changing (glyphs, values); how it leaves again
 * (shrink back? cut?); the panel's own string-lowering entrance; any
 * connection to the real alien abduction feature this is eventually for.
 */

import {
  PANEL_SRC,
  PANEL_SIZE,
  PANEL_HOLE_KEEP_CLEAR_BELOW,
  loadImage,
  fitCanvasToPanel,
  drawPanel,
  overlapsHoles,
} from './cardboardPanel.js';

// Luke's trimmed art, 2026-09-16 — the black surround outside the glowing
// border cut away ("I've also trimmed the image, to remove the black area
// outside the border"), so the frame now sits nearly at the file's edge.
// Kept under its own filename rather than replacing the first version's:
// the untrimmed one is still in Assets/ for comparison, and a new name also
// sidesteps the browser image cache, which has already cost time on this
// project once when a texture was replaced in place.
const INTERFACE_SRC = 'textures/alien-interface-trimmed.webp';

/**
 * The art's own aspect. Trimming changed it (992x487 = 2.037, where the
 * untrimmed 1024x522 was 1.962), so at the same baked width the rect is now
 * ~422 tall rather than 438 — see FINAL_WIDTH's own note for why that still
 * fills the same area on screen.
 */
const INTERFACE_ASPECT = 992 / 487;

/**
 * How much of step 2 is spent fading the stretched version out from under
 * the revealed one, as a fraction of that step. Purely to hide the seam
 * between the two drawing modes — see this file's header. 0 = hard switch.
 */
const REVEAL_CROSSFADE = 0.18;

/**
 * FINAL SIZE AND PLACE — baked in 2026-09-16 from the values Luke settled
 * on live with the UNTRIMMED art: "860 x 438 · x 86-946 · y 93-531". Held
 * as width + centre (not four edges) so the height stays derived from the
 * art's own aspect and can never be stretched. With the trimmed art that
 * now works out at 860 x 422, y 101-523 — 16px shorter, because trimming
 * the black surround changed the aspect. That is still "the same area in
 * game" as Luke expected: the GLOWING FRAME itself lands within a handful
 * of pixels of where it did before, since the black that used to inset it
 * is gone. Width and centre are the things that were actually chosen, so
 * they're what's held. These were sliders while being found; not any more.
 */
const FINAL_WIDTH = 860;
const FINAL_CENTRE = { x: 516, y: 312 };

/**
 * Growth timing — Luke's own values, 2026-09-16 ("here are the values I'd
 * like you to use"), set as the sliders' new starting point (still live
 * controls here, unlike FINAL_WIDTH/FINAL_CENTRE above — only the finished
 * size was asked to be locked). The in-game prototype (alienLowerProto.js)
 * uses these same numbers as fixed constants rather than importing them
 * live from here — see that file's own header for why.
 */
const DEFAULTS = {
  widenDuration: 0.6, // step 1: the sliver runs out to full width
  holdBetween: 0.05, // pause at full-width-still-flat, before it opens
  openDuration: 0.6, // step 2: the full-width line opens to full height
  startWidth: 130,
  startHeight: 5,
};

const state = { ...DEFAULTS, elapsed: Infinity }; // elapsed past the whole sequence = sitting at full size

/** The finished screen's rect — see FINAL_WIDTH above; height always from the art's own aspect, never set independently. */
function finalRect() {
  const w = FINAL_WIDTH;
  const h = w / INTERFACE_ASPECT;
  return { x: FINAL_CENTRE.x - w / 2, y: FINAL_CENTRE.y - h / 2, w, h };
}

/** When each step of the growth starts/ends, in seconds from the start of the sequence. */
function timeline() {
  const widenEnd = state.widenDuration;
  const openStart = widenEnd + state.holdBetween;
  return { widenEnd, openStart, total: openStart + state.openDuration };
}

/**
 * The rect at the current point in the sequence — the two steps from this
 * file's header: widen at constant height, then open to full height. Each
 * step is eased on its own so both have their own start and settle rather
 * than the pair reading as one long ramp.
 */
function currentRect() {
  const end = finalRect();
  const { widenEnd, openStart } = timeline();
  const easeOut = (u) => 1 - (1 - u) * (1 - u) * (1 - u); // cubic: quick off the mark, settles into place
  const clamp01 = (u) => Math.max(0, Math.min(1, u));

  const widenU = easeOut(clamp01(state.elapsed / Math.max(0.01, widenEnd)));
  const openU = easeOut(clamp01((state.elapsed - openStart) / Math.max(0.01, state.openDuration)));

  const w = state.startWidth + (end.w - state.startWidth) * widenU;
  const h = state.startHeight + (end.h - state.startHeight) * openU;
  return { x: FINAL_CENTRE.x - w / 2, y: FINAL_CENTRE.y - h / 2, w, h };
}

async function main() {
  const [panelImg, interfaceImg] = await Promise.all([loadImage(PANEL_SRC), loadImage(INTERFACE_SRC)]);

  const canvas = document.getElementById('c');
  const ctx = fitCanvasToPanel(canvas);
  const warnEl = document.getElementById('warn');
  const finalReadout = document.getElementById('readout');

  function draw() {
    drawPanel(ctx, panelImg);
    const r = currentRect();
    const end = finalRect();
    const { openStart } = timeline();
    const openU = Math.max(0, Math.min(1, (state.elapsed - openStart) / Math.max(0.01, state.openDuration)));

    if (state.elapsed < openStart) {
      // Step 1 (and any hold): the art really is squashed into the bar.
      ctx.drawImage(interfaceImg, r.x, r.y, r.w, r.h);
    } else {
      // Step 2: the art sits at its FINAL size and the aperture uncovers
      // it — "the image being drawn in as the view widens". Nothing about
      // the picture moves or scales here; only the clip does.
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      ctx.drawImage(interfaceImg, end.x, end.y, end.w, end.h);
      ctx.restore();

      // ...and the squashed version fades out from under it, so the change
      // of drawing mode isn't visible as a pop. See REVEAL_CROSSFADE.
      const fade = REVEAL_CROSSFADE > 0 ? 1 - Math.min(1, openU / REVEAL_CROSSFADE) : 0;
      if (fade > 0) {
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.drawImage(interfaceImg, r.x, r.y, r.w, r.h);
        ctx.restore();
      }
    }

    // Hole-clearance guard on the FINISHED size (the growth only ever stays
    // inside it), plus the actual numbers. The size is baked now, so this
    // can't trigger at the current values — it's here to catch a future
    // edit of FINAL_WIDTH/FINAL_CENTRE that would cover a string hole.
    const clash = overlapsHoles(end) || end.y < PANEL_HOLE_KEEP_CLEAR_BELOW;
    warnEl.classList.toggle('hidden', !clash);
    finalReadout.textContent =
      `${Math.round(end.w)} x ${Math.round(end.h)} · ` +
      `x ${Math.round(end.x)}-${Math.round(end.x + end.w)} · ` +
      `y ${Math.round(end.y)}-${Math.round(end.y + end.h)}`;
  }

  function bindSlider(id, key, format = (v) => String(v)) {
    const input = document.getElementById(id);
    const out = document.getElementById(`${id}V`);
    const apply = () => {
      state[key] = Number(input.value);
      out.textContent = format(state[key]);
      draw();
    };
    input.addEventListener('input', apply);
    apply();
  }

  bindSlider('startWidth', 'startWidth');
  bindSlider('startHeight', 'startHeight');
  bindSlider('widenDuration', 'widenDuration', (v) => `${v.toFixed(2)}s`);
  bindSlider('holdBetween', 'holdBetween', (v) => `${v.toFixed(2)}s`);
  bindSlider('openDuration', 'openDuration', (v) => `${v.toFixed(2)}s`);

  const playBtn = document.getElementById('playBtn');
  const loopChk = document.getElementById('loop');

  // One rAF loop, running only while a growth is actually playing — a
  // settled screen is a single static draw, same as the dial prototype.
  let playing = false;
  function play() {
    if (playing) return;
    playing = true;
    playBtn.disabled = true;
    const startedAt = performance.now();
    function step(now) {
      state.elapsed = (now - startedAt) / 1000;
      const done = state.elapsed >= timeline().total;
      draw();
      if (!done) {
        requestAnimationFrame(step);
      } else {
        playing = false;
        playBtn.disabled = false;
        if (loopChk.checked) setTimeout(play, 700);
      }
    }
    state.elapsed = 0;
    requestAnimationFrame(step);
  }
  playBtn.addEventListener('click', play);

  document.getElementById('resetBtn').addEventListener('click', () => {
    for (const key of Object.keys(DEFAULTS)) {
      const input = document.getElementById(key);
      input.value = DEFAULTS[key];
      input.dispatchEvent(new Event('input'));
    }
  });

  draw();
  play(); // show the thing the page is about, rather than opening on a static end state

  // Debug only, same idea as the dial prototype's own hook.
  window.__alienInterfaceState = () => ({ ...state, rect: currentRect(), final: finalRect(), playing });
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="color:#f88;position:absolute;top:10px;left:10px">${err.message}</pre>`
  );
});
