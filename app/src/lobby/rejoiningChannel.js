/**
 * A realtime channel that rejoins itself.
 *
 * Seen in a bot trial, 2026-10-10 22:24:01 UTC: every channel of the game —
 * the projector's, the teacher's board's, all fifteen bots' — was closed at
 * the same instant from the Supabase side, and nothing ever joined again.
 * Sends fell back to REST and reached nobody; players froze mid-bridge and
 * the round never ended (PROJECTOR_FIXES.md item 0). supabase-js retries a
 * dropped socket on its own, but a channel the server has closed stays
 * closed.
 *
 * This stands in for a RealtimeChannel with the same calls — `.on()` then
 * `.subscribe(cb)`, `.send`, `.track`, `.untrack`, `.presenceState` — plus
 * `.close()` in place of `client.removeChannel(ch)`. Whenever the channel
 * closes, errors or times out, it waits (1 s, doubling to 10 s), removes it,
 * and builds a fresh one with the same handlers. After a rejoin it tracks
 * the last presence payload again, and calls `cb('SUBSCRIBED', null,
 * { rejoined: true })`, so a caller can catch up on anything it missed.
 */
const REJOIN_ON = new Set(['CLOSED', 'CHANNEL_ERROR', 'TIMED_OUT']);
const MAX_DELAY_MS = 10000;

export function rejoiningChannel(client, name, opts) {
  const handlers = [];
  let ch = null;
  let last = null; // the channel being replaced: sends in the gap go by it (see send)
  let cb = null;
  let stopped = false;
  let timer = null;
  let attempt = 0;
  let joinedOnce = false;
  let lastTrack = null;
  // The test monitor (monitor.js), when the page has one.
  const log = (kind, data) => globalThis.__monitorLog?.(kind, data);

  const connect = () => {
    const mine = client.channel(name, opts);
    ch = mine;
    last = null;
    for (const [type, filter, fn] of handlers) mine.on(type, filter, fn);
    mine.subscribe((status, err) => {
      if (mine !== ch || stopped) return; // an old channel being removed
      if (status === 'SUBSCRIBED') {
        const rejoined = joinedOnce;
        joinedOnce = true;
        attempt = 0;
        if (rejoined) {
          log('realtime-rejoined', { name });
          if (lastTrack) mine.track(lastTrack);
        }
        cb?.(status, err, { rejoined });
        return;
      }
      cb?.(status, err, {});
      if (!REJOIN_ON.has(status) || timer) return;
      const delay = Math.min(MAX_DELAY_MS, 1000 * 2 ** attempt++);
      log('realtime-lost', { name, status, rejoinInMs: delay });
      timer = setTimeout(async () => {
        timer = null;
        if (stopped || mine !== ch) return;
        last = mine;
        ch = null;
        try {
          await client.removeChannel(mine);
        } catch {
          /* already gone */
        }
        if (!stopped) connect();
      }, delay);
    });
  };

  const self = {
    on(type, filter, fn) {
      handlers.push([type, filter, fn]);
      ch?.on(type, filter, fn);
      return self;
    },
    subscribe(fn) {
      cb = fn ?? null;
      if (!ch && !stopped) connect();
      return self;
    },
    // Between dropping and rejoining, by the old channel: a channel that
    // isn't joined sends by REST instead, which still reaches everyone who
    // is connected (only when every client was down, as on 2026-10-10, did
    // that reach nobody).
    send(msg) {
      const c = ch ?? last;
      return c ? c.send(msg) : Promise.resolve('error');
    },
    track(payload) {
      lastTrack = payload;
      return ch ? ch.track(payload) : Promise.resolve('error');
    },
    untrack() {
      lastTrack = null;
      return ch ? ch.untrack() : Promise.resolve('ok');
    },
    presenceState() {
      return ch ? ch.presenceState() : {};
    },
    async close() {
      stopped = true;
      clearTimeout(timer);
      const c = ch;
      ch = null;
      if (c) await client.removeChannel(c);
    },
  };
  return self;
}
