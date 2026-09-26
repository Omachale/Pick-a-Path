/**
 * React's entire share of the victory stage — a sized div, a mount, and a
 * dispose. Same split as SkyPath.jsx/LavaCavern.jsx: everything inside the
 * surface is owned by the imperative module, since it animates every frame
 * and routing that through React would buy nothing.
 */
import { useEffect, useRef } from 'react';
import { mountVictoryStage } from './victoryStage.js';

export default function VictoryStage({ round, roundResultsByToken, getDisplayName, getCharacter, onBackToLobby }) {
  const containerRef = useRef(null);

  useEffect(() => {
    const handle = mountVictoryStage(containerRef.current, {
      round,
      roundResultsByToken,
      getDisplayName,
      getCharacter,
      onBackToLobby,
    });
    return () => handle.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- round.roundId is the real identity; scores/names update within the same mount via the imperative module's own closure, not a remount.
  }, [round.roundId]);

  return <div ref={containerRef} style={{ position: 'fixed', inset: 0 }} />;
}
