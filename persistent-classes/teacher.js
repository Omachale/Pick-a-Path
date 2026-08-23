/**
 * Teacher prototype for step 5 (persistent classes): real Supabase Auth
 * account, real `classes`/`roster_entries` rows (see schema.sql). No
 * student accounts — only the teacher signs in; students later pick their
 * name from whatever roster this page builds (see student.js).
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const emailInput = document.getElementById('emailInput');
const passwordInput = document.getElementById('passwordInput');
const signUpBtn = document.getElementById('signUpBtn');
const signInBtn = document.getElementById('signInBtn');
const signOutBtn = document.getElementById('signOutBtn');
const authStatus = document.getElementById('authStatus');
const classesSection = document.getElementById('classesSection');
const classList = document.getElementById('classList');
const newClassName = document.getElementById('newClassName');
const createClassBtn = document.getElementById('createClassBtn');
const rosterSection = document.getElementById('rosterSection');
const currentClassNameEl = document.getElementById('currentClassName');
const joinLinkEl = document.getElementById('joinLink');
const rosterTableBody = document.querySelector('#rosterTable tbody');
const newStudentName = document.getElementById('newStudentName');
const addStudentBtn = document.getElementById('addStudentBtn');

let currentClassId = null;

function showError(err) {
  authStatus.textContent = `error: ${err.message ?? err}`;
  authStatus.classList.add('error');
}

signUpBtn.addEventListener('click', async () => {
  const { data, error } = await supabase.auth.signUp({
    email: emailInput.value.trim(),
    password: passwordInput.value,
  });
  if (error) return showError(error);
  // A session here means the project auto-confirms new sign-ups — the
  // auth-state listener has already rendered the signed-in view in that
  // case, so this message would otherwise overwrite it a moment later.
  if (!data.session) {
    authStatus.textContent = 'signed up — check email for confirmation, then sign in';
    authStatus.classList.remove('error');
  }
});

signInBtn.addEventListener('click', async () => {
  const { error } = await supabase.auth.signInWithPassword({
    email: emailInput.value.trim(),
    password: passwordInput.value,
  });
  if (error) return showError(error);
});

signOutBtn.addEventListener('click', async () => {
  await supabase.auth.signOut();
});

supabase.auth.onAuthStateChange((_event, session) => {
  renderAuthState(session);
});

async function renderAuthState(session) {
  if (session) {
    authStatus.textContent = `signed in as ${session.user.email}`;
    authStatus.classList.remove('error');
    signOutBtn.style.display = '';
    signInBtn.style.display = 'none';
    signUpBtn.style.display = 'none';
    classesSection.style.display = '';
    await loadClasses();
  } else {
    authStatus.textContent = 'not signed in';
    signOutBtn.style.display = 'none';
    signInBtn.style.display = '';
    signUpBtn.style.display = '';
    classesSection.style.display = 'none';
    rosterSection.style.display = 'none';
    currentClassId = null;
  }
}

async function loadClasses() {
  const { data, error } = await supabase.from('classes').select('*').order('created_at');
  if (error) return showError(error);
  classList.innerHTML = '';
  for (const cls of data) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.textContent = cls.name;
    btn.addEventListener('click', () => openClass(cls));
    li.appendChild(btn);
    classList.appendChild(li);
  }
}

createClassBtn.addEventListener('click', async () => {
  const name = newClassName.value.trim();
  if (!name) return;
  const { data: sessionData } = await supabase.auth.getSession();
  const teacherId = sessionData.session.user.id;
  const { data, error } = await supabase
    .from('classes')
    .insert({ name, teacher_id: teacherId })
    .select()
    .single();
  if (error) return showError(error);
  newClassName.value = '';
  await loadClasses();
  openClass(data);
});

async function openClass(cls) {
  currentClassId = cls.id;
  currentClassNameEl.textContent = cls.name;
  joinLinkEl.textContent = `student.html?class=${cls.id}`;
  rosterSection.style.display = '';
  await loadRoster();
}

async function loadRoster() {
  const { data, error } = await supabase
    .from('roster_entries')
    .select('*')
    .eq('class_id', currentClassId)
    .order('display_name');
  if (error) return showError(error);
  rosterTableBody.innerHTML = '';
  for (const entry of data) {
    const row = document.createElement('tr');

    const nameCell = document.createElement('td');
    nameCell.textContent = entry.display_name;
    row.appendChild(nameCell);

    const scoreCell = document.createElement('td');
    scoreCell.textContent = entry.score;
    row.appendChild(scoreCell);

    const equipCell = document.createElement('td');
    equipCell.textContent = entry.equipment.length ? entry.equipment.join(', ') : 'none';
    row.appendChild(equipCell);

    const actionCell = document.createElement('td');
    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      const { error: delErr } = await supabase.from('roster_entries').delete().eq('id', entry.id);
      if (delErr) return showError(delErr);
      await loadRoster();
    });
    actionCell.appendChild(removeBtn);
    row.appendChild(actionCell);

    rosterTableBody.appendChild(row);
  }
}

addStudentBtn.addEventListener('click', async () => {
  const name = newStudentName.value.trim();
  if (!name || !currentClassId) return;
  const { error } = await supabase.from('roster_entries').insert({ class_id: currentClassId, display_name: name });
  if (error) return showError(error);
  newStudentName.value = '';
  await loadRoster();
});

// Restore an existing session on reload, rather than always starting logged out.
const { data: initial } = await supabase.auth.getSession();
renderAuthState(initial.session);
