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

<!-- #watchPanel: Watch mode's own top-left HUD (2026-09-24) — Luke, replacing
     the old auto-following "omniscient" camera for a FALLEN player with a
     manual cycle through their own team's other players, one at a time.
     Empty/hidden except in role="watching" — see updateWatchingCamera() and
     stepWatch() in skyPath.js, which own everything inside it. The old
     parked/following camera (updateGuideCamera) still backs this up when
     there's no one to actually show (see that function's own TODO note —
     it's flagged for deletion once this is proven solid). -->
<div id="watchPanel" class="hidden">
  <button id="watchLeft" class="watchArrow watchArrowLeft" title="Previous player" aria-label="Previous player"></button>
  <div id="watchCard">
    <img id="watchAvatar" alt="" draggable="false" />
    <div id="watchName"></div>
  </div>
  <button id="watchRight" class="watchArrow watchArrowRight" title="Next player" aria-label="Next player"></button>
</div>
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
     #abductDefenseStage: the TARGET's defence screen, shown when the
     aliens arrive on their next island — replaced the old plain Resist/Go
     dialog (2026-09-23). Empty here on purpose: abductDefense.js builds
     its own DOM into it (cardboard-track panel, keyboard, avatar, ship)
     the same way the keyboard test harness does, rather than a static
     template — see that file's own header for why.
     #abductGuideStage: the GUIDE's own mirror of that screen (2026-09-23)
     — "the same UI the defending player uses... but no keyboard", showing
     the guide the word to read out instead of letting them type. Same
     empty-on-purpose treatment; createAbductGuideView() in
     abductDefense.js builds into it.
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
<div id="abductDefenseStage"></div>
<div id="abductGuideStage"></div>
<!-- #paperMessage: the abduction-defence messages (2026-09-23) — Luke's
     hand-held paper graphic, text written on it in Sue Ellen Francisco,
     lowered from the top of the screen and raised again. Driven by
     showPaperMessage()/hidePaperMessage() in skyPath.js. -->
<div id="paperMessage"><img src="textures/paper-message.png" alt="" draggable="false" /><div id="paperMessageText"></div></div>
<!-- #roleNote: who's guiding, at the start of a round (2026-10-07) — a
     hand-cut piece of the same photographed cardboard as the keyboard panel,
     written on in Sue Ellen Francisco like #paperMessage. Slides in from the
     right; a tap anywhere on it sends it back. Driven by showRoleNote() in
     skyPath.js. -->
<div id="roleNote"><div id="roleNoteCard"><div id="roleNoteText"></div><div id="roleNoteHint">tap to close</div></div></div>
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

/* #watchPanel — see the markup note above. Sits where the old FPS/debug
   #hud used to (top-left), shown only for role="watching". */
.skypath-surface #watchPanel {
  position: absolute;
  top: calc(env(safe-area-inset-top, 0px) + 8px);
  left: 8px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 6px;
}
.skypath-surface #watchPanel.hidden { display: none; }
/* Fixed width, Luke 2026-09-24: "the player avatars aren't all even width
   it seems, and so when cycling through, the arrows move... place the
   arrows at a fixed width... and then keep the arrows there." The actual
   varying element turned out to be the NAME TAG, not the avatar — every
   figure texture in ROSTER is the same ~0.71 aspect ratio (checked
   directly), but a name tag's width depends on how many letters are in it
   (a 3-letter name is under half the width of a 10-letter one at the same
   height). Rather than key this off the avatar's own (already-constant)
   width, #watchCard gets a flat fixed width generous enough for most
   names at full height, with both children constrained to shrink-to-fit
   inside it (never grow past it) — see #watchAvatar/#watchName canvas
   below — so the slot truly never changes size regardless of which
   teammate or how long their name is. */
.skypath-surface #watchCard {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  width: 84px;
  flex: 0 0 84px;
}
.skypath-surface #watchAvatar {
  /* "big should only mean the same size as they are normally in the game"
     — Luke, 2026-09-24: not blown up like the character-select preview. */
  max-height: 72px;
  max-width: 100%;
  width: auto;
  height: auto;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.45));
  user-select: none;
}
/* #watchName holds the SAME cardboard-cutout name-tag canvas the player's
   own in-world tag uses (buildNameTagCanvas, nameTag.js) — Luke, 2026-09-24:
   "a real, cardboard nametag next to them, the same as they do in the game.
   Not a name written in a font below them." refreshWatchPanel() in
   skyPath.js appends the built <canvas> here; this just sizes it — capped
   to the fixed #watchCard width above rather than a flat height, so a long
   name shrinks to fit instead of stretching the slot (see that rule's own
   comment). */
