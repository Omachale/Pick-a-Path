/**
 * The projector's director (step 5 of the plan in TODO.md): decides which
 * team and which player the big screen shows, and when to cut. Pure logic,
 * no drawing and no network: Projector.jsx feeds it what happens and asks
 * it, a few times a second, what to show.
 *
 * Luke, 2026-10-07: "I think the answer will be to have a priority list,
 * but to allow some flexibility with frequency and completion... 1, alien
 * abduction, whether successful or not... 2, a player about to fall but
 * with a jetpack. 3, a player falling. But there must also be a reasonable
 * number of players succeeding... a system for deprioritising
 * repetitiveness... fairly minor. Two alien abductions in a row should
 * generally be fine... a mild randomness involved, separating borderline
 * cases... a player walking across a bridge can probably be interrupted by
 * an abduction or jetpack firing or a fall, and perhaps a fall can be
 * truncated... as soon as the fall is clear... if something more
 * interesting occurs."
 *
 * Everything worth showing is a STORY, with a build-up and a payoff:
 *   abduction  from the aliens being sent at someone (abduct-target) to the
 *              result. Half weight while the target is still walking to
 *              the island where it happens, full from the defence on.
 *   rescue     a wrong choice while holding a jetpack (choice-outcome):
 *              the walk out, the fall, the flight back to the next island.
 *   fall       a wrong choice without one: the walk out, then the fall.
 *   temple     a right choice at the last fork: the walk into the temple.
 *   crossing   a right choice anywhere else: the walk to the next island.
 *   deciding   someone standing at a fork (the words are on screen) — the
 *              filler when nothing else is happening.
 * Wrong choices are known the moment they're made (the phone's
 * choice-outcome, skyPath.js), several seconds before the fall, so the
 * camera can be there in time.
 *
 * A story's score: base (TYPES) x build-up factor (until its payoff
 * starts) x repetition (each showing of the same type in the last
 * REPEAT_WINDOW s takes off up to REPEAT_PENALTY) x fairness (a team not
 * shown lately gains up to FAIRNESS) x its own fixed random +-JITTER.
 * Cutting: at least MIN_SHOT_S on a shot (except that a fall, rescue or
 * abduction may cut into a mere crossing or filler at once — "a player
 * walking across a bridge can probably be interrupted" — since a fall
 * gives only a few seconds' warning); a challenger must beat the shot's
 * score by HYSTERESIS (TEAM_CHANGE_HYSTERESIS when it means changing team,
 * which costs a cloud wipe; the same margin keeps the camera with its team
 * when a story ends and it's free to choose); a rescue or abduction is never cut once its
 * payoff has begun; a fall may be once it has been clear for
 * FALL_CLEAR_S. A story that has ended frees the camera at once.
 *
 * Split screen (Luke: "Split screen is good", for two big events at once):
 * while the shot is itself a fall, rescue or abduction, another of those on
 * a DIFFERENT team (each team is its own world, with one camera) gets the
 * second half of the screen, from its build-up if it's a fall or rescue
 * (they're short) or from its payoff if it's an abduction. It keeps its
 * half until its story is over; whichever half outlasts the other is then
 * the whole screen again (decide() simply picks it as the shot).
 */

const TYPES = {
  abduction: { base: 100, build: 0.5 },
  rescue: { base: 85, build: 0.95 },
  fall: { base: 70, build: 0.9 },
  temple: { base: 50, build: 0.8 },
  crossing: { base: 35, build: 1 },
  deciding: { base: 15, build: 1 },
};
const REPEAT_WINDOW = 45; // s
const REPEAT_PENALTY = 0.15;
const FAIRNESS = 0.2;
const FAIRNESS_FULL_AFTER = 40; // s since the team was last on screen
const JITTER = 0.08;
const MIN_SHOT_S = 4;
// After a cloud wipe, stay with the new team at least this long, unless a
// BIG story calls elsewhere: seen live, short crossings ending one after
// another on two teams wiped back and forth every few seconds.
const MIN_TEAM_S = 10;
const BIG = new Set(['abduction', 'rescue', 'fall']); // may cut into a SMALL shot before MIN_SHOT_S
const SMALL = new Set(['crossing', 'deciding']);
const HYSTERESIS = 1.3;
const TEAM_CHANGE_HYSTERESIS = 1.5;
const FALL_CLEAR_S = 2.5;
const AFTERMATH_S = { abduction: 3, rescue: 1.5, fall: 1, temple: 1, crossing: 0.5, deciding: 0 }; // kept on after it ends
const STALE_S = 40; // a story with no news for this long is dropped

