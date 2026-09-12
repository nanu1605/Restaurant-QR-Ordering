# Decision log

Decisions taken where the spec was ambiguous, where a library's current API differs from what the
spec assumes, or where the user chose a different default. One line of reasoning each. Newest at the
bottom of each section.

## Versions (Phase 0 setup, 2026-09-12)

| Tool / library               | Version                                          |
| ---------------------------- | ------------------------------------------------ |
| Node.js                      | 24.17.0 (LTS)                                    |
| pnpm                         | 12.4.1                                           |
| Next.js / eslint-config-next | 16.3.5 (App Router, Turbopack)                   |
| React / React DOM            | 19.2.8                                           |
| TypeScript                   | 5.9.3                                            |
| Tailwind CSS                 | 4.3.3                                            |
| shadcn CLI / preset          | 4.21.0 / `base-nova` (Base UI 1.8.0, `cn` 0.2.6) |
| lucide-react                 | 1.44.0                                           |
| @supabase/ssr / supabase-js  | 0.12.7 / 2.116.0                                 |
| Supabase CLI (devDependency) | 2.117.0 — local Postgres 17.6                    |
| zod                          | 4.6.2                                            |
| ESLint / Prettier            | 9.39.5 / 3.9.6                                   |
| Vitest / Vite                | 5.0.0 / 8.3.0                                    |
| Playwright                   | 1.63.0 (Chromium only)                           |
| Docker Desktop engine        | 29.7.2                                           |

## Environment and tooling

- **D1 · Native Windows instead of WSL2.** Spec §0.2 assumes WSL2; the user chose to develop natively
  in `S:\Projects\Restaurant-QR-Ordering`. Windows tools on NTFS are fast (the spec's warning is
  about Linux tools on `/mnt/c`). `.gitattributes` forces LF, npm scripts stay cross-platform, CI
  still runs on Linux.
- **D2 · Repo root is the project root.** No nested `tableorder/` folder; package name `tableorder`,
  `APP_NAME` in `src/lib/config.ts`.
- **D3 · Small conventional commits per logical unit; no push** until a GitHub remote exists and the
  user asks.
- **D4 · pnpm installed with `npm i -g pnpm`.** `corepack enable` needs admin rights on this machine
  (`EPERM` writing to `C:\Program Files\nodejs`). The version is still pinned by `packageManager`.
- **D5 · Supabase CLI as a pinned devDependency** (`pnpm supabase …`), allowed to run its postinstall
  via `allowBuilds` in `pnpm-workspace.yaml`. CI uses the same package instead of
  `supabase/setup-cli`, so local and CI versions never drift.
- **pnpm release-age policy.** pnpm 12 refuses packages published less than a day ago. Next.js
  16.3.5 (released 2026-09-11) and its platform binaries are exempted by exact version in
  `pnpm-workspace.yaml`; remove the entries on the next upgrade.
- **ESLint stays on 9.** ESLint 10 breaks `eslint-plugin-react` 7.37.5 (bundled by
  `eslint-config-next`): `contextOrFilename.getFilename is not a function`. Revisit when
  eslint-config-next ships a compatible plugin.
- **TypeScript stays on 5.x.** TypeScript 7 is out, but `typescript-eslint` supports `<6.1.0` and
  create-next-app pins `^5`.
- **Supabase `project_id` = `tableorder`** (was the folder name) so Docker containers and volumes
  are named after the product.
- **Vitest config is `vitest.config.mts`** so Vite loads it as ESM without adding `"type": "module"`
  to `package.json`.

## Libraries and APIs

- **D7 · Supabase key naming: publishable / secret.** The CLI emits `PUBLISHABLE_KEY` /
  `SECRET_KEY` (`sb_publishable_…`, `sb_secret_…`) and the official Next.js guide uses
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Env vars: `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and
  `SUPABASE_SECRET_KEY` (spec §7's anon/service-role names are replaced).
- **Env split into two modules.** `src/lib/env.ts` (public, reads each `NEXT_PUBLIC_*` by name so
  Next inlines it) and `src/lib/env.server.ts` (`server-only`). Only Phase 0 variables are required;
  later ones become required in their phase.
- **Health check via RPC.** `public.health_check()` (execute granted to `service_role` only) gives
  `/api/health` a real database round trip before any schema exists.
- **Route handlers are uncached by default** in Next.js 16, so `/api/health` needs no `dynamic`
  export; it sends `Cache-Control: no-store` explicitly.
- **D8 · Request interceptor.** Next.js 16 renamed Middleware to Proxy (`proxy.ts`), and the
  Supabase guide refreshes sessions there with `getClaims()`. Implemented in Phase 1 with auth.
- **Type check = `next typegen && tsc --noEmit`** (documented Next.js 16 pattern) so route types
  exist without a full build.
- **shadcn/ui uses its default `base-nova` preset (Base UI primitives).** Simplest option; the CLI
  also added `cn` (shadcn's replacement for clsx + tailwind-merge). The `shadcn` package is a
  devDependency because it is only needed for its CSS import at build time.

## Design system

- **No dark theme.** The spec defines one light palette. shadcn's `dark:` classes are scoped to a
  `.dark` ancestor so they never fire from the OS setting.
- **Ready chip fill is `#0C7C7C`, one shade darker than the `status-ready` token `#0E8A8A`.** White
  on `#0E8A8A` is 4.2:1 and ink is 3.2:1, both under the 4.5:1 floor (§16.2). The token itself is
  still used for edges, icons and dots. Preparing chips use ink text (5.0:1 on turmeric).
