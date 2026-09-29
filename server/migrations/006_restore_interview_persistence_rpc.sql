-- Production repair for environments where migration 005 was recorded or
-- deployed without the RPC becoming visible to PostgREST. This migration is
-- deliberately self-contained and idempotent.

begin;

-- Dropping only the expected identity signature also repairs a function whose
-- input parameter names differ: PostgreSQL cannot rename input parameters via
-- CREATE OR REPLACE. Migration runners apply this file transactionally, so
-- callers never observe a half-created replacement.
drop function if exists public.persist_interview_turn(uuid, uuid, jsonb, jsonb, jsonb, integer, jsonb, jsonb, jsonb);

create function public.persist_interview_turn(
  p_user_id uuid,
  p_project_id uuid,
  p_user_message jsonb,
  p_assistant_message jsonb,
  p_memory jsonb,
  p_memory_version integer,
  p_requirements jsonb,
  p_acceptance_criteria jsonb,
  p_session jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.projects
    where id = p_project_id and user_id = p_user_id
  ) then
    raise exception 'project ownership check failed' using errcode = '42501';
  end if;

  insert into public.interview_messages
    (id, project_id, session_id, role, content, source, created_at)
  values
    ((p_user_message->>'id')::uuid, p_project_id,
     (p_user_message->>'session_id')::uuid, p_user_message->>'role',
     p_user_message->>'content', p_user_message->>'source',
     (p_user_message->>'created_at')::timestamptz),
    ((p_assistant_message->>'id')::uuid, p_project_id,
     (p_assistant_message->>'session_id')::uuid, p_assistant_message->>'role',
     p_assistant_message->>'content', p_assistant_message->>'source',
     (p_assistant_message->>'created_at')::timestamptz);

  insert into public.project_memory (project_id, memory, version)
  values (p_project_id, p_memory, p_memory_version)
  on conflict (project_id) do update
    set memory = excluded.memory, version = excluded.version;

  insert into public.requirements
    (id, project_id, type, category, description, priority, required, source,
     source_message_id, status, confidence, dependencies, version, created_at, updated_at)
  select r.id, p_project_id, r.type, r.category, r.description, r.priority,
         r.required, r.source, r.source_message_id, r.status, r.confidence,
         r.dependencies, r.version, r.created_at, r.updated_at
  from jsonb_to_recordset(coalesce(p_requirements, '[]'::jsonb)) as r(
    id text, project_id uuid, type text, category text, description text,
    priority text, required boolean, source text, source_message_id text,
    status text, confidence text, dependencies jsonb, version integer,
    created_at timestamptz, updated_at timestamptz
  )
  on conflict (id) do update set
    type = excluded.type, category = excluded.category,
    description = excluded.description, priority = excluded.priority,
    required = excluded.required, source = excluded.source,
    source_message_id = excluded.source_message_id, status = excluded.status,
    confidence = excluded.confidence, dependencies = excluded.dependencies,
    version = excluded.version, updated_at = excluded.updated_at;

  insert into public.acceptance_criteria
    (id, project_id, requirement_id, description, source, source_message_id,
     status, confidence, version, created_at, updated_at)
  select a.id, p_project_id, a.requirement_id, a.description, a.source,
         a.source_message_id, a.status, a.confidence, a.version,
         a.created_at, a.updated_at
  from jsonb_to_recordset(coalesce(p_acceptance_criteria, '[]'::jsonb)) as a(
    id text, project_id uuid, requirement_id text, description text,
    source text, source_message_id text, status text, confidence text,
    version integer, created_at timestamptz, updated_at timestamptz
  )
  on conflict (id) do update set
    requirement_id = excluded.requirement_id,
    description = excluded.description, source = excluded.source,
    source_message_id = excluded.source_message_id, status = excluded.status,
    confidence = excluded.confidence, version = excluded.version,
    updated_at = excluded.updated_at;

  update public.interview_sessions set
    planning_depth = p_session->>'planning_depth',
    status = p_session->>'status',
    turn_count = (p_session->>'turn_count')::integer,
    updated_at = (p_session->>'updated_at')::timestamptz
  where id = (p_session->>'id')::uuid and project_id = p_project_id;

  if not found then
    raise exception 'interview session update failed' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.persist_interview_turn(uuid, uuid, jsonb, jsonb, jsonb, integer, jsonb, jsonb, jsonb) from public;
grant execute on function public.persist_interview_turn(uuid, uuid, jsonb, jsonb, jsonb, integer, jsonb, jsonb, jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
