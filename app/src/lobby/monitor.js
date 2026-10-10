/**
 * TEMPORARY test monitor — a flight recorder for the teacher's board and the
 * projector. Luke, 2026-10-10: "It's going to be very hard for me to describe
 * everything that is going wrong to you... Would it be possible to add a
 * monitor of some sort? Perhaps one on the core screen, and one on the
 * projector screen, so each can give you a trove of information at the end?
 * ...it runs differently when I'm in the game and it's being displayed on
 * three screens."
 *
 * Each page keeps one timeline: what it did and saw (the board's messages,
 * players, rounds; the projector's director decisions, crossfades, splits,
 * camera), a one-second health sample (frame rate, longest frame gap,
 * realtime messages in and out, memory, whether the page was hidden), and
 * every error, warning, lost WebGL context and stall.
 *
 * A frozen page can't save anything, so the log is saved every SAVE_EVERY_MS
 * while things run (the last save shows what led up to a freeze), and a
 * stall is recorded with its length once the page comes back.
 *
 * Saving: on the dev server it's written to app/recordings/monitor-*.json
 * (vite.config.js's /__save) — nothing to do but tell Claude. Anywhere else,
 * window.__monitorDownload() saves it as a file. Remove this module and its
 * calls (LobbyBoard.jsx, Projector.jsx, skyPath.js's monitorInfo) once
 * testing no longer needs it.
 */

const SAVE_EVERY_MS = 10000;
const MAX_EVENTS = 60000;
const GAP_MS = 250; // a frame gap this long is logged
const STALL_MS = 2000; // no frame for this long: a stall

let wsTapped = false;
const ws = { sent: 0, recv: 0, closes: [] };

/** Counts every realtime frame in and out of this page (every Supabase client in it, bots included). */
function tapWebSockets(log) {
  if (wsTapped) return;
  wsTapped = true;
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) {
    ws.sent++;
    return send.call(this, d);
  };
  const desc = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
  Object.defineProperty(WebSocket.prototype, 'onmessage', {
    configurable: true,
    get: desc.get,
    set(fn) {
      if (!this.__monitored) {
        this.__monitored = true;
        this.addEventListener('close', (e) => log('socket-closed', { code: e.code, reason: e.reason }));
      }
      desc.set.call(
        this,
        fn &&
          function (e) {
            ws.recv++;
            if (typeof e.data === 'string' && /tenant_events|too_many|rate.?limit/i.test(e.data)) log('realtime-limit', { data: e.data.slice(0, 300) });
            return fn.call(this, e);
          },
      );
    },
  });
}

const short = (v, n = 300) => {
  try {
    const s = typeof v === 'string' ? v : v instanceof Error ? `${v.message}\n${v.stack ?? ''}` : JSON.stringify(v);
    return s && s.length > n ? s.slice(0, n) + '…' : s;
  } catch {
    return String(v).slice(0, n);
  }
};

/**
 * Starts this page's monitor. `name` is the page ('board' or 'projector');
 * `sample()`, if given, adds page-specific fields to each one-second health
 * sample. Returns { log(kind, data), setCode(code), stop() }.
 */
