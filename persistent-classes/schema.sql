-- Sky Path: persistent classes (build-sequence step 5).
-- Run this once in the Supabase dashboard's SQL Editor for this project.
--
-- Model: a teacher (a real Supabase Auth account) owns classes; each class
-- has a roster of student names the teacher curates ahead of time. Score
-- and equipment accumulate against the roster row, keyed by name — not by
-- device — so a student picking their name again on a later day (possibly
-- on a different shared classroom device) resumes the same character. See
-- ESL-classroom-game-HANDOFF.md's "Persistent classes, scores & equipment"
-- section for the reasoning.
--
-- Deliberately NOT in scope here: students creating their own roster
-- entries (only the teacher adds names — a late joiner not on the roster
-- falls back to the existing ephemeral local identity store instead), and
-- scoping anon access by join code (see the RLS comment below).

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

alter table classes enable row level security;
alter table roster_entries enable row level security;

-- Teachers fully manage their own classes and the roster entries inside
-- them. auth.uid() is the signed-in teacher's id, set by Supabase Auth.
create policy "teachers manage own classes"
  on classes for all
  using (auth.uid() = teacher_id)
  with check (auth.uid() = teacher_id);

create policy "teachers manage own roster entries"
  on roster_entries for all
  using (exists (select 1 from classes c where c.id = roster_entries.class_id and c.teacher_id = auth.uid()))
  with check (exists (select 1 from classes c where c.id = roster_entries.class_id and c.teacher_id = auth.uid()));

-- Students join with the anon/publishable key, no Supabase Auth account at
-- all (per the handoff: "does NOT require student accounts"). They need to
-- read the roster to show a name picker, and update their own claimed row's
-- score/equipment as they play. This is deliberately NOT scoped further
-- (e.g. by requiring the class's join code as part of the row filter) —
-- matching the handoff's "not a cheat-prevention problem" decision that
-- clients are trusted in this classroom-game context. It does mean anyone
-- holding this project's public anon key can read or edit any class's
-- roster scores; acceptable for this prototype, worth reconsidering before
-- a real multi-school deployment. No anon insert/delete policy exists, so
-- students can never create or remove roster rows, only the teacher can.
create policy "anon can read roster entries"
  on roster_entries for select
  to anon
  using (true);

create policy "anon can update roster entries"
  on roster_entries for update
  to anon
  using (true)
  with check (true);
