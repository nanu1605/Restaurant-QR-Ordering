-- Menu import (spec §20A, docs/DECISIONS.md P7-12 to P7-20): who may import,
-- the daily limit, the page and draft steps, the commit rules and the cleanup.
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

select tests.create_restaurant('alpha') as rest_a \gset
select tests.create_restaurant('bravo') as rest_b \gset
select tests.add_member(:'rest_a', 'owner', 'a_owner') as a_owner \gset
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
select tests.add_member(:'rest_a', 'waiter', 'a_waiter') as a_waiter \gset
select tests.add_member(:'rest_a', 'kitchen', 'a_kitchen') as a_kitchen \gset
select tests.add_member(:'rest_b', 'owner', 'b_owner') as b_owner \gset
select tests.create_platform_admin('imports@platform.test') as admin \gset

-- Alpha's menu before any import: a visible and a hidden category, a plain
-- dish and one with options.
insert into public.menu_categories (restaurant_id, name, sort_order)
  values (:'rest_a', 'Starters', 1) returning id as starters \gset
insert into public.menu_categories (restaurant_id, name, sort_order, is_active)
  values (:'rest_a', 'Desserts', 2, false) returning id as desserts \gset
insert into public.menu_items (restaurant_id, category_id, name, price_paise, food_type, sort_order)
  values (:'rest_a', :'starters', 'Paneer Tikka', 25000, 'veg', 1) returning id as tikka \gset
insert into public.menu_items (restaurant_id, category_id, name, price_paise, food_type, sort_order)
  values (:'rest_a', :'starters', 'Chicken 65', 18000, 'non_veg', 2) returning id as chicken \gset
insert into public.menu_item_variants (restaurant_id, menu_item_id, name, price_paise, sort_order)
  values (:'rest_a', :'chicken', 'Half', 18000, 1), (:'rest_a', :'chicken', 'Full', 30000, 2);
insert into public.menu_categories (restaurant_id, name)
  values (:'rest_b', 'Bravo Specials') returning id as b_cat \gset
insert into public.menu_items (restaurant_id, category_id, name, price_paise, food_type)
  values (:'rest_b', :'b_cat', 'Bravo Burger', 19900, 'non_veg') returning id as b_item \gset

-- ─── Create ─────────────────────────────────────────────────────────────────
select tests.authenticate_as(:'a_owner');
select public.menu_import_create(:'rest_a', 'photo', 3) ->> 'import_id' as photo1 \gset

select is(
  (select status::text from public.menu_imports where id = :'photo1'),
  'uploaded',
  'a photo import starts as uploaded'
);
select is(
  (select file_paths from public.menu_imports where id = :'photo1'),
  array[
    :'rest_a' || '/' || :'photo1' || '/page-1.jpg',
    :'rest_a' || '/' || :'photo1' || '/page-2.jpg',
    :'rest_a' || '/' || :'photo1' || '/page-3.jpg'
  ],
  'each page gets a path inside the restaurant folder'
);
select is(
  (select jsonb_agg(p ->> 'status') from public.menu_imports, jsonb_array_elements(pages) p
    where id = :'photo1'),
  '["pending", "pending", "pending"]'::jsonb,
  'every page starts pending'
);
select is(
  (select created_by from public.menu_imports where id = :'photo1'),
  :'a_owner'::uuid,
  'the import records who started it'
);

select throws_ok(
  format($$ select public.menu_import_create(%L, 'photo', 0) $$, :'rest_a'),
  'P0001', 'INVALID_INPUT', 'a photo import needs at least one page'
);
select throws_ok(
  format($$ select public.menu_import_create(%L, 'photo', 11) $$, :'rest_a'),
  'P0001', 'INVALID_INPUT', 'a photo import has at most 10 pages'
);
select throws_ok(
  format($$ select public.menu_import_create(%L, 'pdf', 1) $$, :'rest_a'),
  'P0001', 'INVALID_INPUT', 'only photo and csv imports exist'
);
select throws_ok(
  format($$ select public.menu_import_create(%L, 'photo', 1) $$, :'rest_b'),
  'P0001', 'FORBIDDEN', 'an owner cannot import into another restaurant'
);

