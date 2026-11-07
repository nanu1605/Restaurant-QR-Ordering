-- Stop 14e (docs/SUPER_ADMIN_PLAN.md 14e): a restaurant whose account is closed.
-- On its own: a new enum value can't be used in the transaction that adds it.
alter type public.restaurant_status add value 'closed';
