/**
 * The abduction defence screen — replaces the old plain Resist/Go dialog
 * (2026-09-23). Luke: "When a player is targeted currently, they get a
 * window asking them if they want to resist or go. This will replace
 * that... They can resist by typing, for now, 'Resist'... do not tell the
 * player that this word is needed."
 *
 * This is a straight imperative port of the working prototype at
 * `?debugKeyboard=1` (keyboard/KeyboardTestHarness.jsx + CardboardKeyboard.jsx)
 * — not a mounted React component. SkyPath.jsx's own header is explicit
 * that everything inside the game surface is owned by the imperative
 * module and never re-rendered by React, so this builds and mutates plain
 * DOM the same way the rest of skyPath.js/chrome.js does, reusing the same
 * data modules (keyLayout.js, shipTrack.js, letterImage.js, cardboardPanel.js)
 * the React prototype used — those are plain JS with no React dependency.
 *
 * Two behaviours the prototype didn't have, because it had no real trigger:
 *   - the countdown starts automatically once the panel finishes lowering
 *     (no "Go" button — the trigger is the player arriving already targeted);
 *   - typing the target word resolves it early ("resist"), and the ship
 *     reaching the avatar resolves it as a timeout ("go"/abducted) — see
 *     `open()`'s onResist/onTimeout callbacks, which skyPath.js wires to
 *     resolveAbductPrompt(), the same function the old dialog's buttons
 *     called.
 */
import { PANEL_SIZE, PANEL_HOLE_KEEP_CLEAR_BELOW } from '../cardboardPanel.js';
import { KEY_LAYOUT, KEY_LAYOUT_ASPECT, keyImageSrc } from '../keyboard/keyLayout.js';
import { TRACK_PATH, AVATAR_CARD, pointOnTrack } from '../keyboard/shipTrack.js';
import { letterImageSrc } from '../keyboard/letterImage.js';
import { drawPencilBorder } from '../pencilBorder.js';

const TRACK_PANEL_SRC = 'textures/cardboard-panel-track.png';
const SHIP_SRC = 'textures/abduct-ship-small.png';
const SHIP_SIZE = { w: 307, h: 107 };
const SHIP_ANCHOR = { x: 0.5, y: 0.55 };
const SHIP_WIDTH_FRACTION = 0.16;

// "The movement of the ship will be a variable we can control" — Luke,
// 2026-09-22. A plain default for now; open()'s durationMs overrides it,
// becoming a real teacher-facing setting once that mechanism exists.
const DEFAULT_SHIP_DURATION_MS = 20000;

// "For now, just make it Resist" — Luke, 2026-09-23. Matched
// case-insensitively against the typed text; nothing in this UI displays
// this word anywhere ("do not tell the player that this word is needed").
const TARGET_WORD = 'RESIST';

const FILL_FRACTION = 0.92;
const TOP_MARGIN = 0.05;
const LOWER_DURATION_MS = 900;
const LOWER_EASING = 'cubic-bezier(0.33, 1, 0.68, 1)';

const KEYBOARD_COVER_FRACTION = 0.55;
const HOLE_CLEAR_FRACTION = PANEL_HOLE_KEEP_CLEAR_BELOW / PANEL_SIZE.h;
const KEYBOARD_BOTTOM_MARGIN_FRACTION = 0.04;
const KEYBOARD_LEFT_FRACTION = 0.03;
// Text row and keyboard both stop here, leaving the right-hand column
// (lights, track, ship, avatar) clear. Was 0.75 — the track's own leftmost
// point — until the lights went in to its left (2026-09-24); now ~12px
// short of the light stack's left edge (LIGHTS_RECT below). The keyboard
// is height-limited in its box either way, so this moves it left rather
// than shrinking it.
const RIGHT_RAIL_START_FRACTION = 0.68;
const KEYBOARD_WIDTH_FRACTION = RIGHT_RAIL_START_FRACTION - KEYBOARD_LEFT_FRACTION;
// "The border on the left side of the panel was a bit too small" — Luke,
// 2026-09-25: the pencil border sat too close to the panel's left edge.
// Shifts the text-writing area (and its border) right, keeping its right
// edge fixed at RIGHT_RAIL_START_FRACTION so it still lines up with the
// keyboard/lights column above.
const TEXT_AREA_LEFT_FRACTION = 0.04;
const TEXT_AREA_WIDTH_FRACTION = RIGHT_RAIL_START_FRACTION - TEXT_AREA_LEFT_FRACTION;
const TEXT_REGION_FRACTION = 1 - KEYBOARD_COVER_FRACTION - KEYBOARD_BOTTOM_MARGIN_FRACTION - HOLE_CLEAR_FRACTION;
const LETTER_HEIGHT_FRACTION_OF_REGION = 0.4;
const LINE_GAP_FRACTION_OF_REGION = 0.12;
// Same gap-to-letter proportion as the two constants above, but expressed
// relative to the letter height itself rather than the region — needed so
// the gap shrinks along with the letters on a two-line word (see
// renderText's own comment).
const LINE_GAP_RATIO = LINE_GAP_FRACTION_OF_REGION / LETTER_HEIGHT_FRACTION_OF_REGION;

