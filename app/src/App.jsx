/**
 * Top-level view switch: lobby until a round starts, then the game, then
 * back to the lobby — the "persistent lobby" decision from the handoff doc
 * (a game doesn't replace the lobby, it sits on top of it and hands control
 * back when the player leaves).
 *
 * `?solo=1` bypasses the lobby entirely and mounts Sky Path directly with
 * `?forks=`/`role=` read from the URL, exactly like the old standalone
 * prototype did. Dev-only convenience for iterating on the game itself
 * without needing Supabase or a second device — not part of the real app's
 * user-facing flow, and not gated behind import.meta.env.DEV because it's
 * harmless in production (an ordinary player has no reason to add it).
 */
import { useRef } from 'react';
import { useLobby } from './lobby/useLobby.js';
import Lobby from './lobby/Lobby.jsx';
import GameRoom from './lobby/GameRoom.jsx';
import SkyPath from './skypath/SkyPath.jsx';

const params = new URLSearchParams(location.search);

function SoloSkyPath() {
  const gameRef = useRef(null);
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <SkyPath
        forks={params.get('forks')}
        role={params.get('role') === 'player' ? 'player' : 'guide'}
        gameRef={gameRef}
        onRoundEnd={(result) => console.log('[round end]', result)}
      />
    </div>
  );
}

export default function App() {
  const lobby = useLobby();

  if (params.get('solo') === '1') return <SoloSkyPath />;

  if (lobby.gameSession) {
    return (
      <GameRoom
        session={lobby.gameSession}
        sendForkChoice={lobby.sendForkChoice}
        onForkChoiceReceived={lobby.onForkChoiceReceived}
        onLeave={lobby.leaveGame}
      />
    );
  }

  return <Lobby lobby={lobby} />;
}
