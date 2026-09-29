-- Close the remaining reliability gaps: shared authentication throttling and
-- one transaction for applying an accepted implementation-review change set.
begin;

create table if not exists public.auth_rate_limits (
  key_hash text primary key,
  attempt_count integer not null,
  window_started_at timestamptz not null,
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.auth_rate_limits enable row level security;

create index if not exists auth_rate_limits_updated_at_idx
  on public.auth_rate_limits(updated_at);

create or replace function public.consume_auth_rate_limit(
  p_key_hash text,
  p_limit integer default 10,
  p_window_seconds integer default 900
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_row public.auth_rate_limits%rowtype;
  now_utc timestamptz := timezone('utc', now());
begin
  if length(p_key_hash) < 32 or p_limit < 1 or p_window_seconds < 1 then
    raise exception 'invalid rate-limit input' using errcode = '22023';
  end if;

  insert into public.auth_rate_limits(key_hash, attempt_count, window_started_at, updated_at)
  values (p_key_hash, 1, now_utc, now_utc)
  on conflict (key_hash) do update set
    attempt_count = case
      when auth_rate_limits.window_started_at <= now_utc - make_interval(secs => p_window_seconds) then 1
      else auth_rate_limits.attempt_count + 1
    end,
    window_started_at = case
      when auth_rate_limits.window_started_at <= now_utc - make_interval(secs => p_window_seconds) then now_utc
      else auth_rate_limits.window_started_at
    end,
    updated_at = now_utc
  returning * into current_row;

  -- Opportunistic bounded cleanup prevents abandoned IP hashes accumulating.
  delete from public.auth_rate_limits
  where updated_at < now_utc - interval '2 days';

  return jsonb_build_object(
    'allowed', current_row.attempt_count <= p_limit,
    'retry_after', greatest(0, ceil(extract(epoch from
      (current_row.window_started_at + make_interval(secs => p_window_seconds) - now_utc)
    )))::integer
  );
end;
$$;

create or replace function public.persist_iteration_change_approval(
  p_user_id uuid,
  p_project_id uuid,
  p_memory jsonb,
  p_memory_version integer,
  p_requirements jsonb,
  p_acceptance_criteria jsonb,
  p_srs jsonb,
  p_architecture jsonb,
  p_iteration jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.projects where id = p_project_id and user_id = p_user_id
  ) then
    raise exception 'project ownership check failed' using errcode = '42501';
  end if;
  if (p_iteration->>'project_id')::uuid <> p_project_id then
    raise exception 'iteration project mismatch' using errcode = '42501';
  end if;

  insert into public.project_memory(project_id, memory, version)
  values (p_project_id, p_memory, p_memory_version)
  on conflict (project_id) do update set
    memory = excluded.memory, version = excluded.version;

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
    type=excluded.type, category=excluded.category, description=excluded.description,
    priority=excluded.priority, required=excluded.required, source=excluded.source,
    source_message_id=excluded.source_message_id, status=excluded.status,
    confidence=excluded.confidence, dependencies=excluded.dependencies,
    version=excluded.version, updated_at=excluded.updated_at;

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
    requirement_id=excluded.requirement_id, description=excluded.description,
    source=excluded.source, source_message_id=excluded.source_message_id,
    status=excluded.status, confidence=excluded.confidence,
    version=excluded.version, updated_at=excluded.updated_at;

  insert into public.srs_documents
    (id, project_id, version, title, content, requirement_ids, status, created_at)
  values (p_srs->>'id', p_project_id, (p_srs->>'version')::integer,
    p_srs->>'title', p_srs->>'content', p_srs->'requirement_ids',
    p_srs->>'status', (p_srs->>'created_at')::timestamptz);

  if p_architecture is not null and p_architecture <> 'null'::jsonb then
    insert into public.architecture_versions
      (id, project_id, version, diagram_source, summary, reason_for_change, created_at)
    values (p_architecture->>'id', p_project_id,
      (p_architecture->>'version')::integer, p_architecture->>'diagram_source',
      p_architecture->>'summary', p_architecture->>'reason_for_change',
      (p_architecture->>'created_at')::timestamptz);
  end if;

  insert into public.project_iterations
    (id, project_id, sequence_number, title, status, base_srs_version_id,
     base_architecture_version_id, reviewed_commit_sha, data, started_at,
     reviewed_at, completed_at, updated_at)
  values (p_iteration->>'id', p_project_id,
    (p_iteration->>'sequence_number')::integer, p_iteration->>'title',
    p_iteration->>'status', p_iteration->>'base_srs_version_id',
    p_iteration->>'base_architecture_version_id', p_iteration->>'reviewed_commit_sha',
    p_iteration->'data', (p_iteration->>'started_at')::timestamptz,
    nullif(p_iteration->>'reviewed_at','')::timestamptz,
    nullif(p_iteration->>'completed_at','')::timestamptz,
    (p_iteration->>'updated_at')::timestamptz)
  on conflict (id) do update set
    status=excluded.status, reviewed_commit_sha=excluded.reviewed_commit_sha,
    data=excluded.data, reviewed_at=excluded.reviewed_at,
    completed_at=excluded.completed_at, updated_at=excluded.updated_at;
end;
$$;

revoke all on table public.auth_rate_limits from public, anon, authenticated;
revoke all on function public.consume_auth_rate_limit(text,integer,integer) from public;
revoke all on function public.persist_iteration_change_approval(uuid,uuid,jsonb,integer,jsonb,jsonb,jsonb,jsonb,jsonb) from public;
grant execute on function public.consume_auth_rate_limit(text,integer,integer) to service_role;
grant execute on function public.persist_iteration_change_approval(uuid,uuid,jsonb,integer,jsonb,jsonb,jsonb,jsonb,jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
