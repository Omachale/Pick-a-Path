/**
 * Luke, 2026-09-20: "I actually turn the phone to landscape mode, and it is
 * my intention that everyone playing the game do this... can this be baked
 * in, so that when the game starts it is 'sideways' from the start, and
 * remains so always?"
 *
 * A real OS-level orientation lock (`screen.orientation.lock()`) only works
 * in Chromium on Android, and only inside fullscreen — iOS Safari doesn't
 * implement it at all, in a tab or added-to-home-screen, so it can't be
 * relied on for a "scan a QR code and play in the browser" game. This
 * covers every platform instead by blocking the screen with a "rotate your
 * device" prompt whenever the viewport is portrait, which is what most
 * browser-based games do for exactly this reason. `MAX_WIDTH` keeps this
 * from firing on an ordinary desktop window (no reason to demand a desktop
 * dev accidentally resize to portrait be told to "rotate"); it's sized
 * above tablet portrait width so tablets still get the prompt.
 */
import { useEffect, useState } from 'react';

const MAX_WIDTH = 900;

function isPortrait() {
  return window.innerHeight > window.innerWidth && window.innerWidth < MAX_WIDTH;
}

export default function OrientationGuard({ children }) {
  const [portrait, setPortrait] = useState(isPortrait);

  useEffect(() => {
    const update = () => setPortrait(isPortrait());
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    // Best-effort real lock, for the one platform that supports it
    // (Chromium/Android) once it's actually in fullscreen. Silently
    // rejects everywhere else — that's fine, the overlay is the real
    // cross-platform guard.
    screen.orientation?.lock?.('landscape').catch(() => {});
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  return (
    <>
      {children}
      {portrait && (
        <div style={overlayStyle}>
          <div style={phoneStyle} />
          <div style={textStyle}>Rotate your device to play</div>
        </div>
      )}
    </>
  );
}

const overlayStyle = {
  position: 'fixed',
  inset: 0,
  zIndex: 100000,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '1.5rem',
  background: '#05070a',
  color: '#33ff66',
};

const phoneStyle = {
  width: '3.5rem',
  height: '6rem',
  border: '0.25rem solid #33ff66',
  borderRadius: '0.6rem',
  animation: 'orientation-guard-rotate 1.6s ease-in-out infinite',
};

const textStyle = {
  font: '700 1.1rem/1.4 system-ui, sans-serif',
  letterSpacing: '0.02em',
};

// Keyframes injected once, globally — simplest way to get an animation
// without pulling this component's styling into styles.css for one rule.
if (typeof document !== 'undefined' && !document.getElementById('orientation-guard-keyframes')) {
  const style = document.createElement('style');
  style.id = 'orientation-guard-keyframes';
  style.textContent = `
    @keyframes orientation-guard-rotate {
      0%, 15% { transform: rotate(0deg); }
      50%, 65% { transform: rotate(90deg); }
      100% { transform: rotate(0deg); }
    }
  `;
  document.head.appendChild(style);
}
