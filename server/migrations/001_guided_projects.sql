-- Guided Project foundation for Promgent.
-- Apply with Supabase migrations. Auth users live in auth.users; application
-- tables keep ownership on every project-scoped row and enforce it with RLS.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  initial_description text not null,
  project_type text not null default 'general',
  selected_model text not null,
  planning_depth text not null default 'balanced' check (planning_depth in ('fast', 'balanced', 'thorough')),
  credit_budget numeric(12, 2) not null check (credit_budget > 0),
  status text not null default 'intake' check (status in ('intake', 'interviewing', 'reviewing_requirements', 'srs_ready', 'approved', 'implementation', 'reviewing_repository', 'iterating', 'completed')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.project_settings (
  project_id uuid primary key references public.projects(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.project_memory (
  project_id uuid primary key references public.projects(id) on delete cascade,
  memory jsonb not null default '{}'::jsonb,
  version integer not null default 1 check (version > 0),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.orbio_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  encrypted_key text not null,
  key_fingerprint text not null,
  status text not null default 'unverified' check (status in ('unverified', 'active', 'invalid', 'disconnected')),
  last_verified_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.interview_sessions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  planning_depth text not null check (planning_depth in ('fast', 'balanced', 'thorough')),
  status text not null default 'active' check (status in ('active', 'paused', 'complete')),
  turn_count integer not null default 0 check (turn_count >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.interview_messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  session_id uuid not null references public.interview_sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  source text not null default 'text' check (source in ('text', 'voice_transcript', 'reference', 'system')),
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.requirements (
  id text primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  type text not null,
  category text not null,
  description text not null,
  priority text not null default 'medium' check (priority in ('critical', 'high', 'medium', 'low')),
  required boolean not null default true,
  source text not null check (source in ('user', 'ai_inferred', 'reference', 'system')),
  source_message_id text,
  status text not null default 'inferred' check (status in ('inferred', 'proposed', 'confirmed', 'rejected', 'superseded')),
  confidence text not null default 'medium' check (confidence in ('low', 'medium', 'high')),
  dependencies jsonb not null default '[]'::jsonb,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.requirement_versions (
  id uuid primary key default gen_random_uuid(),
  requirement_id text not null references public.requirements(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  version integer not null,
  snapshot jsonb not null,
  change_reason text not null,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.project_references (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  type text not null check (type in ('image', 'website', 'file')),
  source text not null,
  analysis jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.architecture_versions (
  id text primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  version integer not null,
  diagram_source text not null,
  summary text not null,
  reason_for_change text not null,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.srs_documents (
  id text primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  version integer not null,
  title text not null,
  content text not null,
  requirement_ids jsonb not null default '[]'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'approved', 'superseded')),
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.projects
  add column if not exists approved_srs_version_id text references public.srs_documents(id) on delete set null;

create table if not exists public.generated_prompts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  srs_document_id text references public.srs_documents(id) on delete set null,
  kind text not null check (kind in ('implementation', 'correction')),
  iteration integer not null default 1,
  prompt text not null,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  phase text not null,
  source text not null check (source in ('promgent', 'external_snapshot')),
  model text,
  input_tokens integer,
  output_tokens integer,
  cost numeric(12, 6),
  request_id text,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.usage_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  iteration_id text not null,
  captured_at timestamptz not null default timezone('utc', now()),
  key_spend numeric(12, 6),
  model_breakdown jsonb not null default '{}'::jsonb,
  request_counts jsonb not null default '{}'::jsonb,
  attribution_note text not null default 'Inference consumed during implementation interval.'
);

create table if not exists public.github_repositories (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'github',
  repository_url text not null,
  external_id text,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.repository_reviews (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  repository_id uuid references public.github_repositories(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'draft',
  report jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists projects_user_id_idx on public.projects(user_id);
create index if not exists interview_messages_project_id_idx on public.interview_messages(project_id, created_at);
create index if not exists requirements_project_id_idx on public.requirements(project_id);
create index if not exists usage_events_project_id_idx on public.usage_events(project_id, created_at);

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at before update on public.projects for each row execute function public.set_updated_at();
drop trigger if exists project_settings_set_updated_at on public.project_settings;
create trigger project_settings_set_updated_at before update on public.project_settings for each row execute function public.set_updated_at();
drop trigger if exists orbio_connections_set_updated_at on public.orbio_connections;
create trigger orbio_connections_set_updated_at before update on public.orbio_connections for each row execute function public.set_updated_at();
drop trigger if exists interview_sessions_set_updated_at on public.interview_sessions;
create trigger interview_sessions_set_updated_at before update on public.interview_sessions for each row execute function public.set_updated_at();
drop trigger if exists requirements_set_updated_at on public.requirements;
create trigger requirements_set_updated_at before update on public.requirements for each row execute function public.set_updated_at();

alter table public.projects enable row level security;
alter table public.project_settings enable row level security;
alter table public.project_memory enable row level security;
alter table public.orbio_connections enable row level security;
alter table public.interview_sessions enable row level security;
alter table public.interview_messages enable row level security;
alter table public.requirements enable row level security;
alter table public.requirement_versions enable row level security;
alter table public.project_references enable row level security;
alter table public.architecture_versions enable row level security;
alter table public.srs_documents enable row level security;
alter table public.generated_prompts enable row level security;
alter table public.usage_events enable row level security;
alter table public.usage_snapshots enable row level security;
alter table public.github_repositories enable row level security;
alter table public.repository_reviews enable row level security;

create or replace function public.owns_project(target_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(select 1 from public.projects where id = target_project_id and user_id = auth.uid());
$$;

create policy projects_owner on public.projects for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy project_settings_owner on public.project_settings for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));
create policy project_memory_owner on public.project_memory for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));
create policy orbio_connections_owner on public.orbio_connections for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy interview_sessions_owner on public.interview_sessions for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));
create policy interview_messages_owner on public.interview_messages for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));
create policy requirements_owner on public.requirements for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));
create policy requirement_versions_owner on public.requirement_versions for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));
create policy project_references_owner on public.project_references for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));
create policy architecture_versions_owner on public.architecture_versions for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));
create policy srs_documents_owner on public.srs_documents for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));
create policy generated_prompts_owner on public.generated_prompts for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));
create policy usage_events_owner on public.usage_events for all using (user_id = auth.uid() and (project_id is null or public.owns_project(project_id))) with check (user_id = auth.uid() and (project_id is null or public.owns_project(project_id)));
create policy usage_snapshots_owner on public.usage_snapshots for all using (user_id = auth.uid() and public.owns_project(project_id)) with check (user_id = auth.uid() and public.owns_project(project_id));
create policy github_repositories_owner on public.github_repositories for all using (user_id = auth.uid() and public.owns_project(project_id)) with check (user_id = auth.uid() and public.owns_project(project_id));
create policy repository_reviews_owner on public.repository_reviews for all using (user_id = auth.uid() and public.owns_project(project_id)) with check (user_id = auth.uid() and public.owns_project(project_id));
