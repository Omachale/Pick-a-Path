-- Sky Path: persistent classes + session join codes (Stage B).
-- Run this in the Supabase dashboard's SQL Editor for this project. Safe to
-- re-run: every statement is idempotent, so pasting the whole file again
-- after editing it converges the database on whatever the file now says.
--
-- Why the `drop policy if exists` before each `create policy`: Postgres has
-- no `create policy if not exists`, and the SQL Editor runs a snippet as a
-- single transaction — so one "already exists" collision rolls back the
-- entire run, including the tables created above it. Drop-then-create keeps
-- a re-run from tripping over its own previous run.
--
-- Model, per ESL-classroom-game-HANDOFF.md's "Persistent classes, scores &
-- equipment" section: a teacher (a real Supabase Auth account) owns
-- classes; each class has a roster of student names the teacher curates
-- ahead of time. Score and equipment accumulate against the roster row,
-- keyed by name — not by device — so a student picking their name again on
-- a later day (possibly on a different shared classroom device) resumes
-- the same character.
--
-- `sessions` is new for Stage B: one per lesson, holds the join code
-- students actually type in. It's a thin pointer to a class — the roster
-- and its scores live on the class permanently; a session is just "today's
-- door into that class's roster," and a teacher can run many sessions
-- against the same class over the term.
--
-- Deliberately NOT in scope here: students creating their own roster
-- entries (only the teacher adds names — a late joiner not on the roster
-- falls back to the existing ephemeral local identity store instead), and
-- session expiry/ended_at (add when there's an actual reason to close one
-- early rather than letting old join codes go quietly unused).

create table if not exists classes (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists roster_entries (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references classes(id) on delete cascade,
  display_name text not null,
  score integer not null default 0,
  equipment jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (class_id, display_name)
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references classes(id) on delete cascade,
  join_code text not null unique,
  created_at timestamptz not null default now()
);

alter table classes enable row level security;
alter table roster_entries enable row level security;
alter table sessions enable row level security;

-- Teachers fully manage their own classes, the roster entries inside them,
-- and the sessions (join codes) they open against them. auth.uid() is the
-- signed-in teacher's id, set by Supabase Auth.
drop policy if exists "teachers manage own classes" on classes;
create policy "teachers manage own classes"
  on classes for all
  using (auth.uid() = teacher_id)
  with check (auth.uid() = teacher_id);

drop policy if exists "teachers manage own roster entries" on roster_entries;
create policy "teachers manage own roster entries"
  on roster_entries for all
  using (exists (select 1 from classes c where c.id = roster_entries.class_id and c.teacher_id = auth.uid()))
  with check (exists (select 1 from classes c where c.id = roster_entries.class_id and c.teacher_id = auth.uid()));

drop policy if exists "teachers manage own sessions" on sessions;
create policy "teachers manage own sessions"
  on sessions for all
  using (exists (select 1 from classes c where c.id = sessions.class_id and c.teacher_id = auth.uid()))
  with check (exists (select 1 from classes c where c.id = sessions.class_id and c.teacher_id = auth.uid()));

-- Students join with the anon/publishable key, no Supabase Auth account at
-- all (per the handoff: "does NOT require student accounts"). They need to
-- resolve a typed join code to a session/class, read that class's roster to
-- show a name picker, and update their own claimed row's score/equipment as
-- they play. This is deliberately NOT scoped further (e.g. by requiring the
-- session's join code as part of every later roster read) — matching the
-- handoff's "not a cheat-prevention problem" decision that clients are
-- trusted in this classroom-game context. It does mean anyone holding this
-- project's public anon key can read or edit any class's roster scores, or
-- enumerate session join codes directly (rather than only by guessing one);
-- acceptable for this prototype, worth reconsidering before a real
-- multi-school deployment. No anon insert/delete/update policy exists on
-- classes or sessions, so students can never create, remove, or edit
-- either, only read.
drop policy if exists "anon can read sessions" on sessions;
create policy "anon can read sessions"
  on sessions for select
  to anon
  using (true);

drop policy if exists "anon can read roster entries" on roster_entries;
create policy "anon can read roster entries"
  on roster_entries for select
  to anon
  using (true);

drop policy if exists "anon can update roster entries" on roster_entries;
create policy "anon can update roster entries"
  on roster_entries for update
  to anon
  using (true)
  with check (true);
