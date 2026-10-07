/**
 * DEV ONLY: records real Sky Path movement for the bots (bots.js) to
 * replay, so the projector has genuine walks, falls, jetpack rescues and
 * abductions to show without a class of phones. Not imported by the app.
 *
 * Why recordings rather than bots with their own movement: every device
 * builds the same fork islands in the same places (buildJourney has no
 * randomness in positions), and both bridges at a fork look the same, so a
 * walk recorded once ("fork 3, left bridge, fell") is correct in any round.
 * Each player-state the game would send is captured (skyPath.js pushes to
 * window.__stateLog), then buildTracks.mjs cuts the runs into per-fork
 * segments.
 *
 * Driven from the console of a solo game page, e.g.
 *   http://localhost:5181/?solo=1&role=player&pickup=jetpack
 *   const { recordRun } = await import('/src/dev/recordTracks.js');
 *   await recordRun({ name: 'run-ok', outcomes: 'oooooo' });
 * outcomes: one letter per fork, o = correct, x = wrong (falls, or is
 * rescued with a jetpack). abductAtFork: on arriving at that fork, be
 * abducted (needs &debugAbduct=1, which arms window.__debugTriggerDefense;
 * the defence is left to time out). Saved to recordings/NAME.json.
 */
// Waits off a message channel, not setTimeout: a covered window's timers
// are slowed to a few a second (see the frame pump below), which made a
// check miss the short moment between reaching the temple and the solo
// game restarting.
const wait = (ms) =>
  new Promise((resolve) => {
    const end = performance.now() + ms;
    const c = new MessageChannel();
    c.port1.onmessage = () => (performance.now() >= end ? resolve() : c.port2.postMessage(0));
    c.port2.postMessage(0);
  });
async function until(test, timeoutMs, label) {
  const t0 = Date.now();
  while (!test()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await wait(30);
  }
}

/** Several runs in one page, the game reset between them: [{ name, outcomes, abductAtFork }]. */
export async function recordAll(runs) {
  const results = [];
  for (const [i, run] of runs.entries()) {
    if (i > 0) {
      document.getElementById('reset')?.click();
      await wait(1500);
    }
    results.push(await recordRun(run));
  }
  return results;
}

export async function recordRun({ name, outcomes = 'oooooo', abductAtFork = null }) {
  await until(() => document.querySelector('#loader.done'), 60000, 'the game to load');
  await wait(500);
  const start = document.getElementById('charStart');
  if (start?.offsetParent) {
    start.click();
    await wait(2000);
  }
  // The preview window may be covered, and then the browser gives it a
  // couple of animation frames a second, and slows timers as much: the game
  // would walk in slow motion (its frame time is capped at 50 ms). Message
  // channel callbacks aren't slowed, so step frames by hand off one, at
  // most ~60 a second, while recording.
  const pump = new MessageChannel();
  let pumping = true;
  let lastTick = 0;
  pump.port1.onmessage = () => {
    if (!pumping) return;
    const now = performance.now();
    if (now - lastTick >= 16) {
      lastTick = now;
      window.__tick();
    }
    pump.port2.postMessage(0);
  };
  pump.port2.postMessage(0);
  try {
    return await recordSteps(name, outcomes, abductAtFork);
  } finally {
    pumping = false;
    window.__debugHold(0);
  }
}

async function recordSteps(name, outcomes, abductAtFork) {
  window.__stateLog = [];
  const secs = window.__sections();
  const last = () => window.__lastPlayerState ?? {};
  let ending = 'temple';
  for (let k = 1; k <= secs.length; k++) {
    if (abductAtFork === k) {
      window.__debugTriggerDefense();
      await until(() => last().phase === 'gone', 90000, 'the abduction to play out');
      ending = 'abducted';
      break;
    }
    const sec = secs[k - 1];
    const side = outcomes[k - 1] === 'x' ? (sec.correct === 'left' ? 'right' : 'left') : sec.correct;
    window.__forceChoice(side);
    await wait(300);
    window.__debugHold(120000);
    await until(
      () => {
        const s = window.__state();
        // (Reaching the temple never sets `finished` in solo play: the
        // temple entry plays, then the game restarts. Its start is the end.)
        return (s.forkIndex > k && !s.walking) || s.finished || s.templeEntry || last().phase === 'gone';
      },
      60000,
      `fork ${k} to resolve`,
    );
    const s = window.__state();
    if (s.templeEntry) {
      await wait(1500); // the last few pings of the walk into the temple
      break;
    }
    if (s.finished || last().phase === 'gone') {
      // A fall: `finished` comes a few seconds in (when the result shows),
      // while the figure keeps tumbling until the 'gone' report.
      await until(() => last().phase === 'gone', 20000, 'the fall to play out');
      ending = `fell at ${k}`;
      break;
    }
    await wait(800); // a breath on the island, as a player would take
  }
  const record = { name, outcomes, abductAtFork, ending, frames: secs.map((s) => s.fork), log: window.__stateLog };
  window.__stateLog = null;
  const saved = await (await fetch(`/__save?name=${encodeURIComponent(name)}`, { method: 'POST', body: JSON.stringify(record) })).text();
  return { saved, ending, states: record.log.length };
}