export function startMonitor(name, { code = null, sample = null } = {}) {
  const started = new Date();
  const stamp = started.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const t0 = performance.now();
  const events = [];
  let dropped = 0;
  let gameCode = code;
  const log = (kind, data) => {
    if (events.length >= MAX_EVENTS) {
      events.splice(0, 1000);
      dropped += 1000;
    }
    events.push({ t: Math.round(performance.now() - t0) / 1000, kind, ...(data === undefined ? {} : { data }) });
  };
  log('start', { page: name, code, url: location.href, at: started.toISOString(), screen: [screen.width, screen.height], window: [innerWidth, innerHeight], dpr: devicePixelRatio, ua: navigator.userAgent });

  // ---- errors, warnings, lost GPU contexts
  const onError = (e) => log('error', { message: short(e.message), where: `${e.filename ?? ''}:${e.lineno ?? ''}`, stack: short(e.error?.stack, 800) });
  const onRejection = (e) => log('error', { message: 'unhandled rejection', reason: short(e.reason, 800) });
  const onContextLost = (e) => log('webgl-context-lost', { canvas: e.target?.width ? [e.target.width, e.target.height] : null });
  const onVisibility = () => log('visibility', { state: document.visibilityState });
  const onFullscreen = () => log('fullscreen', { on: !!document.fullscreenElement });
  const onResize = () => log('resize', { window: [innerWidth, innerHeight] });
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  document.addEventListener('webglcontextlost', onContextLost, true);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('fullscreenchange', onFullscreen);
  window.addEventListener('resize', onResize);
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...a) => {
    log('console-error', { message: short(a.map((x) => short(x)).join(' '), 800) });
    origError.apply(console, a);
  };
  console.warn = (...a) => {
    log('console-warn', { message: short(a.map((x) => short(x)).join(' '), 500) });
    origWarn.apply(console, a);
  };
  tapWebSockets(log);

  // ---- frames: rate, gaps, stalls
  let frames = 0;
  let lastFrame = performance.now();
  let maxGap = 0;
  let rafId = 0;
  const onFrame = (now) => {
    const gap = now - lastFrame;
    if (gap > maxGap) maxGap = gap;
    if (gap > STALL_MS) log('stall-ended', { ms: Math.round(gap), hidden: document.hidden });
    else if (gap > GAP_MS) log('frame-gap', { ms: Math.round(gap) });
    lastFrame = now;
    frames++;
    rafId = requestAnimationFrame(onFrame);
  };
  rafId = requestAnimationFrame(onFrame);

  // ---- the one-second health sample
  let lastWs = { sent: 0, recv: 0 };
  let lastSampleAt = performance.now();
  const sampler = setInterval(() => {
    const now = performance.now();
    const dt = (now - lastSampleAt) / 1000;
    lastSampleAt = now;
    const s = {
      fps: Math.round(frames / dt),
      maxGapMs: Math.round(maxGap),
      sentPerS: Math.round((ws.sent - lastWs.sent) / dt),
      recvPerS: Math.round((ws.recv - lastWs.recv) / dt),
      hidden: document.hidden,
      heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : undefined,
      sinceFrameMs: Math.round(now - lastFrame),
    };
    frames = 0;
    maxGap = 0;
    lastWs = { sent: ws.sent, recv: ws.recv };
    try {
      if (sample) Object.assign(s, sample());
    } catch (err) {
      s.sampleError = short(err);
    }
    log('sample', s);
  }, 1000);

  // ---- saving
  const fileName = () => `monitor-${name}-${(gameCode ?? 'nocode').toLowerCase()}-${stamp}`.replace(/[^a-z0-9_-]/gi, '');
  const json = () => JSON.stringify({ page: name, code: gameCode, started: started.toISOString(), savedAt: new Date().toISOString(), droppedEvents: dropped, events });
  let saving = false;
  const save = async () => {
    if (!import.meta.env.DEV || saving) return;
    saving = true;
    try {
      await fetch(`/__save?name=${fileName()}`, { method: 'POST', body: json() });
    } catch {
      /* the dev server's gone: nothing to save to */
    } finally {
      saving = false;
    }
  };
  const saver = setInterval(save, SAVE_EVERY_MS);
  const onHide = () => save();
  window.addEventListener('pagehide', onHide);
  window.__monitorDownload = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json()], { type: 'application/json' }));
    a.download = `${fileName()}.json`;
    a.click();
  };
  window.__monitorLog = log;

  return {
    log,
    setCode(c) {
      if (c === gameCode) return;
      gameCode = c;
      log('code', { code: c });
    },
    stop() {
      log('stop');
      save();
      clearInterval(sampler);
      clearInterval(saver);
      cancelAnimationFrame(rafId);
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      document.removeEventListener('webglcontextlost', onContextLost, true);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('fullscreenchange', onFullscreen);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pagehide', onHide);
      console.error = origError;
      console.warn = origWarn;
    },
  };
}