select public.menu_import_create(:'rest_a', 'csv', 0) ->> 'import_id' as csv1 \gset
select is(
  (select status::text || '/' || page_count || '/' || cardinality(file_paths)
     from public.menu_imports where id = :'csv1'),
  'processing/0/0',
  'a csv import has no pages and waits for its draft'
);

select tests.authenticate_as(:'a_manager');
select public.menu_import_create(:'rest_a', 'photo', 1) ->> 'import_id' as photo2 \gset
select ok(:'photo2' is not null, 'a manager can start an import');

select tests.authenticate_as(:'a_waiter');
select throws_ok(
  format($$ select public.menu_import_create(%L, 'photo', 1) $$, :'rest_a'),
  'P0001', 'FORBIDDEN', 'a waiter cannot import'
);
select tests.authenticate_as(:'a_kitchen');
select throws_ok(
  format($$ select public.menu_import_create(%L, 'csv', 0) $$, :'rest_a'),
  'P0001', 'FORBIDDEN', 'the kitchen cannot import'
);

select tests.authenticate_as_platform_admin(:'admin', 'aal1');
select throws_ok(
  format($$ select public.menu_import_create(%L, 'photo', 1) $$, :'rest_b'),
  'P0001', 'MFA_REQUIRED', 'a platform admin needs the second factor'
);
select tests.authenticate_as_platform_admin(:'admin');
select public.menu_import_create(:'rest_b', 'photo', 2) ->> 'import_id' as b_photo \gset
select ok(:'b_photo' is not null, 'a platform admin can import for any restaurant');
select throws_ok(
  $$ select public.menu_import_create('00000000-0000-4000-8000-000000000000', 'csv', 0) $$,
  'P0001', 'RESTAURANT_NOT_FOUND', 'a platform admin import needs a real restaurant'
);

-- ─── Daily limit: 5 photo imports per restaurant in 24 hours ────────────────
select tests.authenticate_as(:'a_owner');
select public.menu_import_create(:'rest_a', 'photo', 1) ->> 'import_id' as photo3 \gset
select public.menu_import_create(:'rest_a', 'photo', 1) ->> 'import_id' as photo4 \gset
select public.menu_import_create(:'rest_a', 'photo', 1) ->> 'import_id' as photo5 \gset
select throws_ok(
  format($$ select public.menu_import_create(%L, 'photo', 1) $$, :'rest_a'),
  'P0001', 'IMPORT_LIMIT_REACHED', 'the sixth photo import in a day is refused'
);
select lives_ok(
  format($$ select public.menu_import_create(%L, 'csv', 0) $$, :'rest_a'),
  'csv imports do not count against the limit'
);
select tests.clear_auth();
update public.menu_imports set created_at = now() - interval '25 hours' where id = :'photo5';
select tests.authenticate_as(:'a_owner');
select lives_ok(
  format($$ select public.menu_import_create(%L, 'photo', 1) $$, :'rest_a'),
  'an import older than 24 hours no longer counts'
);

