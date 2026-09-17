-- Bill detail, payments, voiding (with reopening the table) and print counts
-- (spec §9.3 admin_record_payment / admin_void_bill / admin_increment_print_count,
-- §10.1, §10.5, §10.7 the waiter comes back, §13.3 Bill detail, §8.8 audit;
-- docs/DECISIONS.md P5-6…P5-9, P5-15, P5-16).

-- ─── Document ───────────────────────────────────────────────────────────────
-- A stored bill in the shape the bill renderer reads (admin_sample_bill uses
-- the same keys).
create or replace function private.bill_document(p_bill public.bills)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_bill.id,
    'is_sample', false,
    'session_id', p_bill.session_id,
    'invoice_number', p_bill.invoice_number,
    'document_type', p_bill.document_type,
    'status', p_bill.status,
    'payment_status', p_bill.payment_status,
    'table_label', p_bill.table_label_snapshot,
    'waiter_name', p_bill.waiter_name_snapshot,
    'generated_at', p_bill.generated_at,
    'generated_by_name', (
      select m.display_name from public.restaurant_members m
      where m.restaurant_id = p_bill.restaurant_id and m.user_id = p_bill.generated_by
    ),
    'lines', p_bill.line_items,
    'restaurant', p_bill.restaurant_snapshot,
    'gst_mode', p_bill.gst_mode,
    'gst_rate_bps', p_bill.gst_rate_bps,
    'prices_include_tax', p_bill.prices_include_tax,
    'subtotal_paise', p_bill.subtotal_paise,
    'discount_type', p_bill.discount_type,
    'discount_value', p_bill.discount_value,
    'discount_paise', p_bill.discount_paise,
    'discount_reason', p_bill.discount_reason,
    'service_charge_bps', p_bill.service_charge_bps,
    'service_charge_paise', p_bill.service_charge_paise,
    'taxable_paise', p_bill.taxable_paise,
    'cgst_paise', p_bill.cgst_paise,
    'sgst_paise', p_bill.sgst_paise,
    'total_tax_paise', p_bill.total_tax_paise,
    'round_off_paise', p_bill.round_off_paise,
    'grand_total_paise', p_bill.grand_total_paise,
    'print_count', p_bill.print_count,
    'paid_at', p_bill.paid_at,
    'void_reason', p_bill.void_reason,
    'voided_at', p_bill.voided_at,
    'voided_by_name', (
      select m.display_name from public.restaurant_members m
      where m.restaurant_id = p_bill.restaurant_id and m.user_id = p_bill.voided_by
    )
  );
$$;

-- Why a bill can't be voided with "Reopen table" right now, or null when it
-- can: 'void' (already void), 'window' (no reopen window or it has passed),
-- 'table_busy' (new guests have opened the table).
create or replace function private.reopen_blocker(
  p_bill public.bills,
  p_session public.table_sessions,
  p_window_minutes int
)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_bill.status = 'void' or p_session.status <> 'billed' then 'void'
    when p_window_minutes = 0
      or now() > p_bill.generated_at + make_interval(mins => p_window_minutes) then 'window'
    when exists (
      select 1 from public.table_sessions s
      where s.restaurant_id = p_session.restaurant_id
        and s.dining_table_id = p_session.dining_table_id
        and s.status = 'open'
    ) then 'table_busy'
    else null
  end;
$$;

revoke execute on function private.bill_document(public.bills) from public, anon, authenticated;
revoke execute on function private.reopen_blocker(public.bills, public.table_sessions, int)
  from public, anon, authenticated;

-- ─── Bill detail ────────────────────────────────────────────────────────────
-- The bill, its payments, its audit trail (the bill and its table session,
-- oldest first), whether "Reopen table" is possible, and today's print options.
create or replace function public.admin_get_bill(p_bill_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_bill public.bills;
  v_session public.table_sessions;
  v_restaurant public.restaurants;
  v_blocker text;
begin
  select * into v_bill
  from public.bills b
  where b.id = p_bill_id and b.restaurant_id = v_ctx.restaurant_id;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  select * into v_session from public.table_sessions s where s.id = v_bill.session_id;
  select * into v_restaurant from public.restaurants r where r.id = v_bill.restaurant_id;
  v_blocker := private.reopen_blocker(v_bill, v_session, v_restaurant.reopen_window_minutes);

  return jsonb_build_object(
    'now', now(),
    'bill', private.bill_document(v_bill),
    'session', jsonb_build_object(
      'id', v_session.id,
      'status', v_session.status,
      'opened_at', v_session.opened_at
    ),
    'payments', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', p.id,
          'mode', p.mode,
          'amount_paise', p.amount_paise,
          'reference', p.reference,
          'is_void', p.is_void,
          'created_at', p.created_at,
          'recorded_by_name', (
            select m.display_name from public.restaurant_members m
            where m.restaurant_id = p.restaurant_id and m.user_id = p.recorded_by
          )
        )
        order by p.created_at, p.amount_paise desc, p.id
      )
      from public.bill_payments p
      where p.restaurant_id = v_bill.restaurant_id and p.bill_id = v_bill.id
    ), '[]'::jsonb),
    'audit', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', a.id,
          'action', a.action,
          'actor_label', a.actor_label,
          'actor_role', a.actor_role,
          'reason', a.reason,
          'before', a.before,
          'after', a.after,
          'created_at', a.created_at
        )
        order by a.created_at, a.action
      )
      from public.audit_logs a
      where a.restaurant_id = v_bill.restaurant_id
        and (
          (a.entity_type = 'bill' and a.entity_id = v_bill.id)
          or (a.entity_type = 'table_session' and a.entity_id = v_bill.session_id)
        )
    ), '[]'::jsonb),
    'reopen', jsonb_build_object(
      'allowed', v_blocker is null,
      'blocker', v_blocker,
      'until', case
        when v_restaurant.reopen_window_minutes > 0
          then v_bill.generated_at + make_interval(mins => v_restaurant.reopen_window_minutes)
        else null
      end
    ),
    'features', jsonb_build_object(
      'split_payments', private.has_feature(v_bill.restaurant_id, 'split_payments')
    ),
    'print', private.bill_print_settings(v_restaurant)
  );
