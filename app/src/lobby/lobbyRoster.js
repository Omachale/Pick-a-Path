/**
 * Who's in which team, on the teacher's screen, before teams are committed.
 * Pure data and rules, no drawing (lobbyBoard.js draws it). Luke,
 * 2026-10-05: while arranging, "the names are nothing more than tokens
 * representing players on the teacher's computer; nothing will be
 * communicated to the players' phones or to the rest of the game until the
 * teams are committed." So all of this is local, synchronous and instant.
 *
 * A roster is { names: Map(id -> name), teams: [[id...]...], unassigned: [id...] }.
 * Settings are the two dials: { teams, players } (players = per team).
 *
 * THE RULES (agreed with Luke):
 * - A box holds up to `players + 2` names, so the teacher can still drag
 *   names around when every team is full. A team above `players` is
 *   OVERFULL (drawn red) and must be fixed before starting. Unassigned holds
 *   up to UNASSIGNED_CAP.
 * - Arrivals join the team with the fewest players, lowest number first,
 *   among teams below `players`. That's "one to each team in turn" while
 *   nobody's been moved, and keeps teams balanced after the teacher drags
 *   names about. If every team is full, Unassigned.
 * - Changing the dials keeps placements wherever possible (Luke agreed to
 *   "keep and top up" over reshuffling). Players in removed teams, and the
 *   newest extras in teams now over size, move to the smallest teams with
 *   room, and Unassigned players are topped in after them. An extra with
 *   nowhere to go stays in its team, which goes red. A displaced player
 *   with nowhere to go goes to Unassigned.
 * - Randomise deals everyone, Unassigned included, round the teams up to
 *   `players` each. Any left over go to Unassigned.
 * - A drag into a box already holding its maximum is refused.
 */

export const UNASSIGNED_CAP = 8; // Luke: "the same size as a max team with overflow: up to 8"

export function createRoster(settings) {
  return { names: new Map(), teams: Array.from({ length: settings.teams }, () => []), unassigned: [] };
}

export const boxCap = (settings) => settings.players + 2;
export const isOverfull = (team, settings) => team.length > settings.players;

// Index of the smallest team below `limit`, lowest index on a tie, or -1.
function smallestWithRoom(r, limit) {
  let best = -1;
  r.teams.forEach((t, i) => {
    if (t.length < limit && (best < 0 || t.length < r.teams[best].length)) best = i;
  });
  return best;
}

export function addPlayer(r, settings, id, name) {
  r.names.set(id, name);
  const i = smallestWithRoom(r, settings.players);
  if (i < 0) r.unassigned.push(id);
  else r.teams[i].push(id);
}

export function applySettings(r, settings) {
  const displaced = [];
  while (r.teams.length > settings.teams) displaced.unshift(...r.teams.pop());
  while (r.teams.length < settings.teams) r.teams.push([]);
  // Each over-size team gives up its newest arrivals first.
  const extras = [];
  r.teams.forEach((t, home) => {
    while (t.length > settings.players) extras.unshift({ id: t.pop(), home });
  });
  for (const id of displaced) {
    const i = smallestWithRoom(r, settings.players);
    if (i < 0) r.unassigned.push(id);
    else r.teams[i].push(id);
  }
  for (const { id, home } of extras) {
    const i = smallestWithRoom(r, settings.players);
    r.teams[i < 0 ? home : i].push(id);
  }
  const waiting = r.unassigned.splice(0);
  for (const id of waiting) {
    const i = smallestWithRoom(r, settings.players);
    if (i < 0) r.unassigned.push(id);
    else r.teams[i].push(id);
  }
}

export function randomise(r, settings) {
  const all = [...r.teams.flat(), ...r.unassigned];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  r.teams = Array.from({ length: settings.teams }, () => []);
  r.unassigned = [];
  all.forEach((id, k) => {
    const i = k % settings.teams;
    if (r.teams[i].length < settings.players && k < settings.teams * settings.players) r.teams[i].push(id);
    else r.unassigned.push(id);
  });
}

/** `to` is a team index, or 'unassigned'. Returns false if the move was refused. */
export function movePlayer(r, settings, id, to) {
  const target = to === 'unassigned' ? r.unassigned : r.teams[to];
  if (!target) return false;
  if (target.includes(id)) return true;
  const cap = to === 'unassigned' ? UNASSIGNED_CAP : boxCap(settings);
  if (target.length >= cap) return false;
  for (const box of [...r.teams, r.unassigned]) {
    const k = box.indexOf(id);
    if (k >= 0) box.splice(k, 1);
  }
  target.push(id);
  return true;
}

/** Takes a player out of the lobby entirely (gone for good: see the board's grace period). */
export function removePlayer(r, id) {
  for (const box of [...r.teams, r.unassigned]) {
    const k = box.indexOf(id);
    if (k >= 0) box.splice(k, 1);
  }
  r.names.delete(id);
}