- **Status chip label for `placed` is "New"**, matching the kitchen view's first column (§13.2).
- **Type scale enforced in Tailwind:** `text-xs` 12, `sm` 14, `base` 16, `lg` 20, `xl` 24, `2xl` 32
  px; other default sizes are removed.
- **Food-type mark colours:** FSSAI green (`#1B8A3A`) for veg, brown (`#8B4513`) for non-veg, and
  amber (`#B07800`) for egg, which has no official mark. All are ≥ 3:1 against white.
- **Button `touch` / `icon-touch` sizes (44 px)** added to the shadcn button for worker panel
  actions (§13.2).
- **`formatINR` has no "hide paise" mode.** Only `always` and `auto` (hide `.00` only); truncating
  or rounding real paise would misstate prices.

## Schema and scope

- **D6 · `menu_imports` is created in Phase 7**, not Phase 1. Phase 1 says "all tables in
  §8.1–8.6", which technically includes it, but nothing uses it before Phase 7.

## Phase 1 — database, security and auth (2026-09-12)

### Security model

- **P1-4 · Tenant-safe foreign keys.** Every tenant child table carries `restaurant_id`; parents
  have `unique (restaurant_id, id)` and children reference `(restaurant_id, parent_id)`. The
  database itself rejects a row that points at another restaurant's parent (e.g. an item in
  another restaurant's category). `order_items` also proves its order is in the same session,
  and its variant belongs to the ordered item.
- **P1-5 · RLS helper for policies.** Policies use `private.my_restaurant_ids(roles)` wrapped in
  `(select …)`, so membership is looked up once per statement, not per row. The spec's
  `is_platform_admin()`, `member_role()` and `has_role()` exist for use inside functions.
- **P1-6 · `set search_path = ''`** on every security-definer function (stricter than the spec's
  `= public`), with fully qualified names. A schema-guard test enforces it.
- **P1-7 · `private` schema** for internal helpers; PostgREST doesn't expose it.
- **P1-8 · Explicit EXECUTE grants.** Per-schema `ALTER DEFAULT PRIVILEGES` cannot remove
  PostgreSQL's global EXECUTE-to-PUBLIC default (tried; anon could still call everything). Every
  migration now revokes EXECUTE from `public, anon, authenticated` right after creating a
  function and grants it only where needed. `010_schema_guards` keeps an allowlist of the
  functions signed-in users may call; adding a function without updating it fails the tests.
- **Table privileges.** `anon` has none. `authenticated` never gets TRUNCATE/REFERENCES/TRIGGER
  (not covered by RLS), and has no INSERT/UPDATE/DELETE on state tables — writes to sessions,
  orders, bills and so on can only happen inside business functions, even if a policy were
  added by mistake.
