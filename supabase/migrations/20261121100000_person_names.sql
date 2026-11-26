-- A person's name holds no character that hides or reorders the text around it (docs/DECISIONS.md,
-- "After the review: names that hide or reorder text"): no control character (Unicode Cc), format
-- character (Cf, such as the right-to-left override or the zero-width space) or line or paragraph
-- separator (Zl, Zp). The app's forms refuse them first (hasNoHiddenCharacters in
-- src/lib/person-name.ts); these checks hold every other way in, a function called directly or
-- the service role's own write. Ordinary spaces stay.

-- ─── The rule ───────────────────────────────────────────────────────────────
-- Unicode 17.0's Cc, Cf, Zl and Zp, as Node 24 has them, but U+0000, which text cannot hold.
-- tests/unit/person-name.test.ts holds this list to the app's rule at every code point.
create function private.has_no_hidden_characters(p_text text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_text !~ '[\u0001-\u001F\u007F-\u009F\u00AD\u0600-\u0605\u061C\u06DD\u070F\u0890-\u0891\u08E2\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB\U000110BD\U000110CD\U00013430-\U0001343F\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A\U000E0001\U000E0020-\U000E007F]';
$$;

revoke execute on function private.has_no_hidden_characters(text) from public, anon, authenticated;
-- The checks run it as the writer: a function's owner, or the service role writing a table itself
-- (the first-admin tool writes platform_admins so). A pure function that reveals nothing.
grant execute on function private.has_no_hidden_characters(text) to service_role;

-- ─── Names written before the rule ──────────────────────────────────────────
-- Line breaks and separators become spaces, every other such character goes, and the spaces are
-- tidied as the functions tidy a name (private.tidy_text). A name of nothing but such characters
-- would come out empty, so it stops the migration rather than invent a name, even in a column
-- that may be empty (a team member's), where it would be lost.
create function pg_temp.visible_name(p_name text)
returns text
language plpgsql
as $$
declare
  v_name text;
begin
  select private.tidy_text(string_agg(t.ch, '' order by t.n))
    into v_name
    from regexp_split_to_table(
      translate(
        p_name,
        chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(133) || chr(8232) || chr(8233),
        '        '
      ),
      ''
    ) with ordinality as t(ch, n)
    where private.has_no_hidden_characters(t.ch);
  if v_name is null and p_name is not null then
    raise exception 'visible_name: a name of nothing but hidden characters would be lost'
      using hint = 'Give it a visible name first.';
  end if;
  return v_name;
end;
$$;

update public.platform_admins set display_name = pg_temp.visible_name(display_name)
  where not private.has_no_hidden_characters(display_name);
update public.restaurant_members set display_name = pg_temp.visible_name(display_name)
  where not private.has_no_hidden_characters(display_name);
update public.waiters set full_name = pg_temp.visible_name(full_name)
  where not private.has_no_hidden_characters(full_name);
update public.site_leads set name = pg_temp.visible_name(name)
  where not private.has_no_hidden_characters(name);
update public.support_sessions set staff_name = pg_temp.visible_name(staff_name)
  where not private.has_no_hidden_characters(staff_name);

drop function pg_temp.visible_name(text);

-- ─── The checks ─────────────────────────────────────────────────────────────
-- Every column that keeps a person's name: a team member's (the Team page), a login's (signup,
-- onboarding, Staff logins), a waiter's, a lead's (the "Book a demo" form and the team's own) and
-- the name a support session shows the restaurant.
alter table public.platform_admins
  add constraint platform_admins_display_name_no_hidden_characters
  check (private.has_no_hidden_characters(display_name));
alter table public.restaurant_members
  add constraint restaurant_members_display_name_no_hidden_characters
  check (private.has_no_hidden_characters(display_name));
alter table public.waiters
  add constraint waiters_full_name_no_hidden_characters
  check (private.has_no_hidden_characters(full_name));
alter table public.site_leads
  add constraint site_leads_name_no_hidden_characters
  check (private.has_no_hidden_characters(name));
alter table public.support_sessions
  add constraint support_sessions_staff_name_no_hidden_characters
  check (private.has_no_hidden_characters(staff_name));
