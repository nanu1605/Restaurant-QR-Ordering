-- admin_update_table locked the restaurant row FOR UPDATE and then waited for
-- the dining table. An order at that table does the opposite: it holds the
-- table lock and its inserts need a key-share lock on the restaurant row, which
-- FOR UPDATE blocks — a deadlock. FOR NO KEY UPDATE still serialises the plan
-- limit checks (it conflicts with itself and with FOR UPDATE) but lets orders'
-- foreign-key checks through (docs/DECISIONS.md P4-10). Otherwise unchanged.
create or replace function public.admin_update_table(p_table_id uuid, p_patch jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_table public.dining_tables%rowtype;
  v_label text;
  v_active boolean;
  v_max_tables int;
  v_max_staff int;
  v_count int;
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  perform private.assert_keys(p_patch, array['label', 'is_active']);
  perform 1 from public.restaurants r where r.id = v_ctx.restaurant_id for no key update;

  select * into v_table from public.dining_tables d
    where d.id = p_table_id and d.restaurant_id = v_ctx.restaurant_id
    for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;

  if p_patch ? 'label' then
    v_label := private.tidy_text(private.json_text(p_patch, 'label'));
    if v_label is null or length(v_label) > 30 then
      perform private.fail('INVALID_TABLE_LABEL');
    end if;
  end if;
  if p_patch ? 'is_active' then
    v_active := private.json_bool(p_patch, 'is_active');
  end if;

  if v_active is false and v_table.is_active and exists (
    select 1 from public.table_sessions s
    where s.dining_table_id = p_table_id and s.status = 'open'
  ) then
    perform private.fail('TABLE_HAS_OPEN_SESSION');
  end if;

  if v_active is true and not v_table.is_active then
    select l.max_tables, l.max_staff into v_max_tables, v_max_staff
      from private.plan_limits(v_ctx.restaurant_id) as l;
    select count(*) into v_count
      from public.dining_tables d
      where d.restaurant_id = v_ctx.restaurant_id and d.is_active;
    if v_max_tables is not null and v_count + 1 > v_max_tables then
      perform private.fail('PLAN_LIMIT_TABLES', v_max_tables::text);
    end if;
  end if;

  begin
    update public.dining_tables d
      set label = coalesce(v_label, d.label),
          is_active = coalesce(v_active, d.is_active)
      where d.id = p_table_id;
  exception when unique_violation then
    perform private.fail('TABLE_LABEL_TAKEN', coalesce(v_label, v_table.label));
  end;
end;
$$;

revoke execute on function public.admin_update_table(uuid, jsonb) from public, anon;
grant execute on function public.admin_update_table(uuid, jsonb) to authenticated;
