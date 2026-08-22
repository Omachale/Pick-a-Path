# To-Do List

## Completed

### WebGL context creation failure on some browsers/GPUs
- **Status**: ✓ Mitigated (root cause is environmental, not fixable in this code)
- **What**: The game got stuck on the loading spinner forever in the user's own browser (Firefox on Windows), with console errors `WebGL creation failed: * tryANGLE (FEATURE_FAILURE_EGL_NO_CONFIG) * Exhausted GL driver options. (FEATURE_FAILURE_WEBGL_EXHAUSTED_DRIVERS)`. This is Firefox's ANGLE layer trying every backend it knows for that GPU and failing to get a context at all — a driver/GPU/browser-combination problem, not something wrong in the game's code. It didn't reproduce in the dev preview browser (different GPU/driver stack).
- **What changed**: `new THREE.WebGLRenderer(...)` was a single call with `{ antialias: true, powerPreference: 'high-performance' }` — the `high-performance` hint forces the discrete GPU on hybrid-graphics laptops, which is often exactly the GPU a blocklisted driver combination fails on. Renderer creation now retries with progressively safer options (drop `powerPreference`, then drop `antialias`, then accept `failIfMajorPerformanceCaveat: false` as a last resort) before giving up. If every attempt still fails, the loading spinner is replaced with an actual on-screen message (enable hardware acceleration / update GPU drivers / try Chrome or Edge) instead of hanging silently forever — that part is guaranteed to help regardless of whether the retries themselves fix any particular machine.
- **Files**: [src/main.js](src/main.js) — `createRenderer()` helper wrapping the `WebGLRenderer` construction in a `try/catch` retry loop, right after the `renderer / scene` section header.
- **Caveat**: this cannot be verified from here — the dev preview's GPU/driver stack doesn't reproduce the failure, so there's no way to confirm the retries actually help on the affected machine, only that they don't break the working case (confirmed: preview still loads and reaches fork 1 normally). If it still fails after this, the next step is the browser's own hardware-acceleration/GPU settings, not more code changes.

