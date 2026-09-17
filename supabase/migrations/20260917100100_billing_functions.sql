-- Billing: open tables to bill, the live bill preview, bill generation and the
-- sample bill for test prints (spec §9.3, §10.5, §10.7, §11, §11.2, §13.3;
-- docs/DECISIONS.md P5-3…P5-6, P5-9, P5-10, P5-14).

-- ─── Document helpers ───────────────────────────────────────────────────────
-- Who the bill is from, frozen on the bill (spec §8.6 restaurant_snapshot).
create or replace function private.restaurant_bill_snapshot(p_restaurant public.restaurants)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'name', p_restaurant.name,
    'legal_name', p_restaurant.legal_name,
    'address_line', p_restaurant.address_line,
    'city', p_restaurant.city,
    'state', p_restaurant.state,
    'pincode', p_restaurant.pincode,
    'phone', p_restaurant.phone,
    'gstin', p_restaurant.gstin,
    'fssai_license', p_restaurant.fssai_license,
    'logo_path', p_restaurant.logo_path,
    'footer', p_restaurant.bill_footer_text
  );
$$;

-- How bills print today (docs/DECISIONS.md P5-6): paper, the "Served by" line,
-- branding, and a UPI QR only with the setting, the plan feature and a UPI ID.
create or replace function private.bill_print_settings(p_restaurant public.restaurants)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'paper_width', p_restaurant.paper_width,
    'timezone', p_restaurant.timezone,
    'print_waiter_on_bill', p_restaurant.print_waiter_on_bill,
    'show_branding', not private.has_feature(p_restaurant.id, 'remove_branding'),
    'upi', case
      when p_restaurant.show_upi_qr_on_bill
        and p_restaurant.upi_vpa is not null
        and private.has_feature(p_restaurant.id, 'upi_qr_on_bill')
        then jsonb_build_object(
          'vpa', p_restaurant.upi_vpa,
          'payee_name', coalesce(p_restaurant.upi_payee_name, p_restaurant.name)
        )
      else null
    end
  );
$$;

revoke execute on function private.restaurant_bill_snapshot(public.restaurants)
  from public, anon, authenticated;
revoke execute on function private.bill_print_settings(public.restaurants)
  from public, anon, authenticated;

-- ─── Open tables to bill ────────────────────────────────────────────────────
-- Every open session, oldest first, with what it would bill so far.
create or replace function public.admin_billing_sessions()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
begin
  return jsonb_build_object(
    'now', now(),
    'sessions', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'session_id', s.id,
          'table_label', s.table_label_snapshot,
          'opened_at', s.opened_at,
          'waiter_id', s.assigned_waiter_id,
          'waiter_name', w.full_name,
          'items', d.items,
          'subtotal_paise', d.subtotal_paise,
          'unserved', d.unserved,
          'waiting', (
            select count(*)::int
            from public.orders o
            where o.restaurant_id = s.restaurant_id and o.session_id = s.id
              and private.is_waiting(o)
          )
        )
        order by s.opened_at, s.table_label_snapshot
      )
      from public.table_sessions s
      left join public.waiters w
        on w.restaurant_id = s.restaurant_id and w.id = s.assigned_waiter_id
      cross join lateral (
        select
          coalesce(sum(oi.quantity), 0)::int as items,
          coalesce(sum(oi.quantity * oi.unit_price_paise), 0)::bigint as subtotal_paise,
          coalesce(sum(oi.quantity) filter (where oi.status <> 'served'), 0)::int as unserved
        from public.order_items oi
        join public.orders o
          on o.restaurant_id = oi.restaurant_id and o.session_id = oi.session_id
          and o.id = oi.order_id
        where oi.restaurant_id = s.restaurant_id and oi.session_id = s.id
          and o.status = 'accepted'
          and oi.status in ('placed', 'preparing', 'ready', 'served')
      ) as d
      where s.restaurant_id = v_ctx.restaurant_id and s.status = 'open'
    ), '[]'::jsonb)
  );
end;
$$;

