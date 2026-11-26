-- A person's name holds no control or format character and no line or paragraph separator
-- (supabase/migrations/20261121100000_person_names.sql; docs/DECISIONS.md, "After the review:
-- names that hide or reorder text"): every column that keeps one refuses them, whoever writes
-- it, and still takes ordinary spaces and every script.
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ─── The rule ───────────────────────────────────────────────────────────────
select ok(private.has_no_hidden_characters('Tara Singh'), 'an ordinary name passes');
select ok(
  private.has_no_hidden_characters('आशा वर्मा'),
  'Devanagari passes, its vowel signs and virama included'
);
select ok(
  private.has_no_hidden_characters('Tara' || chr(160) || 'Singh'),
  'a no-break space passes, as a space'
);
select ok(
  private.has_no_hidden_characters(null) is null,
  'no name gets no answer, so a column may still be empty'
);
-- Each inside a name: a right-to-left override (U+202E), a zero-width space (U+200B), the line
-- and paragraph separators (U+2028, U+2029), a tab, an escape, DEL, a C1 next line (U+0085), a
-- soft hyphen (U+00AD), a joiner (U+200D), a byte order mark (U+FEFF) and a tag character past
-- the BMP (U+E0041).
select is_empty(
  $$
    select c
    from unnest(array[8238, 8203, 8232, 8233, 9, 27, 127, 133, 173, 8205, 65279, 917569]) as c
    where private.has_no_hidden_characters('Ta' || chr(c) || 'ra')
  $$,
  'every such character is refused'
);

-- ─── Fixtures ───────────────────────────────────────────────────────────────
select tests.create_restaurant('t694-names') as rest \gset
select tests.add_member(:'rest', 'owner', 't694_owner') as owner \gset
select tests.add_member(:'rest', 'kitchen', 't694_kitchen') as kitchen \gset
select tests.member_id(:'kitchen') as m_kitchen \gset
select tests.add_waiter(:'rest', 'Ravi Kumar') as waiter \gset
select tests.create_platform_admin('t694-admin@menumesh.test') as admin \gset
insert into public.site_leads (name, restaurant_name, city, phone)
  values ('Tara Singh', 'Tara Dhaba', 'Indore', '9876543210')
  returning id as lead \gset
insert into public.support_sessions (restaurant_id, consent, ends_at, user_id, staff_name, started_at)
  values (:'rest', 'owner', now() + interval '1 hour', :'admin', 'Priya', now())
  returning id as session \gset

-- "Asha nimda" behind a right-to-left override reads "Asha admin".
select 'Asha ' || chr(8238) || 'nimda' as bad \gset
select 'Asha' || chr(8232) || 'Verma' as bad_line \gset

-- ─── Each column, written straight ──────────────────────────────────────────
select throws_ok(
  format('update public.platform_admins set display_name = %L where user_id = %L', :'bad', :'admin'),
  '23514',
  'new row for relation "platform_admins" violates check constraint "platform_admins_display_name_no_hidden_characters"',
  'a team member''s name refuses them'
);
select throws_ok(
  format('update public.restaurant_members set display_name = %L where user_id = %L', :'bad', :'owner'),
  '23514',
  'new row for relation "restaurant_members" violates check constraint "restaurant_members_display_name_no_hidden_characters"',
  'a login''s name refuses them'
);
select throws_ok(
  format(
    'update public.restaurant_members set display_name = %L where user_id = %L',
    :'bad_line',
    :'owner'
  ),
  '23514',
  'new row for relation "restaurant_members" violates check constraint "restaurant_members_display_name_no_hidden_characters"',
  'a login''s name refuses a line separator'
);
select throws_ok(
  format('update public.waiters set full_name = %L where id = %L', :'bad', :'waiter'),
  '23514',
  'new row for relation "waiters" violates check constraint "waiters_full_name_no_hidden_characters"',
  'a waiter''s name refuses them'
);
select throws_ok(
  format('update public.site_leads set name = %L where id = %L', :'bad', :'lead'),
  '23514',
  'new row for relation "site_leads" violates check constraint "site_leads_name_no_hidden_characters"',
  'a lead''s name refuses them'
);
select throws_ok(
  format('update public.support_sessions set staff_name = %L where id = %L', :'bad', :'session'),
  '23514',
  'new row for relation "support_sessions" violates check constraint "support_sessions_staff_name_no_hidden_characters"',
  'a support session''s name refuses them'
);

select lives_ok(
  format('update public.platform_admins set display_name = %L where user_id = %L', 'आशा वर्मा', :'admin'),
  'a team member''s name takes Devanagari'
);
select lives_ok(
  format('update public.restaurant_members set display_name = %L where user_id = %L', 'Asha Verma', :'owner'),
  'a login''s name takes an ordinary name'
);
select lives_ok(
  format('update public.waiters set full_name = %L where id = %L', 'रवि कुमार', :'waiter'),
  'a waiter''s name takes Devanagari'
);
select lives_ok(
  format('update public.site_leads set name = %L where id = %L', 'Seán O''Brien-Lee', :'lead'),
  'a lead''s name takes accents and punctuation'
);
select lives_ok(
  format('update public.support_sessions set staff_name = %L where id = %L', 'Priya S', :'session'),
  'a support session''s name takes an ordinary name'
);

-- ─── The service role's own write ───────────────────────────────────────────
-- As the first-admin tool writes platform_admins: the check runs as the service role.
select tests.as_service_role();
select throws_ok(
  format('update public.platform_admins set display_name = %L where user_id = %L', :'bad', :'admin'),
  '23514',
  'new row for relation "platform_admins" violates check constraint "platform_admins_display_name_no_hidden_characters"',
  'the service role''s own write is held to it'
);
select lives_ok(
  format('update public.platform_admins set display_name = %L where user_id = %L', 'Owner Name', :'admin'),
  'and the service role may run the check on an ordinary name'
);
select tests.clear_auth();

-- ─── Through a function, as its owner ───────────────────────────────────────
select tests.authenticate_as(:'owner');
select throws_ok(
  format(
    $f$ select public.admin_update_staff(%L, %L) $f$,
    :'m_kitchen',
    jsonb_build_object('display_name', :'bad')
  ),
  '23514',
  'new row for relation "restaurant_members" violates check constraint "restaurant_members_display_name_no_hidden_characters"',
  'an owner renaming a login is held to it'
);
select lives_ok(
  format(
    $f$ select public.admin_update_staff(%L, %L) $f$,
    :'m_kitchen',
    jsonb_build_object('display_name', 'कविता राव')
  ),
  'and renames it to any ordinary name: the check runs as the function''s owner'
);
select tests.clear_auth();

select * from finish();
rollback;
