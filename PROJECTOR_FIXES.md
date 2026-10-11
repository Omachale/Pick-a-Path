# Projector: issues to fix

From Luke's bot trial on 2026-10-11 (game TRPXF: 4 teams, 4 rounds, Luke playing on
his phone, projector on the TV) and the monitor logs it produced:
`app/recordings/monitor-projector-trpxf-20261010-212743.json` and
`monitor-board-trpxf-20261010-212735.json`. Times below are seconds into the
projector log. Work down this list; tick items off here as they're fixed.

Guiding principle (Luke): the projector is highlights only, not needed for play.
Get it working simply and reliably first, even if that means showing less.

---

## 0. Everything stops: the realtime connection closed and nothing reconnects — FIXED, to test

**Seen (trial ZLVGK, 2026-10-11):** near the end of a round, players stuck (Omar on
the last bridge, not moving), the projector watching him with nothing happening,
the board showing four players still "running".

**Log:** at 22:24:01 UTC (projector 343.0 s, board 355 s) the projector's channel
went CLOSED, and at the same instant the board (and the 15 bots running in it)
started logging "Realtime send() is automatically falling back to REST API" — the
sign of a channel that's no longer joined. Messages received by the projector fell
from ~25/s to 0 and stayed there. No socket errors, no rate-limit message.

**Cause:** the closing itself came from the Supabase side (every client at the
same instant; the previous trial, with the same code, had none). The real problem
is ours: when a channel is closed, nothing in the app rejoins it — phones
(`useLobby.js`), the board (`teacherSession.js`), the projector and the bots all
just stop. In a class, one such moment would stall the whole game.

