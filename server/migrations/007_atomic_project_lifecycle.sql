-- Make the remaining multi-row project lifecycle transitions atomic.
begin;

create or replace function public.persist_project_bootstrap(
  p_user_id uuid, p_project jsonb, p_memory jsonb, p_memory_version integer,
  p_requirements jsonb, p_acceptance_criteria jsonb, p_references jsonb,
  p_session jsonb, p_assistant_message jsonb
) returns void language plpgsql security definer set search_path = public as $$
declare p_project_id uuid := (p_project->>'id')::uuid;
begin
  if (p_project->>'user_id')::uuid <> p_user_id then
    raise exception 'project ownership check failed' using errcode = '42501';
  end if;
  insert into public.projects
    (id,user_id,title,initial_description,project_type,selected_model,planning_depth,credit_budget,status,created_at,updated_at)
  values (p_project_id,p_user_id,p_project->>'title',p_project->>'initial_description',p_project->>'project_type',p_project->>'selected_model',p_project->>'planning_depth',(p_project->>'credit_budget')::numeric,p_project->>'status',(p_project->>'created_at')::timestamptz,(p_project->>'updated_at')::timestamptz);
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
  insert into public.interview_messages(id,project_id,session_id,role,content,source,created_at)
  values ((p_assistant_message->>'id')::uuid,p_project_id,(p_assistant_message->>'session_id')::uuid,p_assistant_message->>'role',p_assistant_message->>'content',p_assistant_message->>'source',(p_assistant_message->>'created_at')::timestamptz);
end; $$;

create or replace function public.save_srs_and_status(p_user_id uuid,p_project_id uuid,p_srs jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists(select 1 from public.projects where id=p_project_id and user_id=p_user_id) then raise exception 'project ownership check failed' using errcode='42501'; end if;
  insert into public.srs_documents(id,project_id,version,title,content,requirement_ids,status,created_at)
  values(p_srs->>'id',p_project_id,(p_srs->>'version')::integer,p_srs->>'title',p_srs->>'content',p_srs->'requirement_ids',p_srs->>'status',(p_srs->>'created_at')::timestamptz);
  update public.projects set status='srs_ready',updated_at=timezone('utc',now()) where id=p_project_id;
end; $$;

create or replace function public.approve_srs_atomic(p_user_id uuid,p_project_id uuid,p_srs_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists(select 1 from public.projects where id=p_project_id and user_id=p_user_id) then raise exception 'project ownership check failed' using errcode='42501'; end if;
  if not exists(select 1 from public.srs_documents where id=p_srs_id and project_id=p_project_id) then raise exception 'specification not found' using errcode='P0002'; end if;
  update public.srs_documents set status=case when id=p_srs_id then 'approved' else 'superseded' end where project_id=p_project_id;
  update public.projects set approved_srs_version_id=p_srs_id,status='approved',updated_at=timezone('utc',now()) where id=p_project_id;
end; $$;

create or replace function public.save_plan_and_status(p_user_id uuid,p_project_id uuid,p_srs_id text,p_prompt_id uuid,p_plan jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists(select 1 from public.projects where id=p_project_id and user_id=p_user_id) then raise exception 'project ownership check failed' using errcode='42501'; end if;
  insert into public.generated_prompts(id,project_id,srs_document_id,kind,iteration,prompt,data,created_at)
  values(p_prompt_id,p_project_id,p_srs_id,'implementation',1,p_plan->>'prompt',p_plan,(p_plan->>'createdAt')::timestamptz);
  update public.projects set status='implementation',updated_at=timezone('utc',now()) where id=p_project_id;
end; $$;

revoke all on function public.persist_project_bootstrap(uuid,jsonb,jsonb,integer,jsonb,jsonb,jsonb,jsonb,jsonb) from public;
revoke all on function public.save_srs_and_status(uuid,uuid,jsonb) from public;
revoke all on function public.approve_srs_atomic(uuid,uuid,text) from public;
revoke all on function public.save_plan_and_status(uuid,uuid,text,uuid,jsonb) from public;
grant execute on function public.persist_project_bootstrap(uuid,jsonb,jsonb,integer,jsonb,jsonb,jsonb,jsonb,jsonb) to service_role;
grant execute on function public.save_srs_and_status(uuid,uuid,jsonb) to service_role;
grant execute on function public.approve_srs_atomic(uuid,uuid,text) to service_role;
grant execute on function public.save_plan_and_status(uuid,uuid,text,uuid,jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
