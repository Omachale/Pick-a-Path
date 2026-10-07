/**
 * What a phone shows once its own run is over and teammates are still
 * running. Luke, 2026-10-06: "a temporary screen for when a player finishes
 * a run, and is waiting for the rest of their team to finish. Show
 * individual players their score, with a simple breakdown of where the
 * score came from, without separating the sections by time" — so every line
 * shows at once, no staged count-up like the victory scene's. Temporary:
 * something to do while waiting (Paper Planes) may replace it.
 *
 * The points are scoring.js's, so they match what the victory scene adds up.
 * Every category is listed, zeros dimmed, so players learn what scores.
 * `ScoreCard` is shared with RoundOver.jsx, which keeps it on screen once
 * the whole team is done.
 */
import { scoreBreakdown } from './scoring.js';

const BACKGROUND = 'textures/mode-skytemple.jpg';

export function ScoreCard({ result }) {
  const b = scoreBreakdown(result);
  const total = b.islands + b.items + b.jetpackBonus + b.resists;
  const lines = [
    [`Correct answers (${b.islands} of ${result.totalForks ?? 6})`, b.islands],
    ['Picked up an item', b.items],
    ['Reached the temple with a jetpack', b.jetpackBonus],
    [`Abductions resisted${b.resists > 1 ? ` (${b.resists})` : ''}`, b.resists],
  ];
  return (
    <div style={{ marginTop: '2vh', textAlign: 'left', font: '600 min(4.4vh, 18px)/1.3 system-ui, sans-serif' }}>
      {lines.map(([label, pts]) => (
        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 24, padding: '0.5vh 0', opacity: pts ? 1 : 0.4 }}>
          <span>{label}</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>+{pts}</span>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '1vh', paddingTop: '1vh', borderTop: '2px solid rgba(244,247,250,0.35)', font: '800 min(6vh, 26px)/1.2 system-ui, sans-serif', color: '#ffe9b8' }}>
        <span>Your score</span>
        <span>{total}</span>
      </div>
    </div>
  );
}

/** The backdrop and panel shared by the between-runs screens (as PlayerJoin.jsx looks). */
export function Panel({ children }) {
  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#12212f' }}>
      <div style={{ position: 'absolute', inset: '-3%', background: `url(${BACKGROUND}) center / cover no-repeat` }} />
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
        <div
          style={{
            background: 'rgba(18, 33, 47, 0.8)',
            backdropFilter: 'blur(3px)',
            WebkitBackdropFilter: 'blur(3px)',
            color: '#f4f7fa',
            borderRadius: 20,
            padding: 'min(5vh, 26px) min(6vw, 40px)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
            textAlign: 'center',
            maxWidth: '90vw',
            minWidth: 'min(80vw, 340px)',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export default function RunScore({ result, stillRunning }) {
  return (
    <Panel>
      <div style={{ font: '800 min(8vh, 32px)/1.15 system-ui, sans-serif', color: '#ffe9b8' }}>
        {result.success ? 'You made it to the temple!' : 'Your run is over'}
      </div>
      <ScoreCard result={result} />
      <p style={{ margin: '2.4vh 0 0', font: '600 min(4.4vh, 18px)/1.35 system-ui, sans-serif', opacity: 0.85 }}>
        {stillRunning.length ? `Waiting for ${listNames(stillRunning)} to finish...` : 'Waiting for your team...'}
      </p>
    </Panel>
  );
}

const listNames = (names) => (names.length < 2 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