const PRESS_OFFSET_PX = 2; // "move very slightly down and to the right when pressed" — see CardboardKeyboard.jsx

// Countdown lights — Luke, 2026-09-24: "all the lights start off, and as
// the ship makes its way along the track, the lights should turn on,
// starting with the top and working their way down to the red. Red will
// mean only a very short time before the ship arrives." Two same-size
// strips (all off / all on), cut from his black-background PNGs by
// flood-filling the black inward from the edges, which stops at each
// capsule's light outline ring and so keeps the dark "off" interiors.
// The "on" strip is laid over the "off" one once per light, each copy
// clipped to one light's own band, so lights switch individually.
const LIGHTS_OFF_SRC = 'textures/abduct-lights-off.png';
const LIGHTS_ON_SRC = 'textures/abduct-lights-on.png';
const LIGHTS_NATIVE_H = 307;
// Placed from Luke's two mockups by matching the track's ink bounding box
// in each crop to the track's on the panel (both crops agreed: 60px left of
// the track, 103px above its bottom, at ~1.0x native size in panel px).
// Percentages of PANEL_SIZE, same space as everything else here.
const LIGHTS_RECT = { left: 68.52, top: 41.76, width: 9.08, height: 56.23 };
// Row boundaries between the 7 capsules in the source strips (the empty
// rows between capsules, identical in both images).
const LIGHT_BAND_ROWS = [0, 51, 94, 136, 179, 220, 263, 307];
// Ship progress at which each light comes on, top (green) to bottom (red).
// Evenly spaced with none at 0 ("all the lights start off") — red comes on
// at 87.5%, i.e. 2.5s before arrival at the default 20s.
const LIGHT_ON_AT = [1, 2, 3, 4, 5, 6, 7].map((i) => i / 8);
// Five blinks a second: 100ms on, 100ms off.
const RED_BLINK_HALF_PERIOD_MS = 100;

// "Draw a border around the area where the text can be written" — Luke,
// 2026-09-24. How far inside the text region's own box the border sits, as
// a fraction of the panel's height (same panel-relative scaling as every
// other measurement here). Any fixed integer works as the seed; it's only
// there so the border's wobble is stable across resizes.
const TEXT_BORDER_MARGIN_FRACTION = 0.03;
const TEXT_BORDER_SEED = 42;

// The guide's mirror screen (2026-09-23) — "the same UI the defending
// player uses... but no keyboard. Instead, instructions ('Read to your
// teammate') above the same bordered box, showing the teammate's word."
// Splits the same left column the player's text+keyboard occupy between a
// header band (top) and the secret-word border box (rest), instead of
// text-output+keyboard. Fractions are of that column's total available
// height (panel height minus HOLE_CLEAR_FRACTION and this bottom margin),
// same as GUIDE_HEADER_FRACTION_OF_REGION below.
const GUIDE_REGION_BOTTOM_MARGIN_FRACTION = KEYBOARD_BOTTOM_MARGIN_FRACTION;
const GUIDE_HEADER_FRACTION_OF_REGION = 0.26;
const GUIDE_HEADER_GAP_FRACTION_OF_REGION = 0.04;
const GUIDE_HEADER_TEXT = 'Read to your teammate';