-- ─── Reading and writing the table ──────────────────────────────────────────
select tests.authenticate_as(:'a_manager');
select ok(
  (select count(*) from public.menu_imports where restaurant_id = :'rest_a') >= 7,
  'a manager reads their imports'
);
select is(
  (select count(*) from public.menu_imports where restaurant_id = :'rest_b'),
  0::bigint,
  'another restaurant''s imports are invisible'
);
select throws_ok(
  format($$ update public.menu_imports set status = 'review' where id = %L $$, :'photo1'),
  '42501', null, 'imports cannot be changed directly'
);
select throws_ok(
  format(
    $$ insert into public.menu_imports (restaurant_id, source, status, page_count)
       values (%L, 'csv', 'review', 0) $$,
    :'rest_a'
  ),
  '42501', null, 'imports cannot be inserted directly'
);
select tests.authenticate_as(:'a_waiter');
select is(
  (select count(*) from public.menu_imports),
  0::bigint,
  'a waiter sees no imports'
);
select tests.authenticate_as(:'b_owner');
select is(
  (select count(*) from public.menu_imports where restaurant_id = :'rest_a'),
  0::bigint,
  'the owner of another restaurant sees none of alpha''s imports'
);
select tests.authenticate_as_platform_admin(:'admin');
select ok(
  (select count(distinct restaurant_id) from public.menu_imports) >= 2,
  'a platform admin reads every restaurant''s imports'
);

-- ─── Pages ──────────────────────────────────────────────────────────────────
select tests.authenticate_as(:'a_owner');
select is(
  public.menu_import_record_page(:'photo1', jsonb_build_object(
    'index', 1, 'status', 'done', 'provider', 'commandcode', 'model', 'google/gemini-3.8-flash',
    'input_tokens', 1000, 'output_tokens', 500, 'cost_paise', 60, 'notes', 'bottom cut off',
    'result', '{"categories": []}'::jsonb, 'raw', '{"categories": []}'::jsonb
  )),
  '{"total": 3, "done": 1, "failed": 0}'::jsonb,
  'a page read returns the progress'
);
select is(
  (select status::text || '/' || model || '/' || input_tokens || '/' || output_tokens || '/'
     || cost_paise from public.menu_imports where id = :'photo1'),
  'processing/google/gemini-3.8-flash/1000/500/60',
  'the import is processing and adds up tokens and cost'
);
select is(
  (select pages -> 0 ->> 'notes' from public.menu_imports where id = :'photo1'),
  'bottom cut off',
  'page notes are kept'
);
select is(
  (select raw_result -> '1' from public.menu_imports where id = :'photo1'),
  '{"categories": []}'::jsonb,
  'the raw model output is kept by page number'
);
select throws_ok(
  format($$ select public.menu_import_record_page(%L, '{"index": 1, "status": "done", "result": {}}') $$, :'photo1'),
  'P0001', 'PAGE_ALREADY_READ', 'a page read successfully is not recorded twice'
);

select is(
  public.menu_import_record_page(:'photo1', jsonb_build_object(
    'index', 2, 'status', 'failed', 'error', 'The photo could not be read.',
    'input_tokens', 800, 'output_tokens', 0, 'cost_paise', 40
  )),
  '{"total": 3, "done": 1, "failed": 1}'::jsonb,
  'a failed page is counted'
);
select is(
  public.menu_import_record_page(:'photo1', jsonb_build_object(
    'index', 2, 'status', 'done', 'input_tokens', 900, 'output_tokens', 300, 'cost_paise', 50,
    'result', '{"categories": []}'::jsonb
  )) ->> 'done',
  '2',
  'a failed page can be read again'
);
select is(
  (select (pages -> 1 ->> 'input_tokens') || '/' || cost_paise
     from public.menu_imports where id = :'photo1'),
  '1700/150',
  'retries add their tokens and cost to the page and the import'
);
select public.menu_import_record_page(:'photo1', jsonb_build_object(
  'index', 3, 'status', 'done', 'model', 'someone/unpriced', 'input_tokens', 100,
  'output_tokens', 100, 'result', '{"categories": []}'::jsonb
));
select is(
  (select cost_paise from public.menu_imports where id = :'photo1'),
  null::bigint,
  'the cost becomes unknown once a call has no price'
);

