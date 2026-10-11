/**
 * Sky Path sound effects, made entirely in code (Web Audio): no audio files,
 * so they add nothing to the download (Luke, 2026-10-11: "I don't want this
 * to bloat the size"). A recorded sound effect is typically 20–200 KB each;
 * this whole file is a few KB.
 *
 * NOT wired into the game yet: sound-preview.html plays each one for Luke to
 * judge first.
 *
 * Every sound is `name(ctx, out, opts)`: it plays into the AudioNode `out` on
 * the AudioContext `ctx`. One-shots start at `opts.when` (default now).
 * Continuous sounds (wind, bridge creaking) return `{ stop() }`; given
 * `opts.duration` they schedule exactly that long instead, which is how the
 * preview page renders them to WAV in an OfflineAudioContext.
 *
 * Two ways of building a sound are used:
 *  - Live node graphs (oscillators, filters, slow LFOs) for long, smoothly
 *    changing sounds: wind, the ship, the beam.
 *  - Short buffers computed sample by sample in JS (`renderBuffer`) for
 *    clicks, cracks and creaks, where exact control of every impulse matters
 *    and the result can be normalised to a known loudness.
 */

// ------------------------------------------------------------------ helpers

const noiseCache = new WeakMap();
/** Two seconds of white noise per context, shared by every noise source. */
function noiseBuffer(ctx) {
  let b = noiseCache.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, b);
  }
  return b;
}
function noise(ctx) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(ctx);
  s.loop = true;
  return s;
}
function filter(ctx, type, frequency, Q = 1) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = Q;
  return f;
}
function gain(ctx, value = 1) {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}
function osc(ctx, type, frequency) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = frequency;
  return o;
}
/** A slow sine LFO driving `param` by ±depth around its current value. */
function lfo(ctx, rate, depth, param, phaseDelay = 0) {
  const o = osc(ctx, 'sine', rate);
  const g = gain(ctx, depth);
  o.connect(g).connect(param);
  o.start(ctx.currentTime + phaseDelay);
  return o;
}

/**
 * Builds a mono buffer sample by sample (`fill(data, sampleRate)`),
 * normalises its peak to 1, and plays it at `level`.
 */
function renderBuffer(ctx, out, seconds, fill, { when = ctx.currentTime, level = 0.6 } = {}) {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.max(1, Math.floor(seconds * sr)), sr);
  const d = buf.getChannelData(0);
  fill(d, sr);
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak > 0) for (let i = 0; i < d.length; i++) d[i] /= peak;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = gain(ctx, level);
  src.connect(g).connect(out);
  src.start(when);
  return src;
}

/** A two-pole resonator (a ringing filter) run over `input` in place of a
 * BiquadFilter, so it can be used inside renderBuffer. Returns a new array. */
function resonate(input, sr, freq, bandwidth) {
  const r = Math.exp((-Math.PI * bandwidth) / sr);
  const a1 = -2 * r * Math.cos((2 * Math.PI * freq) / sr);
  const a2 = r * r;
  const out = new Float32Array(input.length);
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const y = (1 - r) * input[i] - a1 * y1 - a2 * y2;
    out[i] = y;
    y2 = y1;
    y1 = y;
  }
  return out;
}
const rand = (a, b) => a + Math.random() * (b - a);

// ------------------------------------------------------------------ wind

/**
 * Continuous cold wind. Three layers: a broad airy hiss, a thin high whistle
 * drifting in pitch (the "cold" part: high, narrow, lonely), and nothing low
 * at all (a low rumble reads as warm/stormy). Gusts come from slow LFOs at
 * unrelated rates, so the pattern never audibly repeats.
 */
