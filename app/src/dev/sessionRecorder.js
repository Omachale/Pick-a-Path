/**
 * DEV ONLY: records everything sent in a game (every broadcast on the main
 * channel and the team channels, and who is connected), and plays a
 * recording back into another game code. For building and tuning the
 * projector (Luke, 2026-10-07): a real session, even a small phone test,
 * can be watched again and again, faster or slower, while the projector's
 * director is changed. Not imported by the app.
 *
 *   const { recordSession, replaySession } = await import('/src/dev/sessionRecorder.js');
 *   const rec = await recordSession('ABCDE');   // listens from now on
 *   ...play...
 *   await rec.stop('lesson-1');                 // -> recordings/lesson-1.json
 *
 *   const data = await (await fetch('/recordings/lesson-1.json')).json();
 *   const replay = await replaySession(data, { code: 'ZZZZZ', speed: 2 });
 *   replay.stop();
 *
 * The recorder only listens: it never appears in presence (as the
 * teacher's board doesn't). A replay recreates each recorded player's
 * presence with a client of its own (one connection can hold only one
 * presence per channel) and re-sends every broadcast at its recorded time.
 * Replay into a code nobody is playing in: phones in that game would act on
 * the replayed round starts.
 */
import { createClient } from '@supabase/supabase-js';

const env = () => [import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY];
const MAX_TEAMS = 4;

export async function recordSession(code) {
  const CODE = code.toUpperCase();
  const client = createClient(...env());
  const events = [];
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const channels = [];
  const listen = (name, label) => {
    const ch = client.channel(name);
    ch.on('broadcast', { event: '*' }, ({ event, payload }) => events.push({ t: at(), ch: label, event, payload }));
    channels.push(ch);
    return ch;
  };
  const main = listen(`lobby-${CODE}`, 'main');
  main.on('presence', { event: 'sync' }, () => {
    // Without Supabase's own bookkeeping (presence_ref), which a replay
    // mustn't send back as part of a player's own presence.
    const metas = Object.values(main.presenceState()).map((m) => {
      const { presence_ref, ...meta } = m[m.length - 1];
      return meta;
    });
    events.push({ t: at(), ch: 'main', presence: metas });
  });
  for (let g = 1; g <= MAX_TEAMS; g++) listen(`lobby-${CODE}-team-${g}`, `team-${g}`);
  await Promise.all(channels.map((ch) => new Promise((r) => ch.subscribe((st) => st === 'SUBSCRIBED' && r()))));
  return {
    events,
    async stop(name) {
      for (const ch of channels) client.removeChannel(ch);
      const body = JSON.stringify({ code: CODE, recordedAt: new Date().toISOString(), events });
      return (await fetch(`/__save?name=${encodeURIComponent(name)}`, { method: 'POST', body })).text();
    },
  };
}

export async function replaySession(recording, { code, speed = 1 }) {
  const CODE = code.toUpperCase();
  const timers = [];
  const clients = [];
  let stopped = false;
  // One sender for broadcasts, on the main and team channels.
  const sender = createClient(...env());
  clients.push(sender);
  const out = new Map();
  const channelFor = (label) => {
    if (!out.has(label)) {
      const name = label === 'main' ? `lobby-${CODE}` : `lobby-${CODE}-${label}`;
      const ch = sender.channel(name);
      out.set(label, { ch, ready: new Promise((r) => ch.subscribe((st) => st === 'SUBSCRIBED' && r())) });
    }
    return out.get(label);
  };
  // A presence per player, joined when they first appear and dropped when
  // they leave a later snapshot. Snapshots are applied strictly in turn:
  // joining a new player waits for its connection, and an earlier snapshot
  // finishing late was untracking players a later one had just added.
  const players = new Map(); // token -> { client, ch }
  let presenceChain = Promise.resolve();
  const setPresence = (metas) => (presenceChain = presenceChain.then(() => applyPresence(metas)));
  const applyPresence = async (metas) => {
    const now = new Set(metas.map((m) => m.token));
    for (const meta of metas) {
      let p = players.get(meta.token);
      if (!p) {
        const client = createClient(...env());
        clients.push(client);
        const ch = client.channel(`lobby-${CODE}`, { config: { presence: { key: meta.token } } });
        p = { client, ch, ready: new Promise((r) => ch.subscribe((st) => st === 'SUBSCRIBED' && r())) };
        players.set(meta.token, p);
      }
      await p.ready;
      const { presence_ref, ...clean } = meta; // (recordings made before the recorder dropped it)
      if (!stopped && JSON.stringify(clean) !== p.last) {
        p.last = JSON.stringify(clean);
        p.ch.track(clean);
      }
    }
    for (const [tok, p] of players) if (!now.has(tok)) p.ch.untrack();
  };
  for (const e of recording.events) {
    timers.push(
      setTimeout(async () => {
        if (stopped) return;
        if (e.presence) return setPresence(e.presence);
        const c = channelFor(e.ch);
        await c.ready;
        c.ch.send({ type: 'broadcast', event: e.event, payload: e.payload });
      }, e.t / speed),
    );
  }
  const length = recording.events.at(-1)?.t ?? 0;
  return {
    seconds: length / speed / 1000,
    stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      for (const c of clients) c.removeAllChannels();
    },
  };
}