select throws_ok(
  format($$ select public.menu_import_record_page(%L, '{"index": 4, "status": "done", "result": {}}') $$, :'photo2'),
  'P0001', 'INVALID_INPUT', 'the page number must exist'
);
select throws_ok(
  format($$ select public.menu_import_record_page(%L, '{"index": 1, "status": "maybe"}') $$, :'photo2'),
  'P0001', 'INVALID_INPUT', 'a page is done or failed'
);
select throws_ok(
  format($$ select public.menu_import_record_page(%L, '{"index": 1, "status": "done"}') $$, :'photo2'),
  'P0001', 'INVALID_INPUT', 'a page read needs its result'
);
select throws_ok(
  format($$ select public.menu_import_record_page(%L, '{"index": 1, "status": "done", "result": {}, "sql": 1}') $$, :'photo2'),
  'P0001', 'INVALID_INPUT', 'unknown keys are refused'
);
select throws_ok(
  format($$ select public.menu_import_record_page(%L, '{"index": 1, "status": "failed"}') $$, :'csv1'),
  'P0001', 'IMPORT_NOT_OPEN', 'a csv import has no pages to read'
);
select tests.authenticate_as(:'a_waiter');
select throws_ok(
  format($$ select public.menu_import_record_page(%L, '{"index": 1, "status": "failed"}') $$, :'photo2'),
  'P0001', 'FORBIDDEN', 'a waiter cannot record pages'
);
select tests.authenticate_as(:'b_owner');
select throws_ok(
  format($$ select public.menu_import_record_page(%L, '{"index": 1, "status": "failed"}') $$, :'photo2'),
  'P0001', 'FORBIDDEN', 'another restaurant''s owner cannot record pages'
);

-- ─── Draft ──────────────────────────────────────────────────────────────────
select tests.authenticate_as(:'a_owner');
select lives_ok(
  format($$ select public.menu_import_set_draft(%L, 'review', '{"categories": []}') $$, :'photo1'),
  'the merged pages become a draft to review'
);
select is(
  (select status::text from public.menu_imports where id = :'photo1'),
  'review',
  'the import is in review'
);
select throws_ok(
  format($$ select public.menu_import_record_page(%L, '{"index": 1, "status": "failed"}') $$, :'photo1'),
  'P0001', 'IMPORT_NOT_OPEN', 'pages cannot change once the draft exists'
);
select lives_ok(
  format($$ select public.menu_import_set_draft(%L, 'review', '{"categories": [], "saved": true}') $$, :'photo1'),
  'a draft in review can be saved again'
);
select throws_ok(
  format($$ select public.menu_import_set_draft(%L, 'review', '{"items": []}') $$, :'photo2'),
  'P0001', 'INVALID_INPUT', 'a draft has a categories list'
);
select throws_ok(
  format($$ select public.menu_import_set_draft(%L, 'failed', null, '  ') $$, :'photo2'),
  'P0001', 'INVALID_INPUT', 'a failed import says why'
);
select lives_ok(
  format($$ select public.menu_import_set_draft(%L, 'failed', null, 'No page could be read.') $$, :'photo2'),
  'an import with nothing readable fails'
);
select is(
  (select status::text || '/' || error || '/' || (completed_at is not null)
     from public.menu_imports where id = :'photo2'),
  'failed/No page could be read./true',
  'the failure is stored with its message and time'
);
select throws_ok(
  format($$ select public.menu_import_set_draft(%L, 'failed', null, 'Late') $$, :'photo1'),
  'P0001', 'IMPORT_NOT_OPEN', 'an import in review cannot be marked failed'
);

-- ─── Commit ─────────────────────────────────────────────────────────────────
select tests.authenticate_as(:'a_manager');
select public.menu_import_create(:'rest_a', 'csv', 0) ->> 'import_id' as csv2 \gset
select public.menu_import_set_draft(:'csv2', 'review', '{"categories": []}');

