/**
 * Roster-backed identity store — step 5's implementation of the interface
 * documented in identityStore.js. Score, equipment and display name live in
 * a Supabase `roster_entries` row (see persistent-classes/schema.sql)
 * instead of localStorage, so they survive across devices and days. Group
 * assignment stays purely local/session-scoped — grouping is a lobby-layer
 * concept (see the handoff doc) unrelated to the persistent roster, so it's
 * never written to the roster row.
 *
 * Unlike createLocalIdentityStore, a token here isn't bound to a
 * participant by itself — it has to be *claimed* against a roster row by
 * name first (claimByName), because the whole point is that persistence is
 * keyed by student name, not by device: the same student picking their name
 * again next lesson, quite possibly on a different shared classroom device,
 * should resume the same score. The claim itself (which roster row this
 * token currently represents) is stored locally per class+token, since it's
 * just "which row am I this session," not persistent state in its own
 * right — the score/equipment truth lives entirely in the roster row.
 *
 * Every method here is async, because it's a network call — this is safe to
 * mix with the sync createLocalIdentityStore from a caller's point of view
 * as long as the caller awaits both consistently (`await` on a plain
 * already-resolved value just resolves it next microtask).
 */

const CLAIM_KEY_PREFIX = 'skypath.rosterClaim.';

function claimKey(classId, token) {
  return `${CLAIM_KEY_PREFIX}${classId}.${token}`;
}

function toParticipant(token, groupId, row) {
  return {
    token,
    displayName: row.display_name,
    groupId,
    score: row.score,
    equipment: row.equipment,
  };
}

export function createSupabaseIdentityStore({ classId, supabase, storage = globalThis.localStorage }) {
  const localGroup = new Map(); // token -> groupId, session-only, never sent to the DB

  function getClaimedRowId(token) {
    return storage.getItem(claimKey(classId, token));
  }

  function setClaimedRowId(token, rosterEntryId) {
    storage.setItem(claimKey(classId, token), rosterEntryId);
  }

  async function fetchRow(rosterEntryId) {
    const { data, error } = await supabase
      .from('roster_entries')
      .select('*')
      .eq('id', rosterEntryId)
      .single();
    if (error) throw error;
    return data;
  }

  return {
    /** Every roster entry in this class, for a name-picker UI. */
    async listRoster() {
      const { data, error } = await supabase
        .from('roster_entries')
        .select('id, display_name')
        .eq('class_id', classId)
        .order('display_name');
      if (error) throw error;
      return data;
    },

    /**
     * Binds this token to an existing roster row by name. Only the teacher
     * can create roster rows (see schema.sql's RLS — anon has no insert
     * policy), so a name not already on the roster fails here rather than
     * silently creating one; the caller should fall back to the ephemeral
     * local identity store for a student who isn't on the roster.
     */
    async claimByName(token, displayName) {
      const { data, error } = await supabase
        .from('roster_entries')
        .select('*')
        .eq('class_id', classId)
        .eq('display_name', displayName)
        .single();
      if (error) throw error;
      setClaimedRowId(token, data.id);
      return toParticipant(token, localGroup.get(token) ?? null, data);
    },

    /**
     * Alias so this store satisfies the same `setDisplayName(token, name)`
     * every other store gets called with from useLobby.join() — here "the
     * name typed in" means "the roster name claimed," per identityStore.js's
     * own doc comment ("same method, different validation, callers don't
     * need to know"). Throws if `displayName` isn't an existing roster
     * entry, same as claimByName.
     */
    setDisplayName(token, displayName) {
      return this.claimByName(token, displayName);
    },

    async getParticipant(token) {
      const rowId = getClaimedRowId(token);
      if (!rowId) return null; // caller must claimByName() before this means anything
      const row = await fetchRow(rowId);
      return toParticipant(token, localGroup.get(token) ?? null, row);
    },

    setGroup(token, groupId) {
      localGroup.set(token, groupId);
      return this.getParticipant(token);
    },

    async addScore(token, delta) {
      const rowId = getClaimedRowId(token);
      if (!rowId) throw new Error('addScore called before claimByName');
      const row = await fetchRow(rowId);
      const { data, error } = await supabase
        .from('roster_entries')
        .update({ score: row.score + delta })
        .eq('id', rowId)
        .select()
        .single();
      if (error) throw error;
      return toParticipant(token, localGroup.get(token) ?? null, data);
    },

    async addEquipment(token, item) {
      const rowId = getClaimedRowId(token);
      if (!rowId) throw new Error('addEquipment called before claimByName');
      const row = await fetchRow(rowId);
      const equipment = row.equipment.includes(item) ? row.equipment : [...row.equipment, item];
      const { data, error } = await supabase
        .from('roster_entries')
        .update({ equipment })
        .eq('id', rowId)
        .select()
        .single();
      if (error) throw error;
      return toParticipant(token, localGroup.get(token) ?? null, data);
    },
  };
}
