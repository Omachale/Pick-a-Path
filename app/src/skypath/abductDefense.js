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

const TRACK_PANEL_SRC = '/textures/cardboard-panel-track.png';
const SHIP_SRC = '/textures/abduct-ship-small.png';
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
const LIGHTS_OFF_SRC = '/textures/abduct-lights-off.png';
const LIGHTS_ON_SRC = '/textures/abduct-lights-on.png';
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

export function createAbductDefense(stageEl) {
  stageEl.innerHTML = '';

  const panel = el('div', { position: 'absolute' });
  stageEl.appendChild(panel);

  const panelImg = el('img', { width: '100%', height: '100%', display: 'block', userSelect: 'none' });
  panelImg.src = TRACK_PANEL_SRC;
  panelImg.draggable = false;
  panel.appendChild(panelImg);

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

  let box = { width: 0, height: 0, top: 0, left: 0 };
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
    redrawTextBorder();
    applyTransform();
  };

  function redrawTextBorder() {
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
  const resizeObserver = new ResizeObserver(measure);
  resizeObserver.observe(stageEl);

  let down = false;
  function applyTransform() {
    const hiddenOffset = -(box.top + box.height);
    panel.style.transform = `translateY(${down ? 0 : hiddenOffset}px)`;
  }

  const keyboard = mountKeyboard(keyboardWrap, (name) => handleKey(name));

  let text = '';
  let onResistCb = null;
  let onTimeoutCb = null;
  let rafId = null;
  let resolved = false;

  // Renders `text` at a given letter height. Called up to twice per
  // renderText() — once to measure, again at a smaller size if that
  // measurement showed a wrap — so it's plain and side-effect-free beyond
  // rebuilding textBox's own children.
  function renderWords(letterHeight) {
    textBox.innerHTML = '';
    textBox.style.rowGap = `${letterHeight * LINE_GAP_RATIO}px`;
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
      textBox.appendChild(wordEl);
    }
  }

  function renderText() {
    const baseLetterHeight = box.height * TEXT_REGION_FRACTION * LETTER_HEIGHT_FRACTION_OF_REGION;
    renderWords(baseLetterHeight);
    const words = [...textBox.children];
    const wrapped = words.length > 1 && words[0].offsetTop !== words[words.length - 1].offsetTop;
    if (wrapped) {
      // "The letters fall outside the box when they go to two lines...
      // reduce size more when the second line is triggered, so the text
      // will always be contained" — Luke, 2026-09-25. Solve for the
      // largest letter height where two lines, plus the gap between them,
      // still fit inside the bordered area — rather than always using the
      // one-line size and letting a second line overflow it.
      const marginPx = box.height * TEXT_BORDER_MARGIN_FRACTION;
      const availablePx = box.height * TEXT_REGION_FRACTION - marginPx * 2;
      const twoLineHeight = Math.min(baseLetterHeight, availablePx / (2 + LINE_GAP_RATIO));
      renderWords(twoLineHeight);
    }
  }

  function handleKey(name) {
    if (resolved) return;
    if (name === 'BACKSPACE') text = text.slice(0, -1);
    else if (name === 'SPACE') text += ' ';
    else text += name;
    renderText();
    if (text.trim().toUpperCase() === TARGET_WORD) {
      resolved = true;
      stopCountdown();
      liftAway(() => onResistCb?.());
    }
  }

  function updateShipPosition(progress) {
    const p = pointOnTrack(progress);
    const shipWidthPct = SHIP_WIDTH_FRACTION * 100;
    const shipHeightPct = shipWidthPct * (SHIP_SIZE.h / SHIP_SIZE.w) * (PANEL_SIZE.w / PANEL_SIZE.h);
    shipImg.style.left = `${p.x - shipWidthPct * SHIP_ANCHOR.x}%`;
    shipImg.style.top = `${p.y - shipHeightPct * SHIP_ANCHOR.y}%`;
    shipImg.style.width = `${shipWidthPct}%`;
    shipImg.style.height = `${shipHeightPct}%`;
  }

  function startCountdown(durationMs) {
    shipImg.style.display = 'block';
    const startedAt = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - startedAt) / durationMs);
      updateShipPosition(p);
      updateLights(p, now - startedAt - LIGHT_ON_AT[LIGHT_ON_AT.length - 1] * durationMs);
      if (p < 1) {
        rafId = requestAnimationFrame(tick);
      } else if (!resolved) {
        resolved = true;
        liftAway(() => onTimeoutCb?.());
      }
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopCountdown() {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
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
    /** Opens the screen, lowers the panel, then starts the countdown once it's down. `avatarSrc` is the target player's own character art. */
    open({ avatarSrc, durationMs = DEFAULT_SHIP_DURATION_MS, onResist, onTimeout }) {
      text = '';
      resolved = false;
      onResistCb = onResist;
      onTimeoutCb = onTimeout;
      avatarImg.src = avatarSrc;
      shipImg.style.display = 'none';
      updateLights(0);
      renderText();
      stageEl.style.display = 'block';
      measure();
      down = false;
      panel.style.transition = 'none';
      applyTransform();
      // Force layout so the 'hidden' transform above actually applies
      // before switching it back on with a transition — otherwise the
      // browser can coalesce both style writes into one frame and skip
      // the animation entirely.
      // eslint-disable-next-line no-unused-expressions
      panel.offsetHeight;
      down = true;
      panel.style.transition = `transform ${LOWER_DURATION_MS}ms ${LOWER_EASING}`;
      applyTransform();
      onTransitionSettled(panel, LOWER_DURATION_MS, () => startCountdown(durationMs));
    },
    /** Hides immediately, no lift-away animation — for a restart/reset while the screen happens to be open, not the normal resist/timeout close. */
    forceClose() {
      stopCountdown();
      resolved = true;
      stageEl.style.display = 'none';
    },
    dispose() {
      stopCountdown();
      resizeObserver.disconnect();
      keyboard.dispose();
    },
  };
}
