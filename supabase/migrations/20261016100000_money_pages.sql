-- Stop 12c (docs/SUPER_ADMIN_PLAN.md 12c, docs/DECISIONS.md SA-17 to SA-21):
-- the payments ledger, dues, and the subscription states on the Subscriptions
-- list.

-- ─── What a subscription payment paid for ───────────────────────────────────
-- Stamped when a payment is recorded, so a later plan change doesn't rewrite
-- history (SA-17). Setup fees have neither.
alter table public.subscription_payments
  add column plan_id uuid references public.plans (id),
  add column billing_cycle public.billing_cycle;

create index subscription_payments_created_idx on public.subscription_payments (created_at);

-- Every insert path goes through here. A Razorpay charge pays for the plan
-- the mandate was set up with (next_plan_id until the charge applies it);
-- anything else pays for the current plan. A paid period of 360 days or more
-- is yearly, a shorter one monthly; a charge without a period takes the
-- subscription's cycle.
create function private.stamp_payment_plan()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_sub public.restaurant_subscriptions;
begin
  if new.purpose <> 'subscription' or new.plan_id is not null then
    return new;
  end if;
  select * into v_sub
  from public.restaurant_subscriptions s
  where s.restaurant_id = new.restaurant_id;
  if not found then
    return new;
  end if;
  if new.source = 'razorpay' then
    new.plan_id := coalesce(v_sub.next_plan_id, v_sub.plan_id);
  else
    new.plan_id := v_sub.plan_id;
  end if;
  new.billing_cycle := coalesce(
    new.billing_cycle,
    case
      when new.period_end - new.period_start >= interval '360 days' then 'yearly'
      when new.period_end > new.period_start then 'monthly'
    end::public.billing_cycle,
    case when new.source = 'razorpay' then v_sub.next_billing_cycle end,
    v_sub.billing_cycle
  );
  return new;
end;
$$;

create trigger stamp_payment_plan before insert on public.subscription_payments
  for each row execute function private.stamp_payment_plan();

revoke execute on function private.stamp_payment_plan() from public, anon, authenticated;

-- Earlier payments: the restaurant's current plan is the best there is.
update public.subscription_payments p
  set plan_id = s.plan_id,
      billing_cycle = coalesce(
        case
          when p.period_end - p.period_start >= interval '360 days' then 'yearly'
          when p.period_end > p.period_start then 'monthly'
        end::public.billing_cycle,
        s.billing_cycle
      )
  from public.restaurant_subscriptions s
  where s.restaurant_id = p.restaurant_id and p.purpose = 'subscription';

-- ─── Shared money rules ─────────────────────────────────────────────────────

-- A fee with GST, rounded like withGst() in src/features/subscriptions/gst.ts.
create function private.fee_with_gst(p_paise bigint)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select p_paise + round(p_paise * private.fee_gst_bps() / 10000.0)::bigint;
$$;
revoke execute on function private.fee_with_gst(bigint) from public, anon, authenticated;

-- One billing cycle's price, before GST.
create function private.cycle_price_paise(p_plan public.plans, p_cycle public.billing_cycle)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case when p_cycle = 'yearly' then p_plan.price_yearly_paise
    else p_plan.price_monthly_paise end;
$$;
revoke execute on function private.cycle_price_paise(public.plans, public.billing_cycle)
  from public, anon, authenticated;

-- How a paid period renews (plan §5.6): 'autopay' (a mandate will charge),
-- 'needs_payment' (source manual: paid by hand or by link, which never renews
-- on its own) or 'ending' (set to end, or autopay switched off).
create function private.renewal_kind(p_sub public.restaurant_subscriptions)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_sub.cancel_at_period_end then 'ending'
    when private.razorpay_managed(p_sub) then 'autopay'
    when p_sub.source = 'manual' then 'needs_payment'
    else 'ending'
  end;
$$;
revoke execute on function private.renewal_kind(public.restaurant_subscriptions)
  from public, anon, authenticated;