### Wrong-turn falling: Rapier gravity fall, wind, and camera follow
- **Status**: ✓ Complete
- **What**: Wired Rapier into main.js for the first time (previously only in blow-trial.js). When a wrong turn is confirmed, the character hands off from the normal walk-cycle to a free-falling rigid body — real gravity, a one-off randomized stumble, then a short decaying/rotating "wind" push (a single off-centre force that fades over `WIND_DURATION` while its horizontal direction sweeps around at `WIND_ANGULAR_SPEED`) — a cheap fake for a true helical field that reads as "caught by a gust and spun" without simulating a rotating force field. The placeholder red flash on a wrong turn has been removed entirely (function, DOM element, and CSS all deleted) — the fall itself is now the only wrong-turn feedback.
- **Camera** (reworked after first pass didn't actually clear the walkway): eases to a *fixed point beside the edge* — computed once in `startFall()` from the walker's position when the stub ran out, offset sideways by `FALL_CAM_SIDE` (2.8, more than the path's own half-width of 1.3, so the walkway's stones aren't between the camera and the open air below) and up by `FALL_CAM_HEIGHT`. The first version leaned forward from wherever the trailing camera happened to be (still `CAM_BACK` behind the edge), so tilting down looked straight through the walkway itself — this version starts beside it instead. Look-at tracks the falling figure down each frame.
- **Two-phase fall timing**: the "you fell" message/Again button and the card actually stopping are on separate clocks — `FALL_UI_DELAY` (2.2s) shows the result, then the card keeps tumbling for `FALL_EXTRA_DURATION` (5s) more before it actually freezes, so the player reads the outcome while the fall is still visibly happening rather than staring at an already-frozen card. `falling` stays true through both phases (physics keeps stepping and `figure` keeps being written from it); only `finished` flips at the first threshold.
- **Freeze until "Again", fully this time**: the figure and camera hold exactly wherever the fall left them once `falling` finally goes false, until the player clicks "Again" — first pass had this right for position but missed rotation: the walk-bob code only ever writes `figure.rotation.z`, so the fall's x/y tilt (set via `figure.quaternion.set(...)` while falling) survived a reset and the character came back on an angle. The reset handler now explicitly does `figure.rotation.set(0, 0, 0)` before starting the new journey.
- **More twist**: angular damping dropped from 0.3 to 0.15, the initial random stumble's angular velocity raised from ±1.5 to ±2.4 rad/s per axis, wind strength from 1.6 to 2.4, and the wind's off-centre lever arm (`WIND_SPREAD_Y`) from 0.35x to 0.45x figure height — the card now visibly tumbles across all three axes instead of a fairly flat spin.
- **Files**: [src/main.js](src/main.js) — `import RAPIER` + `await RAPIER.init()` at the top; "fall physics (Rapier)" block (`fallWorld`, `startFall()`, `applyFallWind()`, wind/camera-anchor/timing constants); leg-completion branch in `tick()` calls `startFall()` on a wrong turn; step-bob block three-way (`falling` / just-fell-and-frozen / normal walk-bob), with the two-phase `finished`/`falling` split inside the falling branch; camera block matches; `refreshUI()`/`updateMarkers()` hide controls/markers while falling; reset handler clears `falling` and explicitly zeroes `figure.rotation`. Also removed `#wrongFlash` from [index.html](index.html) (element + CSS).
- **Card disappears at 5s**: `figure.visible = false` once `fallElapsed >= FALL_DISAPPEAR` (5s, was briefly 4s — bumped after feedback that 4 felt too short) — still within the extra-tumble window (freeze is at 7.2s), so the card vanishes mid-fall rather than lingering, tiny, all the way to the freeze. Restored to visible both at the start of the next `startFall()` and in the reset handler, so it's never accidentally left hidden.
- **Birds cancelled on fall**: `startFall()` now calls `cancelBirdsForFall()`, which fades whatever bird is currently on screen to transparent over `BIRD_FALL_FADE` (0.3s) instead of letting it finish its flight, and `maybeSpawnBird()` now also checks `falling` (previously only `finished`) so no new bird can spawn for the rest of the fall. The shared bird mesh's opacity is reset to 1 the next time it's reused for a fresh bird, so a fade-cut bird doesn't leave the mesh permanently dimmed.
- **Debug hooks**: `window.__fallDebug()` (falling, fallElapsed, camera position, figure position, **figureVisible**) and `window.__figurePose()` (now reports full `rot: [x,y,z]`, not just z) — both useful for inspecting the fall without eyeballing the render.
- **Testing**: Real-time browser testing is unreliable in this environment — the preview pane reports `document.hidden = true` even when fronted, which throttles `requestAnimationFrame` to near-zero, and screenshots time out entirely regardless of front/select calls. Verified instead with a deterministic test harness (a `requestAnimationFrame` stub queue driven by a fake, manually-advanced clock, plus `window.__sections()` to read the correct side per fork ahead of clicking) that fast-forwards the game loop frame-by-frame without relying on real time or luck. Confirmed numerically: at `fallElapsed` ~2.7s the Again button is visible (`reset` element unhidden) while `falling` is still `true` and the figure's Y is still dropping; at 7.2s `falling` flips `false` and stays frozen indefinitely (checked again after 300 more pumped frames); the frozen rotation is clearly non-zero on all three axes (e.g. `[0.64, 0.52, 2.67]`); clicking "Again" brings `rot` back to exactly `[0, 0, z]` with only the normal walk-bob's small z-tilt, no leftover x/y; a bird mid-flight when a fall starts smoothly fades (opacity measured at exactly `1 - fadeT/0.3` mid-fade, e.g. `0.2` at `fadeT≈0.24s`) and is fully cleared (`bird === null`) within the 0.3s window, with no respawn for the rest of the fall; `figureVisible` flips `false` right at `fallElapsed≈4.0s` and back to `true` immediately on "Again". **Camera framing still not confirmed by eye** — the pane hasn't been able to composite a frame this whole session; worth a manual look when it's available.

### Character selection: Fix invisible character + remove titles
- **Status**: ✓ Complete
- **What**: Fixed a bug where the new Woman2 character was invisible — the texture loader (`tex()`) defaulted to `.png`, but her source file is `.webp`, so it was requesting a nonexistent file. Added a per-roster `ext` field so each character can specify its own file extension. Also removed the character name labels ("Archaeologist", "Explorer") from the carousel — characters are shown by image only, no text caption.
- **Files**: [src/main.js](src/main.js) — ROSTER entries now carry `ext: 'webp'`/`ext: 'png'`, `tex()` call passes it through; `renderCharSelect()` label-rendering code removed entirely.
- **Testing**: Verified Woman2 renders correctly in both the select carousel and in-game; console errors on reload confirmed stale/cached, not live.

### Character selection: Carousel UI with multiple characters
- **Status**: ✓ Complete
- **What**: Replaced grid-based character selection with a rotating carousel. One character visible at a time; left/right arrows cycle through options. Shows counter (e.g., "1/2"). Woman2 (Archaeologist) is now the default character.
- **Files**: [src/main.js](src/main.js) — lines 277–281 (ROSTER with woman2 and indy), 1374–1410 (renderCharSelect carousel), 1412–1450 (updateCarouselNav buttons)
- **Assets**: [public/textures/figure-woman2.webp](public/textures/figure-woman2.webp) — new character texture
- **Testing**: Verified carousel cycles correctly, counter updates, labels are clean, game launches with selected character.

### Fall camera direction: Lean toward falling path
- **Status**: ✓ Complete
- **What**: The fall camera now leans in the direction the character is falling — left when they chose the left path, right when they chose the right. Previously it always leaned in the same direction regardless of choice, which made the walkway block the view on half of the forks.
- **How**: Track which path side was chosen (`choiceSide`) in the `choose()` callback, then use that in `startFall()` to compute the perpendicular offset: `choiceSide === 'left'` points the anchor left, `choiceSide === 'right'` points it right.
- **Files**: [src/main.js](src/main.js) — `choiceSide` variable, set in `choose()` and reset in the "Again" handler; `startFall()` uses it to decide camera offset angle.
- **Tuning note**: Falling position (walker position, ground level) and mist position (lower parallax layer) may need adjustment — they were roughly tuned before camera direction was correct, so they may benefit from re-tuning now that the view is actually useful.

### Character rendering: Remove backing layer
- **Status**: ✓ Complete
- **What**: Removed the two-layer character rig (backing + front) and now use a single front-image layer. Disabled color tinting UI (buttons remain visible but non-functional; may re-implement color via border or other means later).
- **Files**: [src/main.js](src/main.js) — lines 272–281 (CHAR_TEX loading), 1244–1256 (makeCharacterRig), 1260–1263 (disposeRig), 1264–1271 (setCharacter), 1379–1385 (color picker, buttons disabled)
- **Why**: Backing layer was causing occasional flicker and added visual complexity. Single layer is cleaner and more stable.
- **Testing**: Verified in browser—character displays without artifacts, game is fully playable with correct move mechanics and fall detection.

### Card physics trial: Rapier-based blow-off mechanic
- **Status**: ✓ Complete (trial phase)
- **What**: Built a fully-functional physics trial with a floating island, upright standing card, and multi-point gust system. Card tumbles naturally in 3D with realistic chaos (off-center impulses, flutter noise) triggered by randomized blow parameters.
- **Files**: [blow-trial.html](blow-trial.html), [src/blow-trial.js](src/blow-trial.js)
- **Launch**: Navigate to `http://localhost:5180/blow-trial.html` in preview browser
- **Features**:
  - Two sliders: blow distance (near/far, 1.5–9.5m) and blow strength (0–1)
  - 4-puff gust system with ±30% magnitude jitter, ±14° angle jitter, random card-local landing points
  - Upright spring stabilization (0.9 stiffness, 0.35 damping) keeps card stable at rest without rotation locks
  - Flutter torque (sinusoidal, triggered >0.3 m/s) adds uneven tumbling
  - Full 3D rotation enabled—card tips, wobbles, and tumbles across all axes
  - Verified: 3 identical-setting blows produce 3 unique trajectories (physics chaos working)
- **Why**: Cannon-es Box-vs-Box friction solver was broken; Rapier handles contact resolution correctly.
- **Next**: Ready to integrate into main game when falling mechanic is needed.

## Pending

### Path generation: Build forks on-demand, not pre-built
- **Status**: Pending
- **What**: Currently the entire path (all forks, branches, curtains, stone waypoints) is built upfront at scene init. Should instead build only the active fork and its immediate branches, discarding solved forks to save memory.
- **Impact**: Reduces memory footprint for long paths (many forks); simplifies replay/reset logic.
- **Complexity**: Medium — affects [src/main.js](src/main.js) journey building (~lines 1142–1230).
