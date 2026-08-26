/**
 * THROWAWAY — a look-before-you-build harness for the multi-avatar change.
 *
 * The team-play redesign has two unknowns that are cheaper to *look at* than
 * to guess at, and both of them need several avatars standing at one fork:
 *
 *   1. Does the existing fog already hide which way a player went? The curtain
 *      stands only ~1.8 world units past the fork and the branches diverge
 *      +/-12 degrees, so at the moment a walker reaches the fog the two branch
 *      positions are ~0.77 units apart while an avatar card is ~1.25 wide —
 *      i.e. they overlap. On paper that says "already hidden". This harness is
 *      how we find out for real, before committing to a fade-out that might
 *      not be needed.
 *
 *   2. How do five avatars fit at one intersection? PATH_WIDTH is 2.6 and a
 *      card is ~1.25 wide, so only two fit shoulder to shoulder. Five needs
 *      depth-staggering, smaller cards, or a wider fork platform. The layouts
 *      below are the candidates, switchable live.
 *
 * Deliberately NOT built on the real actor model, because the actor model
 * doesn't exist yet — that refactor is the thing this harness is meant to
 * inform. Companions here are dumb: a rig, a waypoint queue, and a crude
 * non-physics drop. None of this code survives; the questions it answers do.
 *
 * Enabled only via `?solo=1&crowd=N`.
 */

// Candidate arrangements for the standing group, expressed in the fork's own
// local frame: `right` is lateral offset, `fwd` is forward of the fork point
// (negative = standing short of it, which is where a group waiting to decide
// belongs), `scale` multiplies the card size.
//
// Each is a function of (i, n) so they all work for any team size, but they
// are tuned for the n=5 worst case.
const LAYOUTS = {
  // Baseline: one straight line. Included precisely because it *fails* at
  // n=5 — it's the "just put them side by side" option, and seeing how far
  // off the path the outer two land is the clearest statement of the problem.
  line: (i, n) => ({ right: (i - (n - 1) / 2) * 1.35, fwd: -0.9, scale: 1 }),

  // Two ranks, front row of three. Keeps everyone near the path centre by
  // spending depth instead of width.
  rows: (i, n) => {
    const front = Math.min(3, n);
    const inFront = i < front;
    const idx = inFront ? i : i - front;
    const count = inFront ? front : n - front;
    return {
      right: (idx - (count - 1) / 2) * 1.15,
      fwd: inFront ? -0.8 : -2.1,
      scale: 1,
    };
  },

  // Shallow arc: the further from centre, the further back. Depth separation
  // stops the cards overlapping on screen without needing lateral room, and
  // reads as a group naturally clustering at the edge of a decision.
  arc: (i, n) => {
    const off = i - (n - 1) / 2;
    return { right: off * 1.05, fwd: -0.8 - Math.abs(off) * 0.75, scale: 1 };
  },

  // The arc again, with smaller cards — tests whether shrinking buys enough
  // room to keep everyone on the path proper.
  arcSmall: (i, n) => {
    const off = i - (n - 1) / 2;
    return { right: off * 0.85, fwd: -0.8 - Math.abs(off) * 0.6, scale: 0.72 };
  },
};
const LAYOUT_NAMES = Object.keys(LAYOUTS);

// Camera pull-back steps for judging the group shot. 1 is the normal trailing
// distance; the rest approximate the "guide's camera pulls back slightly".
const CAM_PULLS = [1, 1.45, 1.9, 2.5];

const FALL_SPEED = 6.5;
const FALL_SPIN = 3.2;
const FALL_HIDE_AFTER = 3.5; // seconds before a dropped companion is hidden

// Prototype-only: a wider stone patch at the fork so the standing group has
// somewhere to stand that isn't 2.6 units wide. Sized off `PLAZA_W`/`PLAZA_D`
// directly rather than derived from the layout functions, because the real
// question this answers is "how wide does the platform itself need to be",
// independent of which arrangement ends up used on top of it.
const PLAZA_W = 8.5;
const PLAZA_D = 3.4;
const PLAZA_ROWS = 4;
const PLAZA_COLS = 8;

