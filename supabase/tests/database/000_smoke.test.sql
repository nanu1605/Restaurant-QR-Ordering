begin;

create extension if not exists pgtap with schema extensions;

select plan(5);

select has_function('public', 'health_check', 'health_check() exists');
select is(public.health_check(), 'ok', 'health_check() returns ok');

select ok(
  has_function_privilege('service_role', 'public.health_check()', 'execute'),
  'service_role can execute health_check()'
);
select ok(
  not has_function_privilege('anon', 'public.health_check()', 'execute'),
  'anon cannot execute health_check()'
);
select ok(
  not has_function_privilege('authenticated', 'public.health_check()', 'execute'),
  'authenticated cannot execute health_check()'
);

select * from finish();

rollback;