end;
$$;

-- ─── Payments ───────────────────────────────────────────────────────────────
-- Records how an active, unpaid bill was paid: 1–10 rows of
-- { mode, amount_paise, reference? } adding up to the grand total. More than
-- one row needs the split_payments feature. Amounts are positive, except that
-- a ₹0 bill takes a single ₹0 row. Works in read-only mode (spec §10.6).
create or replace function public.admin_record_payment(p_bill_id uuid, p_payments jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_bill public.bills;
  v_row jsonb;
  v_mode text;
  v_amount bigint;
  v_reference text;
  v_rows jsonb := '[]'::jsonb;
  v_sum bigint := 0;
  v_count int;
  v_paid_at timestamptz := now();
begin
  select * into v_bill
  from public.bills b
  where b.id = p_bill_id and b.restaurant_id = v_ctx.restaurant_id
  for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  if v_bill.status = 'void' then
    perform private.fail('BILL_VOID');
  end if;
  if v_bill.payment_status = 'paid' then
    perform private.fail('BILL_ALREADY_PAID');
  end if;

  if jsonb_typeof(p_payments) is distinct from 'array' then
    perform private.fail('INVALID_INPUT', 'payments');
  end if;
  v_count := jsonb_array_length(p_payments);
  if v_count not between 1 and 10 then
    perform private.fail('INVALID_INPUT', 'payments');
  end if;
  if v_count > 1 and not private.has_feature(v_bill.restaurant_id, 'split_payments') then
    perform private.fail('FEATURE_NOT_IN_PLAN', 'split_payments');
  end if;

  for v_row in select value from jsonb_array_elements(p_payments) loop
    perform private.assert_keys(v_row, array['mode', 'amount_paise', 'reference']);
    v_mode := private.json_text(v_row, 'mode');
    if v_mode is null or v_mode not in ('cash', 'upi', 'card', 'other') then
      perform private.fail('INVALID_INPUT', 'mode');
    end if;
    v_amount := private.json_int(v_row, 'amount_paise');
    if v_amount < 0 or (v_amount = 0 and (v_bill.grand_total_paise > 0 or v_count > 1)) then
      perform private.fail('INVALID_INPUT', 'amount_paise');
    end if;
    v_reference := private.tidy_text(private.json_text(v_row, 'reference'));
    if length(v_reference) > 100 then
      perform private.fail('INVALID_INPUT', 'reference');
    end if;
    v_sum := v_sum + v_amount;
    v_rows := v_rows || jsonb_build_object(
      'mode', v_mode, 'amount_paise', v_amount, 'reference', v_reference
    );
  end loop;

  if v_sum <> v_bill.grand_total_paise then
    perform private.fail('PAYMENT_MISMATCH', v_bill.grand_total_paise::text);
  end if;

  insert into public.bill_payments (restaurant_id, bill_id, mode, amount_paise, reference, recorded_by, created_at)
  select v_bill.restaurant_id, v_bill.id, r.mode::public.payment_mode, r.amount_paise, r.reference,
         v_ctx.user_id, v_paid_at
  from jsonb_to_recordset(v_rows) as r(mode text, amount_paise bigint, reference text);

  update public.bills set payment_status = 'paid', paid_at = v_paid_at where id = v_bill.id;

  perform private.audit_as(
    v_ctx, 'payment.recorded', 'bill', v_bill.id,
    jsonb_build_object('payment_status', 'unpaid'),
    jsonb_build_object(
      'payment_status', 'paid',
      'invoice_number', v_bill.invoice_number,
      'grand_total_paise', v_bill.grand_total_paise,
      'payments', v_rows
    )
  );

  return jsonb_build_object('bill_id', v_bill.id, 'payment_status', 'paid', 'paid_at', v_paid_at);
end;
$$;

-- ─── Void ───────────────────────────────────────────────────────────────────
-- Voids a bill (its number is never reused, its payments are marked void).
-- With p_reopen, and only inside the reopen window while the table is still
-- free, the session opens again and its waiter comes back if they are active,
-- on duty and under their table limit; otherwise the table is Unassigned.
-- Refused reopens change nothing. Locks table → session → bill → waiter.
create or replace function public.admin_void_bill(p_bill_id uuid, p_reason text, p_reopen boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_bill public.bills;
  v_session public.table_sessions;
  v_restaurant public.restaurants;
  v_reason text;
  v_blocker text;
  v_reopen boolean := coalesce(p_reopen, false);
  v_waiter public.waiters;
  v_restored boolean := false;
begin
  select * into v_bill
  from public.bills b
  where b.id = p_bill_id and b.restaurant_id = v_ctx.restaurant_id;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  v_session := private.locked_session(v_ctx, v_bill.session_id, true);
  select * into v_bill from public.bills b where b.id = p_bill_id for update;

  if v_bill.status = 'void' then
    return jsonb_build_object(
      'bill_id', v_bill.id, 'status', 'void', 'changed', false, 'reopened', false
    );
  end if;
  v_reason := private.reason(p_reason);

  select * into v_restaurant from public.restaurants r where r.id = v_bill.restaurant_id;
  if v_reopen then
    v_blocker := private.reopen_blocker(v_bill, v_session, v_restaurant.reopen_window_minutes);
    if v_blocker is not null then
      perform private.fail('REOPEN_NOT_ALLOWED', v_blocker);
    end if;
  end if;

  update public.bills
  set status = 'void', void_reason = v_reason, voided_by = v_ctx.user_id, voided_at = now()
  where id = v_bill.id;
  update public.bill_payments
  set is_void = true
  where restaurant_id = v_bill.restaurant_id and bill_id = v_bill.id;

  perform private.audit_as(
    v_ctx, 'bill.voided', 'bill', v_bill.id,
    jsonb_build_object(
      'status', v_bill.status,
      'payment_status', v_bill.payment_status,
      'invoice_number', v_bill.invoice_number,
      'grand_total_paise', v_bill.grand_total_paise
    ),
    jsonb_build_object('status', 'void', 'reopen', v_reopen),
    v_reason
  );

  if v_reopen then
    update public.table_sessions
    set status = 'open', billed_at = null,
        assigned_waiter_id = null, assigned_at = null, assigned_by = null
    where id = v_session.id;
    perform private.audit_as(
      v_ctx, 'session.reopened', 'table_session', v_session.id,
      jsonb_build_object('status', 'billed', 'invoice_number', v_bill.invoice_number),
      jsonb_build_object('status', 'open', 'table', v_session.table_label_snapshot),
      v_reason
    );

    if v_bill.waiter_id is not null then
      select * into v_waiter
      from public.waiters w
      where w.restaurant_id = v_bill.restaurant_id and w.id = v_bill.waiter_id
      for update;
      if v_waiter.is_active and v_waiter.on_duty
        and cardinality(private.waiter_open_tables(v_bill.restaurant_id, v_waiter.id, v_session.id))
          < v_restaurant.max_tables_per_waiter
      then
        perform private.start_assignment(v_ctx, v_session.id, v_waiter.id);
        v_restored := true;
        perform private.audit_as(
          v_ctx, 'waiter.assigned', 'table_session', v_session.id, null,
          jsonb_build_object(
            'waiter_id', v_waiter.id, 'waiter_name', v_waiter.full_name,
            'table', v_session.table_label_snapshot, 'via', 'reopen'
          )
        );
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'bill_id', v_bill.id,
    'status', 'void',
    'changed', true,
    'reopened', v_reopen,
    'session_id', v_session.id,
    'assigned_waiter_id', case when v_restored then v_waiter.id else null end
  );
end;
$$;

-- ─── Print count ────────────────────────────────────────────────────────────
create or replace function public.admin_increment_print_count(p_bill_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_count int;
begin
  update public.bills
  set print_count = print_count + 1
  where id = p_bill_id and restaurant_id = v_ctx.restaurant_id
  returning print_count into v_count;
  if v_count is null then
    perform private.fail('NOT_FOUND');
  end if;
  return jsonb_build_object('bill_id', p_bill_id, 'print_count', v_count);
end;
$$;

revoke execute on function public.admin_get_bill(uuid) from public, anon;
revoke execute on function public.admin_record_payment(uuid, jsonb) from public, anon;
revoke execute on function public.admin_void_bill(uuid, text, boolean) from public, anon;
revoke execute on function public.admin_increment_print_count(uuid) from public, anon;

grant execute on function public.admin_get_bill(uuid) to authenticated;
grant execute on function public.admin_record_payment(uuid, jsonb) to authenticated;
grant execute on function public.admin_void_bill(uuid, text, boolean) to authenticated;
grant execute on function public.admin_increment_print_count(uuid) to authenticated;
