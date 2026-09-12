/**
 * The lobby screen, ported from lobby-prototype/index.html + lobby.js.
 * Deliberately plain — this is functional parity with the standalone
 * prototype's acceptance bar, not the real teacher/student UI.
 *
 * Simplified 2026-09-11, Luke: the teacher now manages groups and starts
 * every round from their own dashboard (TeacherDashboard.jsx), not from
 * this screen — a teacher never actually lands here any more, so there's
 * no more `isTeacher`/`GroupEditor` branch, and a student has nothing to
 * click to start a round, only a status line saying they're waiting.
 */
import { useState } from 'react';
import JoinByCode from './JoinByCode.jsx';

function groupLabel(groupId) {
  return groupId === null || groupId === undefined ? 'Unassigned' : `Group ${groupId}`;
}

function ParticipantList({ participants, myToken }) {
  const byGroup = new Map();
  for (const p of participants) {
    const key = p.groupId ?? null;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(p);
  }
  const orderedKeys = [...byGroup.keys()].sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return a - b;
  });

  return (
    <ul style={{ border: '1px solid #ccc', padding: '0.5rem 1rem', minHeight: '3rem', listStyle: 'none' }}>
      {orderedKeys.map((key) => (
        <li key={String(key)} style={{ margin: '0.6rem 0', fontWeight: 'bold' }}>
          {groupLabel(key)}
          <ul style={{ fontWeight: 'normal', margin: '0.2rem 0' }}>
            {[...byGroup.get(key)]
              .sort((a, b) => a.displayName.localeCompare(b.displayName))
              .map((p) => (
                <li key={p.token}>
                  {p.displayName}
                  {p.token === myToken ? ' (you)' : ''} — score {p.score} — equipment:{' '}
                  {p.equipment.length ? p.equipment.join(', ') : 'none'}
                </li>
              ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export default function Lobby({ lobby, onCodeResolved, onOpenTeacherView }) {
  const [name, setName] = useState(lobby.participant?.displayName || '');

  return (
    <div className="screen">
      <h1>Sky Path lobby</h1>

      <p className="hint" style={{ color: '#666', fontSize: '0.9rem' }}>
        My identity token: <code>{lobby.token}</code>{' '}
        <button onClick={lobby.resetDevice}>New device (reset identity)</button>{' '}
        <button onClick={onOpenTeacherView}>Teacher? Start a session →</button>
      </p>

      {lobby.joined && !lobby.hasRealSession && (
        <p
          style={{
            color: '#a00',
            border: '1px solid #a00',
            padding: '0.5rem 0.75rem',
            borderRadius: 4,
            fontWeight: 'bold',
          }}
        >
          ⚠ Not connected to a teacher's session — this device joined without a valid session code (the link it
          used was probably missing its <code>?join=</code> part). Anyone else in this same boat lands in one shared
          local test room together, not your teacher's real class — go back and use the exact code or link/QR
          shown on the teacher's screen.
        </p>
      )}

      <JoinByCode joined={lobby.joined} onCodeResolved={onCodeResolved} />

      <p>
        <input
          type="text"
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={lobby.joined}
        />{' '}
        <button onClick={() => lobby.join(name)} disabled={lobby.joined || !name.trim()}>
          Join lobby
        </button>
      </p>
      <p style={{ fontWeight: 'bold' }}>{lobby.status}</p>

      <p>
        <button onClick={() => lobby.addPoint()} disabled={!lobby.joined}>
          +1 point (test score sync)
        </button>
      </p>

      <p>
        Your group: <span style={{ fontWeight: 'bold' }}>{groupLabel(lobby.myGroupId)}</span>
      </p>

      <h2>Participants</h2>
      <ParticipantList participants={lobby.participants} myToken={lobby.token} />

      <section style={{ borderTop: '1px solid #ddd', paddingTop: '1rem', marginTop: '1.5rem' }}>
        <p style={{ fontWeight: 'bold' }}>
          {lobby.myGroupId === null
            ? 'Waiting for your teacher to put you in a group…'
            : 'Waiting for your teacher to start the game…'}
        </p>
      </section>
    </div>
  );
}
