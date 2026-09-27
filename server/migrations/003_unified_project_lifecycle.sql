-- Unified project lifecycle additions.
-- The existing project, reference and prompt tables remain the source of truth;
-- this only gives implementation planning a durable, queryable project record.

alter table public.generated_prompts
  add column if not exists data jsonb not null default '{}'::jsonb;

create index if not exists generated_prompts_project_created_idx
  on public.generated_prompts(project_id, kind, created_at desc);

