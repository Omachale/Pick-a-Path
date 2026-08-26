/**
 * Minimal teacher screen for Stage B: sign in, create a class, curate its
 * roster, and open a session (join code) against it. Deliberately plain —
 * functional parity with the schema in app/supabase/schema.sql, not the
 * real teacher UI. A teacher is a real Supabase Auth account; RLS in that
 * schema file is what actually restricts a teacher to their own classes,
 * so queries here don't bother re-filtering by teacher_id themselves.
 */
import { useEffect, useState } from 'react';
import { supabase } from '../supabase.js';

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O — easy to misread on a projector

function randomJoinCode() {
  let code = '';
  for (let i = 0; i < 5; i++) code += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
  return code;
}

function AuthForm({ onError, error }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(fn) {
    setBusy(true);
    onError(null);
    const { error: err } = await fn();
    setBusy(false);
    if (err) onError(err.message);
  }

  return (
    <div>
      <h2>Teacher sign in</h2>
      <p>
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />{' '}
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </p>
      <p>
        <button disabled={busy || !email || !password} onClick={() => run(() => supabase.auth.signInWithPassword({ email, password }))}>
          Sign in
        </button>{' '}
        <button disabled={busy || !email || !password} onClick={() => run(() => supabase.auth.signUp({ email, password }))}>
          Sign up (new teacher account)
        </button>
      </p>
      {error && <p style={{ color: '#a00' }}>{error}</p>}
    </div>
  );
}

function Roster({ classId }) {
  const [entries, setEntries] = useState([]);
  const [namesText, setNamesText] = useState('');
  const [sessions, setSessions] = useState([]);
  const [error, setError] = useState(null);

  async function refresh() {
    const [{ data: roster }, { data: sess }] = await Promise.all([
      supabase.from('roster_entries').select('*').eq('class_id', classId).order('display_name'),
      supabase.from('sessions').select('*').eq('class_id', classId).order('created_at', { ascending: false }),
    ]);
    setEntries(roster ?? []);
    setSessions(sess ?? []);
  }

  useEffect(() => {
    refresh();
  }, [classId]);

  async function addNames() {
    const names = namesText
      .split('\n')
      .map((n) => n.trim())
      .filter(Boolean);
    if (names.length === 0) return;
    const { error: err } = await supabase
      .from('roster_entries')
      .insert(names.map((display_name) => ({ class_id: classId, display_name })));
    if (err) {
      setError(err.message);
      return;
    }
    setNamesText('');
    setError(null);
    refresh();
  }

  async function removeEntry(id) {
    await supabase.from('roster_entries').delete().eq('id', id);
    refresh();
  }

  async function newSession() {
    // Retry on the rare join_code collision (5 letters from a 24-letter
    // alphabet is ~7.9M combinations, but the unique constraint is what
    // actually guarantees correctness, not the odds).
    for (let attempt = 0; attempt < 5; attempt++) {
      const join_code = randomJoinCode();
      const { error: err } = await supabase.from('sessions').insert({ class_id: classId, join_code });
      if (!err) {
        refresh();
        return;
      }
      if (err.code !== '23505') {
        setError(err.message);
        return;
      }
    }
    setError('could not generate a unique join code — try again');
  }

  return (
    <div style={{ marginTop: '1rem' }}>
      <h3>Roster</h3>
      <ul>
        {entries.map((e) => (
          <li key={e.id}>
            {e.display_name} — score {e.score}{' '}
            <button onClick={() => removeEntry(e.id)}>remove</button>
          </li>
        ))}
        {entries.length === 0 && <li style={{ color: '#666' }}>no students yet</li>}
      </ul>
      <p>
        <textarea
          placeholder="One name per line"
          value={namesText}
          onChange={(e) => setNamesText(e.target.value)}
          rows={4}
          style={{ width: '100%', maxWidth: '20rem' }}
        />
      </p>
      <p>
        <button onClick={addNames} disabled={!namesText.trim()}>
          Add names
        </button>
      </p>

      <h3>Sessions (join codes)</h3>
      <ul>
        {sessions.map((s) => (
          <li key={s.id}>
            <strong style={{ fontSize: '1.2rem', letterSpacing: '0.1em' }}>{s.join_code}</strong>{' '}
            <span style={{ color: '#666' }}>{new Date(s.created_at).toLocaleString()}</span>
          </li>
        ))}
      </ul>
      <p>
        <button onClick={newSession}>New session (generate join code)</button>
      </p>

      {error && <p style={{ color: '#a00' }}>{error}</p>}
    </div>
  );
}

export default function TeacherDashboard({ onExit }) {
  const [session, setSession] = useState(undefined); // undefined = loading, null = signed out
  const [authError, setAuthError] = useState(null);
  const [classes, setClasses] = useState([]);
  const [newClassName, setNewClassName] = useState('');
  const [selectedClassId, setSelectedClassId] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    supabase
      .from('classes')
      .select('*')
      .order('created_at')
      .then(({ data }) => setClasses(data ?? []));
  }, [session]);

  async function createClass() {
    const name = newClassName.trim();
    if (!name) return;
    const { data, error } = await supabase
      .from('classes')
      .insert({ name, teacher_id: session.user.id })
      .select()
      .single();
    if (error) {
      setAuthError(error.message);
      return;
    }
    setClasses((prev) => [...prev, data]);
    setNewClassName('');
  }

  return (
    <div className="screen" style={{ padding: '1rem' }}>
      <p>
        <button onClick={onExit}>← Back to lobby</button>
      </p>
      <h1>Teacher dashboard</h1>

      {session === undefined && <p>Loading…</p>}

      {session === null && <AuthForm onError={setAuthError} error={authError} />}

      {session && (
        <>
          <p style={{ color: '#666' }}>
            Signed in as {session.user.email} <button onClick={() => supabase.auth.signOut()}>Sign out</button>
          </p>

          <h2>Your classes</h2>
          <ul>
            {classes.map((c) => (
              <li key={c.id}>
                <button onClick={() => setSelectedClassId(c.id)} style={{ fontWeight: c.id === selectedClassId ? 'bold' : 'normal' }}>
                  {c.name}
                </button>
              </li>
            ))}
          </ul>
          <p>
            <input
              type="text"
              placeholder="New class name"
              value={newClassName}
              onChange={(e) => setNewClassName(e.target.value)}
            />{' '}
            <button onClick={createClass} disabled={!newClassName.trim()}>
              Create class
            </button>
          </p>

          {selectedClassId && <Roster classId={selectedClassId} />}
        </>
      )}
    </div>
  );
}
