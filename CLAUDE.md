# Working notes for Claude

Project-specific guidance. Read this before starting work.

## Build it in the game, not beside it

**Default to putting new visual features — and their tuning sliders — directly
into the running game.** Do NOT build a stand-alone prototype or tuner page
unless Luke explicitly asks for one.

Luke, 2026-09-04, after being handed a stand-alone courtyard tuner he hadn't
asked for:

> "In general, while there are times when it's good to prototype things
> independently, you should only make something stand-alone if I ask you to.
> Many times, such as this one, I need to see it in the actual game. I can't
> judge how it will look in the game based on the limited environment you
> created."

This has now come up twice — the same correction was made about the alien
abduction's camera sliders a day earlier ("It's hard to assess there as I can't
see the full picture"). The reasoning behind it:

- A stand-in scene can't answer the question that actually matters. Real fog,
  real time-of-day tinting, the real trailing camera, the real neighbouring
  assets and their real sizes are the context a look is judged against. A
  tuner reproducing "enough" of that is reproducing a guess.
- Sliders in the game are usable the moment the player reaches the thing.
  Reaching it can be slow (the courtyard sits past six forks), but that is a
  one-time cost per session — once you're standing there, every slider is live.
- The existing tuner pages (`bridge-tuner.html`, `island-proto.html`,
  `alien-tuner.html`) are precedent for the *pattern*, not a standing
  instruction to keep making them. They were asked for.

**How to add in-game tuning:** a small panel in `src/skypath/chrome.js`
(markup + CSS), wired in `skyPath.js` to write into a live params object and
apply immediately. `#courtyardTune` is the current worked example. Mark it
clearly as temporary, and delete it once Luke gives final values to bake into
the module's own defaults.

## Always give the URL

When handing over anything to look at, include the full URL — e.g.
`http://localhost:5181/?solo=1&role=guide`. Luke asked for this explicitly
(2026-09-04) after being given a demo without one.

## Where things live

- `app/src/skypath/skyPath.js` — the game itself. Large; find things by grep.
- `app/src/skypath/*Gen.js` — per-asset modules (`bridgeGen`, `islandGen`,
  `courtyardGen`) exporting a `*_DEFAULTS` object plus builders. The defaults
  object is the single source of truth for tuned numbers; bake settled values
  there rather than at the call site.
- `TODO.md` (repo root) — the long-form record of what was tried and why.
- `Assets/` — Luke's source art. Copies for the app go in
  `app/public/textures/` (lowercase-hyphen names), **as WebP, not PNG/JPG**
  (2026-10-10: converting every texture cut Sky Path's download from 22 MB to
  7.5 MB; slow school Wi-Fi made the old size take 30 s+). Keep the editable
  originals in `Assets/`. Command used: `magick in.png -quality 82 -define
  webp:alpha-quality=100 -define webp:method=6 out.webp` (alpha kept lossless,
  so cut-out edges and transparency masks are exact).

## Conventions worth knowing

- Almost everything renders **unlit** (`MeshBasicMaterial`), with shading
  painted into the art. Adding a lit material to this scene will look wrong.
  The one deliberate exception is the abduction's green glow, which is
  additive on purpose — see the header comment in `alienAbduction.js`.
- Comments here carry reasoning, not description. When changing something with
  a comment explaining *why* it is the way it is, update that reasoning too —
  a stale "why" is worse than none.
