/**
 * A series of rounds: the teams play round after round until everyone on
 * every team has been the guide once, then the victory scene shows on the
 * teacher's screen. Luke, 2026-10-06: "wire it into the game. Make sure it
 * only happens at the end of each round, after each player has had a chance
 * to be a guide" (i.e. at the end of the whole set of rounds).
 *
 * The rules, as agreed (TODO.md, Plan 2026-10-05):
 * - Each team plays once per member, a different guide each time, so a team
 *   of N plays N rounds. A smaller team finishes sooner and waits.
 * - A round's score for a runner is their own run; for the guide, the
 *   average of that round's runners, category by category (victoryStage.js's
 *   rule).
 * - A person's score on the podium is their average per round, category by
 *   category; the team's score is the average of its people. With everyone
 *   playing the same number of rounds, that is the per-run average across
 *   the series, guide included, so team size doesn't skew it.
 *
 * Arrivals and departures (Luke, 2026-10-06): "Once a series has started,
 * lock teams, except for a new player arriving. They can be added to a team,
 * and will start at the beginning of the next run, and will be added to the
 * roster to act as Guide. If a player leaves, move them to the last position
 * as a Guide, and if they haven't rejoined by then, remove them from the
 * team, and treat the team's score as if they were never there." So:
 * - A newcomer placed in a team joins it at the next round, as a runner,
 *   and gets a guide turn too (the team plays one more round).
 * - Each round's guide is picked from the members who are here and haven't
 *   guided; anyone away waits, so their turn falls to the end. Away members
 *   sit out rounds, and don't hold a round open.
 * - When only away members are left to guide, they're forgotten: taken out
 *   of the team and out of every past round, so the guides' averages and the
 *   team's score are worked out as if they'd never played. (Someone who has
 *   already guided and then leaves stays: their rounds so far count.)
 *
 * Dropping out of a round (Luke, 2026-10-06: "keep the game flowing for
 * others relatively smoothly, and let players reconnect later within a
 * reasonable timeframe, restarting their round as guide later in the queue
 * and/or averaging their score over fewer rounds"). LobbyBoard.jsx decides
 * who is `out` of a round: gone, or back but no longer in it (a reloaded
 * phone), for longer than a short grace. Then:
 * - A runner out of a round doesn't hold it open. With no result, that
 *   round is left out of their average (seriesBreakdowns), so they're
 *   averaged over fewer rounds; they run again from the next round.
 * - A guide out of a round, while runners are still going, has that round
 *   thrown away (`discardRound`): their runners can't play on without them.
 *   The team restarts at once with another guide, and the dropped guide
 *   keeps their turn for later (and runs meanwhile if they're back).
 *
 * The teacher's controls (Luke, 2026-10-06, agreed):
 * - End round (`closeRounds`): every unfinished round is over now; anyone
 *   still running is treated as dropped out of it (no score for it).
 * - End series (`endSeries`): that, and the series is done, so the victory
 *   scene shows what has been played. Anyone who hasn't played a round
 *   (a newcomer, say) isn't on the podium.
 * - Remove (`removeMember`): the player is taken out as if never there, as
 *   for someone who leaves and doesn't come back.
 *
 * Pure data, no network: LobbyBoard.jsx feeds it round starts, results and
 * who's connected, and persists it (plain JSON) so a teacher reload doesn't
 * lose the series.
 */
import { scoreBreakdown } from './scoring.js';

const KEYS = ['islands', 'items', 'jetpackBonus', 'resists'];

/** teams: [{ groupId, members: [token] }], members in board order. */
export function createSeries(teams) {
  return { teams: teams.filter((t) => t.members.length).map((t) => ({ groupId: t.groupId, members: [...t.members], rounds: [] })) };
}

// A round is over when every runner has finished or is out of it (`out`: a
// Set of tokens, see the header and LobbyBoard.jsx; a phone that briefly
// sleeps isn't out). One who is out doesn't hold it open.
const roundComplete = (r, out) => !!r.closed || r.roster.every((tok) => tok in r.results || out.has(tok));
const lastRound = (team) => team.rounds[team.rounds.length - 1];
const guided = (team) => new Set(team.rounds.map((r) => r.guideToken));
const unguided = (team) => {
  const g = guided(team);
  return team.members.filter((tok) => !g.has(tok));
};

/** Each team's latest round: [{ groupId, round }], for watching who's in it. */
export function latestRounds(series) {
  return series.teams.filter((t) => t.rounds.length).map((t) => ({ groupId: t.groupId, round: lastRound(t) }));
}

export { roundComplete };

/** Throws away a team's latest round (its guide dropped out); returns it. */
export function discardRound(series, groupId) {
  return series.teams.find((t) => t.groupId === groupId)?.rounds.pop() ?? null;
}

/** The teacher's End round: every unfinished round ends now. Returns how many did. */
export function closeRounds(series, out) {
  let n = 0;
  for (const team of series.teams) {
    const r = lastRound(team);
    if (r && !roundComplete(r, out)) {
      r.closed = true;
      n++;
    }
  }
  return n;
}

/** The teacher's End series: unfinished rounds end, and the series is done. */
export function endSeries(series, out) {
  closeRounds(series, out);
  series.ended = true;
}

/** The teacher's Remove: out of their team and every round, as if never there. */
export function removeMember(series, tok) {
  for (const team of series.teams) if (team.members.includes(tok)) forget(team, tok);
}

/** Every token in the series, for locking them on the board. */
export function seriesMembers(series) {
  return series.teams.flatMap((t) => t.members);
}