**Fix (moderate, touches the phones' networking):** on CLOSED / CHANNEL_ERROR /
TIMED_OUT, rejoin automatically (a fresh channel with the same handlers; phones
re-track presence). Before that: check Supabase's Realtime logs around 22:24 UTC
on 2026-10-10 for the reason.

Luke's download (Logs, last 100 entries) was the "edge" source and started at
22:24:14 — after the drop — showing only REST-fallback broadcasts (including the
projector's every-10-s "projector-here"), i.e. the channels were already dead. The
reason, if recorded, would be in the **Realtime** log source, 22:23:30–22:24:30 UTC.

**Done 2026-10-11:** `app/src/lobby/rejoiningChannel.js` — a drop-in stand-in for a
channel (same `.on`/`.subscribe`/`.send`/`.track`/`.untrack`/`.presenceState`, plus
`.close()`) that, when the channel closes, errors or times out, waits 1 s (doubling
to 10 s), removes it and builds a fresh one with the same handlers, re-tracks the
last presence, and tells the caller it rejoined. Used by the board
(`teacherSession.js`), the projector (main + team channels; on rejoining it asks
the board for the rounds and everyone for their state), the phones (`useLobby.js`,
main + team; the status line says "reconnecting") and the bots. The monitor logs
`realtime-lost` and `realtime-rejoined`. Tested offline with a fake client; a real
server-side close hasn't been reproduced.

**Catching up, also done 2026-10-11:**
- Sends between dropping and rejoining go by the old channel (its REST fallback,
  which still reaches everyone connected). The first version dropped them.
- A phone that rejoins sends `phone-hello`; the board answers with the same
  `rounds-now` summary the projector gets, and the phone applies only what
  concerns it: its round started (if that roundId is new and not over), its round
  over, or the series ended. It also re-sends its own position.
- A board that rejoins sends `report-results`; phones (and bots) send their last
  `round-ended` again. Recording a result twice is harmless (`series.js`
  `recordResult` overwrites; a closed round ignores it).
- Still not recoverable: in-round events missed during a drop (an abduction
  aimed at the phone, a defence request). Rare; the round carries on.

## 1. The camera flicks between players (very often) — FIXED, to test

**Seen:** "still sometimes flipping from view to view too quickly".

**Log:** the followed player changed 42 times; 23 of those lasted under 5 s, many
only 0.2–0.5 s, often A → B → A (e.g. 181.0 Felix → Priya, 181.5 Priya → Bea;
199.0 Tomas → Amara, 199.5 back to Tomas; 276.8–277.3 Luke ↔ Hana). Only 13 of
the 42 were team changes.

**Cause:** two systems both choose who the camera follows, and fight:
- the projector's director (`Projector.jsx`), which re-points the camera every 250 ms;
- the game's own Watch mode (`skyPath.js` `updateWatchingCamera`), built for a fallen
  player's phone, which moves to the next player by itself (3 s after the followed
  player is out), and falls back to the guide camera when nobody is followed.

When Watch mode moves on, the director puts it back a quarter-second later.

**Fix (easy):** in projector mode, the projector alone decides — turn off Watch
mode's auto-advance and fallback there.

**Done 2026-10-11:** `skyPath.js` `updateWatchingCamera` no longer picks, advances
or falls back to the guide camera when `projector` is set; with nobody to follow
the camera holds still.

## 2. An abducted character falls back down, then flies away again — FIXED, to test

**Seen:** twice, after the character had gone off the top of the screen.

**Cause:** two sources move the same character. The projector plays its own copy
of the abduction (the saucer and the lift), and the phone also streams the
character's position while its abduction plays. When the projector's copy ends
(several seconds before the phone's "gone" message — Lucia: abducted 232.3 s, gone
244.6 s), the character is still visible and starts following the streamed
position, which lags behind: it drops back into view and rises again.

**Fix (easy):** once the projector's copy of an abduction has ended, hide that
character and ignore its streamed positions until its next report.

**Done 2026-10-11:** the character is hidden when the local copy ends
(`updateTeammates`); hidden, the stream is ignored. Applies on phones too.

## 3. The aliens are repelled too early — FIXED, to test

**Seen:** the repel animation while the player was still resisting.

**Log:** Sam, 284.1 s: "resting, defending" then straight after "resting" without
the defending flag (he'd been targeted twice at once; the second attack fizzled).
The projector played the repel there. His defence actually started at 292.1 s and
ended in an abduction at 316.0 s.

**Cause:** the repel isn't driven by the result. It's guessed: any report from a
defending player that lacks the defending flag counts as "they resisted". Fragile.

**Fix (easy–moderate):** play the repel only on the explicit result message
(`defence-end`, outcome "resisted"). The same guess exists on phones (teammates'
and guides' views), so fix it there too.

**Done 2026-10-11:** `receiveDefenceEnd` plays the repel on "resisted" for any
viewer but the guide (which already did); the projector now forwards
`defence-end` to the team's world. A report without `defending` only clears the
light if the player has moved on or is out (a safety net for a lost result).

## 4. The TV stayed on "Get ready for the next round"

**Seen:** after a break before round 4; still stuck after the game. The window
was moving again once dragged back onto the PC screen.

**Log:** the projector page itself was fine throughout. Round 4 arrived at 474.5 s,
the worlds loaded, it cut to team 2 at 481.6 s, then crossfades and splits as
normal, the series ended at 560.4 s. It drew about 100 frames a second, and was
never hidden (0 of 211 samples). The window was 1427×812 on a 1536×864 screen
(not full screen; no full-screen event logged).

**Cause:** not explained by the logs. The page was producing pictures; they weren't
reaching the TV. Possibly the TV or Windows (the image was static for over two
minutes during the break), possibly Chrome on a second display.

**Next steps:**
- Add a small live indicator (e.g. a ticking clock in a corner) so we can see at a
  glance whether the TV picture is live or frozen.
- Next time, try full screen (F) on the TV and note whether it happens again.
- Check the TV's picture settings for power saving or static-image protection.

## 5. The victory scene is still far too slow

**Log:** the board did its part this time (it showed the "playing on the
projector" panel and ran at about 100 fps). The projector, playing the scene
alone with the team worlds gone, ran 13–18 fps, then **fell to 7–10 fps** within
a minute.

**Likely cause:** the victory scene itself is heavy, and something in it builds
up over time (fireworks or particles not cleared away?).

**Fix:** profile the victory town on the projector (draw calls and objects over
time), then cap or clean up whatever accumulates. Possibly also draw it at a lower
resolution.

## 6. The bridge doesn't break under some falls

**Seen:** Luke fell at the start of round 3 and went straight through an intact,
clean bridge — the planks stayed where they were.

**Log:** on Luke's team, Hana chose the wrong bridge at fork 1 at 265.5 s, Luke at
267.3 s. (Claude first guessed Luke fell through Hana's hole; Luke corrected it:
the bridge he went through was intact, so the break didn't happen at all.)

**Cause:** unknown. The projector breaks the planks on the first tumbling
position it receives for a falling player (`skyPath.js` `breakBridgeUnder`); one of
its conditions must have failed. Luke's guess: the bridge was already "taken" by
another player on it.

**Next step:** each attempt is now logged by the monitor as `bridge-break` (team,
fork, player, whether planks were found, whether already broken, physics loaded),
so the next trial shows which condition fails.

**Trial ZLVGK:** every attempt found its planks and broke them (or found them
already broken by a teammate's fall moments before). Not seen failing; keep watching.

**Side effect found and fixed (2026-10-11):** this break ran on every screen,
including players' phones, so a teammate's fall showed the players behind which
bridge was wrong (Luke saw the broken planks ahead before choosing). It now runs
only on watching screens (projector, guide, a fallen player).

## 7. Characters overlapping on the same spot

**Seen:** avatars sitting in the same place, glitching.

**Log:** not identifiable from the current logs (they don't record where each
character stands).

**Candidates:**
- the landing at the temple's edge after the last fork has no seats, so everyone
  who arrives there stands in the same spot;
- the stale abducted character from item 2.

**Next step:** have the monitor record each character's position now and then, so
an overlap can be found by time.

**Trial ZLVGK (Indy and Bea, round 1, after Indy's jetpack):** probably a bot
artefact. Every bot replays the same recorded movement, recorded from one player in
one seat, so two bots moving at once follow exactly the same line and land in the
recording's seat; real phones each walk and land in their own seat. Also a bot bug:
both claimed the island-2 item at the same moment (67.4 s). To confirm: watch for
overlaps between real phones, or give the bots their own seat offsets.

## 9. The guide's camera swings about once every teammate is out — FIXED, to test

**Seen:** Luke as guide, round 2: near the end the camera shifted side to side,
with nobody in view. **Done 2026-10-11 (Luke's spec):** once every teammate is out
(fallen or carried off), the guide's camera waits at the temple doors with the
message "All your teammates have fallen." (`skyPath.js` `guideTeamOut`).

## 10. The projector's first shot starts too low — FIXED, to test

**Seen:** at round start the camera sat at or under the island's surface (the
characters' feet visible) before moving into place. **Cause:** the projector picked
a team before any of its players had reported in, so its camera had nobody to
follow and stayed at its start position (log: `follow` with no player, then a
player 3.5 s later). **Done:** a team is shown only once one of its players has
reported in.

## 11. "[Name] was abducted by the aliens!" stays up too long — FIXED, to test

It sat over the abduction, partly hiding the saucer. Now shown for 2 s from the
result (`ABDUCTED_CAPTION_MS` in `Projector.jsx`).

## 8. Smaller things

- Every round start freezes the projector for 2–3 s while it builds all four
  team worlds at once (67, 165, 261, 481 s). It happens under the "get ready"
  screen, so it's mostly hidden. Could build them one at a time.
- 261 warnings of "Texture marked for update but no image data found": some
  texture is flagged before its image has loaded. Probably harmless; find it.
- Memory rose to about 240 MB during play and dropped to 163 MB once the worlds
  were discarded at the series end. No sign of a leak this time.

---

## Proposal: a simpler projector, while we get it working — DONE 2026-10-11, to test

Built as "What to show" in `Projector.jsx` (Luke chose this over the guide-camera
option). Dials on the T panel: time on each team (40 s), standing still before
switching player (12 s), hold on a player who is out (3 s), crossfade (0.5 s).
The monitor logs each choice as `follow` (team, player, why).

The current one has a scoring director, interrupts, split screen and two
competing camera systems. For a reliable first version:

1. **One team at a time, full screen. No split screen.**
2. **Teams in turn:** stay on a team for a fixed time (say 40 s), or until its
   round ends, then crossfade to the next team still playing.
3. **One player at a time within the team:** stay with them until their current
   move has finished (they arrive, or they're out plus a few seconds), then move to
   the next player still playing. Only the projector decides (item 1).
4. **No interruptions** for now. Abductions, rescues and falls are shown when they
   happen to the player being followed, with the camera fixes already made.
5. **Keep:** team and player name, the word pair, captions, the typing overlay,
   the QR screen and the victory scene.

That removes the director's scoring and the split screen from the picture, which
are where most of the jumpiness comes from. Once this is solid, we can add back
one thing at a time (for example, cutting to an abduction on another team).

An even simpler alternative: show each team through the guide's camera (the
team-wide view the guide's phone uses, already well tested), rotating teams on a
timer. Calmer, but less close to the action.
