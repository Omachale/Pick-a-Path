/**
 * Wires a live Sky Path round to the room channel — the continuation of the
 * lobby-prototype's step-4 wiring, now living in-app instead of opening a
 * second tab via a stamped URL. This is the piece that makes the fork-choice
 * decision in TODO.md real: `onForkChoice` never decides locally, it only
 * asks `useLobby`'s `sendForkChoice` to put the tap on the relay, and
 * `onForkChoiceReceived` is what calls back into the running game once that
 * tap comes back from Supabase — for every device in the room, including
 * whoever tapped.
 *
 * Stage D: `onRoundEnd` is now `useLobby`'s `reportRoundEnd`, not a
 * console.log — it broadcasts the result so the whole room (not just this
 * device) transitions to the results screen. Whether that credits a
 * participant's roster row is still Stage E's job, unwired either way.
 *
 * 2026-09-12: `onPlayerStateReceived`/`sendPlayerState` is the same
 * relay-a-callback pattern as fork-choice, for teammate visibility — see
 * skyPath.js's own "teammates" section for the full design. `displayName`
 * comes from whatever this device already joined the LOBBY as, not a second
 * name typed into Sky Path's own character-select screen.
 *
 * 2026-09-13: `failed` replaces the old design where a fallen player's
 * device rendered a SECOND, separate `<GameRoom role="watching">` — Luke,
 * after seeing a loading screen flash on every fall: "a loading screen
 * after the player falls suggests a restart of some sort. In no way should
 * the game be restarting." Exactly right: forcing `role` to change on a
 * fresh element is what SkyPath.jsx's mount effect treats as "genuinely a
 * different game," tearing the whole THREE.js scene down and rebuilding it
 * (a real loading screen, not a UI illusion). App.jsx now keeps rendering
 * the SAME `<GameRoom>` (same `round`, whose own `role` never changes to
 * 'watching' any more) straight through a fall, and just flags `failed` —
 * this component reacts to that by calling the running instance's own
 * `becomeSpectator()` instead, which flips it in place with no remount at
 * all. See skyPath.js's own header comment on `becomeSpectator` for why
 * that also makes the old `initialGuideIsland` guesswork unnecessary here:
 * the already-running instance already knows exactly where it is.
 */
import { useEffect, useRef } from 'react';
import SkyPath from '../skypath/SkyPath.jsx';

export default function GameRoom({
  round,
  failed = false,
  displayName,
  sendForkChoice,
  onForkChoiceReceived,
  sendPlayerState,
  onPlayerStateReceived,
  onRoundEnd,
  onLeave,
}) {
  const gameRef = useRef(null);
  const { forks, words, role } = round;

  useEffect(() => {
    onForkChoiceReceived((forkIndex, side) => {
      gameRef.current?.applyChoice(forkIndex, side);
    });
    return () => onForkChoiceReceived(null);
  }, [onForkChoiceReceived]);

  useEffect(() => {
    onPlayerStateReceived((token, state) => {
      gameRef.current?.updateTeammate(token, state);
    });
    return () => onPlayerStateReceived(null);
  }, [onPlayerStateReceived]);

  useEffect(() => {
    if (failed) gameRef.current?.becomeSpectator();
  }, [failed]);

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <SkyPath
        forks={forks}
        words={words}
        role={role}
        canAct={role === 'player'}
        displayName={displayName}
        gameRef={gameRef}
        onForkChoice={sendForkChoice}
        onRoundEnd={onRoundEnd}
        onPlayerState={sendPlayerState}
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
