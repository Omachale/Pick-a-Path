/**
 * What a player sees after scanning the teacher's QR code (`?join=CODE`):
 * the game's own painting as a background, a landscape panel to choose a
 * character, colour and name, then a waiting message until the teacher
 * starts the round.
 *
 * Luke, 2026-10-05: "let's just use the same image that forms the display
 * for the Skypath game in the UI. The joining player will see this
 * background, and then choose their avatar etc. on top of it. Once that's
 * done, put in a simple 'waiting for game to start' message." Choosing
 * happens here, on joining, rather than in the game at round start; the
 * choice travels in this device's presence (so the teacher's board shows the
 * name in the player's colour) and into the game, which then skips its own
 * character select (skyPath.js's presetLook).
 *
 * LANDSCAPE FIRST. The game is played sideways, and the old in-game select
 * screen was shaped for a phone held upright, so players chose in portrait
 * then turned the phone (Luke: "an ugly solution"). This panel is two
 * columns sized from the screen's HEIGHT, so it fits a phone held sideways.
 * Held upright, it stacks and asks the player to turn the phone.
 *
 * REJOINING. A phone that reloads or reconnects mid-game rejoins by itself
 * with the same name and look (remembered per game code), so a dropped
 * player is back in their team for the next round without choosing again
 * (Luke, 2026-10-06: "let players reconnect later within a reasonable
 * timeframe"). Their token is the same, so the teacher's series knows them.
 */
import { useEffect, useState } from 'react';
import { CHARACTERS, PALETTE, characterSrc } from '../skypath/characters.js';
import { normalizePlayerName } from '../skypath/nameTag.js';
import { clearToken } from './identity.js';
import { joinedKey } from './useLobby.js';

const BACKGROUND = 'textures/mode-skytemple.jpg';
const gameCode = new URLSearchParams(location.search).get('join') ?? '';
const css = (hex) => `#${hex.toString(16).padStart(6, '0')}`;
const pick = (n) => Math.floor(Math.random() * n);