-- ─── Preview ────────────────────────────────────────────────────────────────
-- The bill builder's data for an open session, recomputed for the chosen
-- discount and service charge. Nothing is saved. Blockers (waiting rounds,
-- nothing to bill, no waiter) come back as data; generation enforces them.
create or replace function public.admin_preview_bill(
  p_session_id uuid,
  p_discount_type public.discount_type,
  p_discount_value bigint,
  p_apply_service_charge boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_session public.table_sessions;
  v_bill_id uuid;
begin
  select * into v_session
  from public.table_sessions s
  where s.id = p_session_id and s.restaurant_id = v_ctx.restaurant_id;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  if v_session.status <> 'open' then
    select b.id into v_bill_id
    from public.bills b
    where b.restaurant_id = v_session.restaurant_id and b.session_id = v_session.id
      and b.status = 'active';
    if v_bill_id is not null then
      perform private.fail('ALREADY_BILLED', v_bill_id::text);
    end if;
    perform private.fail('SESSION_NOT_OPEN');
  end if;

  return private.bill_draft(v_session, p_discount_type, p_discount_value, p_apply_service_charge);
end;
$$;

-- ─── Generate ───────────────────────────────────────────────────────────────
-- Locks the table, the session and its dishes (docs/DECISIONS.md P4-10, P5-4),
-- refuses while a round waits, with nothing to bill, or without a waiter when
-- the restaurant has waiter profiles; then numbers the invoice, stores the
-- snapshots, marks the session billed (the table is free again) and ends the
-- waiter's assignment. Works in read-only mode (spec §10.6).
create or replace function public.admin_generate_bill(
  p_session_id uuid,
  p_discount_type public.discount_type,
  p_discount_value bigint,
  p_discount_reason text,
  p_apply_service_charge boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_session public.table_sessions;
  v_restaurant public.restaurants;
  v_bill_id uuid;
  v_draft jsonb;
  v_totals jsonb;
  v_reason text;
  v_generated_at timestamptz := now();
  v_financial_year text;
  v_seq int;
  v_invoice_number text;
begin
  v_session := private.locked_session(v_ctx, p_session_id, true);
  if v_session.status <> 'open' then
    select b.id into v_bill_id
    from public.bills b
    where b.restaurant_id = v_session.restaurant_id and b.session_id = v_session.id
      and b.status = 'active';
    if v_bill_id is not null then
      perform private.fail('ALREADY_BILLED', v_bill_id::text);
    end if;
    perform private.fail('SESSION_NOT_OPEN');
  end if;

  -- Customer cancels lock the dish; hold them until the bill is written.
  perform 1
  from public.order_items oi
  where oi.restaurant_id = v_session.restaurant_id and oi.session_id = v_session.id
  for update;

  v_draft := private.bill_draft(v_session, p_discount_type, p_discount_value, p_apply_service_charge);
  if (v_draft ->> 'waiting_count')::int > 0 then
    perform private.fail('ORDERS_WAITING', v_draft ->> 'waiting_count');
  end if;
  if jsonb_array_length(v_draft -> 'lines') = 0 then
    perform private.fail('NOTHING_TO_BILL');
  end if;
  if (v_draft ->> 'waiter_required')::boolean then
    perform private.fail('WAITER_REQUIRED');
  end if;
  v_totals := v_draft -> 'totals';
  if (v_totals ->> 'discount_paise')::bigint > 0 then
    v_reason := private.reason(p_discount_reason);
  end if;

  select * into v_restaurant from public.restaurants r where r.id = v_session.restaurant_id;
  v_financial_year := private.financial_year(v_generated_at, v_restaurant.timezone);
  insert into public.invoice_counters as c (restaurant_id, financial_year, last_seq)
  values (v_restaurant.id, v_financial_year, 1)
  on conflict (restaurant_id, financial_year) do update set last_seq = c.last_seq + 1
  returning c.last_seq into v_seq;
  -- lpad would cut a sixth digit off, so longer numbers are left as they are.
  v_invoice_number := v_restaurant.invoice_prefix || '/' || v_financial_year || '/'
    || case when v_seq < 100000 then lpad(v_seq::text, 5, '0') else v_seq::text end;

  insert into public.bills (
    restaurant_id, session_id, invoice_number, financial_year, invoice_seq, document_type,
    table_label_snapshot, waiter_id, waiter_name_snapshot, line_items, restaurant_snapshot,
    gst_mode, gst_rate_bps, prices_include_tax,
    subtotal_paise, discount_type, discount_value, discount_paise, discount_reason,
    service_charge_bps, service_charge_paise, taxable_paise, cgst_paise, sgst_paise,
    total_tax_paise, round_off_paise, grand_total_paise, generated_by, generated_at
  )
  values (
    v_restaurant.id, v_session.id, v_invoice_number, v_financial_year, v_seq,
    (v_draft ->> 'document_type')::public.document_type,
    v_session.table_label_snapshot,
    (v_draft -> 'waiter' ->> 'id')::uuid, v_draft -> 'waiter' ->> 'name',
    v_draft -> 'lines', private.restaurant_bill_snapshot(v_restaurant),
    v_restaurant.gst_mode, v_restaurant.gst_rate_bps, v_restaurant.prices_include_tax,
    (v_totals ->> 'subtotal_paise')::bigint,
    (v_draft ->> 'discount_type')::public.discount_type,
    (v_draft ->> 'discount_value')::bigint,
    (v_totals ->> 'discount_paise')::bigint,
    v_reason,
    (v_draft ->> 'service_charge_bps')::int,
    (v_totals ->> 'service_charge_paise')::bigint,
    (v_totals ->> 'taxable_paise')::bigint,
    (v_totals ->> 'cgst_paise')::bigint,
    (v_totals ->> 'sgst_paise')::bigint,
    (v_totals ->> 'total_tax_paise')::bigint,
    (v_totals ->> 'round_off_paise')::bigint,
    (v_totals ->> 'grand_total_paise')::bigint,
    v_ctx.user_id, v_generated_at
  )
  returning id into v_bill_id;

  update public.table_sessions
  set status = 'billed', billed_at = v_generated_at
  where id = v_session.id;
  -- The waiter is free again; assigned_waiter_id stays as history (P4-11).
  perform private.end_assignment(v_session.id, 'billed');

  perform private.audit_as(
    v_ctx, 'bill.generated', 'bill', v_bill_id, null,
    jsonb_build_object(
      'invoice_number', v_invoice_number,
      'session_id', v_session.id,
      'table', v_session.table_label_snapshot,
      'waiter_id', v_draft -> 'waiter' -> 'id',
      'subtotal_paise', v_totals -> 'subtotal_paise',
      'grand_total_paise', v_totals -> 'grand_total_paise'
    )
  );
  if v_reason is not null then
    perform private.audit_as(
      v_ctx, 'discount.applied', 'bill', v_bill_id, null,
      jsonb_build_object(
        'discount_type', v_draft -> 'discount_type',
        'discount_value', v_draft -> 'discount_value',
        'discount_paise', v_totals -> 'discount_paise'
      ),
      v_reason
    );
  end if;

  return jsonb_build_object(
    'bill_id', v_bill_id,
    'invoice_number', v_invoice_number,
    'grand_total_paise', (v_totals ->> 'grand_total_paise')::bigint
  );
end;
$$;

-- ─── Sample bill ────────────────────────────────────────────────────────────
-- A bill for "Test print" (spec §15): the §11.1 dishes priced with the saved
-- settings, shaped like admin_get_bill. Nothing is saved or numbered.
create or replace function public.admin_sample_bill()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_restaurant public.restaurants;
  v_pricing jsonb;
  v_totals jsonb;
begin
  select * into v_restaurant from public.restaurants r where r.id = v_ctx.restaurant_id;
  v_pricing := private.bill_pricing(
    v_restaurant,
    jsonb_build_array(
      jsonb_build_object('name', 'Paneer Tikka', 'variant', null, 'qty', 1, 'unit_price_paise', 28000, 'line_total_paise', 28000, 'food_type', 'veg'),
      jsonb_build_object('name', 'Butter Naan', 'variant', null, 'qty', 3, 'unit_price_paise', 6000, 'line_total_paise', 18000, 'food_type', 'veg'),
      jsonb_build_object('name', 'Dal Makhani', 'variant', null, 'qty', 1, 'unit_price_paise', 24000, 'line_total_paise', 24000, 'food_type', 'veg')
    ),
    'none', 0, true
  );
  v_totals := v_pricing -> 'totals';

  return jsonb_build_object(
    'bill', jsonb_build_object(
      'id', null,
      'is_sample', true,
      'invoice_number', v_restaurant.invoice_prefix || '/'
        || private.financial_year(now(), v_restaurant.timezone) || '/00000',
      'document_type', v_pricing -> 'document_type',
      'status', 'active',
      'payment_status', 'unpaid',
      'table_label', '1',
      'waiter_name', 'Sample waiter',
      'generated_at', now(),
      'generated_by_name', v_ctx.display_name,
      'lines', v_pricing -> 'lines',
      'restaurant', private.restaurant_bill_snapshot(v_restaurant),
      'gst_mode', v_restaurant.gst_mode,
      'gst_rate_bps', v_restaurant.gst_rate_bps,
      'prices_include_tax', v_restaurant.prices_include_tax,
      'discount_type', 'none',
      'discount_value', 0,
      'discount_reason', null,
      'service_charge_bps', v_pricing -> 'service_charge_bps',
      'print_count', 0,
      'paid_at', null,
      'void_reason', null,
      'voided_at', null,
      'voided_by_name', null
    ) || (v_totals - 'pre_round_paise'),
    'print', private.bill_print_settings(v_restaurant)
  );
end;
$$;

revoke execute on function public.admin_billing_sessions() from public, anon;
revoke execute on function public.admin_preview_bill(uuid, public.discount_type, bigint, boolean)
  from public, anon;
revoke execute on function public.admin_generate_bill(
  uuid, public.discount_type, bigint, text, boolean
) from public, anon;
revoke execute on function public.admin_sample_bill() from public, anon;

grant execute on function public.admin_billing_sessions() to authenticated;
grant execute on function public.admin_preview_bill(uuid, public.discount_type, bigint, boolean)
  to authenticated;
grant execute on function public.admin_generate_bill(
  uuid, public.discount_type, bigint, text, boolean
) to authenticated;
grant execute on function public.admin_sample_bill() to authenticated;
