/**
 * The cardboard-key spelling keyboard — Luke, 2026-09-20: a custom on-screen
 * keyboard for the abduction defence, built from real photographed cardboard
 * keys rather than drawn, and rather than the device's own OS keyboard
 * (inconsistent sizing/behaviour across phones, and a defence challenge is
 * short enough — one word or number — that losing autocorrect/predictive
 * text costs nothing).
 *
 * This component only renders the keyboard and reports taps via `onKey`; it
 * has no idea what a "challenge" or "target" is. Keeping it dumb like this
 * is what lets it be dropped into a plain test harness today and the real
 * defence screen later without changing it.
 *
 * Sizing: the source photo has a fixed aspect ratio (~2.2:1) that won't
 * generally match whatever box it's asked to fill (see KeyboardTestHarness,
 * which gives it "roughly the bottom half of the screen" — a very different
 * shape). So this measures its own container and fits the keyboard's native
 * aspect ratio inside it (contain, not stretch) rather than assuming the
 * container already has the right shape.
 */
import { useEffect, useRef, useState } from 'react';
import { KEY_LAYOUT, KEY_LAYOUT_ASPECT, keyImageSrc } from './keyLayout.js';

const KEY_NAMES = Object.keys(KEY_LAYOUT);

// "Move very slightly down and to the right when pressed. Not far enough to
// touch any other keys." — Luke, 2026-09-20. Fixed px (not a % of key size)
// so it stays subtle at any scale; keys sit close enough together (by
// design, matching the source photo) that anything bigger risks visually
// overlapping a neighbour.
const PRESS_OFFSET_PX = 2;

export default function CardboardKeyboard({ onKey }) {
  const containerRef = useRef(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [pressed, setPressed] = useState(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const measure = () => {
      const { clientWidth, clientHeight } = el;
      let width = clientWidth;
      let height = width / KEY_LAYOUT_ASPECT;
      if (height > clientHeight) {
        height = clientHeight;
        width = height * KEY_LAYOUT_ASPECT;
      }
      setBox({ width, height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const press = (name) => (e) => {
    e.preventDefault();
    setPressed(name);
    onKey?.(name);
  };
  const release = () => setPressed(null);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div style={{ position: 'relative', width: box.width, height: box.height }}>
        {KEY_NAMES.map((name) => {
          const k = KEY_LAYOUT[name];
          const isPressed = pressed === name;
          return (
            <img
              key={name}
              src={keyImageSrc(name)}
              draggable={false}
              onPointerDown={press(name)}
              onPointerUp={release}
              onPointerLeave={release}
              onPointerCancel={release}
              style={{
                position: 'absolute',
                left: `${k.left}%`,
                top: `${k.top}%`,
                width: `${k.width}%`,
                height: `${k.height}%`,
                transform: isPressed
                  ? `translate(${PRESS_OFFSET_PX}px, ${PRESS_OFFSET_PX}px)`
                  : 'translate(0, 0)',
                transition: isPressed ? 'transform 60ms ease-out' : 'transform 120ms ease-out',
                touchAction: 'none',
                userSelect: 'none',
                cursor: 'pointer',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
