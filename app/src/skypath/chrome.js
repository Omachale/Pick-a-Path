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
  <button id="charStart">Start</button>
</div>

<div id="hud">—</div>
<button id="role" data-role="guide">Guide view</button>

<p id="hint">Drag to look around</p>
<div id="controls">
  <button id="left" class="hidden">◀ Left</button>
  <button id="right" class="hidden">Right ▶</button>
  <button id="reset" class="hidden">Again</button>
</div>
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
}
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

.skypath-surface #hint {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(env(safe-area-inset-bottom, 0px) + 82px);
  z-index: 10;
  text-align: center;
  font: 500 12px/1.4 system-ui, sans-serif;
  color: rgba(244, 247, 250, 0.82);
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.55);
  pointer-events: none;
  padding: 0 20px;
  margin: 0;
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