function el(tag, style) {
  const e = document.createElement(tag);
  if (style) Object.assign(e.style, style);
  return e;
}

/**
 * Runs `cb` once the CSS transition on `target` finishes — but never waits
 * forever for it. A backgrounded/occluded tab can suspend transitions
 * (confirmed while testing this in the Claude Code browser pane: a
 * `transitionend` that simply never fires until the tab is next painted),
 * and there's no reason to assume a real phone screen locking briefly
 * mid-animation couldn't do the same. A plain timeout fallback, slightly
 * longer than the transition itself, guarantees `cb` always runs exactly
 * once — this gates the actual game-state resolution (resist/abducted),
 * so it must never be able to hang.
 */
function onTransitionSettled(target, ms, cb) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    target.removeEventListener('transitionend', onEnd);
    clearTimeout(timer);
    cb();
  };
  const onEnd = (e) => {
    if (e.target === target) finish();
  };
  target.addEventListener('transitionend', onEnd);
  const timer = setTimeout(finish, ms + 150);
}

/** Builds the 38-key cardboard keyboard into `container`, contain-fitted to whatever size it's given. Plain-DOM port of CardboardKeyboard.jsx. */
function mountKeyboard(container, onKey) {
  // A fresh inner element, not `container` itself — `container` already
  // carries its own position/size (the percentage box the caller placed it
  // in); overwriting its style here clobbered that back to inset:0, which
  // is exactly the "keyboard is far too large" bug (it was sizing itself
  // against the whole panel instead of its intended ~70%x55% region).
  const fillHost = el('div', {
    position: 'absolute',
    inset: '0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  });
  container.appendChild(fillHost);
  const box = el('div', { position: 'relative' });
  fillHost.appendChild(box);

  const keyEls = [];
  for (const name of Object.keys(KEY_LAYOUT)) {
    const k = KEY_LAYOUT[name];
    const img = el('img', {
      position: 'absolute',
      left: `${k.left}%`,
      top: `${k.top}%`,
      width: `${k.width}%`,
      height: `${k.height}%`,
      transform: 'translate(0, 0)',
      transition: 'transform 120ms ease-out',
      touchAction: 'none',
      userSelect: 'none',
      cursor: 'pointer',
    });
    img.src = keyImageSrc(name);
    img.draggable = false;
    const press = (e2) => {
      e2.preventDefault();
      img.style.transform = `translate(${PRESS_OFFSET_PX}px, ${PRESS_OFFSET_PX}px)`;
      img.style.transition = 'transform 60ms ease-out';
      onKey(name);
    };
    const release = () => {
      img.style.transform = 'translate(0, 0)';
      img.style.transition = 'transform 120ms ease-out';
    };
    img.addEventListener('pointerdown', press);
    img.addEventListener('pointerup', release);
    img.addEventListener('pointerleave', release);
    img.addEventListener('pointercancel', release);
    box.appendChild(img);
    keyEls.push(img);
  }

  const resize = () => {
    const { clientWidth, clientHeight } = container;
    let width = clientWidth;
    let height = width / KEY_LAYOUT_ASPECT;
    if (height > clientHeight) {
      height = clientHeight;
      width = height * KEY_LAYOUT_ASPECT;
    }
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  return { dispose: () => ro.disconnect() };
}

/**
 * The chrome shared by both abduction screens — the defending player's own
 * (`createAbductDefense`) and the guide's read-only mirror of it
 * (`createAbductGuideView`): the cardboard track panel, the countdown
 * lights, the avatar, the moving ship, and the lower-in/lift-away/countdown
 * mechanics. Builds only that; each caller appends its own left-column
 * content (keyboard+typed-text vs instructions+secret-word) to the returned
 * `panel` and hooks `onMeasure` to redraw/resize it on every resize.
 */
function mountTrackChrome(stageEl) {
  const panel = el('div', { position: 'absolute' });
  stageEl.appendChild(panel);

  const panelImg = el('img', { width: '100%', height: '100%', display: 'block', userSelect: 'none' });
  panelImg.src = TRACK_PANEL_SRC;
  panelImg.draggable = false;
  panel.appendChild(panelImg);

  const lightsBox = el('div', {
    position: 'absolute',
    left: `${LIGHTS_RECT.left}%`,
    top: `${LIGHTS_RECT.top}%`,
    width: `${LIGHTS_RECT.width}%`,
    height: `${LIGHTS_RECT.height}%`,
  });
  panel.appendChild(lightsBox);
  const stripStyle = { position: 'absolute', inset: '0', width: '100%', height: '100%', userSelect: 'none' };
  const lightsOffImg = el('img', stripStyle);
  lightsOffImg.src = LIGHTS_OFF_SRC;
  lightsOffImg.draggable = false;
  lightsBox.appendChild(lightsOffImg);
  const lightOnImgs = LIGHT_ON_AT.map((_, i) => {
    const top = (LIGHT_BAND_ROWS[i] / LIGHTS_NATIVE_H) * 100;
    const bottom = 100 - (LIGHT_BAND_ROWS[i + 1] / LIGHTS_NATIVE_H) * 100;
    const img = el('img', { ...stripStyle, clipPath: `inset(${top}% 0 ${bottom}% 0)`, visibility: 'hidden' });
    img.src = LIGHTS_ON_SRC;
    img.draggable = false;
    lightsBox.appendChild(img);
    return img;
  });
  /** `msSinceRedOn` is how long the last (red) light has been on — only used for its blink. */
  function updateLights(progress, msSinceRedOn = 0) {
    const last = lightOnImgs.length - 1;
    lightOnImgs.forEach((img, i) => {
      let on = progress >= LIGHT_ON_AT[i];
      // Luke, 2026-09-24: "once the red light comes on, make it blink on
      // and off rapidly... five times a second." Starts on, then toggles
      // every RED_BLINK_HALF_PERIOD_MS.
      if (on && i === last) on = Math.floor(msSinceRedOn / RED_BLINK_HALF_PERIOD_MS) % 2 === 0;
      img.style.visibility = on ? 'visible' : 'hidden';
    });
  }

  const avatarImg = el('img', {
    position: 'absolute',
    left: `${AVATAR_CARD.left}%`,
    top: `${AVATAR_CARD.top}%`,
    width: `${AVATAR_CARD.width}%`,
    height: `${AVATAR_CARD.height}%`,
    objectFit: 'contain',
    userSelect: 'none',
  });
  avatarImg.draggable = false;
  panel.appendChild(avatarImg);

  const shipImg = el('img', { position: 'absolute', userSelect: 'none', display: 'none' });
  shipImg.src = SHIP_SRC;
  shipImg.draggable = false;
  panel.appendChild(shipImg);

  function updateShipPosition(progress) {
    const p = pointOnTrack(progress);
    const shipWidthPct = SHIP_WIDTH_FRACTION * 100;
    const shipHeightPct = shipWidthPct * (SHIP_SIZE.h / SHIP_SIZE.w) * (PANEL_SIZE.w / PANEL_SIZE.h);
    shipImg.style.left = `${p.x - shipWidthPct * SHIP_ANCHOR.x}%`;
    shipImg.style.top = `${p.y - shipHeightPct * SHIP_ANCHOR.y}%`;
    shipImg.style.width = `${shipWidthPct}%`;
    shipImg.style.height = `${shipHeightPct}%`;
  }

  let box = { width: 0, height: 0, top: 0, left: 0 };
  const measureListeners = [];
  const measure = () => {
    const vw = stageEl.clientWidth;
    const vh = stageEl.clientHeight;
    const scale = Math.min((vw * FILL_FRACTION) / PANEL_SIZE.w, (vh * FILL_FRACTION) / PANEL_SIZE.h);
    const width = PANEL_SIZE.w * scale;
    const height = PANEL_SIZE.h * scale;
    box = { width, height, top: vh * TOP_MARGIN, left: (vw - width) / 2 };
    panel.style.left = `${box.left}px`;
    panel.style.top = `${box.top}px`;
    panel.style.width = `${box.width}px`;
    panel.style.height = `${box.height}px`;
    measureListeners.forEach((fn) => fn(box));
    applyTransform();
  };
  const resizeObserver = new ResizeObserver(measure);
  resizeObserver.observe(stageEl);

  let down = false;
  function applyTransform() {
    const hiddenOffset = -(box.top + box.height);
    panel.style.transform = `translateY(${down ? 0 : hiddenOffset}px)`;
  }

  let rafId = null;
  function startCountdown(durationMs, onArrived) {
    shipImg.style.display = 'block';
    const startedAt = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - startedAt) / durationMs);
      updateShipPosition(p);
      updateLights(p, now - startedAt - LIGHT_ON_AT[LIGHT_ON_AT.length - 1] * durationMs);
      if (p < 1) {
        rafId = requestAnimationFrame(tick);
      } else {
        rafId = null;
        onArrived?.();
      }
    };
    rafId = requestAnimationFrame(tick);
  }
  function stopCountdown() {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  /** Lowers the panel into view (from hidden, forcing layout in between so the browser can't coalesce both style writes into one frame and skip the animation — see the original bug this avoided), calling `onSettled` once it's fully down. */
  function lower(onSettled) {
    down = false;
    panel.style.transition = 'none';
    applyTransform();
    // eslint-disable-next-line no-unused-expressions
    panel.offsetHeight;
    down = true;
    panel.style.transition = `transform ${LOWER_DURATION_MS}ms ${LOWER_EASING}`;
    applyTransform();
    onTransitionSettled(panel, LOWER_DURATION_MS, () => onSettled?.());
  }

  function liftAway(onDone) {
    down = false;
    panel.style.transition = `transform ${LOWER_DURATION_MS}ms ${LOWER_EASING}`;
    applyTransform();
    onTransitionSettled(panel, LOWER_DURATION_MS, () => {
      stageEl.style.display = 'none';
      onDone?.();
    });
  }

  return {
    panel,
    getBox: () => box,
    onMeasure: (fn) => measureListeners.push(fn),
    measure,
    setAvatarSrc: (src) => {
      avatarImg.src = src;
    },
    /** Hides the ship and turns all lights off — call before each `lower()`. */
    resetShip: () => {
      shipImg.style.display = 'none';
      updateLights(0);
    },
    startCountdown,
    stopCountdown,
    lower,
    liftAway,
    forceClose: () => {
      stopCountdown();
      stageEl.style.display = 'none';
    },
    dispose: () => {
      stopCountdown();
      resizeObserver.disconnect();
    },
  };
}

/** Renders `text` as cardboard-cutout letters (letterImage.js's set, falling back to plain green text for anything it doesn't cover) into `container`, one flex row per word, at `letterHeight`. */
function renderCardboardWords(container, text, letterHeight, lineGapRatio) {
  container.innerHTML = '';
  container.style.rowGap = `${letterHeight * lineGapRatio}px`;
  let index = 0;
  for (const word of text.split(' ')) {
    const wordEl = el('div', { display: 'flex', alignItems: 'flex-end', marginRight: `${letterHeight * 0.35}px` });
    for (const ch of word) {
      const isFirst = index === 0;
      index += 1;
      const src = letterImageSrc(ch, isFirst);
      if (src) {
        const img = el('img', { height: `${letterHeight}px`, width: 'auto', userSelect: 'none' });
        img.src = src;
        img.draggable = false;
        wordEl.appendChild(img);
      } else {
        const span = el('span', { color: '#33ff66', font: `700 ${letterHeight * 0.8}px system-ui, sans-serif` });
        span.textContent = ch;
        wordEl.appendChild(span);
      }
    }
    container.appendChild(wordEl);
  }
}

/**
 * Renders `text` as cardboard-cutout letters into `container` (a flex-wrap
 * box already sized/positioned by the caller), starting at `baseHeight` and
 * shrinking only as far as needed to keep every line inside `availablePx`
 * of vertical space — solved from the actual number of lines the wrap
 * produces, rather than guessed up front. Same "measure the real wrap,
 * don't just guess" approach as the defending player's own text box (see
 * `renderText` below), generalized to any line count since the guide's
 * fixed instruction line ("Read to your teammate") wraps to more than two.
 */
function fitCardboardWords(container, text, baseHeight, availablePx, lineGapRatio) {
  renderCardboardWords(container, text, baseHeight, lineGapRatio);
  const lines = new Set([...container.children].map((c) => c.offsetTop)).size;
  if (lines > 1) {
    const fitted = Math.min(baseHeight, availablePx / (lines + (lines - 1) * lineGapRatio));
    renderCardboardWords(container, text, fitted, lineGapRatio);
  }
}

export function createAbductDefense(stageEl) {
  stageEl.innerHTML = '';

  const rig = mountTrackChrome(stageEl);
  const { panel } = rig;

  // "Draw a border around the area where the text can be written" — Luke,
  // 2026-09-24. A canvas the same size/position as textBox, painted just
  // before it in DOM order so the border sits behind the letters, not over
  // them. Redrawn on every measure() (resize), with a fixed seed so the
  // wobble stays put rather than re-rolling on every resize.
  const textBorderBox = el('div', {
    position: 'absolute',
    left: `${TEXT_AREA_LEFT_FRACTION * 100}%`,
    width: `${TEXT_AREA_WIDTH_FRACTION * 100}%`,
    top: `${HOLE_CLEAR_FRACTION * 100}%`,
    bottom: `${(KEYBOARD_COVER_FRACTION + KEYBOARD_BOTTOM_MARGIN_FRACTION) * 100}%`,
  });
  panel.appendChild(textBorderBox);
  const textBorderCanvas = el('canvas', { position: 'absolute', inset: '0', width: '100%', height: '100%' });
  textBorderBox.appendChild(textBorderCanvas);

  const textBox = el('div', {
    position: 'absolute',
    left: `${TEXT_AREA_LEFT_FRACTION * 100}%`,
    width: `${TEXT_AREA_WIDTH_FRACTION * 100}%`,
    top: `${HOLE_CLEAR_FRACTION * 100}%`,
    bottom: `${(KEYBOARD_COVER_FRACTION + KEYBOARD_BOTTOM_MARGIN_FRACTION) * 100}%`,
    display: 'flex',
    flexWrap: 'wrap',
    alignContent: 'center',
    justifyContent: 'center',
    padding: '0 4%',
    overflow: 'hidden',
  });
  panel.appendChild(textBox);

  const keyboardWrap = el('div', {
    position: 'absolute',
    left: `${KEYBOARD_LEFT_FRACTION * 100}%`,
    width: `${KEYBOARD_WIDTH_FRACTION * 100}%`,
    bottom: `${KEYBOARD_BOTTOM_MARGIN_FRACTION * 100}%`,
    height: `${KEYBOARD_COVER_FRACTION * 100}%`,
  });
  panel.appendChild(keyboardWrap);

  function redrawTextBorder(box) {
    const cssW = textBorderCanvas.clientWidth;
    const cssH = textBorderCanvas.clientHeight;
    if (!cssW || !cssH) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    textBorderCanvas.width = Math.round(cssW * dpr);
    textBorderCanvas.height = Math.round(cssH * dpr);
    const ctx = textBorderCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const margin = box.height * TEXT_BORDER_MARGIN_FRACTION;
    drawPencilBorder(ctx, { x: margin, y: margin, w: cssW - margin * 2, h: cssH - margin * 2 }, TEXT_BORDER_SEED);
  }
  rig.onMeasure(redrawTextBorder);

  const keyboard = mountKeyboard(keyboardWrap, (name) => handleKey(name));

  let text = '';
  let onResistCb = null;
  let onTimeoutCb = null;
  let onWordMatchedCb = null;
  let onTextChangeCb = null; // the projector's typing overlay (skyPath.js)
  let resolved = false;

  function renderText() {
    const box = rig.getBox();
    const baseLetterHeight = box.height * TEXT_REGION_FRACTION * LETTER_HEIGHT_FRACTION_OF_REGION;
    // "The letters fall outside the box when they go to two lines... reduce
    // size more when the second line is triggered, so the text will always
    // be contained" — Luke, 2026-09-25.
    const marginPx = box.height * TEXT_BORDER_MARGIN_FRACTION;
    const availablePx = box.height * TEXT_REGION_FRACTION - marginPx * 2;
    fitCardboardWords(textBox, text, baseLetterHeight, availablePx, LINE_GAP_RATIO);
  }

  function handleKey(name) {
    if (resolved) return;
    if (name === 'BACKSPACE') text = text.slice(0, -1);
    else if (name === 'SPACE') text += ' ';
    else text += name;
    renderText();
    onTextChangeCb?.(text);
    if (text.trim().toUpperCase() === TARGET_WORD) {
      resolved = true;
      rig.stopCountdown();
      // Fired the INSTANT the word matches, before the panel even starts
      // lifting — Luke, 2026-09-23: the green light "should be removed as
      // soon as the defender successfully puts in the word", not once the
      // whole close-and-repel sequence has played out. `onResist` (below)
      // still waits for the lift animation, since that's what actually
      // resolves the game state.
      onWordMatchedCb?.();
      rig.liftAway(() => onResistCb?.());
    }
  }

  return {
    /** Opens the screen, lowers the panel, then starts the countdown once it's down. `avatarSrc` is the target player's own character art. */
    open({ avatarSrc, durationMs = DEFAULT_SHIP_DURATION_MS, onResist, onTimeout, onWordMatched, onTextChange, onCountdownStart }) {
      text = '';
      resolved = false;
      onResistCb = onResist;
      onTimeoutCb = onTimeout;
      onWordMatchedCb = onWordMatched;
      onTextChangeCb = onTextChange;
      rig.setAvatarSrc(avatarSrc);
      rig.resetShip();
      stageEl.style.display = 'block';
      rig.measure();
      renderText();
      rig.lower(() => {
        onCountdownStart?.(durationMs);
        rig.startCountdown(durationMs, () => {
          if (resolved) return;
          resolved = true;
          rig.liftAway(() => onTimeoutCb?.());
        });
      });
    },
    /** Hides immediately, no lift-away animation — for a restart/reset while the screen happens to be open, not the normal resist/timeout close. */
    forceClose() {
      resolved = true;
      rig.forceClose();
    },
    dispose() {
      rig.dispose();
      keyboard.dispose();
    },
  };
}

/**
 * The guide's own screen — Luke, 2026-09-23: "the same UI the defending
 * player uses, with the track and the avatar and the moving spaceship on
 * the right, but no keyboard. Rather, to the left... instructions...
 * 'Read to your teammate'. Below that... the same border... enclosing the
 * message their defending teammate has to write." Unlike the player's own
 * screen, the guide is shown the word in full — this screen is read-only,
 * nothing here ever calls back except when the ship arrives (or the caller
 * force-closes it, e.g. once the real defence resolves).
 */
export function createAbductGuideView(stageEl) {
  stageEl.innerHTML = '';

  const rig = mountTrackChrome(stageEl);
  const { panel } = rig;

  const totalRegionFraction = 1 - HOLE_CLEAR_FRACTION - GUIDE_REGION_BOTTOM_MARGIN_FRACTION;
  const headerHeightFraction = totalRegionFraction * GUIDE_HEADER_FRACTION_OF_REGION;
  const headerGapFraction = totalRegionFraction * GUIDE_HEADER_GAP_FRACTION_OF_REGION;
  const wordBoxHeightFraction = totalRegionFraction - headerHeightFraction - headerGapFraction;
  const wordBoxTopFraction = HOLE_CLEAR_FRACTION + headerHeightFraction + headerGapFraction;

  const headerBox = el('div', {
    position: 'absolute',
    left: `${TEXT_AREA_LEFT_FRACTION * 100}%`,
    width: `${TEXT_AREA_WIDTH_FRACTION * 100}%`,
    top: `${HOLE_CLEAR_FRACTION * 100}%`,
    height: `${headerHeightFraction * 100}%`,
    display: 'flex',
    flexWrap: 'wrap',
    alignContent: 'center',
    justifyContent: 'center',
    padding: '0 4%',
    overflow: 'hidden',
  });
  panel.appendChild(headerBox);

  // Same pencil border as the defending player's own text box — see
  // pencilBorder.js's header, "the default... for any code-drawn border" —
  // enclosing the word the teammate needs to type.
  const wordBorderBox = el('div', {
    position: 'absolute',
    left: `${TEXT_AREA_LEFT_FRACTION * 100}%`,
    width: `${TEXT_AREA_WIDTH_FRACTION * 100}%`,
    top: `${wordBoxTopFraction * 100}%`,
    bottom: `${GUIDE_REGION_BOTTOM_MARGIN_FRACTION * 100}%`,
  });
  panel.appendChild(wordBorderBox);
  const wordBorderCanvas = el('canvas', { position: 'absolute', inset: '0', width: '100%', height: '100%' });
  wordBorderBox.appendChild(wordBorderCanvas);

  const wordBox = el('div', {
    position: 'absolute',
    left: `${TEXT_AREA_LEFT_FRACTION * 100}%`,
    width: `${TEXT_AREA_WIDTH_FRACTION * 100}%`,
    top: `${wordBoxTopFraction * 100}%`,
    bottom: `${GUIDE_REGION_BOTTOM_MARGIN_FRACTION * 100}%`,
    display: 'flex',
    flexWrap: 'wrap',
    alignContent: 'center',
    justifyContent: 'center',
    padding: '0 4%',
    overflow: 'hidden',
  });
  panel.appendChild(wordBox);

  let word = TARGET_WORD;

  function redrawWordBorder(box) {
    const cssW = wordBorderCanvas.clientWidth;
    const cssH = wordBorderCanvas.clientHeight;
    if (!cssW || !cssH) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    wordBorderCanvas.width = Math.round(cssW * dpr);
    wordBorderCanvas.height = Math.round(cssH * dpr);
    const ctx = wordBorderCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const margin = box.height * TEXT_BORDER_MARGIN_FRACTION;
    drawPencilBorder(ctx, { x: margin, y: margin, w: cssW - margin * 2, h: cssH - margin * 2 }, TEXT_BORDER_SEED);
  }

  function renderHeader(box) {
    const baseHeight = box.height * headerHeightFraction * LETTER_HEIGHT_FRACTION_OF_REGION;
    const availablePx = box.height * headerHeightFraction;
    fitCardboardWords(headerBox, GUIDE_HEADER_TEXT, baseHeight, availablePx, LINE_GAP_RATIO);
  }

  function renderWord(box) {
    const baseHeight = box.height * wordBoxHeightFraction * LETTER_HEIGHT_FRACTION_OF_REGION;
    const marginPx = box.height * TEXT_BORDER_MARGIN_FRACTION;
    const availablePx = box.height * wordBoxHeightFraction - marginPx * 2;
    fitCardboardWords(wordBox, word, baseHeight, availablePx, LINE_GAP_RATIO);
  }

  rig.onMeasure((box) => {
    redrawWordBorder(box);
    renderHeader(box);
    renderWord(box);
  });

  // Whether the panel is up (or on its way up/down) — so close() knows
  // whether there's anything left to lift, since the ship reaching the
  // avatar on THIS device's own clock may already have lifted it.
  let isOpen = false;
  let openSession = 0;

  return {
    /** Opens the screen and lowers the panel, mirroring the defending player's own screen. `word` is the actual target word, shown in full — unlike the player's screen, this one is allowed to reveal it. The ship arriving lifts the panel by itself; the defender's own device is still what decides the outcome (see close()). */
    open({ avatarSrc, word: targetWord = TARGET_WORD, durationMs = DEFAULT_SHIP_DURATION_MS }) {
      word = targetWord;
      isOpen = true;
      const session = ++openSession;
      rig.setAvatarSrc(avatarSrc);
      rig.resetShip();
      stageEl.style.display = 'block';
      rig.measure();
      rig.lower(() => {
        // Closed while still lowering — don't start a countdown on a panel that's already leaving.
        if (session !== openSession) return;
        rig.startCountdown(durationMs, () =>
          rig.liftAway(() => {
            isOpen = false;
          }),
        );
      });
    },
    /** Lifts the panel away now (the defence resolved on the defender's device), then calls `onDone` — straight away if it's already gone. */
    close(onDone) {
      openSession++;
      if (!isOpen) {
        onDone?.();
        return;
      }
      rig.stopCountdown();
      rig.liftAway(() => {
        isOpen = false;
        onDone?.();
      });
    },
    /** Hides immediately, no lift-away animation — for a restart/reset. */
    forceClose() {
      openSession++;
      isOpen = false;
      rig.forceClose();
    },
    dispose() {
      rig.dispose();
    },
  };
}