export function createDirector({ now = () => performance.now() / 1000, rand = Math.random } = {}) {
  const players = new Map(); // token -> { groupId, phase, forkIndex, airborne, firing, abducting, defending, out }
  const stories = new Map(); // id -> story
  const history = []; // { type, groupId, at } — shots taken
  const teamShownAt = new Map(); // groupId -> time last on screen
  let shot = null; // { story, since }
  let teamSince = -Infinity; // when the shot last changed team
  let second = null; // { story } — the split screen's other half, or null
  let nextId = 1;

  const player = (token) => players.get(token);
  const jitter = () => 1 + (rand() * 2 - 1) * JITTER;

  function addStory(type, token, extra = {}) {
    const p = player(token);
    if (!p) return null;
    // One story per player at a time: a new one replaces the old (a crossing
    // becomes the next fork's choice, a fall becomes an abduction, etc.),
    // except that an abduction under way isn't replaced by anything less.
    for (const s of stories.values()) {
      if (s.token !== token || s.ended) continue;
      if (s.type === 'abduction' && type !== 'abduction') return null;
      s.ended = now();
    }
    const s = { id: nextId++, type, token, groupId: p.groupId, created: now(), touched: now(), payoffAt: null, ended: null, jitter: jitter(), ...extra };
    stories.set(s.id, s);
    return s;
  }
  const storyOf = (token, type = null) => [...stories.values()].find((s) => s.token === token && !s.ended && (!type || s.type === type));
  const endStory = (s) => s && !s.ended && (s.ended = now());
  const payoff = (s) => {
    if (s && !s.payoffAt) s.payoffAt = now();
    if (s) s.touched = now();
  };

  // ---- what happens (Projector.jsx passes these on)
  const api = {
    /** A team's round started: its players, fresh. */
    roundStarted({ groupId, roster }) {
      for (const s of stories.values()) if (s.groupId === groupId) endStory(s);
      // Only this round's runners: last round's (now perhaps the guide) go.
      for (const [tok, p] of players) if (p.groupId === groupId) players.delete(tok);
      for (const tok of roster) players.set(tok, { groupId, phase: 'resting', forkIndex: 1, airborne: false, firing: false, abducting: false, defending: false, out: false });
    },
    /** A player-state report, as phones send them. */
    playerState(token, st) {
      const p = player(token);
      if (!p) return;
      p.phase = st.phase;
      if (st.forkIndex != null) p.forkIndex = st.forkIndex;
      p.airborne = !!st.livePos?.quat;
      p.firing = !!st.firing;
      p.abducting = !!st.abducting;
      p.defending = !!st.defending;
      const s = storyOf(token);
      if (!s) return;
      s.touched = now();
      if (s.type === 'fall' || s.type === 'rescue') {
        if (p.airborne) payoff(s);
        if (st.phase === 'gone') endStory(s);
        if (s.type === 'rescue' && st.phase === 'resting' && st.forkIndex > s.fork) endStory(s);
      } else if (s.type === 'crossing' || s.type === 'temple') {
        if (st.phase === 'moving') payoff(s);
        if (st.phase === 'resting' && st.forkIndex > s.fork) endStory(s);
        if (st.phase === 'gone') endStory(s);
      } else if (s.type === 'abduction') {
        if (p.defending || p.abducting) payoff(s);
        if (st.phase === 'gone') endStory(s);
      }
    },
    /** A phone's choice-outcome: right or wrong, known before anything shows. */
    choice(token, { forkIndex, correct, powerupKind }) {
      if (!player(token)) return;
      const type = correct ? (forkIndex >= 6 ? 'temple' : 'crossing') : powerupKind === 'jetpack' ? 'rescue' : 'fall';
      addStory(type, token, { fork: forkIndex });
    },
    /** Someone sent the aliens at `targetToken`. */
    abductTarget(targetToken) {
      addStory('abduction', targetToken);
    },
    /** The defence is over: resisted or abducted. */
    defenceEnd(token, outcome) {
      const s = storyOf(token, 'abduction');
      if (!s) return;
      payoff(s);
      if (outcome === 'resisted') s.endAt = now() + 2; // the repel plays out first
    },
    /** A runner's round is over. */
    roundEnded(token) {
      const p = player(token);
      if (p) p.out = true;
      const s = storyOf(token);
      if (s && (s.type === 'temple' || s.type === 'crossing')) endStory(s);
    },

    // ---- choosing
    /**
     * What to show now: { groupId, token, story, second } or null (nothing to
     * show); `second` is the split screen's other half ({ groupId, token,
     * story }) or null.
     */
    decide() {
      const d = decidePrimary();
      if (!d) {
        second = null;
        return null;
      }
      return { ...d, second: decideSecond(d.story) };
    },
    /** For the debug readout: the candidates, best first, and the shot. */
    debug() {
      const t = now();
      return { shot: shot ? { ...shot.story, since: t - shot.since } : null, second: second ? { ...second.story } : null, candidates: candidates(t).slice(0, 8).map((c) => ({ id: c.story.id, type: c.story.type, token: c.story.token, groupId: c.story.groupId, score: Math.round(c.score), stage: c.story.payoffAt ? 'payoff' : 'build' })) };
    },
    /** A player's latest story (for the projector's captions, also when it's chosen by hand). */
    latestStory(token) {
      let latest = null;
      for (const st of stories.values()) if (st.token === token && st.type !== 'deciding' && (!latest || st.id > latest.id)) latest = st;
      return latest;
    },
  };

  function live(s, t) {
    return s && (!s.ended || t - s.ended < AFTERMATH_S[s.type]);
  }
  function decideSecond(primary) {
    const t = now();
    if (second && live(second.story, t) && second.story.groupId !== primary.groupId && second.story.id !== primary.id) return asShot(second.story);
    second = null;
    if (!BIG.has(primary.type) || !live(primary, t)) return null;
    const c = candidates(t).find((x) => BIG.has(x.story.type) && x.story.groupId !== primary.groupId && (x.story.payoffAt || x.story.type !== 'abduction'));
    if (!c) return null;
    second = { story: c.story };
    history.push({ type: c.story.type, groupId: c.story.groupId, at: t });
    teamShownAt.set(c.story.groupId, t);
    return asShot(c.story);
  }
  const asShot = (s) => ({ groupId: s.groupId, token: s.token, story: s });

  function decidePrimary() {
    {
      const t = now();
      tidy(t);
      const cands = candidates(t);
      const cur = shot && stories.get(shot.story.id);
      const curLive = cur && (!cur.ended || t - cur.ended < AFTERMATH_S[cur.type]);
      // May the camera leave this team for `c`? (See MIN_TEAM_S.)
      const mayLeave = (c) => !cur || c.story.groupId === cur.groupId || BIG.has(c.story.type) || t - teamSince >= MIN_TEAM_S;
      if (!curLive) {
        // The split's other half, still going, has the whole screen next.
        if (second && live(second.story, t)) return take({ story: second.story }, t);
        // Free to choose, but a cloud wipe isn't free: stay with this team
        // unless another has something clearly better (seen live: a wipe
        // away for a filler shot, then straight back for a fall).
        const best = cands[0];
        const same = cur && cands.find((c) => c.story.groupId === cur.groupId);
        if (best && same && best.story.groupId !== cur.groupId && (best.score < same.score * TEAM_CHANGE_HYSTERESIS || !mayLeave(best))) return take(same, t);
        if (best && !mayLeave(best)) return current(); // nothing here yet: stay on the last shot a little longer
        return take(best, t);
      }
      if (!interruptible(cur, t)) return current();
      const curScore = score(cur, t, true);
      const best = cands.find((c) => c.story.id !== cur.id && c.story.id !== second?.story.id); // (the other half is already on screen)
      if (!best) return current();
      if (t - shot.since < MIN_SHOT_S && !(BIG.has(best.story.type) && SMALL.has(cur.type))) return current();
      const margin = best.story.groupId === cur.groupId ? HYSTERESIS : TEAM_CHANGE_HYSTERESIS;
      if (best.score > curScore * margin && mayLeave(best)) return take(best, t);
      return current();
    }
  }

  function current() {
    return shot ? { groupId: shot.story.groupId, token: shot.story.token, story: shot.story } : null;
  }
  function take(c, t) {
    if (!c) {
      shot = null;
      return null;
    }
    if (!shot || shot.story.id !== c.story.id) {
      if (!shot || shot.story.groupId !== c.story.groupId) teamSince = t;
      shot = { story: c.story, since: t };
      history.push({ type: c.story.type, groupId: c.story.groupId, at: t });
    }
    teamShownAt.set(c.story.groupId, t);
    return current();
  }
  function interruptible(s, t) {
    if (s.ended) return true;
    if (!s.payoffAt) return true;
    if (s.type === 'rescue' || s.type === 'abduction') return false;
    if (s.type === 'fall') return t - s.payoffAt >= FALL_CLEAR_S;
    return true;
  }
  function score(s, t, isCurrent = false) {
    const ty = TYPES[s.type];
    let v = ty.base * (s.payoffAt ? 1 : ty.build) * s.jitter;
    if (!isCurrent) {
      for (const h of history) {
        const age = t - h.at;
        if (h.type === s.type && age < REPEAT_WINDOW) v *= 1 - REPEAT_PENALTY * (1 - age / REPEAT_WINDOW);
      }
      const since = teamShownAt.has(s.groupId) ? t - teamShownAt.get(s.groupId) : FAIRNESS_FULL_AFTER;
      if (!shot || s.groupId !== shot.story.groupId) v *= 1 + FAIRNESS * Math.min(1, since / FAIRNESS_FULL_AFTER);
    }
    return v;
  }
  function candidates(t) {
    const list = [];
    for (const s of stories.values()) if (!s.ended) list.push({ story: s, score: score(s, t) });
    // Filler: anyone standing at a fork with no story of their own.
    for (const [token, p] of players) {
      if (p.out || p.phase !== 'resting' || storyOf(token)) continue;
      let s = [...stories.values()].find((x) => x.type === 'deciding' && x.token === token && x.fork === p.forkIndex);
      if (!s) {
        s = { id: nextId++, type: 'deciding', token, groupId: p.groupId, created: t, touched: t, payoffAt: t, ended: null, jitter: jitter(), fork: p.forkIndex };
        stories.set(s.id, s);
      }
      if (!s.ended) list.push({ story: s, score: score(s, t) });
    }
    return list.sort((a, b) => b.score - a.score);
  }
  function tidy(t) {
    for (const s of stories.values()) {
      if (s.endAt && t >= s.endAt) endStory(s);
      if (!s.ended && t - s.touched > STALE_S) endStory(s);
      // A deciding shot is over once they've chosen (they have a story then) or left.
      if (s.type === 'deciding' && !s.ended) {
        const p = player(s.token);
        if (!p || p.out || p.phase !== 'resting' || p.forkIndex !== s.fork) endStory(s);
      }
      if (s.ended && t - s.ended > 30 && (!shot || shot.story.id !== s.id) && second?.story.id !== s.id) stories.delete(s.id);
    }
    while (history.length && t - history[0].at > REPEAT_WINDOW) history.shift();
  }

  return api;
}
