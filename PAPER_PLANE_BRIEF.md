# Brief: the paper-plane throwing game (fresh attempt)

Written 2026-10-04 for a new chat. Luke wants a clean, fresh take on this minigame.
Read this whole brief before starting, then `CLAUDE.md` at the repo root.

## Do not look at the earlier attempts

Earlier attempts at this game exist in the repo and the results were poor. Luke wants
something different, so **do not open, read, search or reuse** any of these:

- `app/throw-game.html`, `app/src/throwGameProto.js`, `app/src/throwGame/`
- `app/scripts/throwSim.mjs`, `app/scripts/throwFindAim.mjs`
- `app/paper-plane-proto.html`, `app/src/paperPlaneProto.js`, `app/src/paperPlane/`
- `app/aero-proto.html`, `app/src/aeroProto.js`, `app/scripts/aeroSim.mjs`
- the paper-plane, aerodynamics and "Island Throw" entries in `TODO.md`

The short version of what went wrong is under "Lessons" at the end, so you don't need
them. Everything else in the repo is fair game, especially Sky Path itself
(`app/src/skypath/`), which this game sits beside.

## The game in one paragraph

After a team reaches the Temple Island at the end of Sky Path, players stand **on the
edge of the Temple Island itself** and throw paper planes out from it at smaller islands
nearby, at varying distances and heights. There are three planes, and the choice of plane matters. Wind, shown in the
world, pushes planes noticeably as they fly. Each throw is two decisions: an upward angle
first, then direction and power at the moment of launch. The player should always be
able to see what their plane did and why.

## Who plays it

- ESL students in a classroom, mostly on **phones**, some on tablets or a projector.
  Everything must work by touch, at phone size, at a steady frame rate.
- Children and teenagers of mixed ability: it must be readable at a glance, with
  little or no text needed to understand an outcome.

## Goals (what "good" means here)

1. **Clean, accessible visuals.** At every moment the player can see what is happening
   and why: where the target is, which way and how hard the wind blows, where the plane
   is, and where it is going. No clutter. Big, clear touch targets. Readable on a small
   screen. Don't rely on colour alone to tell things apart.
2. **Understandable results.** After a throw, the player can tell what happened and
   roughly what to change: short or long, left or right, angle too high or too low, the
   wind took it. Show it in the world: the flight path stays visible, the landing spot is
   marked against the target, perhaps earlier throws ghosted. **Luke's rule: no numbers
   and no suggested values.** No "you were 3.2 m short" and no "try 35°". Words and
   pictures only.
3. **Three planes that are significantly different.** It should be obvious from one
   throw each which plane is which, and each should be the best choice for some
   targets. Roughly:
   - **Dart:** fast, flat, short-lived, barely moved by wind. For near or windy targets.
   - **Glider:** slow, floats a long time, carried a long way by wind. For far targets
     with the wind behind, or when the wind can be used.
   - **All-rounder:** in between. Forgiving.
   Different looks too: someone should be able to name the plane from its silhouette.
4. **A significant wind effect.** The wind must visibly push planes **over time**, not
   just nudge them. A glider thrown across the wind should curve noticeably downwind
   during its flight. The wind must be readable before throwing, from something in the
   world (a flag, streamers, drifting particles, cloud motion), not only from a number or
   an arrow in the corner.
5. **Varying, achievable goals.** A sequence of targets that differ in distance, height,
   size and wind. Every target must be hittable with reasonable skill by at least one
   plane. Prove this with a headless simulation that uses the game's own flight code
   (see "Process"). There should be a way to get a partial result (near the target,
   on the island but off the mark) as well as a bullseye.
6. **A camera that shows the flight.** The player must be able to follow the plane's
   path, not lose it. Not too fast: flights should take long enough to watch, and the
   camera should frame plane, path and target together where it can. A short replay or
   slow-motion moment at the end is welcome if it helps understanding.
7. **Planes and target islands that look good.** These are the stars of the scene, not
   placeholders. Paper planes should read as folded paper: crisp creases, each
   facet catching the light differently, slight variation. Target islands should be attractive, clearly
   readable as targets, and fit Sky Path's world. Aim for polish over quantity.

## Input (Luke's decisions from earlier rounds; keep these)

- **Upward angle** is one decision, made *before* launch: a value sweeps up and down and
  the player taps to lock it. It should be hard to hit exactly, but fair. No numbers on
  the gauge.
- **Direction and power** are a separate decision *at* launch, by touch: press and hold,
  drag to aim, and see a launch arrow whose direction is left/right and whose length is
  power. Release throws. There must be a way to cancel a hold without throwing.
- The arrow should be a plain, standard arrow shape (no rounded head), centred so "a
  little left" means a little left.
- The plane picker should get out of the way once a plane is chosen.

