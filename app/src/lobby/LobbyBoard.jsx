/**
 * Full-screen host for the 3D cardboard-and-oak lobby backdrop (see
 * lobbyBoard.js). Only the board for now. The lobby's own screens will sit
 * on it once they're designed.
 */
import { useEffect, useRef } from 'react';
import { createLobbyBoard } from './lobbyBoard.js';

export default function LobbyBoard() {
  const hostRef = useRef(null);
  useEffect(() => {
    const board = createLobbyBoard(hostRef.current);
    return () => board.dispose();
  }, []);
  return <div ref={hostRef} style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#2a1e14' }} />;
}
