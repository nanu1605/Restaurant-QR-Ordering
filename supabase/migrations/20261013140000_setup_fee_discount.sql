-- The setup fee is ₹999, with ₹500 off for now (the owner, 2026-10-13). The
-- discount is its own setting, so the website can show the usual price and it
-- can end without a release:
--   update public.platform_settings set setup_fee_discount_paise = 0 where id = 1;
alter table public.platform_settings
  alter column setup_fee_paise set default 99900,
  add column setup_fee_discount_paise bigint not null default 0,
  add constraint platform_settings_setup_fee_discount_check
    check (setup_fee_discount_paise >= 0 and setup_fee_discount_paise < setup_fee_paise);

update public.platform_settings
set setup_fee_paise = 99900, setup_fee_discount_paise = 50000
where id = 1;
