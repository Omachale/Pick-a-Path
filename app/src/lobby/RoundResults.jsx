/**
 * Stage D's results screen — the room's shared stop between one round ending
 * and the next one starting, per TODO.md's `lobby → assigning → playing →
 * results → lobby` state machine. Every device in the room lands here
 * together (see useLobby.js's `round-ended` broadcast handler), not just
 * whoever's Sky Path instance happened to finish first.
 *
 * "Play again" is literally `lobby.startSkyPath` — the same call the lobby's
 * own "Start Sky Path" button makes. Guide rotation means it produces a
 * different guide automatically; no separate "next round" logic exists.
 */
export default function RoundResults({ round, participants, myToken, onPlayAgain, onBackToLobby }) {
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

      <p>
        <button onClick={onPlayAgain}>Play again</button>{' '}
        <button onClick={onBackToLobby}>Back to lobby</button>
      </p>
    </div>
  );
}
