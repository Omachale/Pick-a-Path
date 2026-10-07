/**
 * The teacher's lobby: the 3D board (lobbyBoard.js) plus everything only a
 * page can do: the game's realtime connection (teacherSession.js), creating
 * a game, starting rounds (roundStart.js), saving the arrangement, and a
 * plain message line for feedback. The board is now the default landing
 * page (App.jsx); players arrive on the `?join=CODE` link the QR card
 * carries.
 *
 * Rounds come in a series (series.js): each press of Start plays the next
 * round, a new guide in every team, until everyone has guided; then the
 * victory scene (modelTown/victoryTown.js) takes over this screen. Luke,
 * 2026-10-06: "Make sure it only happens at the end of each round, after
 * each player has had a chance to be a guide." While a series is on, its
 * players are locked on the board; a newcomer placed in a team joins it at
 * the next round; someone away is left to guide last, and forgotten if
 * still away when their turn comes (see series.js).
 *
 * Dropping out of a round: each phone puts the round it's in into its
 * presence (useLobby.js), so this page sees not only who has gone but who
 * is back without being in their round (a reloaded phone). Out for longer
 * than DROPPED_AFTER_MS, a runner stops holding the round open, and a guide
 * has their team's round restarted with someone else guiding (series.js).
 * When a team's round is over, phones are told (`round-over`), so teammates
 * of a dropped runner aren't left waiting for them.
 *
 * During a series, each player's name tag carries a status badge (guiding,
 * running, finished with their score, dropped, or waiting for the next
 * round), and the teacher has End round, End series and Remove (Luke,
 * 2026-10-06, agreed). A removed player can't rejoin from that device: their
 * token is remembered, kept off the board, and told so.
 *
 * Sign-in is off for now (see sessionConfig.js's TEACHER_SIGN_IN): Create
 * just mints a code, with nothing written to the database.
 */
import { useEffect, useRef, useState } from 'react';
import { createLobbyBoard } from './lobbyBoard.js';
import { openTeacherSession } from './teacherSession.js';
import { randomJoinCode, createRoundState, startRounds } from './roundStart.js';
import { joinUrl, DEFAULT_PLAYER_COLOUR } from './sessionConfig.js';
import { createSeries, seriesMembers, addMembers, settleAbsent, planRound, roundInProgress, roundNumber, recordStarts, recordResult, seriesDone, victoryTeams, latestRounds, roundComplete, discardRound, closeRounds, endSeries, removeMember } from './series.js';
import { totalScore, roundToNearestHalf } from './scoring.js';
import VictoryTown from './VictoryTown.jsx';

