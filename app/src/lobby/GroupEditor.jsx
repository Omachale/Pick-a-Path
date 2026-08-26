/**
 * Manual-or-random grouping, ported from lobby-prototype's group-editor
 * table. "Randomise" only fills this component's own draft state; "Apply
 * groups" is the one action that calls back up to broadcast it — matching
 * the prototype's "both end up as the same {token: groupNumber} shape"
 * design, whether the numbers came from the button or from typing.
 *
 * Teacher-only: App.jsx tracks the Supabase auth session and Lobby.jsx only
 * mounts this component when one exists (Stage C). The prototype's clobbering
 * gap — the draft supposedly rebuilding from the live participant list on
 * every render, discarding in-progress edits when someone joins/leaves mid-
 * edit — turned out not to reproduce here: `draft` is real component state
 * keyed by token, not derived from `participants` each render, so an
 * unrelated participant joining/leaving just adds/removes a row without
 * touching existing entries. Verified in the browser: typed a draft group
 * number for one participant, had a second device join then leave (two
 * separate presence syncs), and the typed value was untouched by either.
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
        "Randomise" only fills the table below; "Apply groups" is what actually broadcasts it to everyone.
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
