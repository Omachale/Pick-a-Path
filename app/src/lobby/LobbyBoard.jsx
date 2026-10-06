/**
 * The teacher's lobby: the 3D board (lobbyBoard.js) plus everything only a
 * page can do: the game's realtime connection (teacherSession.js), creating
 * a game, starting rounds (roundStart.js), saving the arrangement, and a
 * plain message line for feedback. The board is now the default landing
 * page (App.jsx); players arrive on the `?join=CODE` link the QR card
 * carries.
 *
 * Sign-in is off for now (see sessionConfig.js's TEACHER_SIGN_IN): Create
 * just mints a code, with nothing written to the database.
 */
import { useEffect, useRef, useState } from 'react';
import { createLobbyBoard } from './lobbyBoard.js';
import { openTeacherSession } from './teacherSession.js';
import { randomJoinCode, createRoundState, startRounds } from './roundStart.js';
import { joinUrl } from './sessionConfig.js';

// This browser's current game, so a reload mid-lesson reconnects to it.
const GAME_KEY = 'skypath.board.gameCode';
// The board's dials and arrangement for a game, so a reload keeps them too.
const stateKey = (code) => `skypath.board.state.${code}`;
// Between telling phones their teams and starting the round. Phones decide a
// round start is theirs from their team, which they learn from the first
// message; the published player build (which students' phones load) needs
// that to have arrived first.
const TEAMS_THEN_START_MS = 1200;

const MODE_NAMES = { skypath: 'Sky Temple', cavern: 'Volcano' };
const TEAM_WORDS = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];

// Letters only and 10 at most: the cardboard lettering is A-Z, and player
// names are cut to 10 characters (see nameTag.js's normalizePlayerName).
const DEV_NAMES = [
  'Zara', 'Milo', 'Indy', 'Bea', 'Sam', 'Kit', 'Hana', 'Omar', 'Lucia', 'Kenji', 'Amara', 'Felix',
  'Priya', 'Tomas', 'Yuki', 'Noor', 'Mateo', 'Ines', 'Jun', 'Leila', 'Arjun', 'Sofia', 'Kofi', 'Elif',
  'Bartholome', 'Maximilian', 'Josephine', 'Alexandra', 'Ty', 'Al',
];

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

export default function LobbyBoard() {
  const hostRef = useRef(null);
  const boardRef = useRef(null);
  const sessionRef = useRef(null);
  const codeRef = useRef(null);
  const roundStateRef = useRef(createRoundState());
  const [message, setMessage] = useState(null);

  useEffect(() => {
    function connect(code) {
      sessionRef.current?.close();
      codeRef.current = code;
      roundStateRef.current = createRoundState();
      const board = boardRef.current;
      board.setGame(code, joinUrl(code));
      board.importState(readJson(stateKey(code)));
      sessionRef.current = openTeacherSession(code, {
        onPlayers(players) {
          const turnedAway = board.syncPlayers(players);
          if (turnedAway.length) sessionRef.current?.send('lobby-full', { tokens: turnedAway });
        },
      });
    }

    const hooks = {
      onCreate() {
        if (codeRef.current && !window.confirm('Start a new game? Everyone will need to join again with the new code.')) return;
        if (codeRef.current) localStorage.removeItem(stateKey(codeRef.current));
        const code = randomJoinCode();
        localStorage.setItem(GAME_KEY, code);
        connect(code);
        setMessage(`New game created. Code ${code}. Press Join to show the QR code.`);
      },
      // The QR card covers the top-left, where the message sits (Luke: "partly
      // blocking the QR code and looks stupid"), so Join clears it.
      onJoin() {
        setMessage(null);
      },
      onJoinWithoutGame() {
        setMessage('Press Create first, to make a game for players to join.');
      },
      async onStart() {
        const code = codeRef.current;
        if (!code) return setMessage('Press Create first, to make a game for players to join.');
        const t = boardRef.current.getTeams();
        if (!t.playable) return setMessage(`${MODE_NAMES[t.mode] ?? 'That mode'} is coming soon. Turn the top dial to Sky Temple to start.`);
        const total = t.teams.reduce((n, team) => n + team.length, 0) + t.unassigned.length;
        if (total === 0) return setMessage('No players have joined yet.');
        const label = (i) => `Team ${TEAM_WORDS[i] ?? i + 1}`;
        const over = t.teams.findIndex((team) => team.length > t.settings.players);
        if (over >= 0) return setMessage(`${label(over)} has too many players. Move someone out first.`);
        if (t.unassigned.length) return setMessage(`Put everyone in a team first: ${t.unassigned.length} still unassigned.`);
        const small = t.teams.findIndex((team) => team.length < 2);
        if (small >= 0) return setMessage(`${label(small)} needs at least 2 players: a guide and a runner.`);

        const send = (event, payload) => sessionRef.current?.send(event, payload);
        const assignments = {};
        t.teams.forEach((team, i) => team.forEach((id) => (assignments[id] = i + 1)));
        send('groups-updated', { assignments });
        setMessage('Starting...');
        await new Promise((r) => setTimeout(r, TEAMS_THEN_START_MS));
        try {
          await startRounds(send, new Map(t.teams.map((team, i) => [i + 1, team])), roundStateRef.current);
          setMessage('Round started. Press Start again for the next round.');
        } catch (err) {
          setMessage(`Couldn't start: ${err.message ?? err}`);
        }
      },
      onRosterChange(state) {
        if (codeRef.current) localStorage.setItem(stateKey(codeRef.current), JSON.stringify(state));
      },
    };

    const board = createLobbyBoard(hostRef.current, undefined, hooks);
    boardRef.current = board;
    const saved = localStorage.getItem(GAME_KEY);
    if (saved) connect(saved);
    return () => {
      sessionRef.current?.close();
      sessionRef.current = null;
      board.dispose();
    };
  }, []);

  const addPlayer = () => {
    const id = boardRef.current?.addPlayer(DEV_NAMES[Math.floor(Math.random() * DEV_NAMES.length)]);
    if (id === null) setMessage('The game is full (24 players).');
  };
  return (
    <>
      <div ref={hostRef} style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#2a1e14' }} />
      {/* Plain feedback line for now; it'll get proper board styling later. */}
      {message && (
        <div
          onClick={() => setMessage(null)}
          style={{
            position: 'fixed',
            top: 8,
            left: 8,
            zIndex: 10,
            maxWidth: '60vw',
            padding: '6px 10px',
            background: 'rgba(20,14,8,0.85)',
            color: '#f3e6cf',
            borderRadius: 4,
            font: '14px system-ui, sans-serif',
            cursor: 'pointer',
          }}
        >
          {message}
        </div>
      )}
      {/* DEV: adds a made-up player with a random name. */}
      <button onClick={addPlayer} style={{ position: 'fixed', top: 8, right: 8, zIndex: 10 }}>
        + player (dev)
      </button>
    </>
  );
}
