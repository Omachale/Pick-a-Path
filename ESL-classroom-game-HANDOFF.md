# ESL Classroom Game — Project Handoff Brief

## Purpose of this document
Captures the project concept and the architectural decisions made so far, so development can continue in a Claude Code session. No code has been written yet; this is the design foundation.

**Revised 18 August 2026.** Two things changed from the original draft and supersede it wherever they conflict:
1. **The phone is the main game surface**, not a controller for a projected screen. See "Where the game actually runs".
2. **The visual style is a multiplane / diorama look** — 2D artwork arranged as flat panels in a 3D space — not 2D sprites, and not modelled 3D. See "Graphics".

The lobby, identity and grouping sections below are unchanged and still stand.

**Revised 23 August 2026.** Rendering engine is now decided (Three.js — see "Chosen stack"). Cross-mode points, cross-day score/equipment persistence, and shared-screen whole-class rounds were in the original brief and had fallen out of scope; they're restored and reprioritised — see "Persistent classes, scores & equipment" and the build sequence below.

---

## The project

A classroom ESL game, delivered as a **web app** (no desktop app — see reasoning below). A teacher sets up a game/task; students join via a **code or QR code** and are linked to a specific game instance. Students are usually assigned to **teams/groups (3–6)**, but the app must also support **whole-class** activities.

### Core game mechanic (first game mode)
Within each group, one person acts as a **guide** for the rest of that group. The guide's screen shows **different information** from the other players' screens:

- A character/avatar navigates a maze or adventurous area.
- The **guide** sees the hazards to avoid and the correct direction.
- The **players** see the same scene with that information hidden — they see only that the character stands at a junction.
- Simplest version uses **pronunciation / minimal pairs** to choose a direction: e.g. the guide sees "hit" (left path) and "heat" (right path) and must say the correct word to signal the direction to players.
- Base case is **two options**; sometimes three.
- Other choice types later (e.g. correct grammar option).

**Implementation note:** guide and player render the *same scene*; the difference is one layer shown or hidden. This is deliberately cheap, and it is the reason no server-authoritative rendering is needed.

### Other planned game modes (flexibility is a design requirement)
- A simple **quiz mode**: teacher asks questions, students answer by **typing** or **multichoice** on their phones. May often run **whole-class** with no grouping.
- **Shared-screen + phone-input pattern**: the question/prompt is shown on the projected main screen for everyone at once, and each student answers privately on their own phone — the main screen is the prompt surface, the phone is the input surface. This is a variant of whole-class mode, not a new architectural case (see "Where the game actually runs" below).
- The architecture must make adding new modes cheap — see the two-layer split below.

---

## Where the game actually runs (revised — important)

**Gameplay happens on the students' phones.** Several groups play **independently and simultaneously**, which structurally rules out the projected main screen driving gameplay — one screen cannot serve several concurrent games.

The **main/projected screen** is used for:
- Setup and lobby (join code, QR, who has joined, grouping).
- Between-round and end-of-game displays: progress tracking per player or team, winner's podium, scores.
- Optionally, spectating a single group when the whole class is watching one.
- **Driving a whole-class round**: displaying the shared prompt (e.g. a quiz question) while students answer privately on their phones. Still not a peer in the game — it renders room state, same as any other client, it just happens to be the prompt surface for this mode.

**Consequences:**
- The graphically interesting work must run **on phones**, at classroom scale (~30 devices joining at once, on school wifi, across a wide range of device ages including old iPhones/iPads).
- **Load time and download size are first-class requirements**, not polish. A slow first paint at the start of a lesson is the same failure mode that ruled out Render's sleeping free tier.
- The projector client is a separate, simpler view of the same session data. It is not a peer in the game.

---

## Graphics (revised)

### Style: multiplane / puppet-theatre diorama
Stylised and deliberately non-realistic. **2D artwork arranged as flat panels at different depths in a 3D space**, with a perspective camera and parallax as the scene moves — the multiplane camera effect, aiming at a retro cut-out puppet-theatre feel rather than realism.

Intended settings include: a narrow path high in the sky with clouds far below; the same path crossing a volcanic caldera with lava beneath.

### Why this style was chosen
- **The art is 2D images.** No 3D modelling, rigging or animation. This removes the single biggest cost sink in 3D projects and makes assets cheap to produce and revise.
- **Stylised on purpose**, so nothing has to survive close scrutiny and there is no uncanny-valley trap.
- **Cheap to render on phones** — a scene of a dozen flat panels with one light is about as light as real-time graphics get.

