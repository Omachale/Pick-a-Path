/**
 * Teacher screen: sign in, start a session, manage groups, start the game.
 * Deliberately plain — functional parity with the schema in
 * app/supabase/schema.sql, not the real teacher UI.
 *
 * Simplified 2026-09-11, Luke: the old flow was "create a named class, add
 * a roster of student names ahead of time, generate a join code against
 * that class, have each student pick their own name from the roster" — more
 * steps than the classroom actually needs right now. Luke: "let's just have
 * the teacher start a class, and that will generate a code... Once players
 * put in their code they can type their name." So "start a session" is now
 * one button: it creates a throwaway `classes` row behind the scenes (the
 * schema still requires `sessions.class_id`, and changing that is a real
 * migration Luke would have to re-run — not worth it just to lose one FK)
 * and a `sessions` row for the join code, and that's the whole setup. No
 * roster row is ever created; a player's name is never written to Postgres
 * at all any more — see useLobby.js's header comment on why that store swap
 * is gone. That's a real trade-off, not an accident: **scores/equipment no
 * longer persist across days**. Bringing that back is a real design
 * question (how does an ephemeral typed name reconnect to a returning
 * roster row?), better answered when it's actually wanted again rather than
 * half-wired in now.
 *
 * Session state is *this browser's*, kept in localStorage (`skypath.
 * teacherSessionCode`) so a reload doesn't strand a lesson in progress —
 * the underlying `sessions` row and the join code stay valid regardless
 * (already-connected students don't need to rejoin), the teacher's own live
 * view just needs to know which channel to re-observe.
 *
 * The teacher's own device never calls `useLobby`'s `join()` — it observes
 * the session's presence/broadcast channel directly, without ever
 * `.track()`-ing itself into it, so it never shows up as a "participant" of
 * its own class. That sidesteps the bug Luke hit with the previous design:
 * going "back to lobby" from here used to land on the same shared `Lobby`
 * component every student uses, but since the teacher's device had never
 * called `join()`, it had never subscribed to presence at all — the
 * participant list just stayed empty forever. The teacher no longer visits
 * that screen at all now.
 */
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { supabase } from '../supabase.js';
import GroupEditor from './GroupEditor.jsx';
import { loadWordPairs, assignForkWords } from '../skypath/wordPairs.js';

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O — easy to misread on a projector
const SESSION_CODE_STORAGE_KEY = 'skypath.teacherSessionCode';
// Must match Sky Path's own N_FORKS (see app/src/skypath/skyPath.js) and
// useLobby.js's own copy of the same constant — the two modules don't share
// a build-time config yet, same pre-existing gap, not new to this change.
const SKY_PATH_N_FORKS = 6;

function randomJoinCode() {
  let code = '';
  for (let i = 0; i < 5; i++) code += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
  return code;
}

/**
 * `crypto.randomUUID()` — same restriction that broke "Copy link" and the
 * QR/localhost warning before it — only exists in a secure context (https,
 * or http://localhost specifically), and this dashboard is deliberately
 * used over plain http:// on the teacher's own LAN address. Luke, 2026-09-13:
 * pressing "Start game" did nothing at all, for every player — found via the
 * browser console: `Uncaught (in promise) TypeError: crypto.randomUUID is
 * not a function` at the `roundId = crypto.randomUUID()` line, an unhandled
 * rejection in an async click handler with no visible error, so the whole
 * function silently stopped right there before a single broadcast went out.
 * identity/token.js's generateToken() already has this exact fallback for
 * exactly this reason — mirrored here rather than imported, since reusing a
 * "device identity token" generator to mint a *round* id would read
 * confusingly the moment anyone inspects a payload or a log.
 */