select format($j${"categories": [
  {"name": "  starters ", "items": [
    {"name": "Veg  Spring Roll", "description": " crispy ", "food_type": "veg", "price_paise": 18000, "variants": [], "action": "import", "flags": ["price_range"]},
    {"name": "Paneer Tikka", "food_type": "veg", "price_paise": 27000, "variants": [], "action": "update_price", "existing_item_id": "%s"},
    {"name": "Chicken 65", "food_type": "non_veg", "variants": [{"name": "half", "price_paise": 20000}, {"name": "Full", "price_paise": 34000}], "action": "update_price", "existing_item_id": "%s"},
    {"name": "Fish Fingers", "food_type": "non_veg", "price_paise": 32000, "variants": [], "action": "skip"}
  ]},
  {"name": "Tandoor", "items": [
    {"name": "Chicken Tikka", "food_type": "non_veg", "variants": [{"name": "Half", "price_paise": 22000}, {"name": "Full", "price_paise": 40000}], "action": "import"},
    {"name": "Tandoori Roti", "food_type": "unknown", "price_paise": 3000, "variants": [], "action": "import"}
  ]},
  {"name": "desserts", "items": [
    {"name": "Gulab Jamun", "food_type": "veg", "price_paise": 9000, "variants": [], "action": "import"}
  ]},
  {"name": "Drinks", "skip": true, "items": [
    {"name": "Lassi", "food_type": "veg", "price_paise": 8000, "variants": [], "action": "import"}
  ]},
  {"name": "Only updates", "items": [
    {"name": "Paneer Tikka", "food_type": "veg", "price_paise": 27000, "variants": [], "action": "skip"}
  ]}
]}$j$, :'tikka', :'chicken') as draft \gset

select throws_ok(
  format($$ select public.menu_import_commit(%L, %L) $$, :'csv2', :'draft'),
  'P0001', 'FOOD_TYPE_UNCONFIRMED', 'unmarked dishes need the owner''s confirmation'
);
select is(
  public.menu_import_commit(:'csv2', :'draft', true),
  '{"categories_created": 1, "categories_shown": 0, "items_created": 4, "items_updated": 2, "items_skipped": 3}'::jsonb,
  'the commit returns what it did'
);

select is(
  (select count(*) from public.menu_categories
    where restaurant_id = :'rest_a' and lower(name) = 'starters'),
  1::bigint,
  'an existing category is matched ignoring case and spacing'
);
select is(
  (select c.name || '/' || i.description || '/' || i.sort_order || '/' || i.is_available
     || '/' || i.food_type
     from public.menu_items i join public.menu_categories c on c.id = i.category_id
     where i.restaurant_id = :'rest_a' and i.name = 'Veg Spring Roll'),
  'Starters/crispy/3/true/veg',
  'a new dish is tidied, available and goes after the existing ones'
);
select is(
  (select source::text || '/' || sort_order || '/' || is_active from public.menu_categories
    where restaurant_id = :'rest_a' and name = 'Tandoor'),
  'import/3/true',
  'a new category is appended and marked as imported'
);
select is(
  (select i.price_paise || ':' || string_agg(v.name || '=' || v.price_paise, ',' order by v.sort_order)
     from public.menu_items i join public.menu_item_variants v on v.menu_item_id = i.id
     where i.restaurant_id = :'rest_a' and i.name = 'Chicken Tikka'
     group by i.price_paise),
  '22000:Half=22000,Full=40000',
  'options keep their order and the dish price is the cheapest'
);
select is(
  (select food_type::text from public.menu_items
    where restaurant_id = :'rest_a' and name = 'Tandoori Roti'),
  'veg',
  'a confirmed unmarked dish becomes veg'
);
select is(
  (select price_paise from public.menu_items where id = :'tikka'),
  27000::bigint,
  'update_price changes a plain dish''s price'
);
select is(
  (select i.price_paise || ':' || string_agg(v.name || '=' || v.price_paise, ',' order by v.sort_order)
     from public.menu_items i join public.menu_item_variants v on v.menu_item_id = i.id
     where i.id = :'chicken' group by i.price_paise),
  '20000:Half=20000,Full=34000',
  'update_price changes the options with the same names and resets the dish price'
);
select is(
  (select c.is_active::text || '/' || c.name
     from public.menu_items i join public.menu_categories c on c.id = i.category_id
     where i.restaurant_id = :'rest_a' and i.name = 'Gulab Jamun'),
  'false/Desserts',
  'a hidden category is matched and stays hidden'
);
select is(
  (select count(*) from public.menu_items
    where restaurant_id = :'rest_a' and name in ('Lassi', 'Fish Fingers')),
  0::bigint,
  'skipped dishes and skipped categories are not imported'
);
select is(
  (select count(*) from public.menu_categories
    where restaurant_id = :'rest_a' and name in ('Drinks', 'Only updates')),
  0::bigint,
  'a category without new dishes is not created'
);
select is(
  (select status::text || '/' || (completed_at is not null) || '/' || (draft -> 'categories' -> 0 ->> 'name')
     from public.menu_imports where id = :'csv2'),
  'imported/true/  starters ',
  'the import is marked imported and keeps the reviewed draft'
);
select is(
  (select actor_type::text || '/' || actor_label || '/' || entity_type || '/' || (after ->> 'items_created')
     || '/' || (after ->> 'source')
     from public.audit_logs where action = 'menu.imported' and entity_id = :'csv2'),
  'staff/A_manager/menu_import/4/csv',
  'one audit entry records the import'
);

