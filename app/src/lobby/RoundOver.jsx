/**
 * What a phone shows once its team's round is over. The victory scene now
 * plays only on the teacher's screen, once at the end of the whole series
 * (Luke, 2026-10-06: "only... at the end of each round, after each player
 * has had a chance to be a guide"), so between rounds a phone just waits,
 * and at the end points everyone at the big screen. A runner keeps their
 * score from this round on screen (RunScore.jsx's card); the guide has none
 * of their own until the series adds it up.
 */
import { Panel, ScoreCard } from './RunScore.jsx';

export default function RoundOver({ seriesEnded, result = null }) {
  return (
    <Panel>
      <div style={{ font: '800 min(8vh, 32px)/1.15 system-ui, sans-serif', color: '#ffe9b8' }}>
        {seriesEnded ? 'That was the last round!' : 'Round complete!'}
      </div>
      {result && !seriesEnded && <ScoreCard result={result} />}
      <p style={{ margin: '2.4vh 0 0', font: '600 min(5vh, 20px)/1.35 system-ui, sans-serif' }}>
        {seriesEnded ? 'Look at the big screen to see who won.' : 'Waiting for your teacher to start the next round...'}
      </p>
    </Panel>
  );
}