function randomRoundId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `round_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
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

/**
 * Renders `url` as a QR code, generated locally (no network round trip to a
 * third-party QR image service — `location.origin` is already the real
 * reachable address for whoever scans this, dev or deployed, and a
 * classroom's wifi shouldn't need to be reliable enough to fetch the code
 * itself). `url` must be the full absolute address — see joinUrl below,
 * which already builds one via `location.origin` rather than a bare path or
 * join code; a relative URL would resolve against whatever page the phone's
 * camera app opens it in, not this app.
 */
function SessionQRCode({ url }) {
  const [dataUrl, setDataUrl] = useState(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(url, { width: 220, margin: 1 }).then((durl) => {
      if (!cancelled) setDataUrl(durl);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!dataUrl) return null;
  return <img src={dataUrl} alt={`QR code for ${url}`} width={220} height={220} />;
}

/**
 * `navigator.clipboard` (the only thing "Copy link" used to call) is
 * restricted to secure contexts — https, or http://localhost specifically —
 * and this dashboard is deliberately opened over plain http:// on the
 * teacher's own LAN address (see the isLocalOnly warning above: that's the
 * whole fix for phones being unable to reach `localhost`). So on exactly the
 * page a teacher is told to use, `navigator.clipboard` is undefined.
 * Luke, 2026-09-13, after that silently did nothing: "when I copied the
 * link there was no ?join in it" — the button's `?.` swallowed the missing
 * API with no error, so the click was a total no-op and whatever was
 * already on the clipboard (the plain address he'd typed to reach this
 * page, no query string) was what actually got pasted elsewhere. Falls back
 * to the old `document.execCommand('copy')` path (deprecated, but doesn't
 * require a secure context) when the modern API isn't there, and always
 * reports back whether it actually worked rather than assuming success —
 * the exact silence that caused this in the first place.
 */
async function copyText(text) {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path below
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

function CopyLinkButton({ text }) {
  const [result, setResult] = useState(null); // null | 'ok' | 'failed'

  async function handleClick() {
    const ok = await copyText(text);
    setResult(ok ? 'ok' : 'failed');
    setTimeout(() => setResult(null), 2500);
  }

  return (
    <>
      <button onClick={handleClick}>Copy link</button>{' '}
      {result === 'ok' && <span style={{ color: '#0a0' }}>Copied!</span>}
      {result === 'failed' && (
        <span style={{ color: '#a00' }}>Couldn't copy — select the link above and copy it manually.</span>
      )}
    </>
  );
}

function groupLabel(groupId) {
  return groupId === null || groupId === undefined ? 'Unassigned' : `Group ${groupId}`;
}

/**
 * Observes one session's live lobby channel (presence + broadcasts) without
 * ever joining it as a participant, and is the sole place that broadcasts
 * `groups-updated` and `game-started` — see the file header for why that's
 * different from how a student's own `useLobby` talks to the same channel.
 */
function SessionPanel({ joinCode, onEndSession }) {
  const [participants, setParticipants] = useState([]);
  const channelRef = useRef(null);
  // Per-group round-robin guide history, kept as plain state here (not
  // derived from replayed broadcasts, the way the old per-student-initiated
  // design needed) — there is exactly one initiator now (this panel), so
  // there's exactly one place that needs to remember whose turn is next.
  const guideHistoryRef = useRef(new Map()); // groupId -> Set<token>
  // Loaded once and reused for every group/round in this session — the same
  // word-pairs.json file every Sky Path instance already reads, fetched
  // here too because this panel is now the one place that decides a
  // round's actual words (see startGame() below).
  const wordPairsRef = useRef(null);
  // Luke, 2026-09-13: "pressing Start game did nothing" — an unhandled
  // rejection (crypto.randomUUID missing in this insecure-context page, see
  // randomRoundId() above) killed this whole async function with zero
  // on-screen sign anything had gone wrong. That particular cause is fixed,
  // but the silence itself was the real problem — any future failure here
  // (a bad word-pairs.json fetch, a dropped connection) deserves the same
  // visible treatment startSession() already gives its own errors below,
  // not another dead button.
  const [startGameError, setStartGameError] = useState(null);

  useEffect(() => {
    const ch = supabase.channel(`lobby-${joinCode}`);
    ch.on('presence', { event: 'sync' }, () => {
      // Same de-dup-by-latest-meta-per-key reasoning as useLobby.js's join()
      // — a reconnecting student can transiently double-up in presence
      // state before the old entry times out.
      const state = ch.presenceState();
      const latestByKey = Object.values(state).map((metas) => metas[metas.length - 1]);
      const seen = new Set();
      const deduped = [];
      for (const p of latestByKey) {
        if (seen.has(p.token)) continue;
        seen.add(p.token);
        deduped.push(p);
      }
      setParticipants(deduped);
    });
    ch.subscribe();
    channelRef.current = ch;
    return () => {
      supabase.removeChannel(ch);
      channelRef.current = null;
    };
  }, [joinCode]);

  function applyGroups(assignments) {
    channelRef.current?.send({ type: 'broadcast', event: 'groups-updated', payload: { assignments } });
  }

  /**
   * Starts (or restarts) the game for every group that has at least one
   * player in it — this is also what "next round" is now: Luke, 2026-09-11,
   * "the teacher will then be the one to start the game," for every round,
   * not just the first. A device reacts to a fresh `game-started` for its
   * group regardless of what phase it was previously in (see useLobby.js),
   * so one button covers both cases.
   *
   * Words are picked HERE, once per group, and broadcast alongside `forks` —
   * Luke, after the first live multiplayer test: "the words the guide sees
   * are different from the words the players in their teams [see]... [and
   * players see] Heat on the left, Hit on the right, while [another player]
   * sees Heat on the right, and Hit on the left." Every device used to call
   * assignForkWords() itself, so each one drew its own random pair AND its
   * own random left/right layout independently — nothing about the actual
   * words was ever shared, only which SIDE was correct (`forks`). This is
   * the fix: one draw per group, sent to everyone in it, same as `forks`
   * already was. Different groups still get independently random words —
   * only a single group's own members need to agree.
   */
  async function startGame() {
    setStartGameError(null);
    try {
      const byGroup = new Map();
      for (const p of participants) {
        if (p.groupId === null || p.groupId === undefined) continue;
        if (!byGroup.has(p.groupId)) byGroup.set(p.groupId, []);
        byGroup.get(p.groupId).push(p);
      }
      if (byGroup.size === 0) return;

      if (!wordPairsRef.current) wordPairsRef.current = await loadWordPairs();
      const wordPairs = wordPairsRef.current;

      const letters = 'LR';
      for (const [groupId, members] of byGroup) {
        if (!guideHistoryRef.current.has(groupId)) guideHistoryRef.current.set(groupId, new Set());
        const guided = guideHistoryRef.current.get(groupId);
        let candidates = members.filter((p) => !guided.has(p.token));
        if (candidates.length === 0) {
          guided.clear();
          candidates = members;
        }
        const guideToken = candidates[Math.floor(Math.random() * candidates.length)].token;
        guided.add(guideToken);

        const forks = Array.from({ length: SKY_PATH_N_FORKS }, () => letters[Math.random() < 0.5 ? 0 : 1]).join('');
        const words = assignForkWords(wordPairs, SKY_PATH_N_FORKS);
        const roundId = randomRoundId();
        channelRef.current?.send({
          type: 'broadcast',
          event: 'game-started',
          payload: { groupId, forks, words, guideToken, roundId },
        });
      }
    } catch (err) {
      setStartGameError(err.message ?? String(err));
    }
  }

  const joinUrl = `${location.origin}${location.pathname}?join=${joinCode}`;
  // The dev server (see vite.config.js's `server: { host: true }`) already
  // binds to the LAN, not just this machine — but that only matters if the
  // teacher's OWN browser is pointed at the LAN address too. `location`
  // reflects whatever's in the address bar right now: opened as
  // `localhost:5181`, `joinUrl` above bakes in "localhost" — a name that
  // only ever resolves to the device it's typed on, so a student's phone
  // trying that exact link is asking its own phone for a page that isn't
  // there, not this computer. Luke hit exactly this live, 2026-09-12: "the
  // code was indeed localhost, and when I tried it on my phone it could not
  // be reached." No code fix makes "localhost" reachable from another
  // device — the actual fix is the teacher opening the dashboard from this
  // machine's own LAN IP address (`ipconfig`/`ifconfig`, the `192.168.x.x`-
  // style address) instead of `localhost` before starting a session, so
  // `joinUrl` bakes in that address instead. This banner can only warn, not
  // fix it from here — by the time this code runs, `location.origin` is
  // already wrong.
  const isLocalOnly = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const groupedCount = participants.filter((p) => p.groupId !== null && p.groupId !== undefined).length;

  return (
    <div style={{ marginTop: '1rem' }}>
      <h2>Session</h2>
      {isLocalOnly && (
        <p style={{ color: '#a00', border: '1px solid #a00', padding: '0.5rem', borderRadius: 4 }}>
          You're viewing this page as <code>localhost</code> — the code and QR below will only work on{' '}
          <em>this</em> computer. For students' phones to reach it, close this tab and reopen the dashboard using
          this computer's own network address instead (something like <code>http://192.168.x.x:5181</code> — find it
          via <code>ipconfig</code> on Windows or <code>ifconfig</code>/<code>ip addr</code> on Mac/Linux), then start
          the session again from there.
        </p>
      )}
      <p>
        Code: <strong style={{ fontSize: '1.6rem', letterSpacing: '0.15em' }}>{joinCode}</strong>
      </p>
      <p>
        Link: <code>{joinUrl}</code>{' '}
        <CopyLinkButton text={joinUrl} />
      </p>
      <SessionQRCode url={joinUrl} />
      <p>
        <button onClick={onEndSession}>End session</button>
      </p>

      <h3>Players ({participants.length})</h3>
      <ul>
        {[...participants]
          .sort((a, b) => a.displayName.localeCompare(b.displayName))
          .map((p) => (
            <li key={p.token}>
              {p.displayName} — {groupLabel(p.groupId)} — score {p.score}
            </li>
          ))}
        {participants.length === 0 && <li style={{ color: '#666' }}>no one has joined yet</li>}
      </ul>

      <GroupEditor participants={participants} onApply={applyGroups} />

      <section style={{ borderTop: '1px solid #ddd', paddingTop: '1rem', marginTop: '1.5rem' }}>
        <h2>Start the game</h2>
        <p>
          <button onClick={startGame} disabled={groupedCount === 0}>
            Start game (all groups)
          </button>
        </p>
        {groupedCount === 0 && <p style={{ color: '#666' }}>Assign at least one player to a group first.</p>}
        {startGameError && <p style={{ color: '#a00' }}>Couldn't start the game: {startGameError}</p>}
      </section>
    </div>
  );
}

export default function TeacherDashboard({ onExit }) {
  const [authSession, setAuthSession] = useState(undefined); // undefined = loading, null = signed out
  const [authError, setAuthError] = useState(null);
  const [joinCode, setJoinCode] = useState(() => localStorage.getItem(SESSION_CODE_STORAGE_KEY));
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setAuthSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setAuthSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  async function startSession() {
    setStarting(true);
    setStartError(null);
    const { data: cls, error: classError } = await supabase
      .from('classes')
      .insert({ name: `Session ${new Date().toLocaleString()}`, teacher_id: authSession.user.id })
      .select()
      .single();
    if (classError) {
      setStartError(classError.message);
      setStarting(false);
      return;
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomJoinCode();
      const { error: sessionError } = await supabase.from('sessions').insert({ class_id: cls.id, join_code: code });
      if (!sessionError) {
        localStorage.setItem(SESSION_CODE_STORAGE_KEY, code);
        setJoinCode(code);
        setStarting(false);
        return;
      }
      if (sessionError.code !== '23505') {
        setStartError(sessionError.message);
        setStarting(false);
        return;
      }
    }
    setStartError('could not generate a unique join code — try again');
    setStarting(false);
  }

  function endSession() {
    localStorage.removeItem(SESSION_CODE_STORAGE_KEY);
    setJoinCode(null);
  }

  return (
    <div className="screen" style={{ padding: '1rem' }}>
      <p>
        <button onClick={onExit}>← Back</button>
      </p>
      <h1>Teacher dashboard</h1>

      {authSession === undefined && <p>Loading…</p>}

      {authSession === null && <AuthForm onError={setAuthError} error={authError} />}

      {authSession && (
        <>
          <p style={{ color: '#666' }}>
            Signed in as {authSession.user.email} <button onClick={() => supabase.auth.signOut()}>Sign out</button>
          </p>

          {joinCode ? (
            <SessionPanel joinCode={joinCode} onEndSession={endSession} />
          ) : (
            <p>
              <button onClick={startSession} disabled={starting}>
                {starting ? 'Starting…' : 'Start a session'}
              </button>
              {startError && <span style={{ color: '#a00' }}> {startError}</span>}
            </p>
          )}
        </>
      )}
    </div>
  );
}