select is(
  public.menu_import_commit(:'csv2', :'draft', true) ->> 'already_imported',
  'true',
  'committing again says it was already imported'
);
select is(
  (select count(*) from public.menu_items where restaurant_id = :'rest_a'),
  6::bigint,
  'committing again adds nothing'
);
select is(
  (select count(*) from public.audit_logs where action = 'menu.imported' and entity_id = :'csv2'),
  1::bigint,
  'committing again writes no second audit entry'
);

-- Show a hidden category again.
select public.menu_import_create(:'rest_a', 'csv', 0) ->> 'import_id' as csv3 \gset
select public.menu_import_set_draft(:'csv3', 'review', '{"categories": []}');
select is(
  public.menu_import_commit(:'csv3', '{"categories": [{"name": "Desserts", "show_hidden": true, "items": [
    {"name": "Rasmalai", "food_type": "veg", "price_paise": 12000, "variants": [], "action": "import"}
  ]}]}') ->> 'categories_shown',
  '1',
  'show_hidden brings a hidden category back'
);
select is(
  (select is_active from public.menu_categories where id = :'desserts'),
  true,
  'the category is visible again'
);

-- Bad drafts are refused before anything is written.
select public.menu_import_create(:'rest_a', 'csv', 0) ->> 'import_id' as csv4 \gset
select public.menu_import_set_draft(:'csv4', 'review', '{"categories": []}');