You may improve the feel within these rules (forgiveness, feedback, timing), but don't
replace them without asking Luke.

## Variations, not sliders

Where there's a real design choice, **build two or three distinct versions and let Luke
switch between them in the running page** with a small, clearly labelled picker. For
example:

- camera style (chase, side-on, a high three-quarter view that keeps the target in frame);
- how wind is shown (flag, streamers, drifting particles, moving clouds);
- plane looks, and target-island looks;
- how results are shown (trail plus marker, ghost of last throws, a quick replay).

**Do not** build a large panel of sliders for fine details. A few sliders for things
that really need tuning by eye (overall wind strength, overall flight speed) are fine.
Keep these temporary and clearly marked.

## Constraints and house style

- **Three.js**, already in `app/` (Vite + React shell). See `CLAUDE.md` for where things
  live and the conventions.
- **Lighting is allowed here.** `CLAUDE.md` says the rest of the game is unlit
  (`MeshBasicMaterial` with painted shading); **that rule does not apply to this page**
  (Luke, 2026-10-04: lighting is good, as long as it doesn't affect performance). Use
  real lights where they make the planes and islands look better, but keep it cheap on
  phones: a small number of lights, simple materials (e.g. Lambert or a light-touch
  Standard), shadows only if measured to be affordable (baked or a single fake blob
  shadow is fine). Measure the frame rate with and without, and say what it costs. Make
  sure lit pieces still sit comfortably next to Sky Path's unlit sky and Temple Island.
- **Setting: the edge of Sky Path's Temple Island**, at dusk, high above the cloud sheet.
  The throwing spot is on the Temple Island's rim, with the island (and its temple)
  visible underfoot or behind the player, and the target islands out in the open sky
  around it. Use the real Temple Island and Sky Path's real sky and clouds, not
  look-alikes: they're built in `app/src/skypath/skyPath.js` (search for the backdrop,
  the temple island and `island-basic-v2.glb`). Prefer importing or extracting shared
  pieces over copying them, and say what you extracted.
- **Standalone page is authorised** for this minigame (an exception to `CLAUDE.md`'s
  "build it in the game" rule, which Luke made for this game). Make it a new page with
  its own folder, for example `app/plane-game.html` and `app/src/planeGame/`. Don't
  wire it into Sky Path yet.
- **Mobile performance:** keep draw calls and triangles modest, and measure them.
- **No art files needed.** Luke is happy for planes, islands and textures to be made in
  code (geometry plus canvas-drawn textures), as was done for the Lava Cavern's iron
  islands (`app/src/cavern/ironKit.js`, worth a look for technique).
- **Flight model:** realism is NOT the goal. Luke prefers a simple, stable,
  deterministic model with clear, separate stats per plane (speed, glide, how much the
  wind moves it, and so on) over anything physically accurate. Determinism matters: the
  same throw must give the same flight, so it can be simulated headlessly.

## Process

1. **Plan first, briefly.** Before coding, write a short plan to Luke: the flight model
   in a few lines, the camera approach, how wind will be shown, and the variations you
   intend. Wait for his OK on anything that departs from this brief.
2. **Prove the design headlessly.** Write a Node script that imports the game's own
   flight module (no duplicate maths) and, for every target and plane, sweeps throws to
   show: which targets each plane can hit, how forgiving each target is, and that the
   planes really differ (for example flight time, range, wind drift). Use it to set the
   targets and stats; don't tune by eye alone.
3. **Check it in the browser** with the preview tools, at phone size as well as
   desktop, and look at real frames. Don't hand it over unseen.
4. **Hand over with the URL** (`http://localhost:5181/plane-game.html` or whatever the
   page is called). If another chat already has port 5181, the preview launcher picks
   another port; give whichever is real.
5. **Record it.** Add a dated `TODO.md` entry for what you built, what you chose and why,
   and what's open. Don't edit the old paper-plane entries.
6. **Don't commit.** Luke commits himself.

## Lessons from earlier attempts (so you don't repeat them)

- A **realistic aerodynamics** model (lift and drag from each plane's surface areas)
  produced planes that flew almost the same, and kept producing side effects. Explicit
  per-plane stats worked better.
- Wind applied only as a gentle force **barely showed**. Players need to *see* the drift
  during the flight, and it should build up over time.
- **Too-fast flights and a chase camera** made it hard to see what went wrong.
- A **free 3D aim** (pick a point in the world) made it too easy. Hence the two-decision
  input above.
- **Numeric feedback** was explicitly rejected by Luke.
- On panels over the canvas, `pointer-events: none` with an allow-list of clickable
  children caused repeated "can't click this" bugs. Keep the UI layering simple and test
  every control with real clicks.
- Player-drawn paper folding was tried and parked. It is out of scope here. The three
  planes are fixed designs.