// This browser's current game, so a reload mid-lesson reconnects to it.
const GAME_KEY = 'skypath.board.gameCode';
// The board's dials and arrangement for a game, so a reload keeps them too.
const stateKey = (code) => `skypath.board.state.${code}`;
// The series of rounds in progress for a game, likewise.
const seriesKey = (code) => `skypath.board.series.${code}`;
// The last seen name and look of everyone who has joined a game, so the
// victory scene can show a player who has since dropped out.
const peopleKey = (code) => `skypath.board.people.${code}`;
// Each team's latest round start, for a projector opened mid-round (teacherSession.js).
const roundsKey = (code) => `skypath.board.rounds.${code}`;
// Players the teacher has removed from a game, kept out if they come back.
const removedKey = (code) => `skypath.board.removed.${code}`;
// Between telling phones their teams and starting the round. Phones decide a
// round start is theirs from their team, which they learn from the first
// message; the published player build (which students' phones load) needs
// that to have arrived first.
const TEAMS_THEN_START_MS = 1200;
// How long a series player must be gone to count as having left, the same
// grace the board gives before removing a name (lobbyBoard.js AWAY_SECONDS):
// phones sleep and wifi blips, and right after a teacher reload the first
// presence update may not list everyone yet.
// (DEV: localStorage 'dev.leftAfterMs' shortens it, for testing with bots.)
const LEFT_AFTER_MS = (import.meta.env.DEV && Number(localStorage.getItem('dev.leftAfterMs'))) || 60000;
// How long a guide or runner must be out of their round (gone, or back but
// not in it) before the round goes on without them. Shorter than
// LEFT_AFTER_MS: the rest of the team is waiting, and nothing is lost by it
// (a runner is averaged over one round fewer; a guide guides later). Long
// enough for a phone to reconnect after a wifi blip, and for phones to
// report a new round after it starts.
// (DEV: localStorage 'dev.droppedAfterMs'.)
const DROPPED_AFTER_MS = (import.meta.env.DEV && Number(localStorage.getItem('dev.droppedAfterMs'))) || 30000;

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
  const seriesRef = useRef(null);
  const peopleRef = useRef(new Map());
  const presentRef = useRef(new Set()); // tokens connected right now
  const awaySinceRef = useRef(new Map()); // series member token -> when they were last seen going
  const roundOfRef = useRef(new Map()); // token -> the round its phone says it's in (presence)
  const outSinceRef = useRef(new Map()); // 'roundId|token' -> when they were first seen out of that round
  const restartingRef = useRef(new Set()); // groupIds whose round is being restarted
  const roundOverSentRef = useRef(new Set()); // roundIds phones have been told are over
  const removedRef = useRef(new Set()); // tokens removed by the teacher (see removedKey)
  const announcedRef = useRef(0); // the last round number whose end was announced
  const [message, setMessage] = useState(null);
  const [victory, setVictory] = useState(null); // the victory scene's teams, while it shows
  const victoryShownRef = useRef(false);
  // DEV: bot players run from this page (src/dev/bots.js) — see addBots below.
  const botsRef = useRef({ next: 0, sets: [] });
  const stopBots = () => {
    for (const set of botsRef.current.sets) set.stop();
    botsRef.current = { next: 0, sets: [] };
  };

  // No series any more: unlock the board, clear the badges, forget it.
  function resetSeries() {
    setVictory(null);
    seriesRef.current = null;
    victoryShownRef.current = false;
    boardRef.current?.setLocked(null);
    boardRef.current?.setStatuses(null);
    if (codeRef.current) localStorage.removeItem(seriesKey(codeRef.current));
  }

  useEffect(() => {
    const saveSeries = () => {
      const code = codeRef.current;
      if (!code) return;
      if (seriesRef.current) localStorage.setItem(seriesKey(code), JSON.stringify(seriesRef.current));
      else localStorage.removeItem(seriesKey(code));
    };
    const showVictory = () => setVictory(victoryTeams(seriesRef.current, peopleRef.current, DEFAULT_PLAYER_COLOUR));
    const lockSeries = () => boardRef.current.setLocked(seriesRef.current ? seriesMembers(seriesRef.current) : null);
    const nameOf = (tok) => peopleRef.current.get(tok)?.displayName ?? 'A player';
    const teamName = (groupId) => `Team ${TEAM_WORDS[groupId - 1] ?? groupId}`;
    // After any change (a result, someone leaving or coming back): forget
    // players whose guide turn came while they were away, then either end
    // the series or say the round is over.
    // Series members gone for longer than LEFT_AFTER_MS.
    const awaySet = () => {
      const now = Date.now();
      const present = presentRef.current;
      const away = new Set();
      for (const tok of seriesRef.current ? seriesMembers(seriesRef.current) : []) {
        if (present.has(tok)) {
          awaySinceRef.current.delete(tok);
          continue;
        }
        if (!awaySinceRef.current.has(tok)) awaySinceRef.current.set(tok, now);
        if (now - awaySinceRef.current.get(tok) >= LEFT_AFTER_MS) away.add(tok);
      }
      return away;
    };
    // `away`, plus each latest round's runners and guide who have been out of
    // it for longer than DROPPED_AFTER_MS (gone, or back but not in it).
    const outSet = (away) => {
      const now = Date.now();
      const out = new Set(away);
      for (const { round } of latestRounds(seriesRef.current)) {
        for (const tok of [...round.roster, round.guideToken]) {
          const key = `${round.roundId}|${tok}`;
          if (tok in round.results || (presentRef.current.has(tok) && roundOfRef.current.get(tok) === round.roundId)) {
            outSinceRef.current.delete(key);
            continue;
          }
          if (!outSinceRef.current.has(key)) outSinceRef.current.set(key, now);
          if (now - outSinceRef.current.get(key) >= DROPPED_AFTER_MS) out.add(tok);
        }
      }
      return out;
    };
    // A guide out of their round while runners are still going: throw the
    // round away and restart the team with another guide (series.js). The
    // dropped guide keeps their turn, and runs now if they're back.
    const restartTeam = async (groupId, round, { removed = false } = {}) => {
      const series = seriesRef.current;
      restartingRef.current.add(groupId);
      const dropped = round.guideToken;
      const { plan } = planRound(series, presentRef.current, { groupIds: [groupId], notGuide: new Set([dropped]) });
      discardRound(series, groupId);
      saveSeries();
      const lost = `${teamName(groupId)}'s guide, ${nameOf(dropped)}, ${removed ? 'was removed' : 'lost connection'}`;
      try {
        if (!plan.length) {
          // Nobody to restart with: let the runners' phones leave the round.
          sessionRef.current?.send('round-over', { roundId: round.roundId });
          setMessage(`${lost}, and there aren't enough players connected to restart their round. Press Start when they're back.`);
          return;
        }
        const send = (event, payload) => sessionRef.current?.send(event, payload);
        const members = series.teams.find((t) => t.groupId === groupId).members;
        const started = await startRounds(send, new Map([[groupId, members]]), roundStateRef.current, new Map([[groupId, plan[0]]]));
        recordStarts(series, started);
        saveSeries();
        setMessage(`${lost}, so their round has restarted with ${nameOf(plan[0].guideToken)} guiding.${removed ? '' : ` ${nameOf(dropped)} will guide later.`}`);
      } catch (err) {
        setMessage(`${lost}, and their round couldn't restart: ${err.message ?? err}`);
      } finally {
        restartingRef.current.delete(groupId);
      }
    };
    // The badges on the name tags: where each series player is in their
    // team's latest round. Runners show their score once finished; the
    // guide shows theirs (the runners' average) once the round is over.
    const showStatuses = (out) => {
      const series = seriesRef.current;
      const map = new Map();
      for (const { groupId, round } of series && !victoryShownRef.current ? latestRounds(series) : []) {
        const team = series.teams.find((t) => t.groupId === groupId);
        const complete = roundComplete(round, out);
        for (const tok of team.members) {
          if (tok === round.guideToken) {
            const runs = round.roster.filter((r) => r in round.results).map((r) => totalScore(round.results[r]));
            const score = runs.length ? roundToNearestHalf(runs.reduce((a, b) => a + b, 0) / runs.length) : null;
            map.set(tok, { tone: 'guide', text: !complete ? 'Guiding' : score === null ? 'Guided' : `Guided \u2713 ${score}` });
          } else if (round.roster.includes(tok)) {
            if (tok in round.results) map.set(tok, { tone: 'done', text: `\u2713 ${totalScore(round.results[tok])}` });
            else if (out.has(tok) || round.closed) map.set(tok, { tone: 'dropped', text: round.closed && !out.has(tok) ? 'Ended early' : 'Dropped' });
            else map.set(tok, { tone: 'running', text: 'Running' });
          } else if (!complete) {
            map.set(tok, { tone: 'waiting', text: 'Next round' });
          }
        }
      }
      boardRef.current?.setStatuses(map);
    };
    const checkProgress = () => {
      const series = seriesRef.current;
      if (!series || victoryShownRef.current) return boardRef.current?.setStatuses(null);
      const away = awaySet();
      const out = outSet(away);
      showStatuses(out);
      for (const { groupId, round } of latestRounds(series)) {
        if (restartingRef.current.has(groupId)) continue;
        if (!roundComplete(round, out) && out.has(round.guideToken)) restartTeam(groupId, round);
      }
      if (restartingRef.current.size) return; // rounds are in flux until the restart is sent
      // Each team's phones learn when their round is over, including when it
      // ended because a runner dropped out (they'd otherwise wait for them).
      for (const { round } of latestRounds(series)) {
        if (roundComplete(round, out) && !roundOverSentRef.current.has(round.roundId)) {
          roundOverSentRef.current.add(round.roundId);
          sessionRef.current?.send('round-over', { roundId: round.roundId });
        }
      }
      const gone = settleAbsent(series, away, out);
      if (gone.length) {
        saveSeries();
        lockSeries();
      }
      if (seriesDone(series, out)) {
        if (!victoryTeams(series, peopleRef.current, DEFAULT_PLAYER_COLOUR).length) {
          // Ended before anyone played a round: nothing to show.
          resetSeries();
          setMessage('The series ended before anyone finished a round, so there are no results to show. Press Start to begin a new one.');
          return;
        }
        victoryShownRef.current = true;
        boardRef.current?.setStatuses(null);
        // Phones say "look at the big screen" (useLobby.js); the projector
        // plays the victory scene with these teams (Projector.jsx).
        sessionRef.current?.send('series-ended', { teams: victoryTeams(series, peopleRef.current, DEFAULT_PLAYER_COLOUR) });
        setMessage(null);
        showVictory();
        return;
      }
      const n = roundNumber(series);
      if (gone.length) setMessage(`${gone.map(nameOf).join(', ')} left and didn't come back before their turn as guide, so the scores now leave them out.`);
      else if (n && !roundInProgress(series, out) && announcedRef.current !== n) {
        announcedRef.current = n;
        setMessage(`Round ${n} finished. Press Start for the next round.`);
      }
    };

    function connect(code) {
      sessionRef.current?.close();
      codeRef.current = code;
      roundStateRef.current = createRoundState();
      seriesRef.current = readJson(seriesKey(code));
      awaySinceRef.current = new Map(); // a fresh grace period for everyone after a reload
      outSinceRef.current = new Map();
      roundOverSentRef.current = new Set();
      removedRef.current = new Set(readJson(removedKey(code)) ?? []);
      victoryShownRef.current = false;
      // A round still going when the page reloaded hasn't been announced yet.
      announcedRef.current = seriesRef.current ? roundNumber(seriesRef.current) - (roundInProgress(seriesRef.current, new Set()) ? 1 : 0) : 0;
      peopleRef.current = new Map(Object.entries(readJson(peopleKey(code)) ?? {}));
      const board = boardRef.current;
      board.setGame(code, joinUrl(code));
      board.importState(readJson(stateKey(code)));
      lockSeries();
      sessionRef.current = openTeacherSession(code, {
        onPlayers(all) {
          // A removed player who comes back is kept off the board and told.
          const back = all.filter((p) => removedRef.current.has(p.token)).map((p) => p.token);
          if (back.length) sessionRef.current?.send('removed', { tokens: back });
          const players = all.filter((p) => !removedRef.current.has(p.token));
          presentRef.current = new Set(players.map((p) => p.token));
          roundOfRef.current = new Map(players.map((p) => [p.token, p.roundId ?? null]));
          const turnedAway = board.syncPlayers(players);
          if (turnedAway.length) sessionRef.current?.send('lobby-full', { tokens: turnedAway });
          for (const p of players) {
            peopleRef.current.set(p.token, { displayName: p.displayName, characterKey: p.characterKey, colorHex: p.colorHex });
          }
          localStorage.setItem(peopleKey(code), JSON.stringify(Object.fromEntries(peopleRef.current)));
          checkProgress();
        },
        onRoundEnded({ token, roundId, result }) {
          const series = seriesRef.current;
          if (!series || !recordResult(series, token, roundId, result)) return;
          saveSeries();
          checkProgress();
        },
        rounds: readJson(roundsKey(code)) ?? {},
        onRoundsChanged: (rounds) => localStorage.setItem(roundsKey(code), JSON.stringify(rounds)),
        roundIsOver: (roundId) => roundOverSentRef.current.has(roundId),
        seriesIsOver: () => victoryShownRef.current,
        victory: () => (victoryShownRef.current && seriesRef.current ? victoryTeams(seriesRef.current, peopleRef.current, DEFAULT_PLAYER_COLOUR) : null),
      });
    }

    const hooks = {
      onCreate() {
        if (codeRef.current && !window.confirm('Start a new game? Everyone will need to join again with the new code.')) return;
        stopBots();
        if (codeRef.current) {
          boardRef.current.setLocked(null);
          localStorage.removeItem(stateKey(codeRef.current));
          localStorage.removeItem(seriesKey(codeRef.current));
          localStorage.removeItem(peopleKey(codeRef.current));
          localStorage.removeItem(removedKey(codeRef.current));
          localStorage.removeItem(roundsKey(codeRef.current));
        }
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
      onLocked(what) {
        setMessage(
          what === 'dial'
            ? 'The settings are locked until this series of rounds ends.'
            : 'Teams are locked until this series of rounds ends. New players can still be put in a team: they join at the next round.',
        );
      },
      onEndRound() {
        const series = seriesRef.current;
        if (!series || victoryShownRef.current) return setMessage('No round is running.');
        const out = outSet(awaySet());
        if (!roundInProgress(series, out)) return setMessage('No round is running. Press Start for the next round.');
        if (!window.confirm("End this round now? Anyone still running won't score for it.")) return;
        closeRounds(series, out);
        saveSeries();
        checkProgress();
      },
      onEndSeries() {
        const series = seriesRef.current;
        if (!series || victoryShownRef.current) return setMessage('No series of rounds is running.');
        if (!window.confirm("End this series now and show the results? Rounds not played yet won't be.")) return;
        endSeries(series, outSet(awaySet()));
        saveSeries();
        checkProgress();
      },
      onRemoving(on) {
        setMessage(on ? 'Click the name tag of the player to remove. (Press Remove again to cancel.)' : null);
      },
      onRemove(id) {
        const name = boardRef.current.getTeams().names.get(id) ?? nameOf(id);
        const series = seriesRef.current;
        const member = series && !victoryShownRef.current && seriesMembers(series).includes(id);
        if (!window.confirm(`Remove ${name} from this game?${member ? ' Their scores will be left out, as if they had never played.' : ''}${id.startsWith('dev_') ? '' : " They won't be able to rejoin from that device."}`)) return;
        if (!id.startsWith('dev_')) {
          removedRef.current.add(id);
          localStorage.setItem(removedKey(codeRef.current), JSON.stringify([...removedRef.current]));
          sessionRef.current?.send('removed', { tokens: [id] });
        }
        boardRef.current.removePlayer(id);
        setMessage(`${name} has been removed.`);
        if (!member) return;
        // Guiding a round still going: the team restarts with someone else.
        const guiding = latestRounds(series).find(({ round }) => round.guideToken === id && !roundComplete(round, outSet(awaySet())));
        removeMember(series, id);
        saveSeries();
        lockSeries();
        if (guiding) restartTeam(guiding.groupId, guiding.round, { removed: true });
        checkProgress();
      },
      onJoinWithoutGame() {
        setMessage('Press Create first, to make a game for players to join.');
      },
      async onStart() {
        const code = codeRef.current;
        if (!code) return setMessage('Press Create first, to make a game for players to join.');
        const send = (event, payload) => sessionRef.current?.send(event, payload);
        let series = seriesRef.current;

        // A new series: check the board, then fix the teams for its length.
        if (!series) {
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
          series = seriesRef.current = createSeries(t.teams.map((members, i) => ({ groupId: i + 1, members: members.filter((tok) => !tok.startsWith('dev_')) })));
          announcedRef.current = 0;
        }

        // Newcomers the teacher has put in a team join it from this round,
        // with a guide turn of their own (dev players have no device: left out).
        const placed = boardRef.current.getTeams().teams;
        const joined = [];
        placed.forEach((tokens, i) => {
          for (const tok of addMembers(series, i + 1, tokens.filter((tok) => !tok.startsWith('dev_')))) joined.push(`${nameOf(tok)} joined ${teamName(i + 1)}`);
        });
        lockSeries();
        saveSeries();
        checkProgress();
        if (victoryShownRef.current) return;

        const present = presentRef.current;
        if (roundInProgress(series, outSet(awaySet())) && !window.confirm("Some players haven't finished this round yet. Start the next round anyway?")) return;
        const { plan, stuck } = planRound(series, present);
        if (!plan.length) {
          return setMessage(stuck.length ? `${stuck.map(teamName).join(', ')}: nobody connected to run this round.` : 'Waiting for players to come back.');
        }

        // The teams as the series has them.
        const assignments = {};
        for (const team of series.teams) for (const tok of team.members) assignments[tok] = team.groupId;
        send('groups-updated', { assignments });
        setMessage('Starting...');
        await new Promise((r) => setTimeout(r, TEAMS_THEN_START_MS));
        try {
          const members = new Map(series.teams.map((team) => [team.groupId, team.members]));
          const started = await startRounds(send, new Map(plan.map((p) => [p.groupId, members.get(p.groupId)])), roundStateRef.current, new Map(plan.map((p) => [p.groupId, p])));
          recordStarts(series, started);
          saveSeries();
          const notes = [...joined, ...stuck.map((g) => `${teamName(g)} sits out: nobody connected to run`)];
          setMessage(`Round ${roundNumber(series)} started.${notes.length ? ' ' + notes.join('. ') + '.' : ''}`);
        } catch (err) {
          setMessage(`Couldn't start: ${err.message ?? err}`);
        }
      },
      onRosterChange(state) {
        if (codeRef.current) localStorage.setItem(stateKey(codeRef.current), JSON.stringify(state));
      },
    };

    const board = createLobbyBoard(hostRef.current, undefined, hooks);
    const ticker = setInterval(checkProgress, 5000);
    boardRef.current = board;
    const saved = localStorage.getItem(GAME_KEY);
    if (saved) connect(saved);
    return () => {
      clearInterval(ticker);
      stopBots();
      sessionRef.current?.close();
      sessionRef.current = null;
      board.dispose();
    };
  }, []);

  // Back from the victory scene: the series is over; Start begins a new one.
  const closeVictory = () => {
    resetSeries();
    setMessage('Press Start to play another series of rounds.');
  };

  // DEV, temporary (Luke, 2026-10-07: "a temporary html button to add a
  // bunch of bot players, and I'll add myself, and press start"): five bots
  // that join this game and play its rounds for real (src/dev/bots.js), run
  // from this page, so a test needs only this window, the projector and a
  // phone. They stop on Create and when the page closes. Keep this window
  // visible: a minimised window's timers slow right down, and so do the bots.
  const addBots = async () => {
    const code = codeRef.current;
    if (!code) return setMessage('Press Create first, to make a game for the bots to join.');
    const n = 5;
    const { startBots } = await import('../dev/bots.js');
    const set = await startBots(code, n, { offset: botsRef.current.next });
    botsRef.current.next += n;
    botsRef.current.sets.push(set);
    setMessage(`${n} bot players joined. Put them in teams (Shuffle), join on your phone, then Start.`);
  };
  // DEV, temporary: the projector in its own window, to drag onto the TV
  // (then F there for full screen).
  const openProjector = () => {
    const code = codeRef.current;
    if (!code) return setMessage('Press Create first.');
    window.open(`${location.pathname}?projector=${code}`, `projector-${code}`, 'popup,width=1280,height=720');
  };

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
      {import.meta.env.DEV && (
        <>
          <button onClick={addBots} style={{ position: 'fixed', top: 36, right: 8, zIndex: 10 }}>
            + 5 bots (dev)
          </button>
          <button onClick={openProjector} style={{ position: 'fixed', top: 64, right: 8, zIndex: 10 }}>
            Open projector (dev)
          </button>
        </>
      )}
      {victory && <VictoryTown teams={victory} onClose={closeVictory} />}
    </>
  );
}