select throws_ok(
  format($$ select public.menu_import_commit(%L, '{"categories": [{"name": "Mains", "items": [
    {"name": "Dal", "food_type": "veg", "variants": [{"name": "Half", "price_paise": 100}, {"name": " half ", "price_paise": 200}], "action": "import"}
  ]}]}') $$, :'csv4'),
  'P0001', 'VARIANT_NAME_DUPLICATE', 'option names are unique per dish'
);
select throws_ok(
  format($$ select public.menu_import_commit(%L, '{"categories": [{"name": "Mains", "items": [
    {"name": "%s", "food_type": "veg", "price_paise": 100, "variants": [], "action": "import"}
  ]}]}') $$, :'csv4', repeat('x', 81)),
  'P0001', 'INVALID_ITEM_NAME', 'dish names are at most 80 characters'
);
select throws_ok(
  format($$ select public.menu_import_commit(%L, '{"categories": [{"name": "Mains", "items": [
    {"name": "Dal", "food_type": "veg", "variants": [], "action": "import"}
  ]}]}') $$, :'csv4'),
  'P0001', 'INVALID_PRICE', 'a dish without options needs a price'
);
select throws_ok(
  format($$ select public.menu_import_commit(%L, '{"categories": [{"name": "Mains", "items": [
    {"name": "Dal", "food_type": "veg", "price_paise": 100000001, "variants": [], "action": "import"}
  ]}]}') $$, :'csv4'),
  'P0001', 'INVALID_PRICE', 'prices are capped'
);
select throws_ok(
  format($$ select public.menu_import_commit(%L, '{"categories": [{"name": "%s", "items": [
    {"name": "Dal", "food_type": "veg", "price_paise": 100, "variants": [], "action": "import"}
  ]}]}') $$, :'csv4', repeat('c', 61)),
  'P0001', 'INVALID_CATEGORY_NAME', 'category names are at most 60 characters'
);
select throws_ok(
  format(
    $$ select public.menu_import_commit(%L, jsonb_build_object('categories', jsonb_build_array(
         jsonb_build_object('name', 'Mains', 'items', jsonb_build_array(jsonb_build_object(
           'name', 'Thali', 'food_type', 'veg', 'action', 'import',
           'variants', (select jsonb_agg(jsonb_build_object('name', 'Size ' || g, 'price_paise', 100))
                        from generate_series(1, 21) g))))))) $$,
    :'csv4'
  ),
  'P0001', 'INVALID_INPUT', 'a dish has at most 20 options'
);
select throws_ok(
  format($$ select public.menu_import_commit(%L, '{"categories": [{"name": "Mains", "items": [
    {"name": "Dal", "food_type": "veg", "price_paise": 100, "variants": [], "action": "delete"}
  ]}]}') $$, :'csv4'),
  'P0001', 'INVALID_INPUT', 'rows are imported, skipped or update a price'
);
select throws_ok(
  format($$ select public.menu_import_commit(%L, '{"categories": [{"name": "Mains", "items": {}}]}') $$, :'csv4'),
  'P0001', 'INVALID_INPUT', 'a category''s items are a list'
);
select throws_ok(
  format($$ select public.menu_import_commit(%L, '{"categories": [{"name": "Mains", "items": [
    {"name": "Dal", "food_type": "fish", "price_paise": 100, "variants": [], "action": "import"}
  ]}]}') $$, :'csv4'),
  'P0001', 'INVALID_INPUT', 'food types are veg, non_veg or egg'
);
select throws_ok(
  format($$ select public.menu_import_commit(%L, '{"categories": [{"name": "Mains", "items": [
    {"name": "Burger", "food_type": "veg", "price_paise": 100, "variants": [], "action": "update_price", "existing_item_id": "%s"}
  ]}]}') $$, :'csv4', :'b_item'),
  'P0001', 'NOT_FOUND', 'update_price only reaches this restaurant''s dishes'
);
select throws_ok(
  format(
    $$ select public.menu_import_commit(%L, jsonb_build_object('categories', jsonb_build_array(
         jsonb_build_object('name', 'Mains', 'items',
           (select jsonb_agg(jsonb_build_object('name', 'Dish ' || g, 'food_type', 'veg',
              'price_paise', 100, 'variants', '[]'::jsonb, 'action', 'import'))
            from generate_series(1, 501) g))))) $$,
    :'csv4'
  ),
  'P0001', 'IMPORT_TOO_LARGE', 'an import has at most 500 dishes'
);
select is(
  (select status::text from public.menu_imports where id = :'csv4'),
  'review',
  'a refused commit leaves the import in review'
);

