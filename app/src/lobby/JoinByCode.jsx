/**
 * Stage B's join-code entry, layered above Lobby's existing free-text name
 * box rather than replacing it — a device with no code (or a teacher who
 * hasn't set up a class yet) can still play exactly as Stage A verified.
 *
 * Resolving a code only reads `sessions`/`roster_entries` (anon-readable per
 * app/supabase/schema.sql) and never claims a name itself — claiming
 * happens in useLobby.join() via the roster store's `setDisplayName` alias,
 * so there is exactly one code path into the lobby regardless of which
 * identity store backs it. See useLobby.js's doc comment on why the actual
 * `lobby.join(name)` call has to wait for a render with the new store
 * before firing, rather than happening directly from this component's own
 * click handler.
 */
import { useState } from 'react';
import { supabase } from '../supabase.js';
import { createSupabaseIdentityStore } from '../identity/supabaseIdentityStore.js';

export default function JoinByCode({ onRosterStoreReady, onPickName, joined }) {
  const [code, setCode] = useState('');
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState(null);
  const [roster, setRoster] = useState(null); // null until a code resolves

  if (joined) return null; // nothing left to pick once in the lobby

  async function resolveCode() {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return;
    setResolving(true);
    setError(null);
    try {
      const { data: session, error: sessionError } = await supabase
        .from('sessions')
        .select('class_id')
        .eq('join_code', trimmed)
        .single();
      if (sessionError || !session) throw new Error('no class found for that code');

      const store = createSupabaseIdentityStore({ classId: session.class_id, supabase });
      const names = await store.listRoster();
      if (names.length === 0) throw new Error('that class has no students on its roster yet');

      localStorage.setItem('skypath.rosterClassId', session.class_id);
      setRoster(names);
      onRosterStoreReady(store);
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      setResolving(false);
    }
  }

  return (
    <section style={{ border: '1px solid #ccc', padding: '0.75rem 1rem', marginBottom: '1rem' }}>
      <h2 style={{ marginTop: 0 }}>Join with a class code</h2>

      {!roster && (
        <p>
          <input
            type="text"
            placeholder="Join code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={resolving}
            style={{ textTransform: 'uppercase' }}
          />{' '}
          <button onClick={resolveCode} disabled={resolving || !code.trim()}>
            {resolving ? 'Looking up…' : 'Find my class'}
          </button>
        </p>
      )}

      {error && <p style={{ color: '#a00' }}>{error}</p>}

      {roster && (
        <>
          <p>Pick your name:</p>
          <p>
            {roster.map((entry) => (
              <button
                key={entry.id}
                onClick={() => onPickName(entry.display_name)}
                style={{ margin: '0 0.4rem 0.4rem 0' }}
              >
                {entry.display_name}
              </button>
            ))}
          </p>
        </>
      )}

      {!roster && (
        <p style={{ color: '#666', fontSize: '0.85rem' }}>No code? Just type a name below to play without a class.</p>
      )}
    </section>
  );
}
