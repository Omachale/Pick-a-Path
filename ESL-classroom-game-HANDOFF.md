# ESL Classroom Game — Project Handoff Brief

## Purpose of this document
Captures the project concept and the architectural decisions made so far, so development can continue in a Claude Code session. No code has been written yet; this is the design foundation.

**Revised 18 August 2026.** Two things changed from the original draft and supersede it wherever they conflict:
1. **The phone is the main game surface**, not a controller for a projected screen. See "Where the game actually runs".
2. **The visual style is a multiplane / diorama look** — 2D artwork arranged as flat panels in a 3D space — not 2D sprites, and not modelled 3D. See "Graphics".

The lobby, identity, grouping and persistent-class sections below are unchanged and still stand.

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
- The architecture must make adding new modes cheap — see the two-layer split below.

---

## Where the game actually runs (revised — important)

**Gameplay happens on the students' phones.** Several groups play **independently and simultaneously**, which structurally rules out the projected main screen driving gameplay — one screen cannot serve several concurrent games.

The **main/projected screen** is used for:
- Setup and lobby (join code, QR, who has joined, grouping).
- Between-round and end-of-game displays: progress tracking per player or team, winner's podium, scores.
- Optionally, spectating a single group when the whole class is watching one.

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
| Game rendering | **Undecided — prototype first** | Three.js (recommended) vs Godot web export. See below. |
| UI chrome (lobby, join, role select, QR) | **React** | Canvas mounted inside React, as in other projects |
| Realtime relay | **Supabase Realtime** | Pub/sub channels via client SDK; no server code to write or host |
| Static hosting | **GitHub Pages** | Serves the built client bundle |
| QR codes | `qrcode` npm package | Renders QR pointing at join URL, e.g. `.../join/ABC123` |

### Open decision: rendering engine
Superseded: the original brief specified **Phaser 4**. Phaser is a 2D engine and does not do the multiplane-in-3D look, so it is out for the game view. It could still serve non-game screens, but there's no strong reason to.

Two candidates, to be settled by a prototype rather than by argument:

**Three.js (current recommendation)**
- Small download; first paint in well under a second — the decisive factor now that phones are the game surface.
- Drops straight into the React lobby already specified; one codebase, one bundle, one deployment.
- Does exactly what this style needs: textured panels in 3D space, perspective camera, a light, real shadows.

**Godot 4, web export**
- The user's stated reason for wanting it: in past experience, Claude Code produces better visuals and environments in Godot than in React+Phaser. That's a legitimate consideration and shouldn't be dismissed.
- Against it: a web build is roughly a 20–30 MB download before anything renders. Thirty phones at once on school wifi at the start of a lesson is a real risk. It caches after first load, which mitigates repeat lessons but not the first.
- Multi-threaded web export needs COOP/COEP HTTP headers, which **GitHub Pages cannot set**. Workable single-threaded, or via the `coi-serviceworker` trick, but it's friction.
- iOS Safari plus Godot web is the flakiest combination in the matrix, and a classroom is where you meet the oldest devices.
- If Godot is chosen, it also has **no Supabase SDK** — Supabase Realtime is a Phoenix Channels WebSocket protocol, so the client would be hand-rolled (roughly 150–250 lines, quite doable, and firewall-friendly). Do **not** use Godot's built-in ENet/RPC multiplayer; it wants an inbound port and will fail on school networks.

**Decision method:** build the same small test scene both ways and view it on real, student-grade phones. Compare look and load time, then commit.

### Why Supabase over a Render/Socket.io relay
- **Free tier is ample** for this use case (as of mid-2026): 200 concurrent realtime connections, 2 million realtime messages/month, 256 KB max message size, 500 MB database, 5 GB egress. A class of 30 across several rooms is well within limits.
- **No server code** to write or maintain; **no always-on process** needed.
- Render's free tier **sleeps after inactivity** — bad for a "join by QR right now" classroom moment. Supabase is the better fit on cost + functionality, not just convenience.
- **Watch-outs:** free Supabase projects **pause after 1 week of inactivity** (a dashboard click wakes them — mind school holidays). Egress cap is 5 GB/month (nowhere near our volume).
- Supabase also provides a **Postgres database + built-in auth**, which we'll use later for persistent classes (see below).

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
- `participant` — a connected device; belongs to a session; optionally assigned to a group. **Keyed by a stable device token, NOT by connection** (critical — see identity below).
- `group` — a subset of participants; becomes a room when a game starts.
- `room` — an active instance of a specific game mode; holds that mode's state (e.g. maze layout + answer key, or quiz questions + current index). **Several rooms run concurrently and independently.**

The game-mode layer only ever receives "here's my room, here's my list of participants (with roles if relevant)." It never touches lobby logic.

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

## Persistent classes (decided: DEFER, but plan for it)

Reconsidered and found cheaper than first assumed:

- **Does NOT require student accounts.** The **teacher** has an account and creates a class with a roster of student names. Students still join by code/QR and pick their name from the pre-existing roster instead of typing a fresh nickname. Points accumulate against the roster entry.
- Avoids student auth/passwords and per-student data-protection burden (just names against a class list teachers already hold). Only **one account type** to build — the teacher's — which Supabase auth handles out of the box. DB side is modest: `teacher → class → roster → scores`, well within free tier.

**Why defer it (sequencing, not difficulty):** the ephemeral anonymous-lobby layer and the persistent-class layer share the same runtime shape — a participant is "a name in a room," differing only in whether that name is ephemeral or backed by a roster row. If the participant model is keyed by a **stable token** from the start, adding persistent classes later is "back the token with a database row," not a rearchitecture. Building persistent classes first would mean guessing the data model before seeing the system run.

---

## Recommended build sequence (revised)

0. **Visual prototype / engine decision.** One static diorama scene — path, sky, a few parallax layers, one character — viewed on real student-grade phones. Settles Three.js vs Godot on evidence, and settles the art pipeline. Deliberately first, because it's the decision most expensive to reverse and the one the user can judge by looking.
1. **Anonymous open lobby + reconnection-stable identity.** Participants keyed by a device-stored token so a locked or late phone reconnects to the same identity and can be restored to its group. Foundation for everything, including future persistent classes.
2. **Grouping on top.** Optional button; manual or random partition; persistent lobby underneath.
3. **One trivial game mode** — even just "teacher pushes a message that appears on all student screens" — to prove the `session → group → room → game-mode` pipe end to end, with **two groups running at once**, before any real game art or logic.
4. **Then the maze-guide mode**, joining the prototype's visuals to the proven pipe.
5. **Then decide on persistent classes** as a clean addition, once the ephemeral version has shown what the data really needs.

Steps 0 and 1 are independent and can proceed in either order.

---

## Open questions

- **Rendering engine** — settled by step 0 above.
- **Participant identity model** — how the **device token** works and what survives a disconnect. Still the awkward-to-retrofit piece and the exact hook persistent classes will later hang from. Work through before sketching lobby screens.
- **Art sourcing** — who or what produces the 2D panel artwork, and at what resolution and aspect ratio. Affects the prototype.

---

## Conventions
- British/NZ English spelling throughout.
