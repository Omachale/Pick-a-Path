/**
 * Lobby prototype: proves the session/participant data model survives the
 * Supabase relay (see relay-smoke-test), and now that grouping — the
 * handoff doc's "lobby-layer concept that produces rooms" — can be layered
 * on top without changing that model. Each device tracks its own
 * identity-store record in a Supabase Presence channel; every device sees
 * the full participant list update live. Presence key = identity token, so
 * a reload/reconnect from the same device replaces its old entry rather
 * than duplicating it.
 *
 * Grouping here: any connected device can open "Group management" and
 * assign group numbers, either by clicking "Randomise" (shuffles current
 * participants into equal-ish chunks) or by typing numbers directly into
 * the table (manual) — both end up as the same {token: groupNumber} shape,
 * matching the handoff's "manual and random produce the same data shape."
 * "Apply groups" broadcasts that shape to everyone; each device applies
 * only the row matching its own token, writes it to its own identity
 * record, and re-tracks presence so the change shows up for everyone.
 * There's no separate teacher role/auth yet — anyone with the page open can
 * trigger grouping, which is fine for proving the mechanism but is not how
 * the real app will gate this (only a teacher-role client will show these
 * controls).
 *
 * Rooms (trivial game-mode pipe test): once a device's own groupId is
 * known, it auto-joins a *separate* Supabase channel named `room-<groupId>`
 * — a different channel/topic per group, which is what actually gives two
 * groups' rooms independence: a device subscribed to room-1 never receives
 * anything sent on room-2, with no server-side logic needed to enforce
 * that, matching the handoff's "several rooms run concurrently and
 * independently." The trivial "game mode" here is just a text box that
 * broadcasts a message into your own room's channel — proving the full
 * session (lobby-room presence) -> group (groupId) -> room (room-<id>
 * channel) -> game-mode (push-a-message) pipe before any real game mode
 * (Sky Path) is wired to it.
 *
 * Starting Sky Path (step 4 — the real game-mode wiring): "Start Sky Path"
 * generates the shared `forks=LLLRRR` sequence every device's copy of the
 * game needs to build an identical maze, picks one of the room's own
 * participants as guide, and broadcasts both on this same room channel —
 * the literal continuation of the trivial "push a message" pipe test, now
 * carrying a real game-mode payload instead of free text. Every device in
 * the room computes its own role by comparing its own token to the
 * broadcast guide token (no extra round trip needed — everyone already has
 * everyone else's token from presence) and gets a link into
 * prototype-threejs/index.html carrying `?forks=&role=&room=`. Sky Path
 * itself (see prototype-threejs/src/multiplayer.js) then joins this exact
 * room channel independently to keep the guide's fork choices in sync with
 * every player's client for the rest of the game.
 *
 * UI here is deliberately minimal — this is a proof of the sync mechanism,
 * not the lobby screen itself, which will be a proper React UI later.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { getOrCreateToken, clearToken } from '../identity/token.js';
import { createLocalIdentityStore } from '../identity/identityStore.js';

const identityStore = createLocalIdentityStore();
const token = getOrCreateToken();
let participant = identityStore.getParticipant(token);

const tokenEl = document.getElementById('token');
const nameInput = document.getElementById('nameInput');
const joinBtn = document.getElementById('joinBtn');
const addPointBtn = document.getElementById('addPointBtn');
const resetBtn = document.getElementById('resetBtn');
const statusEl = document.getElementById('status');
const listEl = document.getElementById('participantList');
const yourGroupEl = document.getElementById('yourGroup');
const groupSizeInput = document.getElementById('groupSizeInput');
const randomiseBtn = document.getElementById('randomiseBtn');
const applyGroupsBtn = document.getElementById('applyGroupsBtn');
const groupTableBody = document.querySelector('#groupTable tbody');
const roomStatusEl = document.getElementById('roomStatus');
const roomMessageInput = document.getElementById('roomMessageInput');
const sendRoomMessageBtn = document.getElementById('sendRoomMessageBtn');
const roomLogEl = document.getElementById('roomLog');
const startSkyPathBtn = document.getElementById('startSkyPathBtn');
const gameLinkEl = document.getElementById('gameLink');

// Must match Sky Path's own N_FORKS (prototype-threejs/src/main.js) — the
// two apps are separate static pages with no shared build config, so this
// has to be kept in sync by hand. Worth a shared constant once there's a
// real build step joining the two; not worth one for this prototype.
const SKY_PATH_N_FORKS = 6;

// Sky Path needs Vite's dev server (bare-specifier imports like 'three'
// only resolve through it, not from a plain static file server), so this
// points at that dev server directly rather than a relative path — a real
// single-deploy build would just use a relative link instead.
const SKY_PATH_BASE_URL = 'http://localhost:5180/index.html';

tokenEl.textContent = token;
nameInput.value = participant.displayName || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let channel = null;
let latestPresenceEntries = []; // refreshed on every presence sync; feeds the group-editor table

let roomChannel = null;
let roomGroupId = null; // which group's room `roomChannel` is currently subscribed to

function currentTrackPayload() {
  return {
    token,
    displayName: participant.displayName,
    score: participant.score,
    equipment: participant.equipment,
    groupId: participant.groupId,
  };
}

function groupLabel(groupId) {
  return groupId === null || groupId === undefined ? 'Unassigned' : `Group ${groupId}`;
}

function renderParticipants(presenceState) {
  latestPresenceEntries = Object.values(presenceState).flat();

  // Group by groupId so the list already reads like the rooms it will
  // become, not just a flat roster.
  const byGroup = new Map();
  for (const p of latestPresenceEntries) {
    const key = p.groupId ?? null;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(p);
  }
  const orderedKeys = [...byGroup.keys()].sort((a, b) => {
    if (a === null) return 1; // unassigned last
    if (b === null) return -1;
    return a - b;
  });

  listEl.innerHTML = '';
  for (const key of orderedKeys) {
    const groupLi = document.createElement('li');
    groupLi.textContent = groupLabel(key);
    const sub = document.createElement('ul');
    for (const p of byGroup.get(key).sort((a, b) => a.displayName.localeCompare(b.displayName))) {
      const li = document.createElement('li');
      const you = p.token === token ? ' (you)' : '';
      const equipment = p.equipment.length ? p.equipment.join(', ') : 'none';
      li.textContent = `${p.displayName}${you} — score ${p.score} — equipment: ${equipment}`;
      sub.appendChild(li);
    }
    groupLi.appendChild(sub);
    listEl.appendChild(groupLi);
  }

  renderGroupEditorTable();

  const mine = latestPresenceEntries.find((p) => p.token === token);
  yourGroupEl.textContent = mine ? groupLabel(mine.groupId ?? null) : '—';
  ensureRoomChannel(mine?.groupId ?? null);
}

/**
 * Joins (or re-joins, on a group change) the Realtime channel for this
 * device's own group room. `groupId` of null/undefined means "not grouped
 * yet" — no room to join. Switching groups tears down the old room channel
 * first so a device never keeps hearing a room it's no longer part of.
 */
