/**
 * `?debugKeyboard=1` — test rig for CardboardKeyboard, standing in for the
 * real abduction-defence screen (word display, timer, guide sync) which
 * doesn't exist yet.
 *
 * Luke, 2026-09-20: the keyboard should be shown as an overlay on the
 * cardboard backing UI already used elsewhere (see cardboardPanel.js's own
 * header — "this will be one use for the cardboard background, not the
 * only one"), covering a little over half of it, with a "Go" button that
 * brings the whole thing down from the top of the screen with the keyboard
 * already on it. So this reuses the same panel art and the same
 * lower-from-above animation feel as the abduction interface in
 * skyPath.js (ABDUCT_LOWER_DURATION/fill-fraction/top-margin there) rather
 * than inventing new numbers, since the point is for this to look like the
 * same kind of UI, not a different one.
 */
import { useEffect, useRef, useState } from 'react';
import CardboardKeyboard from './CardboardKeyboard.jsx';
import { PANEL_SIZE, PANEL_HOLE_KEEP_CLEAR_BELOW } from '../cardboardPanel.js';
import { TRACK_PATH, AVATAR_CARD, pointOnTrack } from './shipTrack.js';
import { letterImageSrc } from './letterImage.js';

// A separate file from cardboardPanel.js's own PANEL_SRC — that one is
// shared with the real abduction-confirm screen, which doesn't have a
// track on it, so the track art can't overwrite the shared asset.
const TRACK_PANEL_SRC = 'textures/cardboard-panel-track.webp';
const SHIP_SRC = 'textures/abduct-ship-small.webp';
const SHIP_SIZE = { w: 307, h: 107 }; // abduct-ship-small.png's own pixel size
// "Its centre of mass... always remains in the centre of the track line" —
// picked as roughly the ship's visual middle; adjust if it should sit
// further toward the nose or tail once it's actually moving on screen.
const SHIP_ANCHOR = { x: 0.5, y: 0.55 };
const SHIP_WIDTH_FRACTION = 0.16; // width as a fraction of the panel

// "For the prototype, choose any character card and put it in place" —
// Luke, 2026-09-22. Reusing an existing target-selection avatar; swap for
// real character art whenever that's ready, nothing else here depends on
// which one it is.
const AVATAR_SRC = 'textures/figure-robot.webp';

// "The movement of the ship will be a variable we can control" — a plain
// constant for now; becomes a real teacher-facing setting once that
// mechanism exists (see chat, step 1 deliberately stops short of that).
const SHIP_DURATION_MS = 20000;

// Both the text row and the keyboard now stop here, leaving the whole
// right-hand column — where the track/ship/avatar live — clear. 75%
// because the track's own leftmost point measures at ~75.3% of the panel.
const RIGHT_RAIL_START_FRACTION = 0.75;

// Matches skyPath.js's ABDUCT_FILL_FRACTION/ABDUCT_TOP_MARGIN/ABDUCT_LOWER_DURATION.
const FILL_FRACTION = 0.92;
const TOP_MARGIN = 0.05;
const LOWER_DURATION_MS = 900;
const LOWER_EASING = 'cubic-bezier(0.33, 1, 0.68, 1)'; // ease-out-cubic, same curve as the abduction panel's own JS easing

// "It can cover a little over half [the panel]." — Luke, 2026-09-20.
const KEYBOARD_COVER_FRACTION = 0.55;
const HOLE_CLEAR_FRACTION = PANEL_HOLE_KEEP_CLEAR_BELOW / PANEL_SIZE.h;

// Luke, 2026-09-22: "the keyboard moved slightly up (the space bar is
// hanging off the bottom slightly) and to the left. We're going to add a
// little feature to the right area." Measured off his annotated screenshot
// (green = target, red = old bounds) rather than guessed — the keyboard's
// own bounding box, not the whole panel, so its right edge now leaves
// clear space for whatever gets added there next.
const KEYBOARD_BOTTOM_MARGIN_FRACTION = 0.04;
const KEYBOARD_LEFT_FRACTION = 0.03;
const KEYBOARD_WIDTH_FRACTION = RIGHT_RAIL_START_FRACTION - KEYBOARD_LEFT_FRACTION;

const TEXT_REGION_FRACTION = 1 - KEYBOARD_COVER_FRACTION - KEYBOARD_BOTTOM_MARGIN_FRACTION - HOLE_CLEAR_FRACTION;

// Luke, 2026-09-20: "sized so that one line will initially be placed in the
// centre of the area between the keyboard and the holes... but if two lines
// are needed the text can move up to make room for a second line, without
// needing to change the [size] of the text." A fixed letter height (a
// fraction of the text region, not of line count) plus a flex-wrap
// container with alignContent:'center' gets this for free: adding a second
// line grows the wrapped block symmetrically around its own centre, which
// is exactly "the first line moves up," with no separate reflow logic.
const LETTER_HEIGHT_FRACTION_OF_REGION = 0.4;
const LINE_GAP_FRACTION_OF_REGION = 0.12;