select tests.clear_auth();
select tests.suspend(:'rest_a');
select tests.authenticate_as(:'a_manager');
select throws_ok(
  format($$ select public.menu_import_commit(%L, '{"categories": []}') $$, :'csv4'),
  'P0001', 'RESTAURANT_READ_ONLY', 'a read-only restaurant cannot import'
);
select throws_ok(
  format($$ select public.menu_import_create(%L, 'csv', 0) $$, :'rest_a'),
  'P0001', 'RESTAURANT_READ_ONLY', 'a read-only restaurant cannot start an import'
);
select tests.clear_auth();
update public.restaurants set status = 'active', suspended_reason = null where id = :'rest_a';

select tests.authenticate_as(:'a_waiter');
select throws_ok(
  format($$ select public.menu_import_commit(%L, '{"categories": []}') $$, :'csv4'),
  'P0001', 'FORBIDDEN', 'a waiter cannot commit an import'
);

-- A platform admin imports for the restaurant.
select tests.authenticate_as_platform_admin(:'admin');
select is(
  public.menu_import_commit(:'csv4', '{"categories": [{"name": "Chaat", "items": [
    {"name": "Pani Puri", "food_type": "veg", "price_paise": 6000, "variants": [], "action": "import"}
  ]}]}') ->> 'items_created',
  '1',
  'a platform admin can commit an import'
);
select is(
  (select actor_type::text || '/' || actor_label from public.audit_logs
    where action = 'menu.imported' and entity_id = :'csv4'),
  'platform_admin/Platform admin',
  'the audit entry names the platform admin'
);

-- ─── Discard ────────────────────────────────────────────────────────────────
select tests.authenticate_as(:'a_owner');
select lives_ok(
  format($$ select public.menu_import_discard(%L) $$, :'photo1'),
  'an import in review can be discarded'
);
select is(
  (select status::text || '/' || (completed_at is not null) from public.menu_imports where id = :'photo1'),
  'discarded/true',
  'the import is discarded'
);
select lives_ok(
  format($$ select public.menu_import_discard(%L) $$, :'photo1'),
  'discarding twice is harmless'
);
select throws_ok(
  format($$ select public.menu_import_commit(%L, '{"categories": []}') $$, :'photo1'),
  'P0001', 'IMPORT_NOT_OPEN', 'a discarded import cannot be committed'
);
select throws_ok(
  format($$ select public.menu_import_discard(%L) $$, :'csv2'),
  'P0001', 'IMPORT_NOT_OPEN', 'an imported import cannot be discarded'
);

-- ─── Cleanup ────────────────────────────────────────────────────────────────
select tests.authenticate_as(:'a_owner');
select throws_ok(
  $$ select * from public.menu_import_files_to_remove() $$,
  '42501', null, 'signed-in users cannot list files to remove'
);
select throws_ok(
  format($$ select public.menu_import_mark_files_removed(array[%L]::uuid[]) $$, :'photo1'),
  '42501', null, 'signed-in users cannot mark files removed'
);

select tests.clear_auth();
update public.menu_imports set completed_at = now() - interval '8 days' where id = :'photo1';
update public.menu_imports set created_at = now() - interval '31 days' where id = :'photo3';
update public.menu_imports set completed_at = now() - interval '6 days' where id = :'photo2';

select tests.as_service_role();
-- Only this file's imports: other runs may have left some behind.
select set_eq(
  format(
    $$ select import_id from public.menu_import_files_to_remove(1000)
       where import_id in (%L, %L, %L) $$,
    :'photo1', :'photo2', :'photo3'
  ),
  format($$ values (%L::uuid), (%L::uuid) $$, :'photo1', :'photo3'),
  'photos go 7 days after an import ends, or 30 days after an unfinished one started'
);
select is(
  public.menu_import_mark_files_removed(array[:'photo1', :'photo3']::uuid[]),
  2,
  'the cleanup marks the imports whose photos it deleted'
);
select is(
  (select count(*) from public.menu_import_files_to_remove(1000)
    where import_id in (:'photo1', :'photo3')),
  0::bigint,
  'marked imports are not listed again'
);

select * from finish();

rollback;
