# Blow mechanic — spec for an autonomous build pass

Read this whole document before writing any code. It is written to stand on
its own — you will not have access to the conversation that produced it.

## What this game mode is

A minigame played on a large flat island. Players arrive at this island
after completing two earlier stages (Sky Path, then the Cavern) — how
quickly they got here determines their starting position and distance from
the centre (closer = did better; this placement logic is built elsewhere,
not part of this task).

Players take turns. On a turn, a player may (a) move closer to a central
object, or (b) blow another player — pushing them backward, ideally off the
edge of the island. The exact rules for *when* a move or a blow is allowed
(success/failure conditions, whatever "gets a question wrong" means
mechanically) are **explicitly out of scope for this task** — something else
decides "a blow happens now, from A aimed at B, with strength S," and hands
that off to the system you are building.

**Your job is only the physics/mechanics layer**: the island itself, a
player's physical card body, applying a blow, detecting when someone goes
over the edge, and getting a knocked-down player back on their feet. You are
NOT building the turn loop, the question/challenge logic, or multiplayer
networking. See "Explicitly out of scope" below.

## Reference implementation — read this first

`prototype-threejs/src/blow-trial.js` (+ `prototype-threejs/blow-trial.html`)
is an existing, working Rapier physics prototype of a closely related idea: a
card standing on a small floating island gets hit by a multi-puff gust and
tumbles off convincingly in full 3D, with an upright spring that keeps it
stable at rest without locking its rotation. It already solves the "how do
you make a physics-based shove look chaotic and organic rather than a flat
shove" problem. **Treat its constants and approach (puff count, jitter
magnitudes, upright spring/damping, flutter torque, the off-centre-impulse
technique) as your tuned starting baseline — don't reinvent them.** Build
this task as an extension of that file/pattern, not a rewrite from scratch.

Also read the comment block above `// ---- fall physics (Rapier)` in
`app/src/skypath/skyPath.js` (search for that heading) — it's the simplified,
already-shipped version of this same idea (a single decaying, rotating force
instead of the full multi-puff system), used for the "you took a wrong turn
and fell" consequence. It explicitly points back at `blow-trial.js` as "the
fuller multi-puff version of this idea if a later pass wants more chaos" —
this task is that later pass.

## Visual/engine conventions this project follows

- **Three.js + `@dimforge/rapier3d-compat`** (Rapier ships as WASM; call
  `await RAPIER.init()` once before using any `RAPIER.*` class — see the top
  of `blow-trial.js` or `skyPath.js` for the exact pattern).
- **Everything renders unlit** (`MeshBasicMaterial`), with shading painted
  into the art rather than computed by a light. `blow-trial.js`, being a
  physics trial, may not follow this — your new work should, since it's a
  step closer to what ships.
- Card characters are flat single-texture planes, not 3D models — same
  `CARD_LEN`/`CARD_ASPECT`/`CARD_THICK` idea already in `blow-trial.js`.

## Decisions already made — build to these, don't re-derive them

