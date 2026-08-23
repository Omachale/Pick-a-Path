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
 */
import { useEffect, useRef } from 'react';
import { mountSkyPath } from './skyPath.js';

export default function SkyPath({
  forks = null,
  role = 'guide',
  canAct = true,
  onForkChoice,
  onRoundEnd,
  gameRef,
}) {
  const containerRef = useRef(null);
  const callbacks = useRef({ onForkChoice, onRoundEnd });
  callbacks.current = { onForkChoice, onRoundEnd };

  useEffect(() => {
    const handle = mountSkyPath(containerRef.current, {
      forks,
      role,
      canAct,
      // Only forward a handler if the parent actually supplied one — the game
      // treats a missing onForkChoice as "solo, decide it yourself".
      onForkChoice: onForkChoice
        ? (forkIndex, side) => callbacks.current.onForkChoice?.(forkIndex, side)
        : null,
      onRoundEnd: (result) => callbacks.current.onRoundEnd?.(result),
    });
    if (gameRef) gameRef.current = handle;
    return () => {
      handle.dispose();
      if (gameRef) gameRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forks, role, canAct]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