export function wind(ctx, out, { level = 0.3, duration } = {}) {
  const t = ctx.currentTime;
  const master = gain(ctx, 0);
  master.gain.setValueAtTime(0, t);
  master.gain.linearRampToValueAtTime(level, t + 2.5);
  const hp = filter(ctx, 'highpass', 280, 0.7);
  hp.connect(master).connect(out);

  const air = noise(ctx);
  const airBand = filter(ctx, 'bandpass', 900, 0.5);
  const airGain = gain(ctx, 0.45);
  air.connect(airBand).connect(airGain).connect(hp);

  const whistle = noise(ctx);
  const whistleBand = filter(ctx, 'bandpass', 2100, 22);
  const whistleGain = gain(ctx, 0.5);
  whistle.connect(whistleBand).connect(whistleGain).connect(hp);

  const lfos = [
    lfo(ctx, 0.071, 0.22, airGain.gain), // gusts
    lfo(ctx, 0.029, 0.14, airGain.gain, 3),
    lfo(ctx, 0.05, 350, airBand.frequency),
    lfo(ctx, 0.043, 520, whistleBand.frequency, 1.7), // the whistle wanders in pitch
    lfo(ctx, 0.11, 0.35, whistleGain.gain), // and comes and goes
  ];
  air.start(t, rand(0, 1.9));
  whistle.start(t, rand(0, 1.9));
  const sources = [air, whistle, ...lfos];

  const stop = (fade = 1.5) => {
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(0, now + fade);
    sources.forEach((s) => s.stop(now + fade + 0.1));
  };
  if (duration) {
    master.gain.setValueAtTime(level, t + duration - 2);
    master.gain.linearRampToValueAtTime(0, t + duration);
    sources.forEach((s) => s.stop(t + duration + 0.1));
  }
  return { stop };
}

// ------------------------------------------------------------------ bridge

/**
 * One creak of wood and rope under load: a stick-slip train of tiny clicks
 * whose rate glides (that glide is what the ear hears as a creak's pitch),
 * ringing two body resonances. `low` is a slower, deeper version (heavy
 * doors, big timbers).
 */
export function creak(ctx, out, { when = ctx.currentTime, length = rand(0.35, 0.8), pitch = rand(0.85, 1.25), level = 0.45, low = false } = {}) {
  return renderBuffer(ctx, out, length, (d, sr) => {
    const N = d.length;
    const f0 = (low ? 11 : 32) * pitch;
    const f1 = (low ? 22 : 58) * pitch * rand(0.75, 1.3);
    const x = new Float32Array(N);
    let phase = 0;
    for (let i = 0; i < N; i++) {
      const u = i / N;
      const rate = f0 + (f1 - f0) * (u * u * (3 - 2 * u)) + rand(-3, 3);
      phase += rate / sr;
      if (phase >= 1) {
        phase -= 1;
        const env = Math.pow(Math.sin(Math.PI * u), 0.6);
        const a = env * rand(0.5, 1);
        for (let k = 0; k < 4 && i + k < N; k++) x[i + k] += a * (k === 0 ? 1 : rand(-0.5, 0.5));
      }
    }
    const bodyA = resonate(x, sr, (low ? 150 : 420) * pitch, low ? 40 : 60);
    const bodyB = resonate(x, sr, (low ? 470 : 1180) * pitch, low ? 80 : 110);
    for (let i = 0; i < N; i++) d[i] = bodyA[i] + 0.6 * bodyB[i];
  }, { when, level });
}

/**
 * Creaks while a bridge is being crossed: irregular creaks every ~0.5–1.5 s.
 * Live: schedules a little ahead on a timer until stop(). With `duration`:
 * schedules exactly that span up front (offline rendering).
 */
export function bridgeCrossing(ctx, out, { level = 0.4, duration } = {}) {
  let next = ctx.currentTime + 0.05;
  const schedule = (until) => {
    while (next < until) {
      creak(ctx, out, { when: next, level: level * rand(0.6, 1) });
      next += rand(0.45, 1.5);
    }
  };
  if (duration) {
    schedule(ctx.currentTime + duration - 0.8);
    return { stop() {} };
  }
  schedule(ctx.currentTime + 2);
  const timer = setInterval(() => schedule(ctx.currentTime + 2), 500);
  return { stop: () => clearInterval(timer) };
}