### 1. The island
A flat circular deck, **radius = 12 world units** (3× `ISLAND_RADIUS` = 4,
the constant Sky Path's own islands are built around — see
`app/src/skypath/skyPath.js`'s `ISLAND_RADIUS`). Build a simple flat circle
(geometry + matching Rapier collider) for this — you do NOT need Sky Path's
full procedural rock-island generator (`islandGen.js`), just the playing
surface. A player going past this radius (measured from the island's centre,
in the horizontal plane) has gone off the edge.

### 2. The central object
A static decorative object/collider at the island's centre marking the
"finish line" players are moving toward. Assume for now it's simply a solid,
non-interactive obstacle players can rest near but which plays no special
role in blow physics (a blow doesn't bounce off it specially, etc.) — this
is an assumption, flag it clearly in your own notes/README if you build
something more elaborate, since the actual win-condition logic (reaching it)
is out of scope here too.

### 3. Blow direction
The blow originates **from the blower** — i.e. the push direction is chosen
by the blowing player (an aim/targeting decision), not automatically
computed as "radially outward from the centre" or "straight line from
blower to target." Build your blow-application function to take an explicit
direction (unit vector, or angle) as a parameter, supplied by the caller —
do not compute it yourself from player positions. The actual aiming UI and
any constraints on it (limited arc, must be facing a valid target, etc.) are
out of scope — just accept a direction and apply the gust along it.

### 4. Landing and recovery
After a blow, the target's card tumbles per `blow-trial.js`'s existing
approach (off-centre puffs, flutter, upright spring). Once the physics
settles (velocity below some threshold, held for some duration — same
"at rest" detection idea `blow-trial.js` likely already needs for its own UI):

- If the card happens to have settled upright (or near-upright, within some
  tolerance) — nothing further happens, the blow sequence is complete.
- If it settled in any other orientation (on its back, on its side, face
  down) — **immediately** (as part of the same blow sequence concluding, NOT
  deferred to the start of that player's next turn) trigger a "get back up"
  transition that ends with the card standing upright at wherever it came to
  rest. A snap-to-upright is acceptable for a first pass; a short animated
  recovery (the card visibly rotating/standing itself back up) is nicer if
  time allows, but not required.
- Either way, by the time the blow sequence reports itself "finished," the
  target is guaranteed upright (assuming it didn't go off the edge — see
  next point).

### 5. Going off the edge
If, at any point after a blow, a player's card centre crosses outside the
island's radius (see "The island" above) — that's a distinct outcome, not a
landing to recover from. Fire a clearly distinguishable event/callback for
this (e.g. `onWentOffEdge(playerId)`) rather than folding it into the normal
"blow finished, here's where they landed" callback. **The actual
consequence of this (round over / game over, likely a falling-into-lava
animation once the Cavern stage is further along) is explicitly out of
scope — just fire the event.** Do not build any fall-into-lava visuals,
elimination logic, or UI for this.

## Explicitly out of scope for this task

- The turn loop, whose turn it is, movement-toward-the-centre mechanics,
  question/challenge logic, or any rule for *when* a blow or a move is
  allowed.
- Multiplayer networking/synchronization. Build and test this as a **single-
  device, standalone prototype** (new `.html` + `.js` at the
  `prototype-threejs/` root, following `blow-trial.html`/`blow-trial.js`'s
  own pattern — sliders for blow strength/direction/starting distance, a
  simple UI to place a few cards at different starting distances and blow
  one from another).
- Deciding which device is authoritative for a blow's physics outcome in the
  real networked game. This matters a lot for the eventual integration (Rapier's
  chaotic multi-body simulation is not guaranteed to produce identical
  results on two different devices, and every other player needs to see the
  *same* outcome as the person who got blown) — but it is a networking-layer
  decision for a later, separately-reviewed integration pass, not something
  to solve inside this physics module. If it's useful context: the existing
  precedent in this codebase (`useLobby.js`'s `abduct-target`/`abduct-result`
  events, and the fact that a player's own fall physics is always run by
  their own device) points toward "the player being blown computes and
  reports the outcome," not the blower — but that wiring is not this task.
- Final art (card textures, island texture/material polish, the central
  object's actual appearance). Placeholder art/colours are fine.

## Deliverable

- `prototype-threejs/blow-arena.html` + `prototype-threejs/src/blow-arena.js`
  (or similar naming — follow the existing `blow-trial` naming convention),
  extending `blow-trial.js` rather than starting over.
- A small, callable API rather than a page that only works via its own UI —
  something like:
  - `createArena({ radius })` — builds the island + collider.
  - `addPlayer({ startDistance, startAngle })` — places a card at a given
    distance/angle from the centre, returns a handle.
  - `blow(playerHandle, { direction, strength })` — applies the gust,
    returns/calls back with the outcome once the sequence settles:
    either "landed at (x, z), upright" or "went off the edge."
  - A `step(dt)` or internal render-loop tick, however fits the existing
    `blow-trial.js` structure.
- Update `TODO.md` with a dated entry once this is built, same style as the
  existing entries for this project — what was built, what's still open,
  and where to find it. (If you're not sure what "existing style" means,
  read a couple of the entries already in `TODO.md` first.)

## Questions

If anything above is ambiguous or you have to make a real judgment call
(not just picking a placeholder number), leave a clearly marked note in
`TODO.md` or a code comment rather than guessing silently — this is going to
be read and integrated by a human afterward.