- **P1-9 · `dining_tables`**: no direct INSERT (so `max_tables` and the server-side QR token
  can't be bypassed); direct UPDATE only on `label`, `sort_order`, `is_active` via column grants.
- **Category names are unique per restaurant**, case- and spacing-insensitive, including hidden
  ones. This makes "Add suggested categories" and menu imports match cleanly (§8.4, §20A).
- **P1-15 · Actor columns** (`*_by`, `actor_user_id`) are plain uuids with no FK to
  `auth.users`, so history survives a deleted user.
- **Storage.** Public-read `menu-images` and `logos` buckets (1 MB; webp/jpeg/png, no SVG);
  only owners and managers may write, and only inside `<restaurant_id>/`. Storage blocks direct
  SQL deletes (`storage.protect_delete`), so the delete policy is pinned by definition in pgTAP
  and gets exercised through the Storage API in Phase 2.

### Business rules

- **P1-10 · Default plans and `platform_settings` live in a migration**, not `seed.sql`, so
  staging and production get them too. They stay editable.
- **P1-11 · `restaurant_access(p_restaurant_id, p_at default now())`.** The optional `p_at` makes
  the business-day rules testable at fixed instants.
- **P1-12 · Access warnings are codes** (`trial_ends_soon`, `subscription_ends_soon`,
  `payment_failed`); the UI writes the sentence.
- **Active subscriptions that auto-renew don't warn** in the 3 days before restriction. They only
  warn when set to cancel at period end. Otherwise every healthy subscription would show a
  scary banner a day before each renewal.
- **Past-due without `grace_until`** falls back to `current_period_end + 2 days`, and cancelled
  or expired without any period restricts immediately.
- **P1-13 · `platform_create_restaurant(jsonb)`** exists now (`service_role` only), used by
  `pnpm create-restaurant`. Phase 2 adds default categories to it and Phase 7's wizard reuses
  it. New restaurants start with GST `none` (§23).
- **Business-day helpers** `private.business_day_start()` / `next_business_day_start()` are shared
  with Phase 6 reports.

### Auth

- **P1-1 · Platform-admin MFA** — TOTP enrolment/verification is enabled in `config.toml`; the
  enrolment UI and requiring `aal2` on `/super` are built with the Phase 7 panel (user's choice).
- **P1-2 · Username login resolves the stored email.** The server calls
  `auth_staff_login_email(slug, username)` (`service_role` only), then `signInWithPassword`.
  Changing the synthetic domain later can't break logins, and owners with a real email can
  also log in by code + username. Unknown code, unknown username, inactive member and wrong
  password all return the same message.
- **P1-3 · `STAFF_EMAIL_DOMAIN`** (default `tableorder.test`, a reserved non-deliverable TLD)
  builds `<username>@<slug>.staff.<domain>`; set it to the app domain in staging/production.
  Local GoTrue accepts it through the Admin API.
- **P1-16 · Wrong panel → your own panel.** A waiter opening `/admin` lands on `/staff`; a
  platform admin with no restaurant opening `/admin` lands on `/super`.
- **Guards run in every page**, not just layouts. Next.js 16's auth guide warns that layouts
  don't re-run on client navigation and don't stop nested segments from rendering. Guards are
  `cache()`d per request, so repeating them is cheap.
- **Sessions are verified with `getClaims()`** in the proxy and on the server, as the current
  Supabase SSR guide recommends.
- **Log out is device-only** (`scope: 'local'`). Staff often share one login across tablets; a
  global sign-out would kick the other devices off too.
- **`next` redirects are sanitised** to same-origin paths inside panels the user may open
  (`safeNextPath`), so login can't be used as an open redirect.
- **P1-17 · Supabase auth config**: public signup off, minimum password length 8,
  `site_url = http://localhost:3000`. The local `sign_in_sign_ups` rate limit is raised to 1000
  per 5 minutes because server-side sign-in makes every login share one IP (see Phase 10 risk).
  Signups are blocked only by `[auth] enable_signup = false`; `[auth.email] enable_signup` must
  stay `true` because the CLI maps it to the whole email provider (turning it off disables
  password sign-in too — first caught by CI). Auth config changes only apply after
  `pnpm db:stop && pnpm db:start`; `db reset` keeps the running auth container.
- **Unexpected sign-in errors are not "wrong password".** Only `invalid_credentials` shows the
  generic message and 429 shows the rate-limit message; anything else (auth down, bad key,
  provider disabled) throws so it's logged instead of hidden.

### Tooling

- **P1-14 · pgTAP helpers** live in a `tests` schema loaded by `supabase/seeds/test_helpers.sql`
  (second entry in `[db.seed] sql_paths`), so they exist locally and in CI but never in
  staging/production. Test files use psql `\gset` variables for fixture ids.
- **Generated types** (`pnpm db:types`) are committed; CI regenerates them and fails on drift.
  `ORDER_ITEM_STATUSES` comes straight from the generated `Constants`.
- **`pnpm create-restaurant`** runs on Node 24's built-in TypeScript support
  (`scripts/create-restaurant.mts`) and imports the pure `src/lib/auth/staff-email.ts`, which
  needs `allowImportingTsExtensions` (safe with `noEmit`). Node's typeless-package warning is
  silenced in the script command.
- **E2E locators** use roles scoped to the header banner or the form, because Next.js' route
  announcer is also `role="alert"` and Base UI labels tab panels with the tab's name. Login
  helpers scope to the active tab panel: the old panel stays mounted briefly while switching.
- **CI diagnostics**: on failure CI prints the page snapshots of the first failed E2E tests and
  the last auth-service log lines, so most failures can be read from the log without
  downloading the report.
- **Seed**: variant items keep the Half price in `price_paise` as a fallback; tables use fixed
  QR tokens `DEMO0000TABLE001…006` for later E2E tests.
