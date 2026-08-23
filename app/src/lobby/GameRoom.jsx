/**
 * Wires a live Sky Path round to the room channel — the continuation of the
 * lobby-prototype's step-4 wiring, now living in-app instead of opening a
 * second tab via a stamped URL. This is the piece that makes the fork-choice
 * decision in TODO.md real: `onForkChoice` never decides locally, it only
 * asks `useLobby`'s `sendForkChoice` to put the tap on the relay, and
 * `onForkChoiceReceived` is what calls back into the running game once that
 * tap comes back from Supabase — for every device in the room, including
 * whoever tapped.
 */
import { useEffect, useRef } from 'react';
import SkyPath from '../skypath/SkyPath.jsx';

export default function GameRoom({ session, sendForkChoice, onForkChoiceReceived, onLeave }) {
  const gameRef = useRef(null);
  const { forks, role } = session;

  useEffect(() => {
    onForkChoiceReceived((forkIndex, side) => {
      gameRef.current?.applyChoice(forkIndex, side);
    });
    return () => onForkChoiceReceived(null);
  }, [onForkChoiceReceived]);

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <SkyPath
        forks={forks}
        role={role}
        canAct={role === 'player'}
        gameRef={gameRef}
        onForkChoice={sendForkChoice}
        onRoundEnd={(result) => {
          // Stage E credits this to the participant's roster row. For now it
          // just proves the round reports upward through the real room.
          console.log('[round end]', result);
        }}
      />
      <button
        onClick={onLeave}
        style={{
          position: 'absolute',
          top: 'calc(env(safe-area-inset-top, 0px) + 8px)',
          left: 8,
          zIndex: 20,
          padding: '8px 12px',
          border: 0,
          borderRadius: 8,
        }}
      >
        ← Back to lobby
      </button>
    </div>
  );
}
