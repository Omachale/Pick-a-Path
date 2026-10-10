/**
 * ==========================================================================
 * CARDBOARD UI — design notes, status, and where everything lives
 * ==========================================================================
 * If Luke asks to work on "the cardboard UI" or "move the dial around",
 * THIS is the system he means, and THIS file is the reference for exactly
 * how it works. TODO.md has a one-line pointer back to this exact spot —
 * read this whole header before changing anything here.
 *
 * THE ACTUAL IDEA, in one paragraph: a piece of cardboard is lowered on
 * string from the top of the screen (the lowering animation itself is NOT
 * built yet — see "Not built yet" below) carrying whatever dials and
 * lettering a given moment in the game needs. Luke, 2026-09-16: "it's
 * important... this is going to be a malleable interface that we will use
 * in the future, with the dial and its housing moved to different areas.
 * The position will depend on what kind of screen I want with what
 * information." In other words: THE SAME dial/housing pair gets reused
 * across many different screens, each screen placing it somewhere different
 * on the backing depending what that screen is asking the player. Nothing
 * about the dial's own appearance changes between screens — only WHERE it
 * sits. That's the one design constraint everything below exists to serve,
 * and it's why housing position is a live, exposed control in this
 * prototype while everything about the dial's relationship to its housing
 * is a fixed, baked-in constant (see "What's settled" below): position is
 * the part that's actually meant to keep changing; the physical
 * relationship between a dial and its own housing never does, because
 * they're the same physical object every time, just picked up and moved.
 *
 * HOW IT WORKS — three images, alpha-composited with plain Canvas2D
 * drawImage() calls, the same technique nameTag.js already uses to stamp a
 * letter glyph onto a cardboard background: each layer is its own PNG with
 * real alpha outside the shape that actually matters, so stacking them
 * never shows a rectangular seam from one image's own bounding box.
 *
 *   1. cardboard-panel.png — the backing sign itself. Ships with PNG
 *      colour-key transparency (pure black = transparent, see its own
 *      `tRNS` chunk) — NOT reliable; a browser rendered it as solid opaque
 *      black in testing rather than honouring the colour key. Regenerated
 *      with a genuine per-pixel alpha channel (smoothed at the cut edges)
 *      instead — if any OTHER cardboard art in this project turns up with
 *      the same "looks transparent in an editor, renders solid black in the
 *      browser" symptom, this is why: check for a real alpha channel, don't
 *      trust that a PNG "has transparency" just because it LOOKS like it
 *      does in a preview tool.
 *   2. dial-housing2-holes.png — derived from Luke's `Assets/Dial
 *      Housing2.jpg` (a flat, opaque reference photo: cardboard-coloured
 *      square with two black shapes — the window above, the dial's hole
 *      below — each with a soft shadow falling off around it). That JPG's
 *      own cardboard background isn't wanted at all once the housing can
 *      move to an arbitrary spot on a DIFFERENT piece of cardboard — its
 *      grain would never line up — so a one-off script converted luminance
 *      DIRECTLY to alpha (a wide smoothstep band, not a hard cutoff): true
 *      black becomes fully opaque, the cardboard tone fully transparent,
 *      and everything in between — the shadow's own gradient — becomes
 *      genuine partial alpha. That's what makes the shadow a real shadow
 *      once composited onto a different backing, rather than a hard-edged
 *      cutout: see attempt 1 (`Assets/Dial Housing.jpg`, still in Assets/
 *      but no longer used here), which had a crisp torn-paper edge and no
 *      shadow at all, and used a much narrower threshold band for exactly
 *      that reason. Regenerate from the source JPG if the thresholds ever
 *      need revisiting; it's not done at runtime.
 *   3. dial.png — Luke's dial art, cropped tight to the actual disc (the
 *      source file is a mostly-empty 1024x546 canvas with a ~172px circle
 *      near its centre) purely so this prototype's own maths has a simple
 *      "local centre = image centre" to work from. Currently a plain
 *      featureless disc — no notch/pointer/marking — so a turn isn't
 *      actually visible by eye yet; see window.__dialState() below.
 *
 * THE ANCHOR POINT, precisely: every housing PNG has its own measured hole
 * CENTRE (HOUSING_HOLE_CENTER — found via a connected-components pass on
 * the source photo, not eyeballed). The housing is drawn so that point lands
 * exactly on (housingX, housingY); the dial's own draw centre is
 * (housingX, housingY) + DIAL_OFFSET. Neither the housing's own top-left
 * image corner nor an independent dial x/y ever enters the maths — see
 * draw() below. THAT is the mechanism that makes "move the housing anywhere,
 * the dial follows, correctly seated" actually true, and it's the part to
 * preserve if this ever gets rebuilt as a reusable component (e.g. a
 * `placeDial({ x, y, ...})` helper) rather than copied by hand per screen.
 *
 * WHAT'S SETTLED (baked-in constants, not controls) — Luke, 2026-09-16,
 * after tuning both live: "the values for within the housing are perfect...
 * bake them in" (DIAL_OFFSET, DIAL_SCALE) and "lock in 0.25s for the turning
 * duration" (TURN_DURATION). These describe the physical dial+housing
 * object itself, which is why they're fixed regardless of where the pair
 * ends up on a given screen:
 *   - DIAL_OFFSET = {0, 0} — the dial sits exactly centred in the hole.
 *   - DIAL_SCALE ≈ 0.92 — sized so the dial's own diameter fills the hole.
 *   - TURN_DURATION = 0.25s — how long a 45° turn takes, eased (smoothstep).
 * WHAT'S STILL A LIVE CONTROL: housingX/housingY only — see the sliders in
 * dial-tuner.html. That's deliberate, not an oversight: position is the one
 * thing this prototype exists to prove can move freely (see the paragraph
 * at the top), so it's the one thing still exposed.
 *
 * TURNING: a dial turn is a fixed 45° step in either direction, animated
 * over TURN_DURATION with a smoothstep ease (a linear turn read as
 * mechanically unnatural — no start/settle). Nothing here is wired to any
 * real trigger yet (no "correct"/"wrong" concept exists for a dial in this
 * prototype); Turn left/right are direct test buttons, same spirit as the
 * main game's own #abduct/#addJetpack test triggers. No queueing/interrupt
 * behaviour for a turn requested mid-turn either — the buttons just disable
 * for the duration, since nothing has decided yet whether a second request
 * mid-turn should cut the first short, queue, or snap.
 *
 * NOT BUILT YET, all still open: the string-lowering animation that brings
 * the panel onto screen in the first place; the window's white paper insert
 * and the changing printed values behind it; lettering on the cardboard
 * (same alpha-compositing pattern, per Luke: "you already use the same
 * technique with the cardboard alphabet images"); more than one dial/panel
 * layout actually wired up and swapped between; any real trigger for a
 * turn; any connection to the alien abduction feature this was commissioned
 * for in the first place (see TODO.md's "paused" entry on that feature —
 * this cardboard UI is what got built in the pause).
 */