function ensureRoomChannel(groupId) {
  const normalized = groupId ?? null;
  if (normalized === roomGroupId) return; // already in the right room (or still ungrouped)

  if (roomChannel) {
    supabase.removeChannel(roomChannel);
    roomChannel = null;
  }
  roomGroupId = normalized;

  if (normalized === null) {
    roomStatusEl.textContent = 'not in a room (unassigned)';
    sendRoomMessageBtn.disabled = true;
    return;
  }

  roomStatusEl.textContent = `joining room-${normalized}…`;
  gameLinkEl.innerHTML = ''; // a game link from a previous room no longer applies
  roomChannel = supabase.channel(`room-${normalized}`);
  roomChannel
    .on('broadcast', { event: 'game-message' }, ({ payload }) => {
      appendRoomLog(`${payload.from}: ${payload.text}`);
    })
    .on('broadcast', { event: 'game-started' }, ({ payload }) => {
      applyGameStarted(payload);
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        roomStatusEl.textContent = `in room-${normalized}`;
        sendRoomMessageBtn.disabled = false;
        startSkyPathBtn.disabled = false;
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        roomStatusEl.textContent = `room connection problem: ${status}`;
      }
    });
}

function applyGameStarted({ forks, guideToken }) {
  const myRole = guideToken === token ? 'guide' : 'player';
  const url = `${SKY_PATH_BASE_URL}?forks=${forks}&role=${myRole}&room=${roomGroupId}`;
  gameLinkEl.innerHTML = '';
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.textContent = `Open Sky Path (${myRole})`;
  gameLinkEl.appendChild(link);
}

