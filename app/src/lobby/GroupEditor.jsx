/**
 * Manual-or-random grouping, ported from lobby-prototype's group-editor
 * table. "Randomise" only fills this component's own draft state; "Apply
 * groups" is the one action that calls back up to broadcast it — matching
 * the prototype's "both end up as the same {token: groupNumber} shape"
 * design, whether the numbers came from the button or from typing.
 *
 * Known gap carried over unchanged from the prototype (recorded in TODO.md):
 * the draft rebuilds from the live participant list on every render, so an
 * in-progress edit can be overwritten by someone else joining or leaving
 * mid-edit. Acceptable for proving the mechanism; not acceptable for the
 * real teacher UX — flagged for Stage C alongside the "no teacher-role
 * gating yet" gap this panel also still has (anyone can open it).
 */
import { useState } from 'react';

export default function GroupEditor({ participants, onApply }) {
  const [groupSize, setGroupSize] = useState(4);
  const [draft, setDraft] = useState({}); // token -> groupId, local until "Apply groups"

  const draftFor = (p) => (draft[p.token] !== undefined ? draft[p.token] : (p.groupId ?? ''));

  const randomise = () => {
    const size = Math.max(1, groupSize || 4);
    const shuffled = [...participants].sort(() => Math.random() - 0.5);
    const next = {};
    shuffled.forEach((p, i) => {
      next[p.token] = Math.floor(i / size) + 1; // 1-based group numbers
    });
    setDraft(next);
  };

  const apply = () => {
    const assignments = {};
    for (const p of participants) {
      const v = draftFor(p);
      assignments[p.token] = v === '' ? null : parseInt(v, 10);
    }
    onApply(assignments);
    setDraft({});
  };

  return (
    <section style={{ borderTop: '1px solid #ddd', paddingTop: '1rem', marginTop: '1.5rem' }}>
      <h2>Group management</h2>
      <p className="hint" style={{ color: '#666', fontSize: '0.9rem' }}>
        No teacher-role gating yet — anyone in the lobby can open this. "Randomise" only fills the table below;
        "Apply groups" is what actually broadcasts it to everyone.
      </p>
      <p>
        Students per group:{' '}
        <input
          type="number"
          min="1"
          value={groupSize}
          onChange={(e) => setGroupSize(parseInt(e.target.value, 10) || 4)}
          style={{ width: '4rem' }}
        />{' '}
        <button onClick={randomise} disabled={participants.length === 0}>
          Randomise
        </button>
      </p>
      <table style={{ borderCollapse: 'collapse', marginTop: '0.5rem' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: '0.2rem 0.6rem' }}>Name</th>
            <th style={{ textAlign: 'left', padding: '0.2rem 0.6rem' }}>Group #</th>
          </tr>
        </thead>
        <tbody>
          {[...participants]
            .sort((a, b) => a.displayName.localeCompare(b.displayName))
            .map((p) => (
              <tr key={p.token}>
                <td style={{ padding: '0.2rem 0.6rem' }}>{p.displayName}</td>
                <td style={{ padding: '0.2rem 0.6rem' }}>
                  <input
                    type="number"
                    min="1"
                    style={{ width: '4rem' }}
                    value={draftFor(p)}
                    onChange={(e) => setDraft((d) => ({ ...d, [p.token]: e.target.value }))}
                  />
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      <p>
        <button onClick={apply} disabled={participants.length === 0}>
          Apply groups
        </button>
      </p>
    </section>
  );
}