const PANEL_SRC = 'textures/cardboard-panel.webp';
const HOUSING_SRC = 'textures/dial-housing2-holes.webp';
const DIAL_SRC = 'textures/dial.webp';

const PANEL_SIZE = { w: 1024, h: 546 };

// Local pixel geometry inside dial-housing2-holes.png (240x295 — NOT the
// same as the first housing photo's 250x295, hence a separate measurement
// rather than reusing the old numbers), measured off the high-confidence
// black CORE of the source photo (a connected-components pass, ignoring the
// soft shadow halo around each shape so it can't skew the centre/radius).
// The hole's CENTRE is the one point that has to line up with the dial
// regardless of where the housing is moved to; the housing image's own
// top-left corner means nothing on its own.
const HOUSING_SIZE = { w: 240, h: 295 };
const HOUSING_HOLE_CENTER = { x: 118.55, y: 180.88 };
const HOUSING_HOLE_DIAMETER = 158;

// dial.png's own crop (see this file's header) — its circle sits centred in
// the crop, so "local centre" is just half its width/height.
const DIAL_SIZE = { w: 183, h: 184 };
const DIAL_DIAMETER = 172; // the disc's own diameter, not the crop's

// Baked in 2026-09-16 — Luke, after tuning live: "the values for within the
// housing are perfect... bake them in." No longer sliders (see DEFAULTS).
const DIAL_OFFSET = { x: 0, y: 0 };
const DIAL_SCALE = HOUSING_HOLE_DIAMETER / DIAL_DIAMETER;

// A turn is always exactly 45°, in radians for ctx.rotate(). Duration was a
// live slider (0.2-0.8s) until Luke picked 0.25s and asked to lock it in,
// 2026-09-16 — no longer a control, see turn() below.
const TURN_STEP = (45 * Math.PI) / 180;
const TURN_DURATION = 0.25; // seconds

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`dial-tuner: failed to load ${src}`));
    img.src = src;
  });
}

