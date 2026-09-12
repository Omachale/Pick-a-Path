/**
 * Stage D's results screen — the room's shared stop between one round ending
 * and the next one starting, per TODO.md's `lobby → assigning → playing →
 * results → lobby` state machine. Every device in the room lands here
 * together (see useLobby.js's `round-ended` broadcast handler), not just
 * whoever's Sky Path instance happened to finish first.
 *
 * No more "Play again" button — Luke, 2026-09-11: the teacher starts every
 * round now, including the next one, from their own dashboard. The same
 * "Start game" action there re-broadcasts a fresh `game-started` for every
 * group regardless of what phase each one is currently in, so there's no
 * separate "next round" code path to wire up here; a device just waits.
 */
export default function RoundResults({ round, participants, myToken, onBackToLobby }) {
  const { result, role, guideToken } = round;
  const guideName = participants.find((p) => p.token === guideToken)?.displayName ?? 'someone';
  const wasGuide = guideToken === myToken;

  return (
    <div className="screen">
      <h1>Round results</h1>

      <p style={{ fontSize: '1.1rem', fontWeight: 'bold' }}>
        {result.success
          ? `Made it to the temple! ${result.correctCount}/${result.totalForks} correct.`
          : `Fell at fork ${result.forkIndex + 1} of ${result.totalForks}, after ${result.correctCount} safe crossing${
              result.correctCount === 1 ? '' : 's'
            }.`}
      </p>

      <p style={{ color: '#666' }}>
        Guide this round: {guideName}
        {wasGuide ? ' (you)' : ''} — you were {role === 'guide' ? 'the guide' : 'a player'}.
      </p>

      <p style={{ fontWeight: 'bold' }}>Waiting for your teacher to start the next round…</p>

      <p>
        <button onClick={onBackToLobby}>Back to lobby</button>
      </p>
    </div>
  );
}
