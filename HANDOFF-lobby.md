# Handoff: lobby / welcome screen chat

Written 2026-09-30 from the Island Throw chat. This chat only touches the lobby, so
ignore everything about paper planes and the throw game.

## Read first
- `CLAUDE.md` (repo root). Key rules: build in the running game, not stand-alone pages,
  unless Luke asks; always give the full URL when handing something over; comments carry
  the *why*, so update them when you change behaviour.
- Luke commits himself. Never run `git commit` unless he asks for it in his own words.
- Don't blame stale cache/HMR for a bug. He rules that out before reporting.
- TODO.md is the long-form record. Add a dated entry for what you do and why.

## Where the lobby lives (all under `app/src/`)
- `App.jsx`: top-level view switch. Order: dev bypass params (`?solo=1`, `?cavern=1`,
  `?victory=1`, `?debugKeyboard=1`), then teacher dashboard, victory stage, `GameRoom`
  (playing/failed), `RoundResults`, and finally `<Lobby>` as the default. So the lobby is
  what a student sees when no round is running. `?join=CODE` sets the session code.
- `lobby/Lobby.jsx` (185 lines): the student-facing screen. **Deliberately plain and
  unstyled**, a functional port of an old prototype, not a designed UI. It currently
  shows: an "identity token" line with dev buttons ("New device", "Dev player",
  "Teacher? Start a session"), a no-session warning, `JoinByCode`, a name box + "Join
  lobby", status line, a "+1 point (test score sync)" test button, group label, the
  participant list grouped by group, and a "waiting for your teacher" line.
- `lobby/JoinByCode.jsx`: join-code entry (Supabase `sessions` lookup); `?join=` resolves
  automatically.
- `lobby/useLobby.js` (588 lines): all the state (presence, groups, round phase machine
  `lobby -> assigning -> playing -> results -> lobby`, guide rotation). Its header comment
  explains the design. Change with care; the UI can mostly be restyled without touching it.
- `lobby/TeacherDashboard.jsx` (499 lines): the teacher's own screen (starts sessions,
  manages groups, starts rounds). Students never land there.
- Also lobby-adjacent: `lobby/GameRoom.jsx`, `lobby/RoundResults.jsx`, `lobby/GroupEditor.jsx`,
  `lobby/identity.js`, `identity/*`, `supabase.js`, `OrientationGuard.jsx`, `fullscreen.js`.
- Styling: `styles.css` is tiny (a `.screen` column, max-width 40rem). Lobby.jsx is mostly
  inline styles. `pencilBorder.js` exists as a hand-drawn border helper used by the game UI.
- Data model: `app/supabase/schema.sql`. Simplifications on 2026-09-11: no roster, a session
  code just scopes the channel and the student types any name.

## Things the lobby must keep doing
- Dev conveniences (the "Dev player" button, `?devJoin=`, "New device") speed up
  multi-tab testing. Keep them, but they could be hidden behind a dev flag when the screen
  is made student-facing.
- Students can't start rounds. The teacher does that from the dashboard.
- The warning for joining without a real session code matters (otherwise students land in a
  shared local test room).

## Dev URLs
- Vite dev server runs on port 5181 (Luke's preview config): `http://localhost:5181/`
- Lobby with a code: `http://localhost:5181/?join=CODE`. Skip the lobby entirely:
  `http://localhost:5181/?solo=1&role=guide`.
- Multi-device flow needs the real Supabase project (`.env`); a lobby screen can be
  restyled without it, but joining needs it.

## Working-tree caveat
`git status` currently shows uncommitted, unrelated Island Throw work (`throw-game.html`,
`src/throwGame*`, `scripts/throw*.mjs`, and a TODO.md edit). Do not touch, revert or
commit those. Note that TODO.md has an uncommitted edit from the other chat, so append
your own entry rather than rewriting the file.

## Not decided yet (ask Luke)
The brief so far is only "work on the lobby/welcome screen". There's no design direction
in this handoff: look, tone (this is an ESL classroom game for students), what the
welcome screen should show, and whether it stays one screen or splits into
welcome -> join -> waiting are all open. Ask before designing.