.skypath-surface #watchName canvas {
  display: block;
  max-height: 26px;
  max-width: 100%;
  width: auto;
  height: auto;
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.4));
}
/* The two cycle arrows — Luke: "make these arrows look vaguely cardboard,
   but quite simple." Rather than hand-cutting new PNG assets (this
   project's numeral-art attempts went badly trying exactly that — see
   TODO.md), each arrow is a plain triangle cut from the SAME photographed
   cardboard texture the keyboard panel already uses (cardboard-panel.png),
   via clip-path — no pixel editing at all, and easy to re-aim at a
   different patch of the source photo later by nudging background-position
   if this patch reads wrong once seen live. */
.skypath-surface .watchArrow {
  flex: 0 0 auto;
  width: 26px;
  height: 34px;
  padding: 0;
  border: 0;
  background-color: transparent;
  background-image: url('textures/cardboard-panel.png');
  background-size: 420% 420%;
  cursor: pointer;
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.5));
}
.skypath-surface .watchArrowLeft {
  clip-path: polygon(100% 0%, 100% 100%, 0% 50%);
  background-position: 30% 40%;
}
.skypath-surface .watchArrowRight {
  clip-path: polygon(0% 0%, 0% 100%, 100% 50%);
  background-position: 60% 55%;
}

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


/* #abductDefenseStage — replaces the old #abductPrompt dialog (2026-09-23).
   Same "nearly opaque, reads as a real object" treatment as #abductMenu
   below, for the same reason. Empty/inert until abductDefense.js builds
   into it; display is toggled by that module, not by a .hidden class, so
   it can run its own lift-away animation before disappearing. */
.skypath-surface #abductDefenseStage {
  position: absolute;
  inset: 0;
  z-index: 30;
  overflow: hidden;
  display: none;
}
/* #abductGuideStage — same treatment as #abductDefenseStage above, its own
   stacking context (both stay display:none until opened, so they never
   actually show at once in practice). */
.skypath-surface #abductGuideStage {
  position: absolute;
  inset: 0;
  z-index: 30;
  overflow: hidden;
  display: none;
}
.skypath-surface #notice.hidden { display: none; }

/* The hand-held paper message. The image is cropped so the arm runs off its
   top edge, so parked at top:0 it reads as being held down from above the
   screen; hidden = translated fully above it. Above the defence panels
   (z 30) so it stays readable while one is lowering as the paper lifts. The
   text box sits over the paper only (it fills the image's lower half — rows
   299-593 of 595), starting below the thumb. Font size is set in JS to fit
   — see fitPaperMessageText(). */
.skypath-surface #paperMessage {
  position: absolute;
  top: 0;
  left: 50%;
  width: min(92vw, 560px, 110vh);
  z-index: 32;
  transform: translate(-50%, -105%);
  transition: transform 600ms cubic-bezier(0.33, 1, 0.68, 1);
  pointer-events: none;
  user-select: none;
}
.skypath-surface #paperMessage.shown { transform: translate(-50%, 0); }
.skypath-surface #paperMessage img { display: block; width: 100%; height: auto; }
.skypath-surface #paperMessageText {
  position: absolute;
  left: 7%;
  right: 7%;
  top: 59%;
  bottom: 5%;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  font-family: 'Sue Ellen Francisco', cursive;
  line-height: 1.1;
  color: #2c2a26;
  overflow: hidden;
}

/* The projector's worlds (lobby/Projector.jsx): the 3D view only, none of a
   phone's buttons, panels or messages. */
.skypath-surface.skypath-projector > :not(canvas) { display: none !important; }

/* The role note. Luke, 2026-10-07: "a note written in cardboard that comes
   onto the screen from the right and leaves once clicked on." The card is
   cut from cardboard-panel.png, scaled up and positioned below that sign's
   string holes so only plain board shows; clip-path gives it slightly
   uneven, hand-cut edges. clip-path also clips box-shadow, so the shadow is
   a drop-shadow filter on the unclipped wrapper. Parked off the right edge;
   .shown brings it to the centre, tilted a touch like a note put down by
   hand. Above the defence panels and the paper message (z 32).
   Sized up for bigger writing (Luke: "make the text significantly bigger.
   Let's try 50%"): wider, and allowed to fill most of a landscape phone's
   height (160vh), with less margin round the text. */
