/**
 * Plain-node contract tests for the identity module — no browser, no test
 * framework, just assert() and a fake localStorage, matching this project's
 * existing preference for deterministic harnesses over relying on a live
 * preview. Run with: node identity/identityStore.test.mjs
 */
import assert from 'node:assert';
import { generateToken, getOrCreateToken, clearToken } from './token.js';
import { createLocalIdentityStore } from './identityStore.js';

function fakeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
}

// --- token persistence -------------------------------------------------

{
  const storage = fakeLocalStorage();
  const first = getOrCreateToken(storage);
  const second = getOrCreateToken(storage);
  assert.strictEqual(first, second, 'token must survive a simulated reload');
}

{
  const a = generateToken();
  const b = generateToken();
  assert.notStrictEqual(a, b, 'two generated tokens must not collide');
}

{
  const storage = fakeLocalStorage();
  const before = getOrCreateToken(storage);
  clearToken(storage);
  const after = getOrCreateToken(storage);
  assert.notStrictEqual(before, after, 'clearToken must force a fresh identity');
}

// --- identity store contract --------------------------------------------

{
  const storage = fakeLocalStorage();
  const store = createLocalIdentityStore(storage);
  const token = getOrCreateToken(storage);

  const fresh = store.getParticipant(token);
  assert.deepStrictEqual(
    fresh,
    { token, displayName: null, groupId: null, score: 0, equipment: [] },
    'a never-seen token must yield defaults, not throw'
  );

  store.setDisplayName(token, 'Aroha');
  store.setGroup(token, 'group-3');
  store.addScore(token, 10);
  store.addScore(token, 5);
  store.addEquipment(token, 'golden-quill');
  store.addEquipment(token, 'golden-quill'); // duplicate add must not double up

  const after = store.getParticipant(token);
  assert.deepStrictEqual(after, {
    token,
    displayName: 'Aroha',
    groupId: 'group-3',
    score: 15,
    equipment: ['golden-quill'],
  });
}

{
  // Two tokens in the same store must not see each other's state — this is
  // the exact scenario of two "devices" (browser tabs) sharing one origin.
  const storage = fakeLocalStorage();
  const store = createLocalIdentityStore(storage);
  const tokenA = generateToken();
  const tokenB = generateToken();

  store.addScore(tokenA, 100);
  store.addScore(tokenB, 1);

  assert.strictEqual(store.getParticipant(tokenA).score, 100);
  assert.strictEqual(store.getParticipant(tokenB).score, 1);
}

console.log('identity: all checks passed');
