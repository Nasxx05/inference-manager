-- Atomically persist one conversation turn and its canonical state side effects.
-- This does not replace persist_interview_turn; legacy deployed clients remain compatible.
begin;

create or replace function public.persist_conversation_turn(
  p_user_id uuid,
  p_project_id uuid,
  p_user_message jsonb,
  p_assistant_message jsonb,
  p_memory jsonb,
  p_memory_version integer,
  p_requirements jsonb,
  p_acceptance_criteria jsonb,
  p_decisions jsonb,
  p_session jsonb,
  p_project_phase text,
  p_next_recommended_action jsonb,
  p_model_route jsonb,
  p_actions jsonb,
  p_artifacts jsonb,
  p_repository_snapshot jsonb,
  p_test_run jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare artifact jsonb;
declare repository_connection_id uuid;
begin
  if not exists (select 1 from public.projects where id = p_project_id and user_id = p_user_id) then
    raise exception 'project ownership check failed' using errcode = '42501';
  end if;

  insert into public.interview_messages
    (id, project_id, session_id, role, content, source, artifact_ids, model_route, metadata, created_at)
  values
    ((p_user_message->>'id')::uuid, p_project_id, (p_user_message->>'session_id')::uuid,
     p_user_message->>'role', p_user_message->>'content', p_user_message->>'source',
     coalesce(p_user_message->'artifact_ids','[]'::jsonb), p_user_message->'model_route',
     coalesce(p_user_message->'metadata','{}'::jsonb), (p_user_message->>'created_at')::timestamptz),
    ((p_assistant_message->>'id')::uuid, p_project_id, (p_assistant_message->>'session_id')::uuid,
     p_assistant_message->>'role', p_assistant_message->>'content', p_assistant_message->>'source',
     coalesce(p_assistant_message->'artifact_ids','[]'::jsonb), p_assistant_message->'model_route',
     coalesce(p_assistant_message->'metadata','{}'::jsonb), (p_assistant_message->>'created_at')::timestamptz);

  insert into public.project_memory(project_id, memory, version)
  values (p_project_id, p_memory, p_memory_version)
  on conflict (project_id) do update set memory=excluded.memory, version=excluded.version, updated_at=timezone('utc', now());

  insert into public.requirements
    (id, project_id, type, category, description, priority, required, source, source_message_id, status, confidence, dependencies, version, created_at, updated_at)
  select r.id, p_project_id, r.type, r.category, r.description, r.priority, r.required, r.source, r.source_message_id, r.status, r.confidence, r.dependencies, r.version, r.created_at, r.updated_at
  from jsonb_to_recordset(coalesce(p_requirements,'[]'::jsonb)) as r(id text, project_id uuid, type text, category text, description text, priority text, required boolean, source text, source_message_id text, status text, confidence text, dependencies jsonb, version integer, created_at timestamptz, updated_at timestamptz)
  on conflict (id) do update set type=excluded.type, category=excluded.category, description=excluded.description, priority=excluded.priority, required=excluded.required, source=excluded.source, source_message_id=excluded.source_message_id, status=excluded.status, confidence=excluded.confidence, dependencies=excluded.dependencies, version=excluded.version, updated_at=excluded.updated_at;

  insert into public.acceptance_criteria
    (id, project_id, requirement_id, description, source, source_message_id, status, confidence, version, created_at, updated_at)
  select a.id, p_project_id, a.requirement_id, a.description, a.source, a.source_message_id, a.status, a.confidence, a.version, a.created_at, a.updated_at
  from jsonb_to_recordset(coalesce(p_acceptance_criteria,'[]'::jsonb)) as a(id text, project_id uuid, requirement_id text, description text, source text, source_message_id text, status text, confidence text, version integer, created_at timestamptz, updated_at timestamptz)
  on conflict (id) do update set requirement_id=excluded.requirement_id, description=excluded.description, source=excluded.source, source_message_id=excluded.source_message_id, status=excluded.status, confidence=excluded.confidence, version=excluded.version, updated_at=excluded.updated_at;

  insert into public.project_decisions
    (id, project_id, decision, reason, source, source_message_id, confidence, status, created_at, updated_at)
  select d.id, p_project_id, d.decision, d.reason, d.source, d.source_message_id, d.confidence, d.status, d.created_at, d.updated_at
  from jsonb_to_recordset(coalesce(p_decisions,'[]'::jsonb)) as d(id uuid, decision text, reason text, source text, source_message_id uuid, confidence text, status text, created_at timestamptz, updated_at timestamptz)
  on conflict (id) do update set decision=excluded.decision, reason=excluded.reason, source=excluded.source, source_message_id=excluded.source_message_id, confidence=excluded.confidence, status=excluded.status, updated_at=excluded.updated_at;

  update public.interview_sessions set status=p_session->>'status', turn_count=(p_session->>'turn_count')::integer, updated_at=(p_session->>'updated_at')::timestamptz
  where id=(p_session->>'id')::uuid and project_id=p_project_id;
  if not found then raise exception 'conversation session update failed' using errcode = 'P0002'; end if;

  update public.projects set phase=p_project_phase, next_recommended_action=p_next_recommended_action, updated_at=timezone('utc', now()) where id=p_project_id;

  if p_model_route is not null and p_model_route <> 'null'::jsonb then
    insert into public.model_routes(id, project_id, message_id, request_id, task_class, model_mode, requested_model, chosen_model, reason_code, expected_cost_class, fallback_used, provider_usage)
    values ((p_model_route->>'id')::uuid, p_project_id, (p_assistant_message->>'id')::uuid,
      p_model_route->>'request_id', p_model_route->>'task_class', p_model_route->>'model_mode',
      nullif(p_model_route->>'requested_model',''), p_model_route->>'chosen_model', p_model_route->>'reason_code',
      p_model_route->>'expected_cost_class', coalesce((p_model_route->>'fallback_used')::boolean,false), p_model_route->'provider_usage')
    on conflict (request_id) do nothing;
  end if;

  insert into public.project_actions(id, project_id, message_id, type, label, payload, status)
  select a.id, p_project_id, (p_assistant_message->>'id')::uuid, a.type, a.label, a.payload, 'available'
  from jsonb_to_recordset(coalesce(p_actions,'[]'::jsonb)) as a(id uuid, type text, label text, payload jsonb)
  on conflict (id) do nothing;

  for artifact in select value from jsonb_array_elements(coalesce(p_artifacts,'[]'::jsonb)) loop
    update public.project_artifacts set status='superseded', updated_at=timezone('utc', now())
    where project_id=p_project_id and type=artifact->>'type' and status='current' and id<>(artifact->>'id')::uuid;
    insert into public.project_artifacts(id, project_id, type, version, title, content, structured_data, source_message_id, supersedes_artifact_id, status, content_hash, created_at, updated_at)
    values ((artifact->>'id')::uuid, p_project_id, artifact->>'type', (artifact->>'version')::integer,
      artifact->>'title', artifact->>'content', coalesce(artifact->'structured_data','{}'::jsonb),
      (p_assistant_message->>'id')::uuid, nullif(artifact->>'supersedes_artifact_id','')::uuid,
      'current', artifact->>'content_hash', (artifact->>'created_at')::timestamptz, (artifact->>'updated_at')::timestamptz)
    on conflict (project_id,type,version) do nothing;
  end loop;

  if p_repository_snapshot is not null and p_repository_snapshot <> 'null'::jsonb then
    insert into public.repository_connections(project_id, provider, repository_url, default_branch, latest_reviewed_commit, updated_at)
    values (p_project_id, 'github', p_repository_snapshot->>'repository_url', nullif(p_repository_snapshot->>'default_branch',''), nullif(p_repository_snapshot->>'latest_reviewed_commit',''), timezone('utc', now()))
    on conflict (project_id, repository_url) do update
      set default_branch=excluded.default_branch, latest_reviewed_commit=excluded.latest_reviewed_commit, updated_at=excluded.updated_at
    returning id into repository_connection_id;
  end if;

  if p_test_run is not null and p_test_run <> 'null'::jsonb then
    insert into public.test_runs(id, project_id, repository_connection_id, commit_sha, commands, runner, status, authorized_at, started_at, completed_at, exit_code, output_summary, created_at)
    values ((p_test_run->>'id')::uuid, p_project_id, repository_connection_id, p_test_run->>'commit_sha', coalesce(p_test_run->'commands','[]'::jsonb), p_test_run->>'runner', p_test_run->>'status',
      nullif(p_test_run->>'authorized_at','')::timestamptz, nullif(p_test_run->>'started_at','')::timestamptz, nullif(p_test_run->>'completed_at','')::timestamptz,
      nullif(p_test_run->>'exit_code','')::integer, p_test_run->>'output_summary', (p_test_run->>'created_at')::timestamptz)
    on conflict (id) do nothing;
  end if;
end;
$$;

revoke all on function public.persist_conversation_turn(uuid,uuid,jsonb,jsonb,jsonb,integer,jsonb,jsonb,jsonb,jsonb,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) from public;
grant execute on function public.persist_conversation_turn(uuid,uuid,jsonb,jsonb,jsonb,integer,jsonb,jsonb,jsonb,jsonb,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) to service_role;

-- Keep the existing bootstrap RPC signature while teaching it the new project,
-- message, and route fields. Existing clients remain compatible.
create or replace function public.persist_project_bootstrap(
  p_user_id uuid, p_project jsonb, p_memory jsonb, p_memory_version integer,
  p_requirements jsonb, p_acceptance_criteria jsonb, p_references jsonb,
  p_session jsonb, p_assistant_message jsonb
) returns void language plpgsql security definer set search_path = public as $$
declare p_project_id uuid := (p_project->>'id')::uuid;
declare route jsonb := p_assistant_message->'model_route';
begin
  if (p_project->>'user_id')::uuid <> p_user_id then
    raise exception 'project ownership check failed' using errcode = '42501';
  end if;
  insert into public.projects
    (id,user_id,title,initial_description,project_type,selected_model,model_mode,planning_depth,credit_budget,status,phase,next_recommended_action,created_at,updated_at)
  values (p_project_id,p_user_id,p_project->>'title',p_project->>'initial_description',p_project->>'project_type',p_project->>'selected_model',coalesce(p_project->>'model_mode','auto'),p_project->>'planning_depth',(p_project->>'credit_budget')::numeric,p_project->>'status',coalesce(p_project->>'phase','exploring'),p_project->'next_recommended_action',(p_project->>'created_at')::timestamptz,(p_project->>'updated_at')::timestamptz);
  insert into public.project_memory(project_id,memory,version) values(p_project_id,p_memory,p_memory_version);
  insert into public.requirements
    (id,project_id,type,category,description,priority,required,source,source_message_id,status,confidence,dependencies,version,created_at,updated_at)
  select r.id,p_project_id,r.type,r.category,r.description,r.priority,r.required,r.source,r.source_message_id,r.status,r.confidence,r.dependencies,r.version,r.created_at,r.updated_at
  from jsonb_to_recordset(coalesce(p_requirements,'[]'::jsonb)) as r(id text,project_id uuid,type text,category text,description text,priority text,required boolean,source text,source_message_id text,status text,confidence text,dependencies jsonb,version integer,created_at timestamptz,updated_at timestamptz);
  insert into public.acceptance_criteria
    (id,project_id,requirement_id,description,source,source_message_id,status,confidence,version,created_at,updated_at)
  select a.id,p_project_id,a.requirement_id,a.description,a.source,a.source_message_id,a.status,a.confidence,a.version,a.created_at,a.updated_at
  from jsonb_to_recordset(coalesce(p_acceptance_criteria,'[]'::jsonb)) as a(id text,project_id uuid,requirement_id text,description text,source text,source_message_id text,status text,confidence text,version integer,created_at timestamptz,updated_at timestamptz);
  insert into public.project_references(id,project_id,type,source,analysis,metadata,created_at)
  select r.id,p_project_id,r.type,r.source,r.analysis,r.metadata,r.created_at
  from jsonb_to_recordset(coalesce(p_references,'[]'::jsonb)) as r(id uuid,project_id uuid,type text,source text,analysis jsonb,metadata jsonb,created_at timestamptz);
  insert into public.interview_sessions(id,project_id,planning_depth,status,turn_count,created_at,updated_at)
  values ((p_session->>'id')::uuid,p_project_id,p_session->>'planning_depth',p_session->>'status',(p_session->>'turn_count')::integer,(p_session->>'created_at')::timestamptz,(p_session->>'updated_at')::timestamptz);
  insert into public.interview_messages(id,project_id,session_id,role,content,source,artifact_ids,model_route,metadata,created_at)
  values ((p_assistant_message->>'id')::uuid,p_project_id,(p_assistant_message->>'session_id')::uuid,p_assistant_message->>'role',p_assistant_message->>'content',p_assistant_message->>'source',coalesce(p_assistant_message->'artifact_ids','[]'::jsonb),route,coalesce(p_assistant_message->'metadata','{}'::jsonb),(p_assistant_message->>'created_at')::timestamptz);
  if route is not null and route <> 'null'::jsonb and nullif(route->>'requestId','') is not null then
    insert into public.model_routes(id,project_id,message_id,request_id,task_class,model_mode,chosen_model,reason_code,expected_cost_class,fallback_used)
    values (gen_random_uuid(),p_project_id,(p_assistant_message->>'id')::uuid,route->>'requestId',route->>'taskClass',coalesce(route->>'modelMode','auto'),route->>'chosenModel',route->>'reasonCode',route->>'expectedCostClass',coalesce((route->>'fallbackUsed')::boolean,false))
    on conflict (request_id) do nothing;
  end if;
end; $$;

notify pgrst, 'reload schema';
commit;