/** A plank snapping: sharp crack, splinters, then the low knock of wood. */
export function plankBreak(ctx, out, { when = ctx.currentTime, level = 0.8 } = {}) {
  return renderBuffer(ctx, out, 0.7, (d, sr) => {
    const N = d.length;
    // Crack: a hard noise burst, highpassed (first difference) so it's sharp.
    let prev = 0;
    for (let i = 0; i < N; i++) {
      const t = i / sr;
      const n = Math.random() * 2 - 1;
      const env = t < 0.003 ? t / 0.003 : Math.exp(-(t - 0.003) / 0.022);
      d[i] += (n - prev) * env * 0.9;
      prev = n;
    }
    // Splinters: little bright ticks scattered after the crack.
    for (let s = 0; s < 18; s++) {
      const start = Math.floor(sr * rand(0.008, 0.28) * Math.pow(Math.random(), 0.6));
      const len = Math.floor(sr * 0.004);
      const burst = new Float32Array(len * 6);
      for (let k = 0; k < len; k++) burst[k] = (Math.random() * 2 - 1) * (1 - k / len);
      const rung = resonate(burst, sr, rand(1800, 5200), 400);
      const a = rand(0.15, 0.5) * (1 - start / N);
      for (let k = 0; k < rung.length && start + k < N; k++) d[start + k] += rung[k] * a * 6;
    }
    // Knock and thud: the wood's own body, then a low thump.
    const knockIn = new Float32Array(N);
    for (let i = 0; i < Math.floor(sr * 0.03); i++) knockIn[i] = (Math.random() * 2 - 1) * (1 - i / (sr * 0.03));
    const knock = resonate(knockIn, sr, 360, 70);
    let ph = 0;
    for (let i = 0; i < N; i++) {
      const t = i / sr;
      ph += (2 * Math.PI * (55 + 45 * Math.exp(-t / 0.05))) / sr;
      d[i] += knock[i] * 4 + Math.sin(ph) * Math.exp(-t / 0.12) * 0.35;
    }
  }, { when, level });
}

// ------------------------------------------------------------------ alien ship

/** The ship's voice: a detuned low drone through a sweeping filter, a slow
 * throb, and a thin warbling tone on top (the "sci-fi" layer). */
function shipVoice(ctx, out, { when, dur, from, to, level }) {
  const t = when;
  const master = gain(ctx, 0);
  master.connect(out);
  const lp = filter(ctx, 'lowpass', from.cutoff, 5);
  lp.frequency.setValueAtTime(from.cutoff, t);
  lp.frequency.exponentialRampToValueAtTime(to.cutoff, t + dur);
  const throb = gain(ctx, 0.75);
  lp.connect(throb).connect(master);
  const throbLfo = osc(ctx, 'sine', 6.5);
  const throbDepth = gain(ctx, 0.25);
  throbLfo.connect(throbDepth).connect(throb.gain);

  const voices = [
    [osc(ctx, 'sawtooth', 52), 0.5],
    [osc(ctx, 'sawtooth', 52.6), 0.5],
    [osc(ctx, 'square', 104.4), 0.15],
  ];
  const warble = osc(ctx, 'sine', 880);
  const warbleLfo = osc(ctx, 'sine', 5.2);
  const warbleDepth = gain(ctx, 45);
  warbleLfo.connect(warbleDepth).connect(warble.frequency);
  const warbleGain = gain(ctx, 0.05);
  warble.connect(warbleGain).connect(master);

  for (const [o, g] of voices) {
    const base = o.frequency.value;
    o.frequency.setValueAtTime(base * from.pitch, t);
    o.frequency.linearRampToValueAtTime(base * to.pitch, t + dur);
    o.connect(gain(ctx, g)).connect(lp);
  }
  warble.frequency.setValueAtTime(880 * from.pitch, t);
  warble.frequency.linearRampToValueAtTime(880 * to.pitch, t + dur);

  master.gain.setValueAtTime(Math.max(0.0001, from.gain * level), t);
  master.gain.exponentialRampToValueAtTime(Math.max(0.0001, to.gain * level), t + dur);
  if (to.gain === 0) master.gain.linearRampToValueAtTime(0, t + dur + 0.05);

  const all = [...voices.map((v) => v[0]), warble, warbleLfo, throbLfo];
  all.forEach((o) => {
    o.start(t);
    o.stop(t + dur + 0.1);
  });
}

/** The ship arriving: rising out of silence, filter opening, pitch lifting
 * slightly (Doppler: an approaching source sounds higher). */
export function shipArrive(ctx, out, { when = ctx.currentTime, level = 0.35, dur = 3.5 } = {}) {
  shipVoice(ctx, out, { when, dur, level, from: { gain: 0.01, pitch: 0.9, cutoff: 180 }, to: { gain: 1, pitch: 1, cutoff: 1300 } });
}

/** The ship leaving: pitch falling away, filter closing, fading out, with a
 * rush of air as it goes. */