function appendRoomLog(text) {
  const li = document.createElement('li');
  li.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  roomLogEl.appendChild(li);
}

function renderGroupEditorTable() {
  groupTableBody.innerHTML = '';
  for (const p of [...latestPresenceEntries].sort((a, b) => a.displayName.localeCompare(b.displayName))) {
    const row = document.createElement('tr');

    const nameCell = document.createElement('td');
    nameCell.textContent = p.displayName;
    row.appendChild(nameCell);

    const groupCell = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.style.width = '4rem';
    input.dataset.token = p.token;
    if (p.groupId !== null && p.groupId !== undefined) input.value = p.groupId;
    groupCell.appendChild(input);
    row.appendChild(groupCell);

    groupTableBody.appendChild(row);
  }
}

function applyGroupAssignment(assignments) {
  if (!(token in assignments)) return; // this device wasn't part of the assignment
  participant = identityStore.setGroup(token, assignments[token]);
  if (channel) channel.track(currentTrackPayload());
}

joinBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) return;
  participant = identityStore.setDisplayName(token, name);

  if (channel) return; // already joined this session

  channel = supabase.channel('lobby-room', { config: { presence: { key: token } } });

  channel
    .on('presence', { event: 'sync' }, () => {
      renderParticipants(channel.presenceState());
    })
    .on('broadcast', { event: 'groups-updated' }, ({ payload }) => {
      applyGroupAssignment(payload.assignments);
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        statusEl.textContent = 'connected — you are in the lobby';
        await channel.track(currentTrackPayload());
        joinBtn.disabled = true;
        nameInput.disabled = true;
        addPointBtn.disabled = false;
        randomiseBtn.disabled = false;
        applyGroupsBtn.disabled = false;
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        statusEl.textContent = `connection problem: ${status}`;
      }
    });
});

addPointBtn.addEventListener('click', async () => {
  participant = identityStore.addScore(token, 1);
  if (channel) await channel.track(currentTrackPayload());
});

randomiseBtn.addEventListener('click', () => {
  const size = Math.max(1, parseInt(groupSizeInput.value, 10) || 4);
  const shuffled = [...latestPresenceEntries].sort(() => Math.random() - 0.5);
  const assignments = {};
  shuffled.forEach((p, i) => {
    assignments[p.token] = Math.floor(i / size) + 1; // 1-based group numbers
  });
  // Fill the editable table with the proposed assignment without
  // broadcasting yet — "Apply groups" is the one action that actually
  // sends it, whether the numbers came from this button or manual typing.
  for (const input of groupTableBody.querySelectorAll('input[data-token]')) {
    input.value = assignments[input.dataset.token] ?? '';
  }
});

applyGroupsBtn.addEventListener('click', () => {
  const assignments = {};
  for (const input of groupTableBody.querySelectorAll('input[data-token]')) {
    const value = input.value.trim();
    assignments[input.dataset.token] = value === '' ? null : parseInt(value, 10);
  }
  channel?.send({ type: 'broadcast', event: 'groups-updated', payload: { assignments } });
  applyGroupAssignment(assignments); // apply locally too — broadcasts don't echo to the sender
});

startSkyPathBtn.addEventListener('click', () => {
  if (!roomChannel || roomGroupId === null) return;
  const myGroupMembers = latestPresenceEntries.filter((p) => p.groupId === roomGroupId);
  if (myGroupMembers.length === 0) return;

  const letters = 'LR';
  const forks = Array.from({ length: SKY_PATH_N_FORKS }, () => letters[Math.random() < 0.5 ? 0 : 1]).join('');
  const guideToken = myGroupMembers[Math.floor(Math.random() * myGroupMembers.length)].token;

  roomChannel.send({ type: 'broadcast', event: 'game-started', payload: { forks, guideToken } });
  applyGameStarted({ forks, guideToken }); // broadcasts don't echo to the sender
});

sendRoomMessageBtn.addEventListener('click', () => {
  const text = roomMessageInput.value.trim();
  if (!text || !roomChannel) return;
  roomChannel.send({
    type: 'broadcast',
    event: 'game-message',
    payload: { from: participant.displayName, text },
  });
  appendRoomLog(`${participant.displayName} (you): ${text}`); // broadcasts don't echo to the sender
  roomMessageInput.value = '';
});

resetBtn.addEventListener('click', () => {
  clearToken();
  location.reload();
});