function usePortrait() {
  const [portrait, setPortrait] = useState(() => window.innerHeight > window.innerWidth);
  useEffect(() => {
    const onResize = () => setPortrait(window.innerHeight > window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return portrait;
}

// The avatar on a card, glowing in the chosen colour.
function Avatar({ characterKey, colorHex, size }) {
  return (
    <div
      style={{
        height: size,
        aspectRatio: '0.62',
        borderRadius: 16,
        border: `4px solid ${css(colorHex)}`,
        boxShadow: `0 0 22px ${css(colorHex)}aa`,
        background: 'rgba(244, 247, 250, 0.08)',
        display: 'grid',
        placeItems: 'center',
        padding: 8,
        boxSizing: 'border-box',
      }}
    >
      <img src={characterSrc(characterKey)} alt="" style={{ maxHeight: '100%', maxWidth: '100%', objectFit: 'contain' }} />
    </div>
  );
}

const panel = {
  background: 'rgba(18, 33, 47, 0.8)',
  backdropFilter: 'blur(3px)',
  WebkitBackdropFilter: 'blur(3px)',
  color: '#f4f7fa',
  borderRadius: 20,
  padding: 'min(4vh, 22px) min(4vw, 32px)',
  boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
  font: '600 15px/1.3 system-ui, sans-serif',
  maxWidth: '94vw',
  maxHeight: '94vh',
  boxSizing: 'border-box',
  overflow: 'auto',
};
const heading = { margin: '0 0 1.2vh', font: '700 min(4.6vh, 18px)/1.2 system-ui, sans-serif' };
const navButton = {
  width: 'min(11vh, 48px)',
  height: 'min(11vh, 48px)',
  border: 0,
  borderRadius: 10,
  background: 'rgba(244, 247, 250, 0.16)',
  color: '#f4f7fa',
  fontSize: 'min(7vh, 28px)',
  cursor: 'pointer',
};

export default function PlayerJoin({ lobby }) {
  const portrait = usePortrait();
  const [charIdx, setCharIdx] = useState(() => pick(CHARACTERS.length));
  const [colorHex, setColorHex] = useState(() => PALETTE[pick(PALETTE.length)].hex);
  const [name, setName] = useState(() => lobby.participant?.displayName ?? '');
  const characterKey = CHARACTERS[charIdx].key;
  const cleanName = normalizePlayerName(name);
  const join = () => {
    if (!cleanName) return;
    lobby.join(cleanName, { characterKey, colorHex });
    try {
      localStorage.setItem(joinedKey(gameCode), JSON.stringify({ name: cleanName, look: { characterKey, colorHex } }));
    } catch {
      // Private mode: rejoining just means choosing again.
    }
  };
  useEffect(() => {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(joinedKey(gameCode)) ?? 'null');
    } catch {
      // Unreadable: choose again.
    }
    if (saved?.name && !lobby.joined) lobby.join(saved.name, saved.look);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const step = (d) => setCharIdx((i) => (i + d + CHARACTERS.length) % CHARACTERS.length);
  const swatch = 'min(9vh, 42px)';

  let content;
  if (lobby.removed) {
    content = (
      <div style={panel}>
        <h2 style={heading}>Your teacher has removed you from this game</h2>
        <p style={{ margin: 0 }}>Ask your teacher if you think this is a mistake.</p>
      </div>
    );
  } else if (lobby.full) {
    content = (
      <div style={panel}>
        <h2 style={heading}>Sorry, this game is full</h2>
        <p style={{ margin: 0 }}>Ask your teacher what to do.</p>
      </div>
    );
  } else if (lobby.joined) {
    const shown = lobby.look ?? { characterKey, colorHex };
    content = (
      <div style={{ ...panel, display: 'flex', alignItems: 'center', gap: 'min(5vw, 36px)', flexDirection: portrait ? 'column' : 'row' }}>
        <Avatar characterKey={shown.characterKey} colorHex={shown.colorHex} size="min(46vh, 240px)" />
        <div style={{ textAlign: portrait ? 'center' : 'left' }}>
          <div style={{ font: '800 min(8vh, 34px)/1.1 system-ui, sans-serif', color: css(shown.colorHex) }}>
            {lobby.participant?.displayName}
          </div>
          <p style={{ margin: '1.5vh 0 0', font: '600 min(5vh, 20px)/1.3 system-ui, sans-serif' }}>
            {lobby.sittingOut ? "You're in! Your team is playing a round: you'll join in from the next one." : "You're in! Waiting for the game to start..."}
          </p>
        </div>
      </div>
    );
  } else {
    content = (
      <div style={{ ...panel, display: 'flex', gap: 'min(5vw, 40px)', alignItems: 'center', flexDirection: portrait ? 'column' : 'row' }}>
        <div style={{ textAlign: 'center' }}>
          <h2 style={heading}>Choose your character</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button style={navButton} onClick={() => step(-1)} aria-label="Previous character">‹</button>
            <Avatar characterKey={characterKey} colorHex={colorHex} size="min(52vh, 260px)" />
            <button style={navButton} onClick={() => step(1)} aria-label="Next character">›</button>
          </div>
          <div style={{ opacity: 0.6, fontSize: 12, marginTop: 6 }}>
            {charIdx + 1}/{CHARACTERS.length}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2.2vh' }}>
          <div>
            <h2 style={{ ...heading, textAlign: 'center' }}>Choose your colour</h2>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(4, ${swatch})`, gap: 10 }}>
              {PALETTE.map((p) => (
                <button
                  key={p.key}
                  aria-label={p.label}
                  onClick={() => setColorHex(p.hex)}
                  style={{
                    width: swatch,
                    height: swatch,
                    borderRadius: 999,
                    border: `3px solid ${p.hex === colorHex ? '#ffe9b8' : 'transparent'}`,
                    boxShadow: 'inset 0 0 0 2px rgba(0,0,0,0.25)',
                    background: css(p.hex),
                    cursor: 'pointer',
                  }}
                />
              ))}
            </div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <h2 style={heading}>Your name</h2>
            <input
              value={name}
              // Letters and spaces only, 10 at most: the game's cardboard
              // lettering is A-Z, and names are cut to 10 (normalizePlayerName).
              onChange={(e) => setName(e.target.value.replace(/[^a-zA-Z ]/g, '').slice(0, 10))}
              onKeyDown={(e) => e.key === 'Enter' && join()}
              placeholder="Your name"
              autoComplete="off"
              style={{
                width: 'min(56vw, 230px)',
                height: 'min(11vh, 46px)',
                padding: '0 14px',
                border: '2px solid rgba(244, 247, 250, 0.3)',
                borderRadius: 10,
                background: 'rgba(244, 247, 250, 0.1)',
                color: '#f4f7fa',
                font: '600 16px/1.2 system-ui, sans-serif',
                textAlign: 'center',
                boxSizing: 'border-box',
              }}
            />
          </div>
          <button
            onClick={join}
            disabled={!cleanName}
            style={{
              minHeight: 'min(13vh, 52px)',
              padding: '0 36px',
              border: 0,
              borderRadius: 14,
              font: '700 17px/1.2 system-ui, sans-serif',
              color: '#12212f',
              background: cleanName ? '#f4f7fa' : 'rgba(244,247,250,0.4)',
              boxShadow: '0 3px 14px rgba(0,0,0,0.35)',
              cursor: cleanName ? 'pointer' : 'default',
            }}
          >
            Join
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#12212f' }}>
      {/* The game's painting, cropped a little so its paper edge doesn't show. */}
      <div
        style={{
          position: 'absolute',
          inset: '-3%',
          background: `url(${BACKGROUND}) center / cover no-repeat`,
        }}
      />
      {portrait && (
        <div
          style={{
            position: 'absolute',
            top: 10,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 2,
            padding: '6px 14px',
            borderRadius: 999,
            background: 'rgba(18, 33, 47, 0.85)',
            color: '#ffe9b8',
            font: '700 14px/1.2 system-ui, sans-serif',
            whiteSpace: 'nowrap',
          }}
        >
          Turn your phone sideways ↻
        </div>
      )}
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', zIndex: 1 }}>{content}</div>
      {/* DEV: a fresh identity, for testing several players in one browser. Shown after joining too, since a reload now rejoins by itself. */}
      {import.meta.env.DEV && (
        <button
          onClick={() => {
            clearToken();
            localStorage.removeItem(joinedKey(gameCode));
            location.reload();
          }}
          style={{ position: 'absolute', left: 8, bottom: 8, zIndex: 2, fontSize: 11, opacity: 0.7 }}
        >
          New device (dev)
        </button>
      )}
    </div>
  );
}
