/**
 * Proves the roster-backed identity store (identity/supabaseIdentityStore.js)
 * actually persists across a simulated "new day": pick a name, earn a
 * point, then "forget this device's claim" (clear the local token +
 * claim-of-that-token, simulating a different day or a different shared
 * classroom device) and pick the same name again — the score should still
 * be there, because it lives in the roster row, not on this device.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { getOrCreateToken, clearToken } from '../identity/token.js';
import { createSupabaseIdentityStore } from '../identity/supabaseIdentityStore.js';

const classId = new URLSearchParams(location.search).get('class');
const classIdDisplay = document.getElementById('classIdDisplay');
const tokenEl = document.getElementById('token');
const nameSelect = document.getElementById('nameSelect');
const joinBtn = document.getElementById('joinBtn');
const statusEl = document.getElementById('status');
const participantSection = document.getElementById('participantSection');
const participantEl = document.getElementById('participant');
const addPointBtn = document.getElementById('addPointBtn');
const simulateNewDayBtn = document.getElementById('simulateNewDayBtn');

classIdDisplay.textContent = classId ?? '(none — pass ?class=<id> in the URL)';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const token = getOrCreateToken();
tokenEl.textContent = token;

let store = null;
let participant = null;

function renderParticipant() {
  participantEl.textContent = `${participant.displayName} — score ${participant.score} — equipment: ${
    participant.equipment.length ? participant.equipment.join(', ') : 'none'
  }`;
}

function showError(err) {
  statusEl.textContent = `error: ${err.message ?? err}`;
  statusEl.classList.add('error');
}

async function init() {
  if (!classId) {
    statusEl.textContent = 'no class id in URL — nothing to join';
    return;
  }
  store = createSupabaseIdentityStore({ classId, supabase });

  try {
    const roster = await store.listRoster();
    nameSelect.innerHTML = '';
    if (roster.length === 0) {
      nameSelect.innerHTML = '<option value="">(roster is empty — add students in teacher.html)</option>';
      return;
    }
    for (const entry of roster) {
      const option = document.createElement('option');
      option.value = entry.display_name;
      option.textContent = entry.display_name;
      nameSelect.appendChild(option);
    }

    // Already claimed on this device? Skip straight to the participant view
    // — this is what a same-device reconnect mid-lesson looks like.
    const existing = await store.getParticipant(token);
    if (existing) {
      participant = existing;
      participantSection.style.display = '';
      renderParticipant();
      statusEl.textContent = `already joined as ${participant.displayName} on this device`;
    }
  } catch (err) {
    showError(err);
  }
}

joinBtn.addEventListener('click', async () => {
  const name = nameSelect.value;
  if (!name || !store) return;
  try {
    participant = await store.claimByName(token, name);
    participantSection.style.display = '';
    statusEl.textContent = '';
    statusEl.classList.remove('error');
    renderParticipant();
  } catch (err) {
    showError(err);
  }
});

addPointBtn.addEventListener('click', async () => {
  if (!store || !participant) return;
  try {
    participant = await store.addScore(token, 1);
    renderParticipant();
  } catch (err) {
    showError(err);
  }
});

simulateNewDayBtn.addEventListener('click', () => {
  clearToken(); // this device forgets who it was — a new token means a fresh claim next time
  location.reload();
});

init();
