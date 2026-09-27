-- Iteration/review loop for the existing canonical project.
-- The aggregate payload keeps the first rollout backwards-compatible while the
-- child tables provide queryable, project-scoped records for future views.

create table if not exists public.project_iterations (
  id text primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  sequence_number integer not null check (sequence_number > 0),
  title text not null,
  status text not null check (status in ('draft', 'collecting_context', 'analyzing', 'review_ready', 'discussing', 'changes_approved', 'prompt_ready', 'implementation_in_progress', 'ready_for_rereview', 'completed')),
  base_srs_version_id text,
  base_architecture_version_id text,
  reviewed_commit_sha text,
  data jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default timezone('utc', now()),
  reviewed_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default timezone('utc', now()),
  unique(project_id, sequence_number)
);

create table if not exists public.iteration_inputs (
  id text primary key,
  iteration_id text not null references public.project_iterations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  input jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.repository_snapshots (
  id uuid primary key default gen_random_uuid(),
  iteration_id text not null references public.project_iterations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  repository_url text not null,
  branch text,
  commit_sha text,
  snapshot jsonb not null default '{}'::jsonb,
  reviewed_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.live_product_snapshots (
  id uuid primary key default gen_random_uuid(),
  iteration_id text not null references public.project_iterations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  url text not null,
  snapshot jsonb not null default '{}'::jsonb,
  inspected_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.change_requests (
  id text primary key,
  iteration_id text not null references public.project_iterations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  category text not null,
  description text not null,
  status text not null default 'proposed',
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.review_findings (
  id text primary key,
  iteration_id text not null references public.project_iterations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  type text not null,
  severity text not null,
  status text not null default 'open',
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.review_evidence (
  id text primary key,
  iteration_id text not null references public.project_iterations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  evidence_type text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.traceability_records (
  id text primary key,
  iteration_id text not null references public.project_iterations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  requirement_id text not null references public.requirements(id) on delete cascade,
  status text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.project_suggestions (
  id text primary key,
  iteration_id text not null references public.project_iterations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  status text not null default 'proposed',
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.suggestion_discussions (
  id uuid primary key default gen_random_uuid(),
  suggestion_id text not null references public.project_suggestions(id) on delete cascade,
  iteration_id text not null references public.project_iterations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.iteration_decisions (
  id text primary key,
  iteration_id text not null references public.project_iterations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  subject_id text not null,
  decision_type text not null,
  decision text not null,
  rationale text,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.iteration_prompts (
  id text primary key,
  iteration_id text not null references public.project_iterations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  kind text not null,
  reviewed_commit_sha text,
  prompt text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists project_iterations_project_idx on public.project_iterations(project_id, sequence_number);
create index if not exists iteration_inputs_iteration_idx on public.iteration_inputs(iteration_id);
create index if not exists review_findings_iteration_idx on public.review_findings(iteration_id, status);
create index if not exists traceability_records_iteration_idx on public.traceability_records(iteration_id, status);
create index if not exists project_suggestions_iteration_idx on public.project_suggestions(iteration_id, status);

alter table public.project_iterations enable row level security;
alter table public.iteration_inputs enable row level security;
alter table public.repository_snapshots enable row level security;
alter table public.live_product_snapshots enable row level security;
alter table public.change_requests enable row level security;
alter table public.review_findings enable row level security;
alter table public.review_evidence enable row level security;
alter table public.traceability_records enable row level security;
alter table public.project_suggestions enable row level security;
alter table public.suggestion_discussions enable row level security;
alter table public.iteration_decisions enable row level security;
alter table public.iteration_prompts enable row level security;

create or replace function public.owns_iteration(target_iteration_id text)
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.project_iterations i join public.projects p on p.id = i.project_id where i.id = target_iteration_id and p.user_id = auth.uid()); $$;

create policy project_iterations_owner on public.project_iterations for all using (public.owns_project(project_id)) with check (public.owns_project(project_id));
create policy iteration_inputs_owner on public.iteration_inputs for all using (public.owns_iteration(iteration_id)) with check (public.owns_iteration(iteration_id));
create policy repository_snapshots_owner on public.repository_snapshots for all using (public.owns_iteration(iteration_id)) with check (public.owns_iteration(iteration_id));
create policy live_product_snapshots_owner on public.live_product_snapshots for all using (public.owns_iteration(iteration_id)) with check (public.owns_iteration(iteration_id));
create policy change_requests_owner on public.change_requests for all using (public.owns_iteration(iteration_id)) with check (public.owns_iteration(iteration_id));
create policy review_findings_owner on public.review_findings for all using (public.owns_iteration(iteration_id)) with check (public.owns_iteration(iteration_id));
create policy review_evidence_owner on public.review_evidence for all using (public.owns_iteration(iteration_id)) with check (public.owns_iteration(iteration_id));
create policy traceability_records_owner on public.traceability_records for all using (public.owns_iteration(iteration_id)) with check (public.owns_iteration(iteration_id));
create policy project_suggestions_owner on public.project_suggestions for all using (public.owns_iteration(iteration_id)) with check (public.owns_iteration(iteration_id));
create policy suggestion_discussions_owner on public.suggestion_discussions for all using (public.owns_iteration(iteration_id)) with check (public.owns_iteration(iteration_id));
create policy iteration_decisions_owner on public.iteration_decisions for all using (public.owns_iteration(iteration_id)) with check (public.owns_iteration(iteration_id));
create policy iteration_prompts_owner on public.iteration_prompts for all using (public.owns_iteration(iteration_id)) with check (public.owns_iteration(iteration_id));

alter table public.generated_prompts add column if not exists iteration_id text references public.project_iterations(id) on delete set null;