export default function KeyboardTestHarness() {
  const stageRef = useRef(null);
  const [box, setBox] = useState({ width: 0, height: 0, top: 0, left: 0 });
  const [phase, setPhase] = useState('hidden'); // 'hidden' | 'lowering' | 'resting'
  const [text, setText] = useState('');
  const [shipProgress, setShipProgress] = useState(0);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    const measure = () => {
      const vw = el.clientWidth;
      const vh = el.clientHeight;
      const scale = Math.min((vw * FILL_FRACTION) / PANEL_SIZE.w, (vh * FILL_FRACTION) / PANEL_SIZE.h);
      const width = PANEL_SIZE.w * scale;
      const height = PANEL_SIZE.h * scale;
      setBox({ width, height, top: vh * TOP_MARGIN, left: (vw - width) / 2 });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (phase !== 'resting') {
      setShipProgress(0);
      return undefined;
    }
    let rafId;
    const startedAt = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - startedAt) / SHIP_DURATION_MS);
      setShipProgress(p);
      if (p < 1) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [phase]);

  const handleKey = (name) => {
    if (name === 'BACKSPACE') setText((t) => t.slice(0, -1));
    else if (name === 'SPACE') setText((t) => `${t} `);
    else setText((t) => t + name);
  };

  const handleButton = () => {
    if (phase === 'lowering') return; // ignore taps mid-animation
    if (phase === 'hidden') {
      setPhase('lowering');
    } else {
      // Replay: snap back off-screen, clear the slate, then lower again.
      setPhase('hidden-instant');
      setText('');
      requestAnimationFrame(() => requestAnimationFrame(() => setPhase('lowering')));
    }
  };

  const down = phase === 'lowering' || phase === 'resting'; // target position — 'lowering' is mid-transition TO here, not away from it
  const animatingDown = phase === 'lowering';
  const hiddenOffset = -(box.top + box.height);
  const letterHeight = box.height * TEXT_REGION_FRACTION * LETTER_HEIGHT_FRACTION_OF_REGION;

  return (
    <div ref={stageRef} style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#05070a' }}>
      <div
        style={{
          position: 'absolute',
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height,
          transform: `translateY(${down ? 0 : hiddenOffset}px)`,
          transition: phase === 'hidden-instant' ? 'none' : `transform ${LOWER_DURATION_MS}ms ${LOWER_EASING}`,
        }}
        onTransitionEnd={() => {
          if (animatingDown) setPhase('resting');
        }}
      >
        <img src={TRACK_PANEL_SRC} draggable={false} style={{ width: '100%', height: '100%', display: 'block', userSelect: 'none' }} />

        <div
          style={{
            position: 'absolute',
            left: 0,
            width: `${RIGHT_RAIL_START_FRACTION * 100}%`,
            top: `${HOLE_CLEAR_FRACTION * 100}%`,
            bottom: `${(KEYBOARD_COVER_FRACTION + KEYBOARD_BOTTOM_MARGIN_FRACTION) * 100}%`,
            display: 'flex',
            flexWrap: 'wrap',
            alignContent: 'center',
            justifyContent: 'center',
            padding: '0 4%',
            rowGap: box.height * TEXT_REGION_FRACTION * LINE_GAP_FRACTION_OF_REGION,
            overflow: 'hidden',
          }}
        >
          {(() => {
            let index = 0;
            return text.split(' ').map((word, wi) => (
              <div key={wi} style={{ display: 'flex', alignItems: 'flex-end', marginRight: letterHeight * 0.35 }}>
                {word.split('').map((ch, ci) => {
                  const isFirst = index === 0;
                  index += 1;
                  const src = letterImageSrc(ch, isFirst);
                  return src ? (
                    <img key={ci} src={src} draggable={false} style={{ height: letterHeight, width: 'auto', userSelect: 'none' }} />
                  ) : (
                    <span key={ci} style={{ color: '#33ff66', font: `700 ${letterHeight * 0.8}px system-ui, sans-serif` }}>
                      {ch}
                    </span>
                  );
                })}
              </div>
            ));
          })()}
        </div>

        <div
          style={{
            position: 'absolute',
            left: `${KEYBOARD_LEFT_FRACTION * 100}%`,
            width: `${KEYBOARD_WIDTH_FRACTION * 100}%`,
            bottom: `${KEYBOARD_BOTTOM_MARGIN_FRACTION * 100}%`,
            height: `${KEYBOARD_COVER_FRACTION * 100}%`,
          }}
        >
          <CardboardKeyboard onKey={handleKey} />
        </div>

        <img
          src={AVATAR_SRC}
          draggable={false}
          style={{
            position: 'absolute',
            left: `${AVATAR_CARD.left}%`,
            top: `${AVATAR_CARD.top}%`,
            width: `${AVATAR_CARD.width}%`,
            height: `${AVATAR_CARD.height}%`,
            objectFit: 'contain',
            userSelect: 'none',
          }}
        />

        {phase === 'resting' &&
          (() => {
            const p = pointOnTrack(shipProgress);
            const shipWidthPct = SHIP_WIDTH_FRACTION * 100;
            const shipHeightPct = shipWidthPct * (SHIP_SIZE.h / SHIP_SIZE.w) * (PANEL_SIZE.w / PANEL_SIZE.h);
            return (
              <img
                src={SHIP_SRC}
                draggable={false}
                style={{
                  position: 'absolute',
                  left: `${p.x - shipWidthPct * SHIP_ANCHOR.x}%`,
                  top: `${p.y - shipHeightPct * SHIP_ANCHOR.y}%`,
                  width: `${shipWidthPct}%`,
                  height: `${shipHeightPct}%`,
                  userSelect: 'none',
                }}
              />
            );
          })()}
      </div>

      <button
        onClick={handleButton}
        disabled={animatingDown}
        style={{
          position: 'fixed',
          top: '0.75rem',
          right: '0.75rem',
          zIndex: 10,
          padding: '0.5rem 1.25rem',
          background: '#05070a',
          color: '#33ff66',
          border: '2px solid #33ff66',
          borderRadius: '0.4rem',
          font: '700 1rem system-ui, sans-serif',
          opacity: animatingDown ? 0.5 : 1,
          cursor: animatingDown ? 'default' : 'pointer',
        }}
      >
        {phase === 'hidden' || phase === 'lowering' ? 'Go' : 'Replay'}
      </button>
    </div>
  );
}