export function shipDepart(ctx, out, { when = ctx.currentTime, level = 0.35, dur = 3 } = {}) {
  shipVoice(ctx, out, { when, dur, level, from: { gain: 1, pitch: 1, cutoff: 1300 }, to: { gain: 0, pitch: 0.72, cutoff: 160 } });
  const n = noise(ctx);
  const bp = filter(ctx, 'bandpass', 2200, 1.2);
  bp.frequency.setValueAtTime(2200, when);
  bp.frequency.exponentialRampToValueAtTime(350, when + dur);
  const g = gain(ctx, 0);
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(level * 0.35, when + 0.4);
  g.gain.linearRampToValueAtTime(0, when + dur);
  n.connect(bp).connect(g).connect(out);
  n.start(when);
  n.stop(when + dur + 0.1);
}

/**
 * The tractor beam taking a player: a shimmering chord sweeping DOWN as the
 * beam descends, a held trembling chord while it holds them, then sweeping
 * UP as it lifts them away. Sparkles throughout.
 */
export function beamAbduct(ctx, out, { when = ctx.currentTime, level = 0.3 } = {}) {
  const t = when;
  const DOWN = 1.6;
  const HOLD = 1.1;
  const UP = 1.9;
  const end = t + DOWN + HOLD + UP;
  const master = gain(ctx, 0);
  master.gain.setValueAtTime(0, t);
  master.gain.linearRampToValueAtTime(level, t + 0.4);
  master.gain.setValueAtTime(level, end - 0.8);
  master.gain.linearRampToValueAtTime(0, end);
  const trem = gain(ctx, 0.7);
  trem.connect(master).connect(out);
  const tremLfo = osc(ctx, 'sine', 13);
  const tremDepth = gain(ctx, 0.3);
  tremLfo.connect(tremDepth).connect(trem.gain);
  tremLfo.frequency.setValueAtTime(13, t);
  tremLfo.frequency.linearRampToValueAtTime(19, t + DOWN + HOLD);
  tremLfo.frequency.linearRampToValueAtTime(9, end);
  tremLfo.start(t);
  tremLfo.stop(end + 0.1);

  const partials = [
    [1, 0.5],
    [1.5, 0.25],
    [2.01, 0.2],
    [3.02, 0.1],
  ];
  for (const [ratio, g] of partials) {
    const o = osc(ctx, 'sine', 1600 * ratio);
    const f = o.frequency;
    f.setValueAtTime(1600 * ratio, t);
    f.exponentialRampToValueAtTime(480 * ratio, t + DOWN);
    f.setValueAtTime(480 * ratio, t + DOWN + HOLD);
    f.exponentialRampToValueAtTime(1900 * ratio, end);
    o.connect(gain(ctx, g)).connect(trem);
    o.start(t);
    o.stop(end + 0.1);
  }
  // Energy hiss and sparkles.
  const n = noise(ctx);
  const hiss = filter(ctx, 'bandpass', 3500, 2);
  const hissGain = gain(ctx, 0.12);
  n.connect(hiss).connect(hissGain).connect(master);
  n.start(t);
  n.stop(end + 0.1);
  for (let i = 0; i < 28; i++) {
    const at = t + rand(0.1, DOWN + HOLD + UP - 0.2);
    const s = osc(ctx, 'sine', rand(2200, 5200));
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.12, at + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
    s.connect(g).connect(master);
    s.start(at);
    s.stop(at + 0.1);
  }
}

// ------------------------------------------------------------------ others

/** Tapping a cardboard word sign: a dull papery thock. */
export function cardTap(ctx, out, { when = ctx.currentTime, level = 0.5 } = {}) {
  return renderBuffer(ctx, out, 0.16, (d, sr) => {
    const N = d.length;
    const x = new Float32Array(N);
    for (let i = 0; i < Math.floor(sr * 0.012); i++) x[i] = Math.random() * 2 - 1;
    const a = resonate(x, sr, 620, 220);
    const b = resonate(x, sr, 1450, 380);
    let ph = 0;
    for (let i = 0; i < N; i++) {
      const t = i / sr;
      ph += (2 * Math.PI * 150) / sr;
      d[i] = a[i] + 0.5 * b[i] + Math.sin(ph) * Math.exp(-t / 0.03) * 0.04;
    }
  }, { when, level });
}

/** Falling: a rush of air dropping away below. */
export function fallWhoosh(ctx, out, { when = ctx.currentTime, level = 0.8, dur = 1.8 } = {}) {
  const n = noise(ctx);
  const bp = filter(ctx, 'bandpass', 1500, 1.6);
  bp.frequency.setValueAtTime(1500, when);
  bp.frequency.exponentialRampToValueAtTime(220, when + dur);
  const g = gain(ctx, 0);
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(level, when + 0.12);
  g.gain.exponentialRampToValueAtTime(0.001, when + dur);
  n.connect(bp).connect(g).connect(out);
  n.start(when, rand(0, 1.5));
  n.stop(when + dur + 0.05);
}