-- ─── Payments ledger (plan §4.2, §5.4) ──────────────────────────────────────
-- Payments recorded between two India dates, newest first, with totals of
-- every matching row. p_filters: from, to ('YYYY-MM-DD'), q (restaurant name
-- or code), purpose, method (autopay, payment_link, or a manual mode), plan
-- (code), page; export: true returns up to 10,000 rows on one page.
create function public.platform_list_payments(p_filters jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_from date;
  v_to date;
  v_q text;
  v_purpose text;
  v_method text;
  v_plan text;
  v_page int;
  v_page_size int := 50;
  v_totals jsonb;
  v_rows jsonb;
begin
  perform private.require_platform_permission('money.view');
  perform private.assert_keys(
    v_filters, array['from', 'to', 'q', 'purpose', 'method', 'plan', 'page', 'export']
  );
  v_from := private.json_date(v_filters, 'from');
  v_to := private.json_date(v_filters, 'to');
  if v_from is not null and v_to is not null and v_to < v_from then
    perform private.fail('INVALID_INPUT', 'to');
  end if;
  v_q := nullif(btrim(coalesce(private.json_text(v_filters, 'q'), '')), '');
  if length(v_q) > 80 then
    perform private.fail('INVALID_INPUT', 'q');
  end if;
  v_purpose := private.json_text(v_filters, 'purpose');
  if v_purpose is not null and v_purpose not in ('subscription', 'setup_fee') then
    perform private.fail('INVALID_INPUT', 'purpose');
  end if;
  v_method := private.json_text(v_filters, 'method');
  if v_method is not null and v_method not in (
    'autopay', 'payment_link', 'bank_transfer', 'cash', 'upi', 'cheque'
  ) then
    perform private.fail('INVALID_INPUT', 'method');
  end if;
  v_plan := private.json_text(v_filters, 'plan');
  if v_plan is not null and v_plan !~ '^[a-z_]{2,30}$' then
    perform private.fail('INVALID_INPUT', 'plan');
  end if;
  v_page := case
    when coalesce(jsonb_typeof(v_filters -> 'page'), 'null') = 'null' then 1
    else private.json_int(v_filters, 'page')
  end;
  if v_page < 1 or v_page > 10000 then
    perform private.fail('INVALID_INPUT', 'page');
  end if;
  if v_filters ? 'export' and private.json_bool(v_filters, 'export') then
    v_page := 1;
    v_page_size := 10000;
  end if;

  with matching as (
    select
      p.id, p.created_at, p.restaurant_id, r.name, r.slug, p.purpose, p.source,
      pl.code as plan_code, pl.name as plan_name, p.billing_cycle,
      p.base_paise, p.gst_paise, p.amount_paise, m.method, p.razorpay_payment_id,
      p.period_start, p.period_end, p.recorded_by, p.notes,
      p.list_price_paise, p.discount_paise
    from public.subscription_payments p
    join public.restaurants r on r.id = p.restaurant_id
    left join public.plans pl on pl.id = p.plan_id
    cross join lateral (
      select case p.source
        when 'razorpay' then 'autopay'
        when 'payment_link' then 'payment_link'
        else p.manual_mode::text
      end as method
    ) as m
    where (v_from is null or p.created_at >= v_from::timestamp at time zone 'Asia/Kolkata')
      and (v_to is null or p.created_at < (v_to + 1)::timestamp at time zone 'Asia/Kolkata')
      and (v_q is null or r.name ilike '%' || v_q || '%' or r.slug ilike '%' || v_q || '%')
      and (v_purpose is null or p.purpose = v_purpose)
      and (v_method is null or m.method = v_method)
      and (v_plan is null or pl.code = v_plan)
  ),
  page as (
    select m.*
    from matching m
    order by m.created_at desc, m.id desc
    limit v_page_size offset (v_page - 1) * v_page_size
  )
  select
    (
      select jsonb_build_object(
        'count', count(*),
        'base_paise', coalesce(sum(m.base_paise), 0),
        'gst_paise', coalesce(sum(m.gst_paise), 0),
        'amount_paise', coalesce(sum(m.amount_paise), 0),
        'subscription_base_paise',
          coalesce(sum(m.base_paise) filter (where m.purpose = 'subscription'), 0),
        'setup_fee_base_paise',
          coalesce(sum(m.base_paise) filter (where m.purpose = 'setup_fee'), 0)
      )
      from matching m
    ),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'payment_id', pg.id,
        'created_at', pg.created_at,
        'restaurant_id', pg.restaurant_id,
        'restaurant_name', pg.name,
        'slug', pg.slug,
        'purpose', pg.purpose,
        'plan_code', pg.plan_code,
        'plan_name', pg.plan_name,
        'billing_cycle', pg.billing_cycle,
        'base_paise', pg.base_paise,
        'gst_paise', pg.gst_paise,
        'amount_paise', pg.amount_paise,
        'method', pg.method,
        'razorpay_payment_id', pg.razorpay_payment_id,
        'period_start', pg.period_start,
        'period_end', pg.period_end,
        'recorded_by', u.email,
        'notes', pg.notes,
        'list_price_paise', pg.list_price_paise,
        'discount_paise', pg.discount_paise
      ) order by pg.created_at desc, pg.id desc)
      from page pg
      left join auth.users u on u.id = pg.recorded_by
    ), '[]'::jsonb)
  into v_totals, v_rows;

  return jsonb_build_object(
    'page', v_page,
    'page_size', v_page_size,
    'total', (v_totals ->> 'count')::bigint,
    'totals', v_totals,
    'rows', v_rows
  );
