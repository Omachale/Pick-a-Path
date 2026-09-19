/**
 * Sky Path's in-game HUD: the markup and styles that used to live in
 * prototype-threejs/index.html, where the game was the whole page.
 *
 * Two changes from that original, both forced by the game now being a panel
 * inside a larger app rather than the document itself:
 *   - every `position: fixed` became `position: absolute`, anchored to the
 *     mount container (`.skypath-surface`, which sets `position: relative`);
 *   - the `html, body` reset became rules on that container instead, so the
 *     game no longer dictates page-level scrolling, background or user-select.
 *
 * Selectors are scoped under `.skypath-surface` so this can't leak into the
 * lobby screens, even though the ids themselves are still global.
 */

export const SKY_PATH_CHROME = `
<div id="loader">
  <div>Loading sky path…</div>
  <div id="bar"><i></i></div>
</div>
<div id="charSelect">
  <h2>Choose your character</h2>
  <div id="charList"></div>
  <h2>Choose your colour</h2>
  <div id="paletteList"></div>
  <h2>Name your character</h2>
  <input id="nameInput" type="text" maxlength="10" placeholder="Name (optional)" autocomplete="off" />
  <button id="charStart">Start</button>
</div>

<div id="hud">—</div>
<button id="role" data-role="guide">Guide view</button>

<!-- Temporary manual trigger for the alien abduction event (Luke, 2026-09-02:
     "the alien abduction will be triggered by a certain action I haven't told
     you about yet. For the moment, just have it activated by a button push").
     Deliberately tucked into the bottom-left corner and kept small — it is a
     test control, not part of the game's own UI, and it goes away entirely
     once the real trigger is known. -->
<button id="abduct" title="Trigger alien abduction">👽</button>
<!-- Temporary manual trigger for the jetpack power-up (Luke, 2026-09-12:
     "don't worry about how they earn it for now, just add it as a button
     above the alien abduction button"). Same treatment as #abduct: a small
     test control, not part of the game's own UI, parked directly above it. -->
<button id="addJetpack" title="Add jetpack power-up">🚀</button>
<!-- The REAL abduction control (2026-09-15) — not a test trigger like the two
     above it, which Luke asked to keep alongside it. Greyed out unless this
     player is actually holding the abduction trigger item picked up on
     island 2 (see skyPath.js's pickup section); once held, opens the
     target-selection menu. -->
<button id="useAbduct" title="Use abduction trigger (choose a target)" disabled>🛸</button>
<div id="controls">
  <button id="advance" class="hidden" title="Hold to walk">▲</button>
  <button id="reset" class="hidden">Again</button>
</div>
<!-- Abduction targeting (2026-09-15, cardboard UI 2026-09-18) — see
     skyPath.js's "abduction targeting" / "abduction cardboard UI" sections.
     #abductMenu: the attacker's target picker, opened by #useAbduct — the
     cardboard panel lowers into #abductStage, which skyPath.js draws
     avatar/name-tag/arrows/runes onto directly; #abductTeamBox is a plain
     text label laid over it (no background/border — Luke, 2026-09-20:
     "remove the team name area and replace it with the team name written
     in the same green (#33ff66) and bold Orbitron font. No background
     needed"), with #abductTeamLeft/#abductTeamRight either side of it —
     "it needs arrows on either side for cycling through teams" — wired to
     abductStepTeam() in skyPath.js. The old
     placeholder #abductConfirmBtn (plain white button) was removed
     2026-09-20 — Luke: "Time for the confirm button... remove the existing
     confirm button" — in favour of the rune-circle drawn directly on the
     canvas (see skyPath.js's ABDUCT_RUNES/abductDrawRunesAndRing), which is
     now the real confirm control ("wire the runes up as the actual confirm
     button" — same day, once he'd seen the visual): a canvas click inside
     the ring's own radius, while a target is selected, calls
     chooseAbductTarget() directly. #abductCancel sits outside the panel so
     it's reachable regardless of panel size.
     #abductPrompt: the TARGET's Resist / Go choice, shown when the aliens
     arrive on their next island — unrelated to the picker, unchanged.
     #notice: a short self-hiding message. All hidden until needed. -->
<div id="abductMenu" class="hidden">
  <div id="abductStage">
    <canvas id="abductCanvas"></canvas>
    <button id="abductTeamLeft" class="abductTeamArrow" title="Previous team" aria-label="Previous team"></button>
    <div id="abductTeamBox">Team –</div>
    <button id="abductTeamRight" class="abductTeamArrow" title="Next team" aria-label="Next team"></button>
  </div>
  <button id="abductCancel" title="Cancel">✕</button>
</div>
<div id="abductPrompt" class="hidden">
  <div class="panel">
    <h3 id="abductPromptText">The aliens have come for you!</h3>
    <div class="row">
      <button id="abductResist">Resist</button>
      <button id="abductGo" class="secondary">Go</button>
    </div>
  </div>
</div>
<div id="notice" class="hidden"></div>
<!-- The temple-doors ending: opacity driven directly by updateTempleEntry()
     in skyPath.js, frame by frame — no CSS transition here, since the fade's
     own timing is already computed there alongside the door rotation and the
     walker's approach, and a second, independent CSS-driven fade would just
     fight it. Sits above everything (z-index 60) including the loader. -->
<div id="templeFade"></div>
`;

