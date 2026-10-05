/**
 * Full-screen host for the 3D cardboard-and-oak lobby backdrop (see
 * lobbyBoard.js), which now also holds the player lobby on its right half.
 */
import { useEffect, useRef } from 'react';
import { createLobbyBoard } from './lobbyBoard.js';

// Letters only and 10 at most: the cardboard lettering is A-Z, and player
// names are cut to 10 characters (see nameTag.js's normalizePlayerName).
const DEV_NAMES = [
  'Zara', 'Milo', 'Indy', 'Bea', 'Sam', 'Kit', 'Hana', 'Omar', 'Lucia', 'Kenji', 'Amara', 'Felix',
  'Priya', 'Tomas', 'Yuki', 'Noor', 'Mateo', 'Ines', 'Jun', 'Leila', 'Arjun', 'Sofia', 'Kofi', 'Elif',
  'Bartholome', 'Maximilian', 'Josephine', 'Alexandra', 'Ty', 'Al',
];

export default function LobbyBoard() {
  const hostRef = useRef(null);
  const boardRef = useRef(null);
  useEffect(() => {
    const board = createLobbyBoard(hostRef.current);
    boardRef.current = board;
    return () => board.dispose();
  }, []);
  const addPlayer = () => boardRef.current?.addPlayer(DEV_NAMES[Math.floor(Math.random() * DEV_NAMES.length)]);
  return (
    <>
      <div ref={hostRef} style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#2a1e14' }} />
      {/* DEV: adds a player with a random name, until real arrivals are wired up. */}
      <button onClick={addPlayer} style={{ position: 'fixed', top: 8, right: 8, zIndex: 10 }}>
        + player (dev)
      </button>
    </>
  );
}