/** Adds newcomers to a team (from the board), to play from the next round. */
export function addMembers(series, groupId, tokens) {
  const team = series.teams.find((t) => t.groupId === groupId);
  if (!team) return [];
  const all = new Set(seriesMembers(series));
  const added = tokens.filter((tok) => !all.has(tok));
  team.members.push(...added);
  return added;
}

/** Takes a player out of a team and every round it played, as if never there. */
function forget(team, tok) {
  team.members = team.members.filter((t) => t !== tok);
  for (const r of team.rounds) {
    r.roster = r.roster.filter((t) => t !== tok);
    delete r.results[tok];
  }
}

/**
 * Forgets members whose guide turn has come round while they're away: in a
 * team where everyone left to guide has left (`away`), and its last round
 * is done (`out`, see roundComplete). Returns the tokens forgotten.
 */
export function settleAbsent(series, away, out = away) {
  const gone = [];
  for (const team of series.teams) {
    if (team.rounds.length && !roundComplete(lastRound(team), out)) continue;
    const waiting = unguided(team);
    if (waiting.length && waiting.every((tok) => away.has(tok))) {
      for (const tok of waiting) forget(team, tok);
      gone.push(...waiting);
    }
  }
  return gone;
}

/**
 * The next round for each team that still has a connected member to guide:
 * [{ groupId, guideToken, roster }], the guide picked at random from those,
 * the runners every other connected member. A team with nobody connected
 * to run is left out (and listed in `stuck`). Options: `groupIds`, only
 * those teams; `notGuide`, tokens who may run but not guide this time.
 */
export function planRound(series, present, { groupIds = null, notGuide = new Set() } = {}) {
  const plan = [];
  const stuck = [];
  for (const team of series.teams) {
    if (groupIds && !groupIds.includes(team.groupId)) continue;
    const candidates = unguided(team).filter((tok) => present.has(tok) && !notGuide.has(tok));
    if (!candidates.length) continue;
    const guideToken = candidates[Math.floor(Math.random() * candidates.length)];
    const roster = team.members.filter((tok) => tok !== guideToken && present.has(tok));
    if (!roster.length) stuck.push(team.groupId);
    else plan.push({ groupId: team.groupId, guideToken, roster });
  }
  return { plan, stuck };
}

/** True while any team's latest round still has runners going. */
export function roundInProgress(series, out) {
  return series.teams.some((t) => t.rounds.length && !roundComplete(lastRound(t), out));
}

/** The highest round number any team has reached. */
export function roundNumber(series) {
  return Math.max(0, ...series.teams.map((t) => t.rounds.length));
}

/** Records the rounds just started: [{ groupId, roundId, guideToken, roster }]. */
export function recordStarts(series, started) {
  for (const s of started) {
    const team = series.teams.find((t) => t.groupId === s.groupId);
    if (team) team.rounds.push({ roundId: s.roundId, guideToken: s.guideToken, roster: [...s.roster], results: {} });
  }
}

/** Records one runner's result; returns true if it belonged to the series. */
export function recordResult(series, token, roundId, result) {
  for (const team of series.teams) {
    const round = team.rounds.find((r) => r.roundId === roundId);
    // (A round the teacher ended takes no more results: a straggler's
    // phone may still report.)
    if (round && !round.closed && round.roster.includes(token)) {
      round.results[token] = result;
      return true;
    }
  }
  return false;
}

/** True once every member of every team has guided and the last rounds are done. */
export function seriesDone(series, out) {
  if (series.ended) return true;
  return series.teams.length > 0 && series.teams.every((t) => !unguided(t).length && (!t.rounds.length || roundComplete(lastRound(t), out)));
}

/**
 * Each person's average per round, category by category. A runner with no
 * result for a round (dropped out) has that round left out of their own
 * average; a guide whose runners all dropped out likewise. Someone with no
 * rounds at all (the series ended before they played) gets null.
 */
export function seriesBreakdowns(team) {
  const sums = new Map(team.members.map((tok) => [tok, { n: 0, b: Object.fromEntries(KEYS.map((k) => [k, 0])) }]));
  const add = (tok, b) => {
    const s = sums.get(tok);
    if (!s) return;
    s.n++;
    for (const k of KEYS) s.b[k] += b[k] ?? 0;
  };
  for (const round of team.rounds) {
    const runs = round.roster.filter((tok) => tok in round.results).map((tok) => [tok, scoreBreakdown(round.results[tok])]);
    for (const [tok, b] of runs) add(tok, b);
    if (runs.length) {
      const guide = {};
      for (const k of KEYS) guide[k] = runs.reduce((a, [, b]) => a + (b[k] ?? 0), 0) / runs.length;
      add(round.guideToken, guide);
    }
  }
  return new Map([...sums].map(([tok, s]) => [tok, s.n ? Object.fromEntries(KEYS.map((k) => [k, s.b[k] / s.n])) : null]));
}

/**
 * The victory scene's teams (victoryTown.js): every member who played as a
 * seat, with name and look from `people` (token -> { displayName,
 * characterKey, colorHex }, the last seen presence of each). A team with
 * nobody who played is left out.
 */
export function victoryTeams(series, people, defaultColour) {
  return series.teams.map((team) => {
    const b = seriesBreakdowns(team);
    return {
      seats: team.members.filter((tok) => b.get(tok)).map((tok) => {
        const p = people.get(tok) ?? {};
        return { name: p.displayName ?? 'Player', characterKey: p.characterKey ?? null, colorHex: p.colorHex ?? defaultColour, breakdown: b.get(tok) };
      }),
    };
  }).filter((t) => t.seats.length);
}