end;
$$;

revoke execute on function public.platform_list_payments(jsonb) from public, anon;
grant execute on function public.platform_list_payments(jsonb) to authenticated;

-- ─── Dues (plan §5.6) ───────────────────────────────────────────────────────
-- Each restaurant that isn't suspended falls in at most one bucket, first
-- match wins: payment_failed (Razorpay is retrying, still full access),
-- lapsed (read-only), trial_ending (within 3 days, no autopay mandate) and
-- renewal_due (a paid period ending within p_filters.days, 7 or 30). The
-- amount due is the plan's price for its cycle (monthly when none) with GST;
-- while a Razorpay mandate is live, its plan and cycle, which is what Razorpay
-- charges (as private.stamp_payment_plan). Renewals come by kind: autopay,
-- needs a payment, ending, with each kind's count.
-- Expected collections are the next 30 days' renewals, by autopay and by
-- hand. p_filters: bucket, days, q (restaurant name or code), page.
create function public.platform_list_dues(p_filters jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_bucket text;
  v_days int;
  v_q text;
  v_page int;
  v_page_size constant int := 50;
  v_counts jsonb;
  v_expected jsonb;
  v_kinds jsonb;
  v_total bigint;
  v_rows jsonb;
begin
  perform private.require_platform_permission('money.view');
  perform private.assert_keys(v_filters, array['bucket', 'days', 'q', 'page']);
  v_bucket := coalesce(private.json_text(v_filters, 'bucket'), 'payment_failed');
  if v_bucket not in ('payment_failed', 'lapsed', 'trial_ending', 'renewal_due') then
    perform private.fail('INVALID_INPUT', 'bucket');
  end if;
  v_days := case
    when coalesce(jsonb_typeof(v_filters -> 'days'), 'null') = 'null' then 30
    else private.json_int(v_filters, 'days')
  end;
  if v_days not in (7, 30) then
    perform private.fail('INVALID_INPUT', 'days');
  end if;
  v_q := nullif(btrim(coalesce(private.json_text(v_filters, 'q'), '')), '');
  if length(v_q) > 80 then
    perform private.fail('INVALID_INPUT', 'q');
  end if;
  v_page := case
    when coalesce(jsonb_typeof(v_filters -> 'page'), 'null') = 'null' then 1
    else private.json_int(v_filters, 'page')
  end;
  if v_page < 1 or v_page > 10000 then
    perform private.fail('INVALID_INPUT', 'page');
  end if;

  with subs as (
    select
      r.id as restaurant_id, r.name, r.slug, r.city, r.phone,
      s.status, s.source, s.billing_cycle, s.trial_ends_at, s.current_period_end,
      s.grace_until, s.cancel_at_period_end, s.razorpay_status,
      private.razorpay_managed(s) as autopay,
      private.renewal_kind(s) as renewal_kind,
      pl.code as plan_code, pl.name as plan_name,
      private.fee_with_gst(private.cycle_price_paise(pl, coalesce(
        case when m.live then s.next_billing_cycle end, s.billing_cycle, 'monthly'
      ))) as due_paise,
      a.state as access_state, a.reason as access_reason, a.restriction_at
    from public.restaurants r
    join public.restaurant_subscriptions s on s.restaurant_id = r.id
    -- A mandate Razorpay charges or retries; one not yet paid for has its plan
    -- waiting in next_plan_id.
    cross join lateral (
      select coalesce(s.razorpay_status in ('authenticated', 'active', 'pending', 'halted'), false)
        as live
    ) as m
    join public.plans pl on pl.id = coalesce(case when m.live then s.next_plan_id end, s.plan_id)
    cross join lateral public.restaurant_access(r.id) as a
    where r.status = 'active'
      and (v_q is null or r.name ilike '%' || v_q || '%' or r.slug ilike '%' || v_q || '%')
  ),
  dues as (
    select subs.*, b.bucket, b.bucket = v_bucket and (
        v_bucket <> 'renewal_due'
        or subs.current_period_end <= now() + make_interval(days => v_days)
      ) as chosen,
      case v_bucket
        when 'payment_failed' then coalesce(subs.grace_until, subs.current_period_end)
        when 'lapsed' then subs.restriction_at
        when 'trial_ending' then subs.trial_ends_at
        else subs.current_period_end
      end as sort_at
    from subs
    cross join lateral (
      select case
        when subs.access_state = 'full' and subs.status in ('past_due', 'halted')
          then 'payment_failed'
        when subs.access_state = 'read_only' then 'lapsed'
        when subs.status = 'trialing' and not subs.autopay
          and subs.trial_ends_at <= now() + interval '3 days'
          then 'trial_ending'
        when subs.status = 'active' and subs.source is not null
          and subs.current_period_end <= now() + interval '30 days'
          then 'renewal_due'
      end as bucket
    ) as b
    where b.bucket is not null
  ),
  page as (
    select d.*
    from dues d
    where d.chosen
    -- Renewals by kind; lapsed: most recent first; the rest: soonest first.
    order by
      case when v_bucket = 'renewal_due'
        then array_position(array['autopay', 'needs_payment', 'ending'], d.renewal_kind) end,
      case when v_bucket <> 'lapsed' then d.sort_at end asc nulls last,
      case when v_bucket = 'lapsed' then d.sort_at end desc nulls last,
      d.name, d.restaurant_id
    limit v_page_size offset (v_page - 1) * v_page_size
  )
  select
    jsonb_build_object(
      'payment_failed', count(*) filter (where d.bucket = 'payment_failed'),
      'lapsed', count(*) filter (where d.bucket = 'lapsed'),
      'trial_ending', count(*) filter (where d.bucket = 'trial_ending'),
      'renewal_due', count(*) filter (
        where d.bucket = 'renewal_due'
          and d.current_period_end <= now() + make_interval(days => v_days)
      )
    ),
    jsonb_build_object(
      'autopay_paise', coalesce(sum(d.due_paise) filter (
        where d.bucket = 'renewal_due' and d.renewal_kind = 'autopay'), 0),
      'autopay_count', count(*) filter (
        where d.bucket = 'renewal_due' and d.renewal_kind = 'autopay'),
      'needs_payment_paise', coalesce(sum(d.due_paise) filter (
        where d.bucket = 'renewal_due' and d.renewal_kind = 'needs_payment'), 0),
      'needs_payment_count', count(*) filter (
        where d.bucket = 'renewal_due' and d.renewal_kind = 'needs_payment')
    ),
    jsonb_build_object(
      'autopay', count(*) filter (where d.chosen and d.renewal_kind = 'autopay'),
      'needs_payment', count(*) filter (where d.chosen and d.renewal_kind = 'needs_payment'),
      'ending', count(*) filter (where d.chosen and d.renewal_kind = 'ending')
    ),
    count(*) filter (where d.chosen),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'restaurant_id', pg.restaurant_id,
        'name', pg.name,
        'slug', pg.slug,
        'city', pg.city,
        'phone', pg.phone,
        'plan_code', pg.plan_code,
        'plan_name', pg.plan_name,
        'billing_cycle', pg.billing_cycle,
        'status', pg.status,
        'source', pg.source,
        'state', private.subscription_state(
          'active', pg.access_state, pg.status::text, pg.source::text
        ),
        'trial_ends_at', pg.trial_ends_at,
        'current_period_end', pg.current_period_end,
        'grace_until', pg.grace_until,
        'restriction_at', pg.restriction_at,
        'access_reason', pg.access_reason,
        'razorpay_status', pg.razorpay_status,
        'autopay', pg.autopay,
        'renewal_kind', pg.renewal_kind,
        'due_paise', pg.due_paise,
        'last_reminder_kind', rem.kind,
        'last_reminder_at', rem.sent_at
      ) order by
        case when v_bucket = 'renewal_due'
          then array_position(array['autopay', 'needs_payment', 'ending'], pg.renewal_kind) end,
        case when v_bucket <> 'lapsed' then pg.sort_at end asc nulls last,
        case when v_bucket = 'lapsed' then pg.sort_at end desc nulls last,
        pg.name, pg.restaurant_id)
      from page pg
      left join lateral (
        select sr.kind, sr.sent_at
        from public.subscription_reminders sr
        where sr.restaurant_id = pg.restaurant_id
        order by sr.sent_at desc
        limit 1
      ) as rem on true
    ), '[]'::jsonb)
  into v_counts, v_expected, v_kinds, v_total, v_rows
  from dues d;

  return jsonb_build_object(
    'bucket', v_bucket,
    'days', v_days,
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'counts', v_counts,
    'expected', v_expected,
    'kinds', v_kinds,
    'rows', v_rows
  );
