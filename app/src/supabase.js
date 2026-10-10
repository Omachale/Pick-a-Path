/**
 * The single Supabase client for the whole app.
 *
 * The prototypes each called `createClient` themselves (relay-smoke-test,
 * lobby-prototype, persistent-classes, and prototype-threejs/multiplayer.js
 * — four clients, four copies of the credentials, and in the multiplayer
 * case a second client in a second browser tab for what was logically one
 * participant). One client here means one auth session, one websocket, and
 * one place to change when the project moves.
 */
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy app/.env.example to app/.env.local and fill it in.',
  );
}

// `worker`: the realtime connection's keep-alive runs in a Web Worker (an
// inline one, realtime-js's own), so it carries on in a hidden window. Seen in
// the test monitor, 2026-10-10: the teacher's board, minimised or covered on
// the PC, had its timers cut to once a minute after five minutes — too
// seldom for the keep-alive, and the connection would be dropped.
export const supabase = createClient(url, anonKey, { realtime: { worker: true } });
