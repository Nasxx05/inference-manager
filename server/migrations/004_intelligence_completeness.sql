-- Structured acceptance criteria for the existing canonical project memory.
-- Additive only: legacy string criteria remain readable from project_memory.

create table if not exists public.acceptance_criteria (
  id text primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  requirement_id text not null references public.requirements(id) on delete cascade,
  description text not null,
  source text not null check (source in ('user', 'ai_inferred', 'reference', 'system')),
  source_message_id text,
  status text not null default 'proposed' check (status in ('inferred', 'proposed', 'confirmed', 'rejected', 'superseded')),
  confidence text not null default 'medium' check (confidence in ('low', 'medium', 'high')),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists acceptance_criteria_project_idx on public.acceptance_criteria(project_id, requirement_id);

drop trigger if exists acceptance_criteria_set_updated_at on public.acceptance_criteria;
create trigger acceptance_criteria_set_updated_at before update on public.acceptance_criteria for each row execute function public.set_updated_at();

alter table public.acceptance_criteria enable row level security;
drop policy if exists acceptance_criteria_owner on public.acceptance_criteria;
create policy acceptance_criteria_owner on public.acceptance_criteria for all
  using (public.owns_project(project_id))
  with check (public.owns_project(project_id));

create table if not exists public.screenshot_artifacts (
  id text primary key,
  iteration_id text not null references public.project_iterations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  filename text not null,
  mime_type text not null,
  analysis jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists screenshot_artifacts_iteration_idx on public.screenshot_artifacts(iteration_id, created_at);
alter table public.screenshot_artifacts enable row level security;
drop policy if exists screenshot_artifacts_owner on public.screenshot_artifacts;
create policy screenshot_artifacts_owner on public.screenshot_artifacts for all
  using (public.owns_project(project_id))
  with check (public.owns_project(project_id));
