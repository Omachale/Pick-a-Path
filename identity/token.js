/**
 * Device-local identity token.
 *
 * This token is the one thing the handoff doc flags as awkward to retrofit:
 * every participant, group membership, score and (later) roster row hangs
 * off it, so it has to be stable across reconnects from day one. It is
 * intentionally opaque — a random ID, not a name — so it works the same way
 * whether the identity behind it is scored locally now (LocalIdentityStore)
 * or against a Supabase roster row later (see identityStore.js).
 */

const STORAGE_KEY = 'skypath.identityToken';

/** Generates a fresh opaque token. Not meant to be human-readable or guessable. */
export function generateToken() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Fallback for environments without crypto.randomUUID (older WebViews).
  return `tok_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

/**
 * Returns this device's token, creating and persisting one on first use.
 * `storage` defaults to localStorage but is injectable so this is testable
 * without a browser (see identityStore.test.mjs).
 */
export function getOrCreateToken(storage = globalThis.localStorage) {
  const existing = storage.getItem(STORAGE_KEY);
  if (existing) return existing;
  const token = generateToken();
  storage.setItem(STORAGE_KEY, token);
  return token;
}

/** Wipes the stored token — a device will get a fresh identity next time. Used for testing and for an explicit "not you" / sign-out flow later, not called in normal operation. */
export function clearToken(storage = globalThis.localStorage) {
  storage.removeItem(STORAGE_KEY);
}