export function attachCrowdHarness(ctx) {
  const {
    count,
    scene,
    container,
    makeRig,
    disposeRig,
    localToWorld,
    sections,
    getForkIndex,
    isWalking,
    FIGURE_H,
    WALK_SPEED,
    ROSTER,
    placeStone,
    setCamPull,
  } = ctx;

  let layoutName = 'arc';
  let camPullIndex = 0;
  let plazaOn = false;
  let plazaBuiltForFork = null;

  /** Lays (or re-lays) a wider stone patch centred on the current fork. */
  function buildPlaza() {
    const sec = currentFork();
    if (!sec || plazaBuiltForFork === sec) return;
    plazaBuiltForFork = sec;
    for (let r = 0; r < PLAZA_ROWS; r++) {
      const fwd = -0.6 - (r * PLAZA_D) / (PLAZA_ROWS - 1);
      for (let c = 0; c < PLAZA_COLS; c++) {
        const right = (c - (PLAZA_COLS - 1) / 2) * (PLAZA_W / (PLAZA_COLS - 1));
        const jitter = (Math.random() - 0.5) * 0.2;
        const p = localToWorld(sec.fork, right + jitter, fwd);
        placeStone(p.x, p.z);
      }
    }
  }

  // One companion per team-mate. They cycle through the roster so at least
  // some visual variety exists — there are only two characters in ROSTER
  // today, which is itself a finding worth seeing at n=5.
  const companions = Array.from({ length: count }, (_, i) => {
    const rig = makeRig(ROSTER[i % ROSTER.length].key);
    return {
      rig,
      group: rig.group,
      scale: 1,
      state: 'idle', // 'idle' | 'walking' | 'falling' | 'held'
      queue: null,
      wrong: false,
      fallElapsed: 0,
      spin: 0,
    };
  });

  function currentFork() {
    return sections[getForkIndex() - 1] ?? null;
  }

  /** Parks every still-idle companion at its layout slot around the live fork. */
  function placeIdle() {
    const sec = currentFork();
    if (!sec) return;
    const layout = LAYOUTS[layoutName];
    const n = companions.length;
    companions.forEach((c, i) => {
      if (c.state !== 'idle') return;
      const { right, fwd, scale } = layout(i, n);
      const p = localToWorld(sec.fork, right, fwd);
      c.scale = scale;
      c.group.scale.setScalar(scale);
      // makeRig parks the card at FIGURE_H / 2 so its feet sit on the path;
      // scaling the group doesn't move its origin, so the centre has to come
      // down by the same factor or a shrunk card floats.
      c.group.position.set(p.x, (FIGURE_H * scale) / 2, p.z);
      c.group.rotation.set(0, 0, 0);
      c.group.visible = true;
    });
  }

  /** Sends the first idle companion down `side` — the fog test. */
  function send(side) {
    const sec = currentFork();
    if (!sec) return;
    const c = companions.find((x) => x.state === 'idle');
    if (!c) return;
    c.queue = sec.branch[side].map((p) => ({ x: p.x, z: p.z }));
    c.wrong = side !== sec.correct;
    c.state = 'walking';
  }

  function resetCompanions() {
    for (const c of companions) {
      c.state = 'idle';
      c.queue = null;
      c.wrong = false;
      c.fallElapsed = 0;
      c.spin = 0;
    }
    placeIdle();
  }

  // ------------------------------------------------------------------ HUD
  const bar = document.createElement('div');
  bar.id = 'crowdHarness';
  bar.style.cssText = [
    'position:absolute',
    'left:50%',
    'transform:translateX(-50%)',
    'top:calc(env(safe-area-inset-top, 0px) + 8px)',
    'z-index:30',
    'display:flex',
    'gap:6px',
    'align-items:center',
    'padding:6px',
    'border-radius:10px',
    'background:rgba(10,20,30,0.55)',
    'backdrop-filter:blur(6px)',
    'font:600 11px/1 system-ui, sans-serif',
  ].join(';');

  const mkBtn = (label, onClick) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'border:0;border-radius:7px;padding:8px 10px;font:600 11px/1 system-ui,sans-serif;color:#12212f;background:#f4f7fa;';
    b.addEventListener('click', onClick);
    bar.appendChild(b);
    return b;
  };

  mkBtn('◀ send', () => send('left'));
  mkBtn('send ▶', () => send('right'));

  const layoutBtn = mkBtn(`layout: ${layoutName}`, () => {
    layoutName = LAYOUT_NAMES[(LAYOUT_NAMES.indexOf(layoutName) + 1) % LAYOUT_NAMES.length];
    layoutBtn.textContent = `layout: ${layoutName}`;
    placeIdle();
  });

  const zoomBtn = mkBtn(`zoom: ${CAM_PULLS[0]}x`, () => {
    camPullIndex = (camPullIndex + 1) % CAM_PULLS.length;
    zoomBtn.textContent = `zoom: ${CAM_PULLS[camPullIndex]}x`;
    setCamPull(CAM_PULLS[camPullIndex]);
  });

  const plazaBtn = mkBtn('plaza: off', () => {
    plazaOn = !plazaOn;
    plazaBtn.textContent = `plaza: ${plazaOn ? 'on' : 'off'}`;
    if (plazaOn) buildPlaza();
  });

  mkBtn('reset crowd', resetCompanions);
  container.appendChild(bar);

  placeIdle();

  // ----------------------------------------------------------------- loop
  function update(dt) {
    // While the real walker is mid-leg the fork it was standing at is behind
    // it, so parking idle companions there would strand them in mid-air —
    // leave them where they are until it settles at the next fork.
    if (!isWalking()) {
      placeIdle();
      if (plazaOn) buildPlaza();
    }

    for (const c of companions) {
      if (c.state === 'walking') {
        const head = c.queue[0];
        if (!head) {
          // Correct branch: hold past the curtain, which is exactly the
          // "waiting for the others" position the real design calls for.
          // Wrong branch: the stones have run out.
          c.state = c.wrong ? 'falling' : 'held';
          continue;
        }
        const dx = head.x - c.group.position.x;
        const dz = head.z - c.group.position.z;
        const d = Math.hypot(dx, dz);
        const step = Math.min(d, WALK_SPEED * dt);
        if (d > 1e-4) {
          c.group.position.x += (dx / d) * step;
          c.group.position.z += (dz / d) * step;
        }
        if (d <= step + 1e-4) c.queue.shift();
      } else if (c.state === 'falling') {
        c.fallElapsed += dt;
        c.group.position.y -= FALL_SPEED * dt * Math.min(1, c.fallElapsed * 2);
        c.spin += FALL_SPIN * dt;
        c.group.rotation.z = c.spin;
        if (c.fallElapsed > FALL_HIDE_AFTER) c.group.visible = false;
      }
    }
  }

  function dispose() {
    for (const c of companions) disposeRig(c.rig);
    companions.length = 0;
    bar.remove();
  }

  return { update, dispose };
}
