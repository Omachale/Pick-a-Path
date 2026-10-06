/**
 * Join-code entry, layered above Lobby's existing free-text name box rather
 * than replacing it — a device with no code (or a teacher who hasn't
 * started a session yet) can still play exactly as before.
 *
 * Simplified 2026-09-11, Luke: no more pre-built roster to pick a name
 * from — a code just proves a session exists (a session's own `class_id`
 * is a throwaway row TeacherDashboard.jsx creates behind the scenes; there
 * is no roster left to fetch), and the player types whatever name they
 * like into the box that was already there. `?join=CODE` in the URL
 * resolves automatically, so the full link the teacher shows on screen is
 * enough on its own — nothing left to also retype by hand.
 */
import { useEffect, useState } from 'react';
import { supabase } from '../supabase.js';
import { TEACHER_SIGN_IN } from './sessionConfig.js';

export default function JoinByCode({ onCodeResolved, joined }) {
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get('join') ?? '');
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState(null);
  const [resolvedCode, setResolvedCode] = useState(null);

  async function resolveCode(raw) {
    const trimmed = raw.trim().toUpperCase();
    if (!trimmed) return;
    setResolving(true);
    setError(null);
    // With teacher sign-in off (sessionConfig.js), games aren't recorded in
    // the `sessions` table at all, so there's nothing to look a code up in:
    // any well-formed code is accepted as it is. The lookup below is kept
    // for when sign-in comes back.
    if (!TEACHER_SIGN_IN) {
      if (/^[A-Z]{5}$/.test(trimmed)) {
        setResolvedCode(trimmed);
        onCodeResolved(trimmed);
      } else setError('That code should be 5 letters.');
      setResolving(false);
      return;
    }
    try {
      const { data: session, error: sessionError } = await supabase
        .from('sessions')
        .select('join_code')
        .eq('join_code', trimmed)
        .single();
      if (sessionError || !session) throw new Error('no session found for that code');
      setResolvedCode(trimmed);
      onCodeResolved(trimmed);
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      setResolving(false);
    }
  }

  // A `?join=CODE` link resolves itself on load — the whole point of
  // showing the full URL on the teacher's screen rather than just the code.
  useEffect(() => {
    const fromUrl = new URLSearchParams(location.search).get('join');
    if (fromUrl) resolveCode(fromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (joined) return null; // nothing left to pick once in the lobby

  return (
    <section style={{ border: '1px solid #ccc', padding: '0.75rem 1rem', marginBottom: '1rem' }}>
      <h2 style={{ marginTop: 0 }}>Join with a session code</h2>

      {resolvedCode ? (
        <p style={{ color: '#0a0' }}>
          Found session <strong>{resolvedCode}</strong> — type your name below.
        </p>
      ) : (
        <p>
          <input
            type="text"
            placeholder="Session code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={resolving}
            style={{ textTransform: 'uppercase' }}
          />{' '}
          <button onClick={() => resolveCode(code)} disabled={resolving || !code.trim()}>
            {resolving ? 'Looking up…' : 'Find session'}
          </button>
        </p>
      )}

      {error && <p style={{ color: '#a00' }}>{error}</p>}

      {!resolvedCode && (
        <p style={{ color: '#666', fontSize: '0.85rem' }}>No code? Just type a name below to play without a session.</p>
      )}
    </section>
  );
}