### Technique decisions
- **Use a 3D scene with flat panels, not 2D parallax layers.** True perspective, a raking light, and — most importantly — **panels casting soft shadows onto the panels behind them**. That inter-layer shadow is what makes it read as a physical diorama rather than as stacked pictures.
- **Do not extrude the artwork into geometry by default.** With a mostly front-facing camera the edge is rarely visible. Imply thickness instead by (a) the shadow a panel casts on the layer behind it, and (b) a thin darker edge painted into the artwork itself. Reserve real extrusion for hero objects whose sides genuinely come into view.
- **Cost note (recorded so it isn't re-litigated):** the expense in 3D is complicated geometry, many lights, and realistic lighting — none of which apply here. Mildly counterintuitively, stacking many large semi-transparent layers in *2D* can cost a phone **more** than the 3D version, because the same pixels get repainted repeatedly.

### Movement
Discrete and turn-based. The avatar occupies a tile/waypoint; a resolved choice animates it one step. No free roaming, no character controller, no physics, no navmesh. Camera is fixed or on a gentle rail — so only a handful of viewpoints ever need to look good, and everything outside them can be faked.

### Character customisation
Originally specified as customisable appearance. In this style, reduce to **a small set of preset characters plus a colour tint**, at least initially. Revisit later.

---

## Key decision: NOT a cheat-prevention problem

The guide-vs-player "different screens" requirement does **not** need a secure, server-authoritative architecture. The user is **not** concerned about students inspecting the page/console to cheat — it's a casual classroom game, and the few students with both the skills and motivation to do so aren't a meaningful problem.

**Consequence:** We only need to get the right info onto the right screen, not *forbid* the player client from seeing more. This drastically simplifies the stack — no authoritative game server, no server-side game logic. Clients are trusted; a lightweight **relay** for passing messages between devices is all that's required. Each client filters its own display.

---

## Chosen stack

| Layer | Choice | Notes |
|---|---|---|
| Game rendering | **Three.js — decided** | Settled by the diorama prototype. Godot is no longer under consideration; see below. |
| UI chrome (lobby, join, role select, QR) | **React** | Canvas mounted inside React, as in other projects |
| Realtime relay | **Supabase Realtime** | Pub/sub channels via client SDK; no server code to write or host |
| Static hosting | **GitHub Pages** | Serves the built client bundle |
| QR codes | `qrcode` npm package | Renders QR pointing at join URL, e.g. `.../join/ABC123` |

### Rendering engine: decided — Three.js
Superseded: the original brief specified **Phaser 4**. Phaser is a 2D engine and does not do the multiplane-in-3D look, so it was ruled out for the game view.

Godot 4 web export was the other candidate and is now **dropped** — Three.js drops straight into the React lobby already specified (one codebase, one bundle, one deployment), has a small download with sub-second first paint on phones, and has a Supabase SDK already, none of which Godot offered without extra friction (COOP/COEP headers GitHub Pages can't set, ~20–30 MB first-load download, flakier iOS Safari behaviour, a hand-rolled Supabase client). The diorama prototype confirmed it does what this style needs: textured panels in 3D, perspective camera, a light, real shadows.

### Why Supabase over a Render/Socket.io relay
- **Free tier is ample** for this use case (as of mid-2026): 200 concurrent realtime connections, 2 million realtime messages/month, 256 KB max message size, 500 MB database, 5 GB egress. A class of 30 across several rooms is well within limits.
- **No server code** to write or maintain; **no always-on process** needed.
- Render's free tier **sleeps after inactivity** — bad for a "join by QR right now" classroom moment. Supabase is the better fit on cost + functionality, not just convenience.
- **Watch-outs:** free Supabase projects **pause after 1 week of inactivity** (a dashboard click wakes them — mind school holidays). Egress cap is 5 GB/month (nowhere near our volume).
- Supabase also provides a **Postgres database + built-in auth**, which backs persistent classes, scores and equipment (see below) — no separate service needed for that.

### Function of each service (clarified)
- **GitHub Pages** = static file hosting only. No server logic.
- **Render** = would run a long-lived server process (the option we're *not* taking).
- **Supabase** = hosted backend-as-a-service; runs the realtime infrastructure for us, client talks to it directly via SDK. Replaces the *need* for a Render deployment for this job.

### Networking note
Avoid **PeerJS/WebRTC** — school networks/firewalls make peer connections flaky, a bad mid-lesson failure mode. Websocket-based relays (Supabase) are more firewall-friendly.

---

## Architecture: two decoupled layers

Design these as genuinely separate concerns so new game modes are "write a new module," not "restructure everything."

**1. Session/lobby layer** — joining, identity, room assignment. Same for every game mode.
**2. Game-mode layer** — the actual gameplay (maze-guide, quiz, etc.). Swappable.

Grouping is a **lobby-layer** concept that produces rooms; it must know nothing about mazes or quizzes.

### Data model (rough)
- `session` — one per lesson; has join code/QR; holds a flat list of participants.
- `participant` — a connected device; belongs to a session; optionally assigned to a group. **Keyed by a stable identity token, NOT by connection** (critical — see identity below).
- `group` — a subset of participants; becomes a room when a game starts.
- `room` — an active instance of a specific game mode; holds that mode's state (e.g. maze layout + answer key, or quiz questions + current index). **Several rooms run concurrently and independently.**

The game-mode layer only ever receives "here's my room, here's my list of participants (with roles if relevant)." It never touches lobby logic.

**Score and inventory live on the participant's identity, not on the room.** A room reports round results (points earned, items won) up to the session layer; the session layer is what credits them to the participant. This is what makes points earned in Sky Path carry into a later quiz, and — once identity is roster-backed (see below) — across days. A game mode never accumulates or reads a running total itself; it only ever emits "this participant earned N points / item X this round."

---

## Lobby & grouping decisions

- **Open lobby is the default state.** Grouping is an **optional, clear, easy button** layered on top.
- **Whole-class mode = the lobby without the grouping step** = one implicit room containing everyone. Not a separate code path.
- Grouped mode = N rooms = partitioned participants. The game-mode layer receives a room identically in both cases.
- **Grouping options:** manual (teacher assigns named students) **or** random (teacher picks group count/size, system randomly partitions). Both produce the same data shape: a set of groups, each a list of participants.
- **Grouping should be opt-in per mode** — modes that need groups (maze-guide) trigger it; modes that don't (whole-class quiz) skip it.
- **Role assignment within a group** (who is the guide) is a game-mode concern, not a lobby concern — but it must be re-assignable between rounds so students take turns guiding.

### Persistent lobby (decided: YES)
The lobby **persists** as a home base rather than dissolving when a game starts. Supports "play a round in groups → regroup → play again" and mixing grouped play with whole-class questions. Slightly more state to manage, but worth it for the flexibility teachers need across a multi-activity lesson.

### Late joiners & reconnection (decided)
- **Late joiners** land in the open lobby, unassigned; teacher slots them in.
- **Reconnecting students should return to their existing group** where possible.
- This requires participant identity to be tied to a **stable name/token that survives a dropped connection**, not to the connection itself. Supabase presence tells us who's *connected*; our own session state must decide identity persistence. **This is the one thing to get right from the very start — awkward to retrofit.**

---

## Persistent classes, scores & equipment (reprioritised — 23 August 2026)

Points that persist across game modes within a lesson, and scores/equipment that survive across days so a student can log back in as the same character, are **now a real requirement**, not a nice-to-have. This was in the original brief and had dropped out of scope during the graphics/engine work; restoring it changes **sequencing**, not the architecture — the two-layer design and the "stable token, not connection" rule already exist for exactly this reason.

- **Does NOT require student accounts.** The **teacher** has an account and creates a class with a roster of student names. Students still join by code/QR and pick their name from the pre-existing roster instead of typing a fresh nickname. Points and equipment accumulate against the roster entry, and picking that name again on a later day resumes the same character.
- Avoids student auth/passwords and per-student data-protection burden (just names against a class list teachers already hold). Only **one account type** to build — the teacher's — which Supabase auth handles out of the box. DB side is modest: `teacher → class → roster → scores/equipment`, well within free tier.
- **Equipment** (cosmetic/functional items a character accumulates, e.g. from Sky Path rewards) is just another column against the roster row, same shape as score — no separate model needed, but call it out explicitly now so the schema has a slot for it from the start rather than scores being a bare integer.

**What changes vs. the original "defer" call:** the *build* (teacher login screen, roster CRUD UI, cross-day persistence) can still wait until step 5 — no functionality is needed before then. But the **participant identity model in step 1** must now be designed as "a stable token that *can* be backed by a roster row," not a throwaway session-only token retrofitted later. Concretely: keep the token generic (an opaque ID), and make the lookup from token → display name/score/equipment go through one layer that's backed by local-only state in step 1 and by a Supabase roster row from step 5 — the game-mode and lobby code shouldn't need to change when that swap happens.

---

## Recommended build sequence (revised)

0. **Visual prototype / engine decision.** ✓ Done — Three.js confirmed via the diorama prototype.
1. **Anonymous open lobby + reconnection-stable identity, designed roster-ready.** Participants keyed by an opaque stable token, looked up through an identity layer that's local-only for now but is the seam a Supabase roster row will slot into at step 5 (see "Persistent classes, scores & equipment" above) — get this seam right now even though the roster UI itself waits.
2. **Grouping on top.** Optional button; manual or random partition; persistent lobby underneath.
3. **One trivial game mode** — even just "teacher pushes a message that appears on all student screens" — to prove the `session → group → room → game-mode` pipe end to end, with **two groups running at once**, before any real game art or logic. Include a points payload in this trial (even a fake fixed value) to prove a room can report a score up through session to the participant record.
4. **Then the maze-guide mode**, joining the prototype's visuals to the proven pipe. Sky Path reports round results (points/items) through the same path proven in step 3.
5. **Persistent classes**, built out now as a scheduled requirement rather than an open-ended "someday": teacher login, roster CRUD, and backing the identity layer from step 1 with a real Supabase roster row so score/equipment survive across days.

---

## Open questions

- **Participant identity model** — how the **device token** works, what survives a disconnect, and the exact shape of the token → name/score/equipment lookup layer that step 5 will back with a real roster row. Now the single most load-bearing open question, since both cross-mode points and cross-day persistence hang off it. Work through before sketching lobby screens.
- **Art sourcing** — who or what produces the 2D panel artwork, and at what resolution and aspect ratio. Affects the prototype.

---

## Conventions
- British/NZ English spelling throughout.
