-- Mark implementation prompts stale when canonical project memory advances.
-- A newly compiled prompt is inserted later in the same atomic turn and
-- becomes the current version through the existing artifact RPC behavior.
begin;

create or replace function public.supersede_stale_project_prompts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.project_artifacts
  set status = 'superseded', updated_at = timezone('utc', now())
  where project_id = new.project_id
    and status = 'current'
    and type in ('implementation_prompt', 'correction_prompt', 'enhancement_prompt')
    and case
      when coalesce(structured_data->>'memoryVersion', structured_data->>'generatedFromMemoryVersion', '') ~ '^[0-9]+$'
        then coalesce(structured_data->>'memoryVersion', structured_data->>'generatedFromMemoryVersion')::integer
      else -1
    end < new.version;
  return new;
end;
$$;

drop trigger if exists project_memory_supersede_stale_prompts on public.project_memory;
create trigger project_memory_supersede_stale_prompts
after insert or update of version on public.project_memory
for each row execute function public.supersede_stale_project_prompts();

revoke all on function public.supersede_stale_project_prompts() from public;
grant execute on function public.supersede_stale_project_prompts() to service_role;

commit;