// Defaults match the sliders' own starting `value=` in dial-tuner.html —
// duplicated rather than read back from the DOM at load, so this object is
// the single thing "Reset to defaults" needs to know about.
const DEFAULTS = {
  housingX: 620,
  housingY: 190,
};
const state = { ...DEFAULTS, dialAngle: 0 };

async function main() {
  const [panelImg, housingImg, dialImg] = await Promise.all([
    loadImage(PANEL_SRC),
    loadImage(HOUSING_SRC),
    loadImage(DIAL_SRC),
  ]);

  const canvas = document.getElementById('c');
  canvas.width = PANEL_SIZE.w;
  canvas.height = PANEL_SIZE.h;
  const ctx = canvas.getContext('2d');

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(panelImg, 0, 0, PANEL_SIZE.w, PANEL_SIZE.h);

    // Housing: drawn so its OWN hole centre lands at (housingX, housingY),
    // not so its top-left corner does — that's what makes the two position
    // sliders mean "where the hole is," which is the only thing anyone
    // looking at the panel actually cares about.
    ctx.drawImage(
      housingImg,
      state.housingX - HOUSING_HOLE_CENTER.x,
      state.housingY - HOUSING_HOLE_CENTER.y,
      HOUSING_SIZE.w,
      HOUSING_SIZE.h
    );

    // Dial: its target centre is the housing's position PLUS a fixed
    // offset — never an independent x/y — so moving the housing carries
    // the dial with it automatically, which is the actual thing this
    // prototype exists to prove out. Rotated in place around that same
    // centre for a turn (see turn() below); translate+rotate is the only
    // way Canvas2D rotates anything other than around the canvas origin.
    const dialW = DIAL_SIZE.w * DIAL_SCALE;
    const dialH = DIAL_SIZE.h * DIAL_SCALE;
    const dialCenterX = state.housingX + DIAL_OFFSET.x;
    const dialCenterY = state.housingY + DIAL_OFFSET.y;
    ctx.save();
    ctx.translate(dialCenterX, dialCenterY);
    ctx.rotate(state.dialAngle);
    ctx.drawImage(dialImg, -dialW / 2, -dialH / 2, dialW, dialH);
    ctx.restore();
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

  bindSlider('housingX', 'housingX');
  bindSlider('housingY', 'housingY');

  document.getElementById('resetBtn').addEventListener('click', () => {
    for (const key of Object.keys(DEFAULTS)) {
      const input = document.getElementById(key);
      input.value = DEFAULTS[key];
      input.dispatchEvent(new Event('input'));
    }
  });

  // Turning: eased (smoothstep — a linear turn read as mechanically
  // unnatural, no start/settle) rotation from the dial's CURRENT angle to
  // current ± 45°, over TURN_DURATION. Buttons disable for the duration of
  // their own turn — this prototype has no queueing/interrupt behaviour for
  // a turn requested mid-turn, since nothing yet decides whether that should
  // cut the first turn short, queue, or snap; simplest is "can't happen"
  // until that's actually asked for.
  let turning = false;
  function turn(direction) {
    if (turning) return;
    turning = true;
    turnLeftBtn.disabled = true;
    turnRightBtn.disabled = true;
    const from = state.dialAngle;
    const to = from + direction * TURN_STEP;
    const durationMs = TURN_DURATION * 1000;
    const startedAt = performance.now();
    function step(now) {
      const t = Math.min(1, (now - startedAt) / durationMs);
      const eased = t * t * (3 - 2 * t);
      state.dialAngle = from + (to - from) * eased;
      draw();
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        turning = false;
        turnLeftBtn.disabled = false;
        turnRightBtn.disabled = false;
      }
    }
    requestAnimationFrame(step);
  }

  const turnLeftBtn = document.getElementById('turnLeftBtn');
  const turnRightBtn = document.getElementById('turnRightBtn');
  turnLeftBtn.addEventListener('click', () => turn(-1));
  turnRightBtn.addEventListener('click', () => turn(1));

  draw();

  // Debug only — dial.png is a plain featureless disc, so a 45° turn isn't
  // actually visible by eye in this prototype; this is how to confirm the
  // rotation itself is correct without eyeballing a symmetric circle.
  window.__dialState = () => ({ ...state, dialAngleDeg: (state.dialAngle * 180) / Math.PI, turning });
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#f88;position:absolute;top:10px;left:10px">${err.message}</pre>`);
});