export const SKY_PATH_CSS = `
.skypath-surface {
  --ink: #12212f;
  --paper: #f4f7fa;
  --edge: rgba(18, 33, 47, 0.28);
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #1e3a63;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-user-select: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  overscroll-behavior: none;
}
.skypath-surface canvas { display: block; touch-action: none; }

.skypath-surface #hud {
  position: absolute;
  top: calc(env(safe-area-inset-top, 0px) + 8px);
  left: 8px;
  z-index: 10;
  font: 500 11px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color: var(--paper);
  background: rgba(10, 20, 30, 0.45);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  padding: 7px 10px;
  border-radius: 8px;
  pointer-events: none;
  letter-spacing: 0.02em;
}
.skypath-surface #hud b { font-weight: 700; }

.skypath-surface #role {
  position: absolute;
  top: calc(env(safe-area-inset-top, 0px) + 8px);
  right: 8px;
  z-index: 10;
  padding: 10px 14px;
  border: 0;
  border-radius: 999px;
  font: 700 13px/1 system-ui, sans-serif;
  color: #12212f;
  background: #ffe9b8;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
}
.skypath-surface #role[data-role="player"] { background: #cddbe8; }

/* See the markup note: a temporary test trigger, parked in the bottom-left
   where it can't be mistaken for a game control or fouled by the centred
   choice buttons. Semi-transparent until hovered so it stays unobtrusive in
   screenshots. */
.skypath-surface #abduct {
  position: absolute;
  left: calc(env(safe-area-inset-left, 0px) + 8px);
  bottom: calc(env(safe-area-inset-bottom, 0px) + 12px);
  z-index: 10;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  font-size: 17px;
  line-height: 1;
  cursor: pointer;
  color: #12212f;
  background: rgba(244, 247, 250, 0.45);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  transition: background 0.15s;
}
.skypath-surface #abduct:hover { background: rgba(244, 247, 250, 0.9); }
.skypath-surface #abduct:active { transform: translateY(1px); }
.skypath-surface #abduct:disabled { opacity: 0.25; cursor: default; }

/* Same treatment as #abduct, directly above it (34px + 8px gap + 12px base). */
.skypath-surface #addJetpack {
  position: absolute;
  left: calc(env(safe-area-inset-left, 0px) + 8px);
  bottom: calc(env(safe-area-inset-bottom, 0px) + 54px);
  z-index: 10;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  font-size: 17px;
  line-height: 1;
  cursor: pointer;
  color: #12212f;
  background: rgba(244, 247, 250, 0.45);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  transition: background 0.15s;
}
.skypath-surface #addJetpack:hover { background: rgba(244, 247, 250, 0.9); }
.skypath-surface #addJetpack:active { transform: translateY(1px); }
.skypath-surface #addJetpack:disabled { opacity: 0.25; cursor: default; }

/* The real abduction control, stacked above the two test buttons (next slot
   up: 12 + 3 × 42). Fully opaque when live, unlike the test buttons — it's
   a game control the player is meant to notice once they hold the item. */
.skypath-surface #useAbduct {
  position: absolute;
  left: calc(env(safe-area-inset-left, 0px) + 8px);
  bottom: calc(env(safe-area-inset-bottom, 0px) + 96px);
  z-index: 10;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  font-size: 17px;
  line-height: 1;
  cursor: pointer;
  color: #12212f;
  background: #ffe9b8;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  transition: background 0.15s, opacity 0.15s;
}
.skypath-surface #useAbduct:hover { background: #fff3d6; }
.skypath-surface #useAbduct:active { transform: translateY(1px); }
.skypath-surface #useAbduct:disabled { opacity: 0.25; cursor: default; background: rgba(244, 247, 250, 0.45); }

.skypath-surface #controls {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(env(safe-area-inset-bottom, 0px) + 12px);
  z-index: 10;
  display: flex;
  gap: 10px;
  justify-content: center;
  padding: 0 12px;
  /* The container is a full-width invisible bar across the bottom of the
     surface, and without this it swallows every pointer event in that strip —
     not just its own buttons. That hid the abduction trigger in the corner
     (it was receiving nothing at all), and it also quietly ate drag-to-look
     gestures started anywhere along the bottom edge. The buttons take their
     own events back below. */
  pointer-events: none;
}
.skypath-surface #controls button { pointer-events: auto; }
.skypath-surface #controls button {
  flex: 1 1 0;
  max-width: 200px;
  min-height: 58px;
  border: 0;
  border-radius: 14px;
  font: 700 16px/1.2 system-ui, sans-serif;
  color: #12212f;
  background: var(--paper);
  box-shadow: 0 3px 14px rgba(0, 0, 0, 0.35);
}
.skypath-surface #controls button:active { transform: translateY(2px); }
.skypath-surface #controls button:disabled { opacity: 0.35; }
.skypath-surface #controls button.hidden { display: none; }

/* Hold-to-advance: deliberately smaller and off to the side of the two word
   buttons, not another full-width choice — it's a "keep going" hold, not a
   decision. */
.skypath-surface #controls #advance {
  flex: 0 0 64px;
  max-width: 64px;
  font-size: 28px;
}


/* #abductPrompt keeps the original dimmed-glass dialog treatment (same as
   #charSelect) — it's still a plain Resist/Go choice, unrelated to the
   cardboard picker below. */
.skypath-surface #abductPrompt {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(18, 33, 47, 0.72);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
.skypath-surface #abductPrompt.hidden,
.skypath-surface #notice.hidden { display: none; }
.skypath-surface #abductPrompt .panel {
  width: min(360px, 100%);
  max-height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px;
  border-radius: 16px;
  background: var(--paper);
  color: var(--ink);
  box-shadow: 0 6px 30px rgba(0, 0, 0, 0.45);
}
.skypath-surface #abductPrompt h3 {
  margin: 0 0 4px;
  font: 700 17px/1.3 system-ui, sans-serif;
  text-align: center;
}
.skypath-surface #abductPrompt button {
  min-height: 48px;
  padding: 0 14px;
  border: 0;
  border-radius: 12px;
  font: 700 15px/1.2 system-ui, sans-serif;
  color: var(--ink);
  background: #ffe9b8;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
}
.skypath-surface #abductPrompt button.secondary { background: #cddbe8; }
.skypath-surface #abductPrompt button:active { transform: translateY(1px); }
.skypath-surface #abductPrompt .row { display: flex; gap: 10px; }
.skypath-surface #abductPrompt .row button { flex: 1 1 0; text-align: center; min-height: 56px; }

/* The cardboard target picker (2026-09-18) — see skyPath.js's "abduction
   cardboard UI" section for what draws onto #abductCanvas and how
   #abductTeamBox is positioned (in JS pixels, not CSS percentages — see its
   own rule below for why). Nearly opaque,
   not blurred glass like #abductPrompt — Luke: this should be "in front
   of anything else on the screen," reading as a real object blocking the
   view, not a dialog floating over it. */
.skypath-surface #abductMenu {
  position: absolute;
  inset: 0;
  z-index: 30;
  background: rgba(10, 16, 22, 0.94);
}
.skypath-surface #abductMenu.hidden { display: none; }
/* #abductStage is the visible VIEWPORT the panel lowers into — clips the
   tall canvas above it (see skyPath.js's "abduction cardboard UI" section:
   the canvas is taller than this box on purpose, carrying the string art
   above the panel, and slides down via a JS-driven transform). Everything
   inside is positioned in plain PIXELS computed in JS, not CSS percentages
   — the canvas moves during the lower-in, so a percentage of this box
   would drift out of alignment with the panel's own on-screen rect the
   moment it isn't at rest. */
.skypath-surface #abductStage { position: absolute; inset: 0; overflow: hidden; }
.skypath-surface #abductCanvas { position: absolute; top: 0; }
/* Luke, 2026-09-20: "remove the team name area and replace it with the
   team name written in the same green (#33ff66) and bold Orbitron font. No
   background needed" — was a boxed white/red button (matching the old
   placeholder confirm button's own styling); now plain text laid straight
   over the cardboard, same green/font as everything else selected in this
   UI (the rune ring, Earth's glow). A plain <div> now, not a <button> — the
   arrows either side are the real "switch team" control (see
   abductStepTeam in skyPath.js), so the name itself has nothing to click. */
.skypath-surface #abductTeamBox {
  position: absolute;
  visibility: hidden; /* shown once the picker is actually interactive — see abductTick() */
  color: #33ff66;
  font: 700 15px/1.2 'Orbitron', system-ui, sans-serif; /* font-size overridden per-frame in JS (ABDUCT_TEAM_FONT_SIZE) */
  display: flex;
  align-items: center;
  justify-content: flex-start;
  white-space: nowrap; /* sized to its own text (no fixed width) — see abductPositionOverlayButtons's own comment on why */
}
/* The team-cycling arrows — Luke: "it needs arrows on either side for
   cycling through teams... a smaller version (30% size) of the arrows [used
   for target avatars]." Same source art as those (see ABDUCT_ARROW_LEFT_SRC/
   ABDUCT_ARROW_RIGHT_SRC), referenced directly as a CSS background image
   here rather than drawn on the canvas — these live in the DOM, positioned
   in JS pixels exactly like #abductTeamBox, since they need their own click
   targets independent of the canvas's own hit-testing. */
.skypath-surface .abductTeamArrow {
  position: absolute;
  visibility: hidden; /* shown once the picker is actually interactive — see abductTick() */
  border: 0;
  background-color: transparent;
  background-position: center;
  background-size: contain;
  background-repeat: no-repeat;
  padding: 0;
  cursor: pointer;
}
.skypath-surface #abductTeamLeft { background-image: url('/textures/alien-arrow-left.png'); }
.skypath-surface #abductTeamRight { background-image: url('/textures/alien-arrow-right.png'); }
.skypath-surface #abductCancel {
  position: absolute;
  top: calc(env(safe-area-inset-top, 0px) + 10px);
  right: 10px;
  z-index: 31;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 50%;
  background: rgba(244, 247, 250, 0.85);
  color: #12212f;
  font: 700 15px system-ui, sans-serif;
  cursor: pointer;
}

.skypath-surface #notice {
  position: absolute;
  left: 50%;
  top: calc(env(safe-area-inset-top, 0px) + 56px);
  transform: translateX(-50%);
  z-index: 25;
  max-width: min(420px, calc(100% - 32px));
  padding: 10px 16px;
  border-radius: 12px;
  font: 700 14px/1.3 system-ui, sans-serif;
  color: var(--ink);
  background: #ffe9b8;
  box-shadow: 0 3px 14px rgba(0, 0, 0, 0.35);
  text-align: center;
  pointer-events: none;
}

.skypath-surface #templeFade {
  position: absolute;
  inset: 0;
  /* Above the 3D canvas and name-tag layer (unlayered/9) so it actually
     covers the scene, but below the HUD/controls (10) — otherwise "Again"
     would be sitting invisibly *behind* solid black once fully faded, with
     no visible way back to it. */
  z-index: 9.5;
  background: #000;
  opacity: 0;
  pointer-events: none;
}

.skypath-surface #loader {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: grid;
  place-content: center;
  gap: 14px;
  justify-items: center;
  background: #1e3a63;
  color: var(--paper);
  font: 500 13px/1.4 system-ui, sans-serif;
  transition: opacity 0.45s ease;
}
.skypath-surface #loader.done { opacity: 0; pointer-events: none; }
.skypath-surface #bar {
  width: 190px;
  height: 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.2);
  overflow: hidden;
}
.skypath-surface #bar > i {
  display: block;
  height: 100%;
  width: 0%;
  background: #ffe9b8;
  transition: width 0.2s ease;
}

.skypath-surface #charSelect {
  position: absolute;
  inset: 0;
  z-index: 45; /* above the game, below the loader (which fades out first) */
  display: none;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 22px;
  background: rgba(18, 33, 47, 0.88);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  color: var(--paper);
  text-align: center;
  padding: 24px 16px;
  opacity: 0;
  transition: opacity 0.35s ease;
}
.skypath-surface #charSelect.show { display: flex; }
.skypath-surface #charSelect.visible { opacity: 1; }
.skypath-surface #charSelect h2 {
  margin: 0;
  font: 700 17px/1.3 system-ui, sans-serif;
}
.skypath-surface #charList,
.skypath-surface #paletteList {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: center;
  max-width: 420px;
}
.skypath-surface .charOption {
  border: 3px solid transparent;
  border-radius: 14px;
  background: rgba(244, 247, 250, 0.08);
  padding: 8px;
  display: grid;
  place-items: center;
}
.skypath-surface .charOption img { width: 64px; height: auto; display: block; }
.skypath-surface .charOption.selected { border-color: #ffe9b8; background: rgba(255, 233, 184, 0.14); }
.skypath-surface .swatch {
  width: 44px;
  height: 44px;
  border-radius: 999px;
  border: 3px solid transparent;
  box-shadow: inset 0 0 0 2px rgba(0, 0, 0, 0.25);
}
.skypath-surface .swatch.selected { border-color: #ffe9b8; }
.skypath-surface #nameInput {
  width: 220px;
  max-width: 80vw;
  height: 44px;
  padding: 0 14px;
  border: 2px solid rgba(244, 247, 250, 0.25);
  border-radius: 10px;
  background: rgba(244, 247, 250, 0.08);
  color: var(--paper);
  font: 600 16px/1.2 system-ui, sans-serif;
  text-align: center;
}
.skypath-surface #nameInput:focus { outline: none; border-color: #ffe9b8; }
.skypath-surface #nameInput::placeholder { color: rgba(244, 247, 250, 0.45); }
.skypath-surface #charStart {
  margin-top: 4px;
  min-height: 52px;
  padding: 0 32px;
  border: 0;
  border-radius: 14px;
  font: 700 16px/1.2 system-ui, sans-serif;
  color: #12212f;
  background: var(--paper);
  box-shadow: 0 3px 14px rgba(0, 0, 0, 0.35);
}
.skypath-surface #charStart:active { transform: translateY(2px); }
`;
