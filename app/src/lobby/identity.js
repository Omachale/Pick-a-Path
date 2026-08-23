/**
 * Device identity: a module singleton, not React state, because the token
 * and its localStorage-backed record belong to *this browser*, not to any
 * component's lifecycle — the old lobby-prototype had exactly this at module
 * scope (`const token = getOrCreateToken()`) and there's no reason for React
 * to own it differently.
 *
 * `createLocalIdentityStore()` is step 1's implementation (see
 * ../identity/identityStore.js's doc comment) — ephemeral, per-device. Stage
 * B swaps this for the roster-backed store from ../identity/
 * supabaseIdentityStore.js once a real class/session exists to claim a name
 * against; nothing above this file should need to change when that happens.
 */
import { getOrCreateToken, clearToken } from '../identity/token.js';
import { createLocalIdentityStore } from '../identity/identityStore.js';

export const identityStore = createLocalIdentityStore();
export const token = getOrCreateToken();
export { clearToken };