end;
$$;

revoke execute on function public.platform_list_dues(jsonb) from public, anon;
grant execute on function public.platform_list_dues(jsonb) to authenticated;

-- ─── Subscriptions list: states (plan §5.1) ─────────────────────────────────
-- Filtered by state instead of Razorpay's status; payment problems first,
-- then whatever ends soonest. Each row says its state and whether a paid
-- period is set to end.
create or replace function public.platform_list_subscriptions(p_filters jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.current_platform_admin();
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_state text;
  v_page int;
  v_page_size constant int := 50;
  v_total bigint;
  v_rows jsonb;
begin
  perform private.assert_keys(v_filters, array['state', 'page']);
  v_state := private.json_text(v_filters, 'state');
  v_page := case
    when coalesce(jsonb_typeof(v_filters -> 'page'), 'null') = 'null' then 1
    else private.json_int(v_filters, 'page')
  end;
  if v_state is not null and v_state not in (
    'suspended', 'read_only', 'trial', 'payment_failed', 'paid', 'cancelled'
  ) then
    perform private.fail('INVALID_INPUT', 'state');
  end if;
  if v_page < 1 or v_page > 10000 then
    perform private.fail('INVALID_INPUT', 'page');
  end if;

  with matching as (
    select
      r.id, r.name, r.slug, r.status as restaurant_status,
      p.name as plan_name, p.code as plan_code,
      s.billing_cycle, s.status, s.source, s.trial_ends_at, s.current_period_end,
      s.grace_until, s.cancel_at_period_end, a.state as access_state, st.state,
      st.state = 'paid' and private.renewal_kind(s) = 'ending' as ending,
      case when s.status = 'trialing' then s.trial_ends_at else s.current_period_end end as next_date
    from public.restaurant_subscriptions s
    join public.restaurants r on r.id = s.restaurant_id
    join public.plans p on p.id = s.plan_id
    cross join lateral public.restaurant_access(r.id) as a
    cross join lateral (
      select private.subscription_state(r.status::text, a.state, s.status::text, s.source::text)
        as state
    ) as st
    where v_state is null or st.state = v_state
  ),
  page as (
    select m.*
    from matching m
    order by m.state = 'payment_failed' desc, m.next_date nulls last, m.name, m.id
    limit v_page_size offset (v_page - 1) * v_page_size
  )
  select
    (select count(*) from matching),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'restaurant_id', pg.id,
        'name', pg.name,
        'slug', pg.slug,
        'restaurant_status', pg.restaurant_status,
        'plan_code', pg.plan_code,
        'plan_name', pg.plan_name,
        'billing_cycle', pg.billing_cycle,
        'status', pg.status,
        'source', pg.source,
        'trial_ends_at', pg.trial_ends_at,
        'current_period_end', pg.current_period_end,
        'grace_until', pg.grace_until,
        'cancel_at_period_end', pg.cancel_at_period_end,
        'access_state', pg.access_state,
        'state', pg.state,
        'ending', pg.ending
      ) order by pg.state = 'payment_failed' desc, pg.next_date nulls last, pg.name, pg.id)
      from page pg
    ), '[]'::jsonb)
  into v_total, v_rows;

  return jsonb_build_object('page', v_page, 'page_size', v_page_size, 'total', v_total, 'rows', v_rows);
end;
$$;
