-- Conversation-first product foundation. Additive and backward compatible.
-- Recovery: application code can ignore these columns/tables and continue to
-- use the legacy status, interview, architecture, SRS and iteration records.
-- Do not drop legacy objects during rollback; remove only the new objects after
-- verifying no conversation-era data needs export.
begin;

alter table public.projects add column if not exists model_mode text;
update public.projects
set model_mode = case when selected_model = 'auto' then 'auto' else 'locked' end
where model_mode is null;
alter table public.projects alter column model_mode set default 'auto';
alter table public.projects alter column model_mode set not null;

alter table public.projects add column if not exists phase text;
update public.projects set phase = case status
  when 'intake' then 'exploring'
  when 'interviewing' then 'shaping'
  when 'reviewing_requirements' then 'shaping'
  when 'srs_ready' then 'ready_to_build'
  when 'approved' then 'ready_to_build'
  when 'implementation' then 'building'
  when 'reviewing_repository' then 'reviewing'
  when 'iterating' then 'improving'
  when 'completed' then 'completed'
  else 'exploring'
end where phase is null;
alter table public.projects alter column phase set default 'exploring';
alter table public.projects alter column phase set not null;
alter table public.projects add column if not exists next_recommended_action jsonb;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'projects_model_mode_check') then
    alter table public.projects add constraint projects_model_mode_check check (model_mode in ('auto', 'locked'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'projects_phase_check') then
    alter table public.projects add constraint projects_phase_check check (phase in ('exploring', 'shaping', 'ready_to_build', 'building', 'reviewing', 'improving', 'completed'));
  end if;
end $$;

alter table public.interview_messages drop constraint if exists interview_messages_source_check;
alter table public.interview_messages add constraint interview_messages_source_check
  check (source in ('text', 'voice_transcript', 'reference', 'image', 'website_reference', 'repository', 'live_url', 'system'));
alter table public.interview_messages add column if not exists artifact_ids jsonb not null default '[]'::jsonb;
alter table public.interview_messages add column if not exists model_route jsonb;
alter table public.interview_messages add column if not exists metadata jsonb not null default '{}'::jsonb;

create table if not exists public.project_decisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  decision text not null,
  reason text not null default '',
  source text not null check (source in ('user', 'assistant_proposal', 'system')),
  source_message_id uuid references public.interview_messages(id) on delete set null,
  confidence text not null default 'medium' check (confidence in ('low', 'medium', 'high')),
  status text not null default 'proposed' check (status in ('proposed', 'confirmed', 'rejected', 'superseded')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.project_artifacts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  type text not null,
  version integer not null check (version > 0),
  title text not null,
  content text not null default '',
  structured_data jsonb not null default '{}'::jsonb,
  source_message_id uuid references public.interview_messages(id) on delete set null,
  supersedes_artifact_id uuid references public.project_artifacts(id) on delete set null,
  status text not null default 'current' check (status in ('draft', 'current', 'superseded', 'archived')),
  content_hash text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (project_id, type, version)
);

create table if not exists public.model_routes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  message_id uuid references public.interview_messages(id) on delete set null,
  request_id text not null,
  task_class text not null,
  model_mode text not null check (model_mode in ('auto', 'locked')),
  requested_model text,
  chosen_model text not null,
  reason_code text not null,
  expected_cost_class text not null check (expected_cost_class in ('low', 'medium', 'high')),
  fallback_used boolean not null default false,
  provider_usage jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  unique (request_id)
);

create table if not exists public.repository_connections (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  provider text not null default 'github',
  repository_url text not null,
  default_branch text,
  latest_reviewed_commit text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (project_id, repository_url)
);

create table if not exists public.test_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  repository_connection_id uuid references public.repository_connections(id) on delete set null,
  commit_sha text not null,
  commands jsonb not null default '[]'::jsonb,
  runner text not null check (runner in ('disabled', 'github_actions', 'isolated_container')),
  status text not null check (status in ('awaiting_authorization', 'queued', 'running', 'passed', 'failed', 'unavailable')),
  authorized_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  exit_code integer,
  output_summary text,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.project_actions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  message_id uuid references public.interview_messages(id) on delete cascade,
  type text not null,
  label text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'available' check (status in ('available', 'started', 'completed', 'dismissed', 'failed')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists project_decisions_project_idx on public.project_decisions(project_id, created_at);
create index if not exists project_artifacts_project_idx on public.project_artifacts(project_id, type, version desc);
create index if not exists model_routes_project_idx on public.model_routes(project_id, created_at desc);
create index if not exists repository_connections_project_idx on public.repository_connections(project_id);
create index if not exists test_runs_project_idx on public.test_runs(project_id, created_at desc);
create index if not exists project_actions_project_idx on public.project_actions(project_id, created_at);

alter table public.project_decisions enable row level security;
alter table public.project_artifacts enable row level security;
alter table public.model_routes enable row level security;
alter table public.repository_connections enable row level security;
alter table public.test_runs enable row level security;
alter table public.project_actions enable row level security;

drop policy if exists project_decisions_owner on public.project_decisions;
create policy project_decisions_owner on public.project_decisions for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));
drop policy if exists project_artifacts_owner on public.project_artifacts;
create policy project_artifacts_owner on public.project_artifacts for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));
drop policy if exists model_routes_owner on public.model_routes;
create policy model_routes_owner on public.model_routes for all using (project_id is null or public.owns_project(project_id)) with check (project_id is null or public.owns_project(project_id));
drop policy if exists repository_connections_owner on public.repository_connections;
create policy repository_connections_owner on public.repository_connections for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));
drop policy if exists test_runs_owner on public.test_runs;
create policy test_runs_owner on public.test_runs for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));
drop policy if exists project_actions_owner on public.project_actions;
create policy project_actions_owner on public.project_actions for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));

notify pgrst, 'reload schema';
commit;