/** The jetpack firing: an ignition whump, then a crackling rocket roar. */
export function jetpack(ctx, out, { when = ctx.currentTime, level = 0.4, dur = 2.8 } = {}) {
  const t = when;
  const end = t + dur;
  const master = gain(ctx, 0);
  master.gain.setValueAtTime(0, t);
  master.gain.linearRampToValueAtTime(level, t + 0.15);
  master.gain.setValueAtTime(level, end - 0.6);
  master.gain.linearRampToValueAtTime(0, end);
  master.connect(out);
  const roar = noise(ctx);
  const lp = filter(ctx, 'lowpass', 120, 1);
  lp.frequency.setValueAtTime(120, t);
  lp.frequency.exponentialRampToValueAtTime(700, t + 0.35);
  lp.frequency.setValueAtTime(700, end - 0.6);
  lp.frequency.exponentialRampToValueAtTime(200, end);
  roar.connect(lp).connect(gain(ctx, 1)).connect(master);
  const hiss = noise(ctx);
  const hp = filter(ctx, 'bandpass', 1800, 0.8);
  const hissGain = gain(ctx, 0.25);
  hiss.connect(hp).connect(hissGain).connect(master);
  // Flicker: the roar's loudness jitters like a real flame.
  for (let at = t + 0.2; at < end; at += 0.035) hissGain.gain.setValueAtTime(rand(0.12, 0.35), at);
  roar.start(t);
  hiss.start(t, 0.7);
  roar.stop(end + 0.05);
  hiss.stop(end + 0.05);
  // Crackle.
  renderBuffer(ctx, out, dur, (d, sr) => {
    for (let k = 0; k < dur * 40; k++) {
      const i = Math.floor(rand(0.15, dur - 0.5) * sr);
      d[i] = rand(-1, 1);
      if (i + 1 < d.length) d[i + 1] = rand(-0.5, 0.5);
    }
  }, { when: t, level: level * 0.25 });
}

/** The temple doors swinging open: deep wooden groans over a stone rumble. */
export function templeDoors(ctx, out, { when = ctx.currentTime, level = 0.5 } = {}) {
  creak(ctx, out, { when, length: 1.9, pitch: 0.9, low: true, level: level * 0.9 });
  creak(ctx, out, { when: when + 0.35, length: 1.6, pitch: 1.15, low: true, level: level * 0.6 });
  const n = noise(ctx);
  const lp = filter(ctx, 'lowpass', 110, 0.8);
  const g = gain(ctx, 0);
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(level * 0.9, when + 0.4);
  g.gain.linearRampToValueAtTime(0, when + 2.2);
  n.connect(lp).connect(g).connect(out);
  n.start(when);
  n.stop(when + 2.3);
}

/** Wind chimes / temple bells: a few soft, inharmonic bell notes. For
 * arriving at the temple, or a correct choice. */
export function chimes(ctx, out, { when = ctx.currentTime, level = 0.22, notes = 4 } = {}) {
  const scale = [1175, 1319, 1568, 1760, 2093, 2349]; // pentatonic, D6 upward
  const partials = [
    [1, 1, 2.6],
    [2.76, 0.45, 1.2],
    [5.4, 0.2, 0.6],
    [8.93, 0.08, 0.3],
  ];
  let at = when;
  for (let i = 0; i < notes; i++) {
    const f0 = scale[Math.floor(Math.random() * scale.length)];
    for (const [ratio, g, decay] of partials) {
      const o = osc(ctx, 'sine', f0 * ratio);
      const e = gain(ctx, 0);
      e.gain.setValueAtTime(0, at);
      e.gain.linearRampToValueAtTime(level * g, at + 0.004);
      e.gain.exponentialRampToValueAtTime(0.0001, at + decay);
      o.connect(e).connect(out);
      o.start(at);
      o.stop(at + decay + 0.05);
    }
    at += rand(0.12, 0.38);
  }
}

/** Everything the preview page lists, in order. */
export const SOUNDS = {
  wind,
  bridgeCrossing,
  creak,
  plankBreak,
  shipArrive,
  shipDepart,
  beamAbduct,
  cardTap,
  fallWhoosh,
  jetpack,
  templeDoors,
  chimes,
};