.skypath-surface #roleNote {
  position: absolute;
  top: 50%;
  left: 50%;
  width: min(90vw, 700px, 160vh);
  z-index: 34;
  transform: translate(60vw, -50%) rotate(4deg);
  opacity: 0;
  transition: transform 700ms cubic-bezier(0.22, 1, 0.36, 1), opacity 250ms linear;
  filter: drop-shadow(0 6px 14px rgba(0, 0, 0, 0.45));
  pointer-events: none;
  user-select: none;
  cursor: pointer;
}
.skypath-surface #roleNote.shown {
  transform: translate(-50%, -50%) rotate(-2deg);
  opacity: 1;
  pointer-events: auto;
}
.skypath-surface #roleNoteCard {
  position: relative;
  aspect-ratio: 2.1 / 1;
  background-image: url('textures/cardboard-panel.png');
  background-size: 150% auto;
  background-position: 40% 75%;
  clip-path: polygon(0.6% 2.4%, 22% 0.8%, 49% 2%, 77% 0.4%, 99.4% 1.6%, 98.6% 34%, 99.6% 68%, 98.8% 98.4%, 71% 99.4%, 44% 98%, 18% 99.6%, 0.4% 98.2%, 1.4% 63%, 0.2% 31%);
  box-shadow: inset 0 0 18px rgba(70, 45, 20, 0.35);
}
.skypath-surface #roleNoteText {
  position: absolute;
  left: 7%;
  right: 7%;
  top: 8%;
  bottom: 17%;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  font-family: 'Sue Ellen Francisco', cursive;
  line-height: 1.1;
  color: #2a2119;
  overflow: hidden;
}
.skypath-surface #roleNoteHint {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 5%;
  text-align: center;
  font-family: 'Sue Ellen Francisco', cursive;
  font-size: clamp(13px, 3.4vh, 20px);
  color: rgba(42, 33, 25, 0.6);
}

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
.skypath-surface #abductTeamLeft { background-image: url('textures/alien-arrow-left.png'); }
.skypath-surface #abductTeamRight { background-image: url('textures/alien-arrow-right.png'); }
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
/* Landscape (2026-10-05, Luke: choosing in portrait then turning the phone
   was "an ugly solution"): two columns instead of one tall stack, the
   character on the left, colour/name/Start on the right, all sized from the
   screen's height so a phone held sideways fits it without scrolling. Real
   players now choose on the lobby's join screen (lobby/PlayerJoin.jsx), which
   uses the same layout; this screen is still used in solo play. */
@media (orientation: landscape) {
  .skypath-surface #charSelect.show {
    display: grid;
    grid-template-columns: auto auto;
    grid-template-rows: auto auto auto auto auto;
    column-gap: min(6vw, 56px);
    row-gap: min(2.4vh, 14px);
    align-content: center;
    justify-content: center;
    justify-items: center;
    padding: 2vh 3vw;
  }
  .skypath-surface #charSelect > h2:nth-of-type(1) { grid-column: 1; grid-row: 1; }
  .skypath-surface #charList { grid-column: 1; grid-row: 2 / 5; align-self: center; }
  .skypath-surface #charNavRow { grid-column: 1; grid-row: 5; margin-top: 0 !important; }
  .skypath-surface #charSelect > h2:nth-of-type(2) { grid-column: 2; grid-row: 1; }
  .skypath-surface #paletteList { grid-column: 2; grid-row: 2; max-width: calc(4 * min(9vh, 44px) + 3 * 12px); }
  .skypath-surface #charSelect > h2:nth-of-type(3) { grid-column: 2; grid-row: 3; align-self: end; }
  .skypath-surface #nameInput { grid-column: 2; grid-row: 4; height: min(11vh, 44px); }
  .skypath-surface #charStart { grid-column: 2; grid-row: 5; margin-top: 0; min-height: min(12vh, 52px); }
  .skypath-surface .charOption img { width: auto; height: min(46vh, 240px); }
  .skypath-surface .swatch { width: min(9vh, 44px); height: min(9vh, 44px); }
  .skypath-surface #charSelect h2 { font-size: min(4.6vh, 17px); }
}
`;
