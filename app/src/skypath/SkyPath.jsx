/**
 * React's entire share of Sky Path: a sized div, a mount, and a dispose.
 *
 * Everything inside the surface — canvas, HUD, fork buttons, character
 * select — is owned by the imperative module and never re-rendered by React.
 * That is deliberate: the HUD updates from the animation loop, and routing
 * 60fps of state through React would buy nothing.
 *
 * The callbacks are held in a ref rather than listed as effect dependencies,
 * so a parent re-render (which produces new function identities) can't tear
 * down a round in progress. The effect re-runs only on the things that
 * genuinely define a different game: the fork sequence, the role, and
 * whether this device may act.
 *
 * `displayName` and `onPlayerState` (2026-09-12) are the teammate-visibility
 * seam: `displayName` overrides the character-select screen's own free-text
 * name input with whatever name this device already joined the lobby as,
 * and `onPlayerState` fires whenever this device's own resting position
 * changes so GameRoom.jsx can relay it to teammates — see skyPath.js's own
 * header comment on `updateTeammate`/`notifyPlayerState` for the full
 * design. Not listed as an effect dependency: a name can't change mid-round
 * (it's fixed at lobby join), and onPlayerState goes through the same ref
 * pattern as the other callbacks.
 */
import { useEffect, useRef } from 'react';
import { mountSkyPath } from './skyPath.js';

export default function SkyPath({
  forks = null,
  words = null,
  role = 'guide',
  canAct = true,
  crowd = 0,
  displayName = null,
  initialGuideIsland = null,
  roster = [],
  myToken = null,
  pickup = null,
  guideToken = null,
  onForkChoice,
  onRoundEnd,
  onPlayerState,
  onGameEvent,
  getAbductionTargets,
  getDisplayName,
  gameRef,
}) {
  const containerRef = useRef(null);
  const callbacks = useRef({ onForkChoice, onRoundEnd, onPlayerState, onGameEvent, getAbductionTargets, getDisplayName });
  callbacks.current = { onForkChoice, onRoundEnd, onPlayerState, onGameEvent, getAbductionTargets, getDisplayName };

  useEffect(() => {
    const handle = mountSkyPath(containerRef.current, {
      forks,
      words,
      role,
      canAct,
      crowd,
      displayName,
      initialGuideIsland,
      roster,
      myToken,
      pickup,
      guideToken,
      // Only forward a handler if the parent actually supplied one — the game
      // treats a missing onForkChoice as "solo, decide it yourself".
      onForkChoice: onForkChoice
        ? (forkIndex, side) => callbacks.current.onForkChoice?.(forkIndex, side)
        : null,
      onRoundEnd: (result) => callbacks.current.onRoundEnd?.(result),
      onPlayerState: onPlayerState ? (state) => callbacks.current.onPlayerState?.(state) : null,
      // Same "missing = solo, settle it locally" contract as onForkChoice.
      onGameEvent: onGameEvent ? (kind, data) => callbacks.current.onGameEvent?.(kind, data) : null,
      getAbductionTargets: getAbductionTargets ? () => callbacks.current.getAbductionTargets?.() ?? [] : null,
      getDisplayName: (tok) => callbacks.current.getDisplayName?.(tok) ?? null,
    });
    if (gameRef) gameRef.current = handle;
    return () => {
      handle.dispose();
      if (gameRef) gameRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forks, words, role, canAct, crowd, displayName, initialGuideIsland, roster, myToken, pickup, guideToken]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
