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
- **Product name: MenuMesh** (user, 2026-09-25; replaces the provisional DineFlow of 2026-09-13).
  `APP_NAME` is `MenuMesh`, the package is `menumesh`. The user owns `menumesh.app`,
  `menumesh.co` and `menumesh.in`. The app is served from **`https://menumesh.in`** (user,
  2026-09-25): it is production's `NEXT_PUBLIC_APP_URL`, so the address printed into every QR
  code, and production's `STAFF_EMAIL_DOMAIN`. `www.menumesh.in`, `menumesh.app` and
  `menumesh.co` redirect to it (301); QR codes use the bare domain because it is shortest.
  Identifiers nobody outside development sees keep
  `tableorder`: Supabase `project_id` (renaming recreates the containers and volumes), the local
  `STAFF_EMAIL_DOMAIN` default `tableorder.test` (staging/production set the real domain) and the
  cart's storage key `tableorder:cart:<token>`. A later rename stays one constant plus the package
  name.

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

- **The palette below was replaced by the logo's** on 2026-10-03: see "Brand refresh" (B-1, B-2).
- **No dark theme.** The spec defines one light palette. shadcn's `dark:` classes are scoped to a
  `.dark` ancestor so they never fire from the OS setting. _Superseded on 2026-10-03: a dark
  theme the user can switch (B-3)._
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

## Phase 2 — admin setup (2026-09-12)

### Rules and access

- **P2-1 · Read-only restaurants can't change setup** (user's choice). Menu, tables, staff
  logins (create, edit, reactivate), waiter profiles (create, edit, delete) and settings raise
  `RESTAURANT_READ_ONLY` in the database, and the UI disables them under a banner. Still allowed,
  so service can go on and accounts can be locked: the dish in-stock switch, waiter on/off duty,
  deactivating a login and resetting a password.
- **P2-2 · Staff limit leaves the owner out** (user's choice): `max_staff` counts active logins
  with any role but owner; `max_tables` counts active tables. Reactivating a table or a login is
  checked like creating one, so switching things off and on can't get round a limit. Both checks
  lock the restaurant row, so parallel requests can't overshoot.
- **P2-3 · Menu and tables are written only through `admin_*` functions.** The Phase 1 direct
  write privileges and policies on `menu_*` and the column grant on `dining_tables` are revoked.
  §9.1 allows direct CRUD but doesn't require it; one path keeps role, read-only, plan and format
  checks together and makes multi-row changes (dish + options, reorder, delete-and-move) atomic.
- **P2-4 · Functions work out the restaurant from the caller** (`private.current_member`), never
  from a client-supplied id. Ids that belong to another restaurant are reported as `NOT_FOUND`.
- **Error convention extended:** `DETAIL` carries context for the message (the clashing label,
  the plan limit, the open tables). `src/lib/db-errors.ts` turns codes into sentences; unknown
  errors are logged on the server and shown as "Something went wrong".

### Staff logins and waiters

- **P2-5 · Staff logins:** the server action creates the auth user through the Admin API
  (synthetic email, confirmed), then `admin_create_staff(p_actor_user_id, …)` — service role only,
  with the actor taken from the verified session — adds the membership. If the database refuses,
  the auth user is deleted. Password resets are authorised and logged by
  `admin_reset_staff_password(member_id)` as the signed-in manager, then set with the Admin API.
  Everyone can reset their own password there; the owner is never managed by others.
- **P2-6 · Reactivate** is the inverse of Deactivate (not named in the spec). Usernames are unique
  per restaurant, so without it a deactivated username could never be used again.
- **Deactivated logins get the generic "wrong code, username or password" message** at the code +
  username login (the lookup only returns active members, Phase 1). The "account is inactive"
  message stays for email logins.
- **Existing sessions:** deactivation takes effect on the next request (RLS and the guards only
  see active memberships). A password reset doesn't end sessions already signed in; the Admin API
  has no "sign out this user" call without their token.
- **P2-12 · Deleting a waiter profile** is a soft delete that also unlinks its login, so the login
  can be linked again; `employee_code` is unique among active waiters only. The login itself stays
  under Staff logins. A login moved off the waiter role is unlinked from its profile.
- **"Create a login for this waiter"** creates the login first and removes it again if the profile
  can't be saved.
- **Waiter status** follows `max_tables_per_waiter`: Busy once a waiter has that many open
  tables, otherwise Available (with the tables listed). "Tables today" counts sessions assigned
  during the current business day.

### Menu, tables and settings

- **P2-7 · Default category sets live only in `src/features/menu/default-categories.ts`.**
  `platform_create_restaurant` takes the names (`categories`) and marks them `source = default`;
  `admin_add_categories` adds the missing ones for "Add suggested categories", matching case- and
  spacing-insensitively. `pnpm create-restaurant --cuisine <set>` picks the set (default
  `north_indian`).
- **P2-8 · Hide = soft delete for dishes** (`is_active = false`); hidden dishes and categories are
  listed under "Hidden (n)" to show them again. Removed options become inactive rather than being
  deleted, because order history points at them. With options, `price_paise` holds the cheapest
  option ("from ₹X").
- **P2-9 · Deleting a category** with dishes (hidden ones too) moves them to a chosen category
  first; the dialog also offers "Hide instead".
- **P2-10 · Dish photos** are resized in the browser (`browser-image-compression`, 800 px, WebP)
  and uploaded by the same server action that saves the dish, under the signed-in user's session
  so Storage RLS applies: `menu-images/<restaurant_id>/<item_id>.webp`. New dishes get their id in
  the browser for this. The URL carries `?v=<updated_at>` so a replaced photo isn't served from
  cache. The compression library runs on the main thread because its worker loads a script from
  a CDN. Logos work the same way (`logos/<restaurant_id>/logo.webp`, 512 px).
- **Admin images use `next/image` with `unoptimized`.** Next.js 16 refuses to optimise images from
  local IPs (the local Supabase URL), and thumbnails don't need it; the customer menu (Phase 3)
  will configure optimisation for the hosted Storage URL.
- **P2-11 · QR codes:** PNG download from `GET /admin/tables/[tableId]/qr` (owner/manager, RLS
  scoped); the print sheet renders SVG codes on the server, 6 cards per A4 page. It warns when
  `NEXT_PUBLIC_APP_URL` points at a local address, since those codes won't work on customers'
  phones. Table ranges accept `1–20`, `T1–T5`, `Terrace 1–4`, up to 100 at a time.
- **P2-13 · Plan features for the UI** come from `restaurant_plan()` (security definer; managers
  can't read subscriptions through RLS). The database checks the same features and limits.
- **P2-14 · Settings** go through one whitelisted `admin_update_settings`; every change is
  audited with before/after values of the keys that changed (a superset of the spec's tax/bill
  requirement). The UPI QR switch needs the `upi_qr_on_bill` feature to turn on (never to turn
  off) and a UPI ID. GST rate is a choice of the standard slabs. **"Test print" moves to Phase 5**
  with the bill print page.
- **Settings forms follow the server instead of remounting.** The refresh after a save lands a
  moment after the "Settings saved" toast, and the forms used to remount on `updated_at`, which
  wiped anything typed in the meantime, even in another tab. Each form now takes the stored values
  through react-hook-form's `values` with `keepDirtyValues`, and a save makes the submitted values
  the new baseline (`resetDefaultValues`), so the refresh still shows what was stored (the GSTIN in
  capitals) without touching edits made since.
- **`upi_vpa` check fixed:** the Phase 1 regex used `{2,256}`, above Postgres' repetition limit of
  255, so every VPA failed at runtime; now `{2,255}`.

### UI and tooling

- **P2-15 · Forms:** react-hook-form with zod schemas shared by the dialog and the server action;
  actions return `{ ok, data } | { ok: false, error, fieldErrors }`. Watching values uses
  `useWatch` (the React Compiler lint rule rejects `watch()`). Toasts use sonner without
  `next-themes` (one light theme; since B-3 the root layout passes the theme to the toaster).
- **Drag and drop uses `@dnd-kit/core` + `sortable` 6.x/10.x**, the stable line; the new
  `@dnd-kit/react` is still pre-1.0. Screen readers hear dish, category and table names instead of
  ids, and the keyboard works (Space, arrows, Space). Order changes show at once
  (`useOptimistic`) and roll back with a message if the save fails.
- **Switch track colour** for "off" is `ink-muted` at 70 % instead of the light border colour, which
  was under the 3:1 contrast needed for controls.
- **P2-16** Staff "last login" comes from `admin_list_staff()` (reads `auth.users`).
- **P2-17 · E2E tests create their own restaurants** through the shared onboarding module
  (`src/features/platform/onboard.ts`, also used by the script) with unique codes, and never
  change the demo seed. Admin feature specs run on the desktop project; the admin navigation also
  runs on the phone viewport.
- **P2-18** Later admin sections (Dashboard, Live orders, Billing, Total orders, Reports,
  Subscription) show an empty state until their phase.

## Phase 3 — customer ordering (2026-09-13)

### Device cookie and access

- **P3-1 · `cid` device cookie:** an HS256 JWT signed with `jose` (`{ sub: <uuid> }`, algorithm
  pinned on verify), `httpOnly`, `SameSite=Lax`, `path=/t`, one year, `Secure` only when
  `NEXT_PUBLIC_APP_URL` is https (so localhost and LAN testing work). The proxy now matches `/t/*`
  in its own branch, without any Supabase work: a phone without a valid cookie gets one, set on
  the response and on the forwarded request so the same render sees it. Server actions post to
  the page's path, so they pass through the same branch; an action that still finds no cookie
  issues one. `CUSTOMER_COOKIE_SECRET` is now required (CI generates one per run).
- **P3-2 · `customer_get_session(p_qr_token, p_device_id)`** takes the device id (the spec lists
  only the token): it marks this phone's rounds, offers cancellation and reports
  `last_session_billed`.
- **Customer functions are service-role only** and take no restaurant id: the QR token is the
  credential, and the device id always comes from the cookie, never from the client.
- **P3-15 · A QR code that doesn't work** (unknown, switched off, regenerated) gets a 404 with a
  friendly page (`src/app/t/not-found.tsx`, which catches `notFound()` from the table layout).

### Ordering rules

- **P3-3 · `ITEM_UNAVAILABLE`** covers unknown, hidden, out-of-stock and other restaurants' dishes,
  dishes in hidden categories and option mismatches (the dish gained or lost options, or the option
  was removed). DETAIL lists the dish ids; the cart removes and names them. Nothing reveals whether
  another restaurant's id exists.
- **P3-4 · Idempotency:** the table row is locked first, then the key is looked up. The same key
  from the same phone at the same table returns the original order (`replayed: true`), even if the
  menu has changed since; reused anywhere else it is `INVALID_INPUT`. The unique constraint is
  the backstop.
- **P3-5 · Rate limits (§9.4)** count customer orders only; the per-phone limits follow the
  device cookie across restaurants. "3 waiting for approval" applies only when the new order
  would wait too (approval on and the session not yet approved), and a waiting order whose dishes
  the customer cancelled no longer counts. **Phases 4 and 5 must use the same rule** for "Needs
  approval" and billing, or a fully cancelled waiting order could block a table.
- **Approval switched off mid-session:** later orders are accepted and the session counts as
  approved; rounds already waiting stay with staff to decide.
- **P3-6 · Read-only:** ordering raises `ORDERING_UNAVAILABLE` and the menu is view-only;
  cancelling one's own dish stays allowed (it only takes work away).
- **P3-7 · Audit:** customer cancellations only (`order_item.cancelled`, actor
  `Customer (device …abcd)`); the order row itself records placement.
- **P3-8 · Customer menu:** active categories with at least one active dish; active dishes (out of
  stock ones listed as "Not available"); active options. Dish order within a round is by name.
- **P3-11 · Billed state:** `last_session_billed` is true when this phone's latest session at the
  table was billed within the hour; the orders page shows the thank-you message until the phone
  orders again, which starts a fresh session.

### Customer panel

- **P3-9 · Polling:** `GET /t/<token>/session` (no-store) every 10 s while the page is visible, when
  it becomes visible and after a cancel, with plain `fetch`. Countdowns use the offset between the
  server's clock and the phone's.
- **P3-10 · Cart:** `localStorage["tableorder:cart:<token>"]` (versioned), one line per dish or per
  dish and option, a note per line, 1–20 each, at most 30 lines; checked against the menu on every
  page load. The idempotency key is made when the cart page loads with `crypto.getRandomValues`
  (`randomUUID` needs a secure context, and LAN testing is plain http), kept across retries and
  renewed after a successful order.
- **P3-12 · Accent colour:** the layout writes the accent variables to `:root` (so portalled sheets
  and dialogs get them) with a foreground of white or ink, whichever reaches 4.5:1, falling back to
  the default brand colour. The accent is never used as text on white; focus is a 2 px outline in a
  ring colour that reaches 3:1 on white, and the current category tab also gets that ring.
- **P3-13 · Customer status label** for `placed` is "Placed" (staff keep "New"). Cancelled and
  removed dishes are struck through with the reason.
- **Category tabs scroll without a URL fragment:** a native `#fragment` jump adds a history entry
  that the Next.js router ignores, which broke the phone's Back button. The scroll-spy picks the
  last heading that has reached the sticky bar (or the last category at the page end) and keeps a
  tapped tab selected until the customer scrolls.
- **Screen readers:** adding or removing a dish and search results are announced; focus moves to the
  control that replaces the one just used; the cart and orders pages have their own titles, so page
  changes are announced; the Cancel button reads out the time left.
- **Customer text uses typographic apostrophes (’)** throughout.

### Performance

- **P3-14 · Images:** `next/image` optimises Storage images through `images.remotePatterns` built
  from `NEXT_PUBLIC_SUPABASE_URL` (public buckets only); `dangerouslyAllowLocalIP` is on only when
  that URL is local (dev and CI). Thumbnails are 112 px with matching `sizes`, lazy-loaded.
- **Menu JavaScript:** no Supabase client, zod, dnd-kit, react-hook-form, qrcode or jose reach the
  customer bundle (checked in the build's client manifests). The options sheet (Base UI dialog and
  radio group, about 40 KB gzipped) loads after the page with `next/dynamic`.
- **Measurement:** `PERF=1 pnpm e2e customer-perf --project=mobile` measures menu LCP on a production
  build with Lighthouse's mobile throttling (150 ms RTT, 1.6 Mbps, 4× CPU) and fails above 2.5 s.
  Measured 2026-09-13 on the demo table (3 runs): LCP 960–988 ms; 213 KiB of compressed
  JavaScript downloaded in total (about 128 KiB of it framework). The options sheet still
  downloads on every menu visit, but after hydration, so it is off the path to first paint.

### Tests

- **P3-16 · Concurrent first orders** are tested in pgTAP with `dblink`: two real connections race
  for one free table on a committed fixture that the file removes again. The local stack trusts
  127.0.0.1, where `dblink` refuses non-superusers, so the test connects through the server's own
  network address, which asks for a password. The lock wait is detected by polling
  `pg_stat_activity` with a fresh snapshot each time.
- **P3-17 · Customer E2E** runs on the phone project only, on restaurants it creates; the demo
  table is only viewed. Test fixtures insert rows with the service role (bulk inserts send every
  key, so each row sets `is_available`).

## Phase 4 — worker panel and live orders (2026-09-17)

### Live data

- **P4-1 · TanStack Query 5.102.8** for the live screens (spec §4): one browser `QueryClient`. Server
  layouts and pages seed the first board with `setQueryData` + `dehydrate` / `HydrationBoundary`
  rather than `initialData`, because several observers (alerts in the layout, the page) share one
  query. The board is keyed by membership, so a shared tablet that switches login never shows the
  previous user's board; the menu is keyed by restaurant.
- **P4-2 · One Realtime channel per restaurant**, opened by `LiveProvider` in the `/staff` and
  `/admin` layouts: Postgres Changes on the six published tables, filtered by `restaurant_id`,
  joined after `await supabase.realtime.setAuth()` with `postgres_changes_options.wait: true`, so
  "Live" means the database side is listening. Any event refetches the board 300 ms after the last
  one (the menu too for `menu_items`); nothing is patched from payloads. Safety nets: 30 s
  refetch, window focus, coming back online, and a refetch on every (re)subscription. A spike on
  the local stack showed events ~110 ms after a commit, and that binding a table that isn't
  published fails the channel **and silently stops events on every other channel of the same
  socket** — so exactly one channel, published tables only.
- **P4-3 · Board data from one read function, `staff_get_board()`** (security definer, scoped by
  the caller's membership): every table, its open session's rounds and dishes, the waiters, the
  settings the screens need and the server clock. One round trip, the role filter runs in the
  database and pgTAP tests it. No prices.
- **P4-4 · Kitchen logins never receive waiting or rejected rounds**, only how many rounds are
  waiting at each table. This is a display rule: RLS lets every member read orders (§9.1). The
  kitchen view shows accepted rounds for every role. Removed rounds aren’t sent to kitchen either:
  its board carries accepted rounds only.
- **P4-5 · One "waiting for approval" rule:** `private.is_waiting(order)` (pending with a dish still
  `placed`, P3-5) drives the customer rate limit, the board and later billing.
  `customer_place_order` was recreated on shared helpers (`parse_order_lines`, `assert_orderable`,
  `insert_order_items`) with no behaviour change; `staff_place_order` uses the same ones.
- **P4-16 · New-order alerts** compare each board refresh with the previous one instead of reacting
  to `INSERT` events: a missed event still alerts on the next refetch, the kitchen hears about an
  order when it is approved (when it becomes visible to it), the first load is silent and orders
  placed on this device don't chime. Admin Live orders also announces newly seated tables. The
  alerts component observes the cache without re-rendering, takes a cached board as its baseline
  only when it is fresh (under 15 s and not invalidated), treats hydration as a new baseline rather
  than news, and ignores refetch results while this device's own board changes are pending.
- **P4-19 · Board changes are server actions without `refresh()`:** optimistic update, then one
  board refetch once this device's last change has finished (`isMutating === 1`), so overlapping
  taps don't flicker. Next 16 runs server actions one at a time per client; a kitchen ticket moves
  all its dishes in one action. The 30 s poll, focus and reconnect refetches also wait while a change
  is pending, the menu query has its own mutation key so a refetch can't undo an in-flight
  availability switch, and the fetch time travels inside the board data so optimistic updates don't
  shift the server clock offset. Availability on the worker panel uses its own action without
  `refresh()`.
- **Measured:** tap "Place order" on the phone → table shows on the waiter's and manager's boards
  in 843–862 ms on the production build (E2E, local stack), inside the ~2 s target.

### Rules

- **P4-6 · A session with nothing active and nothing waiting** (after a reject, or when the
  customer cancelled everything) shows "No active dishes" and stays open until staff close it or
  add dishes (§10.2).
- **P4-7 · Dishes only move forward;** skipping ahead is allowed. Asking for the status a dish
  already has does nothing, so two devices tapping at once don't see errors; going backwards is
  `INVALID_STATUS_CHANGE` (managers use Revert, one step). Revert takes the status the manager saw
  (`p_from_status`); if the dish has moved since, it returns `changed: false` instead of stepping
  back twice.
- **P4-8 · A partial removal lowers the quantity in place** and is audited with before/after
  quantities (§9.3); removing the whole quantity marks the dish `removed`, struck through with who
  and why (§10.8: existing rounds are never edited, so no split lines).
- **P4-9 · Read-only (§10.6):** only new orders stop (`ORDERING_UNAVAILABLE`, "Add dishes" disabled).
  Approve, reject, status changes, removals, assignment and close without bill keep working.
- **P4-10 · Lock order** everywhere: dining table → session → waiter → order → dishes. Functions
  that end a session lock the table first, so a customer order (which holds the table lock) can't
  land in a session that is closing. Phase 5 billing and void-reopen must follow the same order.
  `customer_place_order` also locks the open session row. `admin_update_table` locks the restaurant
  with `for no key update`, which doesn't block the `for key share` locks foreign keys take while
  orders are inserted.
- **P4-11 · Assignment keeps `table_sessions.assigned_*` and `session_waiter_assignments` in step**
  through `start_assignment` / `end_assignment`. A closed or billed session keeps
  `assigned_waiter_id` as history; availability counts open sessions only.
- **P4-12 · Assigning a waiter approves every waiting order** of the session (§10.7 "one tap"),
  audited as `order.approved` with `via: assignment`; waiting rounds exist only because approval was
  on when they were placed.
- **P4-13 · Auto-assign (§10.7)** only when the caller's own waiter profile is active, on duty and
  under the limit and the table has no waiter; the waiter row is locked for the check, as it is
  when a manager assigns (so two managers can't both give a waiter their last free table).
- **P4-14 · Staff orders** store their note in `orders.customer_note` (the order's note), are always
  accepted and approve the session. Placing orders and moving dishes forward aren't audited
  (§8.8's list); approvals, rejections, removals, reverts, assignments and closes are.
- **P4-15 · A staff order's idempotency key** replays only for the same staff member at the same
  table; any other reuse is `INVALID_INPUT` (like P3-4).
- **P4-20 · Reasons** are 1–200 characters. Reject offers "Prank / not seated", "Items unavailable",
  "Duplicate" or Other…; Remove dish "Customer request", "Wrong item", "Out of stock", "Quality
  complaint" or Other… (§13.2). Delete order and Close without bill take a typed reason.
- **Close without bill (§9.3):** waiters close tables with no accepted dishes; anything else needs a
  manager (`REQUIRES_MANAGER`). Dishes still on the way are cancelled, served ones stay.
- **New error codes:** `SESSION_NOT_OPEN`, `ORDER_NOT_PENDING`, `ORDER_NOT_ACCEPTED`,
  `ORDER_NOT_ACTIVE`, `ITEM_NOT_ACTIVE`, `INVALID_STATUS_CHANGE`, `REQUIRES_MANAGER`,
  `REASON_REQUIRED`, `WAITER_BUSY` (DETAIL = the tables), `WAITER_NOT_AVAILABLE` (DETAIL = name).

### Screens

- **P4-17 · Kitchen tickets are one per round and status:** a round with dishes at different stages
  shows in each column it has dishes in, so ready dishes never hide behind new ones. Tickets turn
  to the attention colour with a "Late" label after 15 minutes. Tapping a dish moves it on; the
  ticket button moves all its dishes.
- **P4-18 · The `kds` plan feature is gated in the UI** (the Kitchen tab and page); no database
  function is specific to the kitchen view.
- **P4-21 · `dining_tables` isn't published to Realtime (§8.11):** new or renamed tables reach open
  boards on the next 30 s refetch or window focus.
- **Sound (§12):** "Enable sound" shows until the device chooses; then a small on/off toggle. The
  choice is kept in `localStorage["tableorder:sound"]`; the chime is two notes synthesised with Web
  Audio (no sound file), and audio is resumed by a tap after a reload.
- **Drawer and pickers:** "Add dishes" is a menu picker on top of the table drawer; after placing,
  the drawer stays open on the new round. Options are one button each ("Half · ₹280") so staff add
  them in one tap. "Waiter:" with Assign / Reassign / Unassign appears in the drawer on Live orders.
- **Worker panel navigation:** Board · Kitchen (with `kds`) · Availability. Linked waiter logins
  start on "My tables"; kitchen logins don't get the "Needs approval" filter.
- **Shared hooks moved to `src/hooks`** (`useNow` now shares one timer per interval; the board ticks
  every 30 s). Table cards are at least 13rem wide (spec minimum 160 px) so state badges fit, and
  labels on cards and badges are 16 px.
- **Touch and keyboard:** close buttons, the sound toggle and header controls are 44 px. After a
  kitchen move, focus goes to the next dish on the same ticket or the column heading, and a polite
  status message says what moved. Delete order is offered on waiting rounds too. Sound resumes on
  any later click, touch end or key press, not only the first.

### Tests

- **pgTAP 150–200** cover the board (including the kitchen filter and P3-5), approval and status,
  staff orders with auto-assignment, removals and close without bill, assignment, and `dblink`
  races: a staff order and a customer first order on one free table, and two managers assigning
  the same waiter. Helpers `tests.add_waiter` and `tests.bill_session` (billing arrives in Phase 5).
- **P4-22 · Live E2E** runs on the desktop project and opens its own phone context for the customer.
  Realtime checks start only once the header says "Live" and use 5 s timeouts, shorter than the
  30 s poll, so a broken channel fails the test.

## Phase 5 — billing, printing, payments, Total orders (2026-09-17)

### Bills

- **P5-1 · One calculation:** `private.calc_bill_totals` (subtotal, discount, service charge and GST
  settings in, totals out) is pure SQL with numeric maths and `round()`, half up on non-negative
  values (checked on Postgres 17). `private.bill_pricing` prices lines with the saved settings and
  `private.bill_draft` adds the blockers; preview, generation and the sample bill all use them, so
  the screen and the stored bill can't disagree. The §11.1 cases are pgTAP tests.
- **P5-2 · Bill lines merge** the same dish, option and unit price across rounds ("Butter Naan × 3"),
  in the order first ordered. Dish notes aren't printed.
- **P5-3 · Billable** means placed, preparing, ready or served dishes on accepted rounds. Only a
  round that is really waiting (`private.is_waiting`, P3-5) blocks the bill (`ORDERS_WAITING`); a
  waiting round the customer cancelled entirely neither blocks nor bills.
- **P5-4 · Generation locks** the dining table, the session and the session's dishes, then the
  invoice counter. A second generate on the same table gets `ALREADY_BILLED` with the bill id in
  DETAIL, and the screen opens that bill. A customer cancel that waited for those dish locks used
  to go through on a billed table (bill generation locks dishes without changing them, so Postgres
  didn't re-check the join); `customer_cancel_item` now looks at the session again after locking
  the dish. The `dblink` race test fails without that fix.
- **P5-5 · Invoice numbers** come from `insert … on conflict do update set last_seq = last_seq + 1`
  per restaurant and financial year (April–March in the restaurant's timezone). Numbers are padded
  to five digits but a sixth isn't cut off (`lpad` truncates). A new prefix applies to new bills.
- **P5-6 · What a bill freezes:** the restaurant's name, legal name, address, phone, GSTIN, FSSAI,
  logo and footer, the waiter, the tax settings and the lines. How it prints is read at print time:
  paper width, the "Served by" line, branding (`remove_branding`) and the UPI QR, which needs the
  setting, the plan feature and a UPI ID, so a reprint pays today's UPI ID. The tax settings stored
  on the bill come from the same read the totals were worked out with. Known limit: the logo is
  frozen as a path, and uploading a new logo replaces that file, so old bills reprint with the new
  logo (or none after the logo is removed). Accepted by the user (2026-09-25): everything that
  matters legally is frozen, and logos rarely change.
- **UPI QR payload (§11.3):** `upi://pay?pa=<vpa>&pn=…&am=…&cu=INR&tn=…` with the UPI ID as it is
  (its pattern allows only URL-safe characters and `@`); the payee name and note are URL-encoded.
- **P5-17 · Discounts:** percent up to 100% with two decimals (stored as basis points), flat in
  rupees capped at the subtotal by the calculation, a reason of 1–200 characters when the discount
  is above zero, and `FEATURE_NOT_IN_PLAN` without `discounts`. A service charge is added only when
  it is switched on in settings and ticked on the bill; the bill labels it "Service charge
  (optional)".

### Payments, void and reopen

- **P5-8 · Payments** are recorded once per bill: 1–10 rows that add up to the grand total
  (`PAYMENT_MISMATCH`, DETAIL = the total), more than one row needs `split_payments`, amounts are
  positive except that a ₹0 bill takes a single ₹0 row, references are at most 100 characters.
  The cash change calculator is on screen only.
- **P5-7 · Void** marks the bill void and its payments `is_void`; `payment_status` stays as history
  and voiding twice changes nothing. **Reopen** is allowed only while `reopen_window_minutes > 0`,
  within the window, while the table is still switched on and has no new session; otherwise
  `REOPEN_NOT_ALLOWED` (`window` / `table_inactive` / `table_busy`) and nothing is voided. The session opens again (billed time cleared)
  and its waiter comes back if still active, on duty and under the table limit (waiter row locked),
  else the table is Unassigned. A void without reopening leaves the session billed. Locks: table →
  session → bill → waiter.
- **P5-9 · Read-only restaurants** still bill, take payments, void, reopen and print (§10.6).
- **P5-16 · A printed void bill** says VOID under the title; the sample bill says "TEST PRINT — NOT A
  BILL".

### Screens

- **P5-10 · Print pages have no admin chrome:** the admin pages moved into the route group
  `src/app/admin/(panel)` (URLs unchanged) and `src/app/admin/(print)` holds
  `/admin/bills/[billId]/print` and `/admin/settings/test-print` behind the same login check,
  without the live connection. §15's `@page { size: 80mm auto }` isn't valid CSS (Chromium drops
  it), and a fixed height would split long bills into pages, so the print page sets only
  `@page { margin: 0 }`, lays the bill out 72 mm (or 48 mm) wide and leaves the paper size to the
  printer driver, as §15 expects. The A4 page size of the QR card sheet moved from the global
  stylesheet into that page, so it no longer applies to bills. The page opens the print dialog once
  on load and counts the print after `window.print()` returns. `?copy=office` adds the discount reason and who generated the
  bill. Test print uses `admin_sample_bill()` (the §11.1 dishes with the saved settings) and counts
  nothing.
- **P5-11 · No A4 bill layout:** `paper_width` only has 58 mm and 80 mm (§15 lists A4 as optional).
- **P5-12 · Total orders** is one function, `admin_total_orders(p_filters)`: business dates (the
  range covers from the start hour of the first day to the start hour after the last, at most 366
  days, default today's business day), table, waiter, payment status and mode, invoice number
  (plain text match), void bills shown or hidden, the Closed without bill view, 50 rows a page.
  Void bills never count in the summary; "Net collected" sums non-void payments (only those in the
  chosen mode when a payment mode is picked); "Items" is billed quantities. Impossible dates in the
  URL are dropped, and a range longer than a year is cut to a year, with a note on the page. Business-day and financial-year logic lives in SQL only, so the §18 edge cases (3:59
  am, 31 March 11:59 pm) are pgTAP tests rather than a `time.ts`; the filters live in the URL.
- **P5-13 · Billing screens stay live:** open tables and the bill preview are TanStack queries under
  `['billing', memberId, …]`, refreshed by the restaurant channel's events (and a 30 s poll); the bill
  page and Total orders are server-rendered and refresh after their own actions.
- **P5-14 · The bill builder** is a page per table (`/admin/billing/[sessionId]`). The preview
  refetches 300 ms after the discount or service charge stops changing and keeps the previous
  numbers meanwhile; Generate bill stays disabled until the preview matches the choice (background
  refetches don't disable it, so keyboard focus stays). Generation sends the grand total the
  confirmation shows; if the bill now comes to something else (a dish removed, settings changed
  meanwhile), `BILL_CHANGED` saves nothing and the screen shows the new preview. Unserved dishes get the §10.5 confirmation ("2 items not marked served
  — bill anyway?") with the list.
- **P5-15 · Bill history** shows the audit entries of the bill and its table session, oldest first.
- **New error codes:** `ORDERS_WAITING`, `NOTHING_TO_BILL`, `WAITER_REQUIRED`, `ALREADY_BILLED`,
  `BILL_VOID`, `BILL_ALREADY_PAID`, `PAYMENT_MISMATCH`, `REOPEN_NOT_ALLOWED`, `BILL_CHANGED`.
- **Review fixes (database, money, React, accessibility):** the print page size above,
  `BILL_CHANGED`, per-mode collected totals, reopen on a switched-off table, date validation on
  Total orders, a single settings read when generating, the UPI payload, focus after recording a
  payment or voiding (the status line), "Short by ₹…" in the cash calculator, the bill page
  refreshing after a refused payment or void, and a login check on each print page.

### Tests

- **pgTAP 210–250:** the §11.1 cases and edges, financial year, lines and pricing; preview and
  generation (roles, blockers, snapshots, numbering, prefix, a sixth digit, plan gating, read-only,
  audit); payments, void, reopen and print counts; Total orders filters and business-day bounds;
  `dblink` races (two generates, bill vs customer order both ways, cancel vs bill both ways, two
  tables numbered at once, reopen vs customer order).
- **E2E:** the live orders flow now ends with the §18 billing steps (delete a round, discount, print
  page content, UPI payment, Total orders, Ravi available, a fresh customer session);
  `billing.spec.ts` covers void and reopen, blockers, split payments and the change calculator,
  Starter limits, read-only billing, Total orders filters and test print. Printing on a real 80 mm
  printer stays a manual check.

## Phase 6 — dashboard and reports (2026-09-18)

### Definitions

- **P6-1 · Sales are counted by bill:** every report covers the active (non-void) bills whose
  `generated_at` falls in the chosen business days, in the restaurant's timezone — the same rule as
  Total orders (P5-12). So the dashboard's "today", Reports → Today and Total orders → Today always
  agree. A voided bill leaves the money behind but still shows in the Voids log.
- **P6-2 · What the summary means:** bills; **gross sales** (the menu value on the bills);
  discounts; service charge; GST (CGST + SGST); round off; **net sales** = the taxable value, so
  after discounts, with service charge and without GST; **total billed** = the grand totals; and
  **average bill** = total billed ÷ bills. Payment modes come from the non-void payments on those
  bills, with the unpaid bills counted separately. The screen says what net sales means, because
  owners and accountants read it differently.
- **P6-3 · Dish and category sales** come from the billed dishes of those bills (the same filter
  the bill lines use: a billable status on an accepted round), at menu prices **before the bill's
  discount** — the screen says so, since a bill-level discount can't be split over dishes honestly.
  Dishes group by dish and option, so a renamed dish stays one row (the current name wins, the
  snapshot is the fallback), and a category is the dish's **current** category.
- **P6-4 · Busy hours** are a weekday × hour grid: the weekday of the **business day** and the hour
  on the restaurant's clock, ordered from the business-day start hour. A 1:30 am Saturday bill is
  Friday night's, where a restaurant would look for it.
- **P6-5 · The day trend** has a row per business date in range, zero days included, each carrying
  the whole summary and the payment modes. The chart and the Sales CSV read the same rows.
- **P6-6 · Table turnover:** per table, the bills in range, the average table time (first order
  until the bill, so a table reopened after a void counts its whole stay), sales and average bill.
  Tables with no sittings are listed at zero; "sittings per table" divides by the tables listed.
- **P6-7 · The waiter report** counts a table for the waiter it was assigned to **when the bill was
  made** (`bills.waiter_id`), so a table handed over counts once, for whoever finished it. Sales
  are those bills' grand totals; rounds are their accepted rounds; dishes are the billed
  quantities, not only the ones tapped as served, which some restaurants never tap. "Open tables
  now" is live, not in the range. Deleted waiters stay listed while they have bills in range.
- **P6-8 · The activity logs read the audit log,** not the current rows, because who did it, their
  role at the time and why only exist there — and a partial removal leaves no trace anywhere else.
  Three logs: voids and discounts (joined to the bill for its number, table and amounts), removed
  dishes (quantity taken off, what it was worth, whether it had been served, table and round) and
  deleted orders (the round, its dishes and their value). 50 rows a page, newest first.

### Rules

- **P6-9 · Plan gating, in SQL and in the screens:** Starter gets the sales **summary** only, for a
  single day that is today or yesterday; a wider range raises `FEATURE_NOT_IN_PLAN` and the page
  falls back to today with a note, and payment modes, the trend and the heatmap come back null.
  Dishes, tables and activity need `advanced_reports`; the waiter report needs `waiter_reports`.
  Asking for a CSV (`"export": true`) needs `csv_export`, so the database refuses a typed-in
  download URL too. A read-only restaurant can still read every report it pays for (§10.6).
- **P6-10 · One function per report screen**, `(p_filters jsonb) → jsonb`, sharing
  `private.report_window(ctx, filters, feature)`: it validates `from`/`to` (default today, at most
  366 days), applies the gating and returns the times the range spans. Each response echoes
  `today`, `from` and `to`, so the screens need no timezone maths.
- **P6-11 · The dashboard mixes two sources:** today's money comes from `admin_report_sales({})`
  under the billing query keys, so a new bill refreshes it through Realtime; open tables, dishes in
  progress and orders waiting for approval come from the board data the Live orders screen already
  keeps, so there is no second channel. It reuses the unassigned-tables queue and the waiter strip,
  and adds a compact board of every table. Subscription warnings stay in the panel's own banner.
- **P6-12 · "Sales today" is the total billed** (what the guests paid, GST included), the number an
  owner counts at the counter; Reports shows net sales beside it.
- **P6-13 · CSV downloads** go through `GET /admin/reports/export`: the role and `csv_export` are
  checked, then the same report function runs with `"export": true` (unpaged). Files carry a
  byte-order mark so Excel reads ₹ and Hindi, use CRLF, quote what needs quoting and prefix a cell
  that starts with `=`, `+`, `-` or `@` so a dish name can't run as a formula. Money is written in
  rupees (`662.50`) so spreadsheets can add it up, and times use the restaurant's clock.
- **P6-14 · Reports is one page** (`/admin/reports?report=…&from=…&to=…`), server-rendered, with
  tabs as links, the Total orders date presets plus custom dates, and every chart beside the table
  of the same numbers. Charts are Recharts with one series and one hue; the busy-hours heatmap is a
  plain table of coloured cells, which keeps it readable and searchable. Wide tables scroll inside
  a positioned box, so their screen-reader text can't push the page sideways on a phone.
- **P6-15 · The waiter chart is small multiples:** one row of bars per waiter (up to six, for
  ranges up to 31 days), rather than the stacked bars the plan sketched. One hue needs no
  categorical palette and no legend, and comparing waiters row by row is easier than reading a
  stack.
- **P6-16 · Shared date-range helpers** moved to `src/lib/date-range.ts` (`readDateRange`,
  `datePresets`, `addDays`, `hrefWithParams`), used by both Total orders and Reports.
- **Not added:** Total orders keeps its own screen without a CSV (it isn't a report), and menu costs
  or profit stay out of scope.
- **Review fixes (accessibility, money, React, tests):**
  - Unpaid bills left the "How it was paid" table for a line of their own.
  - Round off joined the on-screen summary, with a note that net sales, GST and round off make the
    total billed.
  - Negative amounts in a CSV stay numbers (the formula guard skips plain numbers), so a round off
    of `-0.50` adds up in a spreadsheet.
  - The heatmap got a legend, a "Show the numbers" table, a Busy hours CSV link, rows only for the
    weekdays the range covers and short screen-reader text on busy cells only.
  - The category chart and the waiter chart got the same numbers table.
  - Wide tables scroll inside a focusable region, so the keyboard can scroll them.
  - Locked tabs carry a lock icon and "(Growth plan)" in their name.
  - An owner on Starter is pointed to the Subscription page, while a manager is told to ask the
    owner.
  - An empty waiter report explains itself, and Reports has a loading skeleton.
  - The export route answers a reversed, too-long or end-only range with a 400.
  - The dashboard stays up if today's sales can't be prefetched; the browser fetches them instead.
  - Links styled as outline buttons had lost their border across the app, because the button
    classes weren't merged. `buttonVariants` now merges them.
  - The heatmap and the waiter chart compute each bill's business date inline rather than through
    `private.business_date`. A function with `search_path` set is never inlined, and calling it
    once per bill made a year of 200 bills a day take 1.6 s instead of 0.3 s. The expression gives
    the same dates (checked over 74,664 bills).

### Tests

- **pgTAP 260–290:** the sales summary over mixed bills (discount, service charge, inclusive tax,
  round off), a 1:30 am bill counted in the previous business day, 03:59 versus 04:00, zero-filled
  days, the heatmap's business-day weekday, Starter's today/yesterday limit and its refusals; dish
  and category sales (merged rounds, removed, cancelled, rejected and waiting dishes left out,
  renames and category moves); table turnover with quiet tables, busiest first and a table taken
  out of use; the waiter report including a handed-over table, a deleted waiter, open tables now
  and a 1:30 am bill on the chart; and the activity logs built from real removals, bills and voids
  (one reopening the table), with 52 rows to prove paging, order and export. Each file also seeds a
  second restaurant's data to show none of it leaks, and `today` is checked against the
  restaurant's clock directly.
- **Unit:** the shared date-range helpers, the report URL params, the CSV writer (quoting, formula
  guard, byte-order mark, rupees, the restaurant clock) and the parsers.
- **E2E (`reports.spec.ts`):** the dashboard's numbers, alerts and a bill appearing live; the sales,
  dish, table and activity tabs with a CSV download checked line by line; the waiter report's
  handover rule and column sorting; and Starter seeing the summary only, with the export URL
  refused. The data is made through the real functions, so bills, audit rows and waiter history are
  genuine.

## Phase 7 — super-admin panel (2026-09-19)

Phase 7 has two review stops: the super-admin panel first, then menu import (CSV and photos).

### Access

- **P7-1 · Platform data needs the second factor, in the database.** `is_platform_admin()` now
  also requires an `aal2` session (`auth.jwt() ->> 'aal'`), so every policy and function built on
  it (13 policies, `restaurant_access`, `restaurant_plan`) refuses a platform admin who has only
  typed a password: a stolen password can't read every tenant through PostgREST.
  `platform_admin_status()` (`none` / `mfa_required` / `ok`) is what login, the access summary and
  the guards use for routing; only `requirePlatformAdmin()` tells the last two apart.
- **P7-2 · TOTP at `/super/mfa`** (Supabase Auth MFA). The first visit enrols an authenticator app
  (QR code, or the key as text), clearing any enrolment left unfinished; later logins ask for the
  code. `/super`'s own layout has no guard so that page can open; the `(panel)` layout and every
  page guard themselves. A lost device is fixed in SQL (README). E2E tests make their own platform
  admins and compute the codes (RFC 6238), so the seeded `super@local.test` stays for people.

### Platform functions

- **P7-3 · Platform functions are `authenticated` RPCs** that check `current_platform_admin()`
  (aal2) and audit as `platform_admin` with the label "Platform admin" — owners can read their own
  restaurant's log, so the label is neutral; the platform log shows the admin's email.
  `platform_create_restaurant` stays service-role only, because the owner's login is created
  through the Admin API first; the wizard's action checks the platform admin before calling it.
- **P7-4 · Actions**, each with an audit row:
  - **Suspend** needs a reason (≤ 300). `restaurant_access` does the rest: customers can't order,
    tables already eating can still be billed. **Unsuspend** clears the reason.
  - **Extend trial:** trials only, 1–90 days, added to the trial's end or to now if it has ended.
  - **Change plan:** active plans only; status and dates stay; a smaller plan never deactivates
    tables or staff (§14.2).
  - **Manual payment** (§14.5): amount, how it was paid, cycle, first and last day (business days in
    the restaurant's timezone, last day included), notes. The payment row stores the period from
    the first day's business-day start to the start of the day after the last. **The payment
    changes the subscription only when it keeps the restaurant going for longer** than it goes now
    (the trial's end, the period end + 2 days, or the grace period, as `restaurant_access` works it
    out). Then the subscription becomes active and manual with that cycle (payments have no cycle
    column, and MRR needs it), the period moves forward, and grace and cancel-at-period-end are
    cleared. A payment for time already covered — a month inside a long trial, arrears during
    grace — is only recorded, and the screen says access didn't change; the form starts the period
    on the first day not yet covered. A suspension stays until someone lifts it.
  - **Reset owner password:** the database logs it and returns the login; the server sets the new
    password through the Admin API, as for staff. The dialog offers a generated password without
    look-alike characters.
- **P7-5 · Not in Phase 7:** send payment link, resend invite (email), the webhook events page and
  real Razorpay plan ids arrive with Razorpay and Resend in Phase 8; there is no platform settings
  editor (not in §13.4). The plans editor already stores Razorpay plan ids as text.
- **P7-6 · Support view:** `platform_support_view(restaurant, section, filters)` returns the menu
  (hidden dishes and categories included), the tables (never their QR tokens, which are what lets a
  phone order), the live board or Total orders. The board and Total orders bodies moved unchanged
  into `private.board_json(restaurant, role, member)` and `private.total_orders_json(restaurant,
filters)`; `staff_get_board()` and `admin_total_orders()` are now wrappers with the same output,
  and the support view shows the board as a manager would. **Each look is audited
  (`support.viewed`), once per admin, restaurant and section in 10 minutes** — a small departure
  from "every view", because the board reloads itself every 15 seconds (platform admins get no
  Realtime). The screens have no buttons at all; bill numbers aren't links.
- **P7-7 · Overview and lists:** restaurants by state with no overlaps (suspended, then read-only,
  then trial / active / payment failed); **MRR** = the plan's monthly price, or yearly ÷ 12, over
  the restaurants in the "active" state: paid, not suspended and still within their period (a
  manual subscription stays `active` after its period ends, because nothing renews it, so the
  status alone would keep counting a restaurant that stopped paying); orders in the last 24
  hours; trials ending within 7 days. The restaurants list searches name, code and city and
  filters by status, plan, subscription, city and created dates (India time), 50 a page. The
  subscriptions list puts failed payments first, then whatever ends soonest.
- **P7-8 · Restaurant detail:** profile, owners (a staff login address such as
  `owner@code.staff.domain` isn't shown as a contact), subscription, payments, access state and
  usage (active tables, staff logins, waiters, orders in 7 and 30 days, last order, bills).
- **P7-9 · Onboarding wizard** (restaurant → owner login → tax → plan and trial → one save → the
  login details to hand over, with a Copy button). It reuses `onboardRestaurant()`, which now takes
  the address, contact, tax and trial fields and checks the code before creating the login (the
  staff login address contains the code, so a retry would otherwise fail as "email exists").
  `platform_create_restaurant` now refuses a bad trial length, GST rate or mode as
  `INVALID_INPUT` instead of a cast error, and the form mirrors the column checks, so errors go
  back to the right step. `pnpm create-restaurant` stays as a developer tool.
- **P7-10 · Plans change only through `platform_update_plan`,** which audits the fields that
  changed (a platform-level row, no restaurant). The direct insert/update policies and grants on
  `plans` are gone, so the schema guard now says no table accepts direct writes. Features are the
  eight known keys, merged into the plan's; limits are 1–10,000 or empty for unlimited.
- **P7-11 · Platform audit log:** every restaurant's log plus platform events, filtered by
  restaurant, who (staff, customer, system, platform admin), an action prefix such as `bill.` and
  dates (India time), newest first, 50 a page, with before/after in a disclosure.
- **P7-21 · The owner's Subscription page shows the subscription now,** not in Phase 8 (spec
  §13.3 said "Phase 8"). Once platform admins record trials, plan changes and manual payments,
  the owner needs to see them. The page shows the plan, its status (free trial, paid, payment
  failed, ended, suspended) with days left, trial end or paid period and next payment date, the
  price, tables and staff logins used against the plan's limits, the included features, and the
  payment history (date, amount, method, period covered; the platform admin's payment notes stay
  internal). It reads through the existing owner RLS on subscriptions and payments, so no new
  function was needed. Plan cards, Razorpay checkout and cancelling stay in Phase 8; until then
  the page says to contact support.
- **P7-22 · The bill's branding line carries the domain:** "Powered by MenuMesh · menumesh.in"
  (user, 2026-09-25) instead of a MenuMesh logo, which would print as grey dots on thermal paper
  and add paper to every bill. It stays one small line, still hidden with `remove_branding`
  (Pro). The domain is `APP_DOMAIN` next to `APP_NAME`, not `NEXT_PUBLIC_APP_URL`, so local and
  staging bills print the real domain too. It fits one line on 58 mm paper with a few pixels to
  spare; non-breaking spaces keep "Powered by MenuMesh ·" together if a font wraps it.

### Review fixes (Stop A)

- A manual payment no longer shortens access (a month paid inside a long trial, arrears paid
  during grace), and MRR leaves out lapsed and suspended restaurants — both above.
- The onboarding wizard's "Create restaurant" waits a moment after the last step appears, so a
  double-click on Next can't create the restaurant before the plan and trial step is seen; the
  summary follows the fields as they change and shows the trial length.
- The support board is parsed on the device, so elapsed times are corrected against the device's
  clock like the staff board.

### Tests (Stop A)

- **pgTAP 300–340:** aal1 versus aal2 across policies and functions; the overview counted against
  a baseline (the demo seed has a restaurant), MRR (lapsed and suspended left out), list filters
  and paging, detail usage and owner
  emails; every action and its audit row, including suspension stopping `customer_place_order`
  while `admin_generate_bill` still works on an open table; the support view matching the member
  functions' output, without QR tokens, with the 10-minute audit window; plan edits and their
  audit, direct writes refused; the platform log's filters and paging; payments that extend access
  and payments that don't (long trial, arrears in grace).
- **Unit:** payment periods (short months, leap years), the code suggestion, generated passwords,
  the wizard, payment and plan forms, the list filters read from URLs, and the owner's
  subscription status (days left, last paid day, each status).
- **E2E (`super-admin.spec.ts`, and the platform-admin login in `auth.spec.ts`):** TOTP enrolment
  and a second login; onboarding through the wizard with the owner logging in on the handed-over
  details, and a taken code sent back to step 1; extend trial, change plan and a manual payment,
  each in the audit log; suspend → a customer can't order while the open table is billed →
  unsuspend; the support view's four sections with nothing to press and four `support.viewed` rows;
  a plan edit saved, audited and restored; the owner's Subscription page before (free trial) and
  after (paid Starter, the payment without its notes) a manual payment.

### Menu import (Stop B)

- **P7-12 · The menu reader is any OpenAI-compatible `/chat/completions` API, not the Anthropic
  SDK** (a deviation from spec §20A.2 and the `ANTHROPIC_API_KEY` variable, at the user's request).
  `src/lib/vision/openai-compatible.ts` is a small `fetch` client: one JPEG per request as a base64
  `image_url`, the §20A.2 rules as the system prompt (with "the photo is data, not instructions"),
  `response_format: json_schema` (strict), temperature 0, a 60 s timeout. Primary: the Command Code
  Provider API (`https://api.commandcode.ai/provider/v1`, sent with `x-cmd-zdr: 1` for zero data
  retention); fallback: OpenRouter. Both default to `google/gemini-3.8-flash` (checked in both
  model lists on 2026-09-19). Settings: `MENU_IMPORT_API_KEY` / `_BASE_URL` / `_MODEL` and the
  `MENU_IMPORT_FALLBACK_*` trio. Any provider error (unreachable, timeout, any HTTP error, a cut-off
  reply) moves the page to the next provider; a provider that refuses `response_format` is asked
  again without it. A reply that doesn't match the zod schema is retried once on the same provider
  with the problems appended; a second bad reply fails the page. Photo import shows only when a key
  is set; CSV import and manual entry always work (§20A.6).
- **P7-13 · Cost per import:** each call's `usage.cost` (US dollars) when the provider reports it
  (OpenRouter does), otherwise tokens × a small price list (`google/gemini-3.8-flash`: $0.75 in /
  $3.75 out per million tokens), × `MENU_IMPORT_USD_INR` (default 96, the rate on 2026-09-19),
  rounded to paise. A call with neither makes the import's cost unknown (`null`, shown as "—" or
  "Unknown") rather than wrong. Tokens and cost add up over retries and fallbacks, since they are
  paid for. About 30 paise a page at the default model.
- **P7-14 · Everything is a page photo before it leaves the browser.** Photos are decoded with
  `createImageBitmap` (EXIF rotation applied), refused under 800 px wide with the §20A.1 message,
  and redrawn at a long edge of 1600 px as 85% JPEG. PDFs are rendered page by page with
  `pdfjs-dist` (loaded only when a PDF is picked; its worker is bundled). HEIC works where the
  browser can decode it (Safari; iPhones convert when uploading), otherwise the owner is asked to
  export a JPEG, so there is no 1 MB HEIC decoder in the bundle. Uploads go to the private
  `menu-imports` bucket through signed upload links the server makes after `menu_import_create`
  has checked the caller; signed-in users have no storage policy on that bucket at all. Thumbnails
  in the review are one-hour signed links.
- **P7-15 · The browser drives the reading, one page per server action** (§20A.1 step 2): "Reading
  page 2 of 4…", and a reload carries on with the pages still pending. The server claims a page
  before it pays to read it (`menu_import_claim_page`, service role), so a reload or a second tab
  can't buy the same page twice; a claim that never comes back lapses after 3 minutes. Claiming and
  recording are service-role only: the tokens and cost shown in super-admin must not come from a
  restaurant's own browser. A read that lands after someone else finished the page keeps the first
  result and still counts what it cost — every paid call is counted. "Try again" after a failure
  re-reads the pages that failed. Each page gets 150 s for its
  retry and fallback; the import pages set `maxDuration = 180`. The server reads the photo with the
  service role only after the caller's own client could read the import. When no page yields a
  dish, the import fails with a message saying so (and the reader's note, e.g. "the photo is
  blank"); pages that failed are listed on the review.
- **P7-16 · CSV import:** our own RFC 4180 reader (quotes, escaped quotes, line breaks in quotes,
  BOM, CRLF). Columns in any order and case: `category, name, description, food_type, price,
variant_name, variant_price`. Rows in a row with the same category and name are one dish; a
  `variant_name` makes the row one of its options (with `variant_price`, or `price` when that is
  empty). `food_type` takes veg / non_veg / non-veg / egg, and blank means "not marked". A file with
  bad rows is refused whole, listing up to 20 rows by their spreadsheet row number: the owner fixes
  the file rather than importing half of it. At most 1 MB and 500 dishes (the server action limit
  is 2 MB for this). The result is the same draft and review as a photo import.
- **P7-17 · The draft** holds categories (`name`, `skip`, `show_hidden`) and their rows (`name`,
  `description`, `food_type` including `unknown`, `price_paise` or options, `confidence`, `notes`,
  the page, `reviewed`, `action` import / skip / update_price, `existing_item_id`). Flags are worked
  out from the current values, not stored: price missing, veg/non-veg not detected, duplicate
  option names and a missing or too-long name must be fixed (or the row skipped); low confidence, a
  price outside ₹5–₹5,000 or zero, a name under 3 characters and a name used in another category go
  away once the owner edits the row or presses "Looks right". "Already in menu" is worked out each
  time the review opens and again on every edit in the review, since renaming a row, moving it or
  renaming its category changes what it matches: a row matching an active dish in the same category
  is skipped by default, with "Update price instead" offered only when the row and the dish have
  the same shape (one price, or the same option names). Everything the screen shows — the counts,
  the flags, the Import button and the confirmation — is worked out from exactly what the commit
  will be sent, so the two can never disagree. A row that matches but is still set to
  import is flagged "Already on the menu". Rows can be moved into the menu's own categories as well
  as the extracted ones.
- **P7-18 · Commit** (`menu_import_commit`): one transaction under a row lock, with
  `assert_full_access`, checking every field again as `admin_save_menu_item` does. Categories match
  ignoring case and spacing, hidden ones included (the unique index covers them); a matched hidden
  category stays hidden unless the owner ticks "Show it again", as `admin_add_categories` does. A
  category gets created only for new dishes, but one that only updates prices is still shown again
  when the owner ticks "Show it again". `update_price` sets a plain dish's price, or the prices
  of its options with the same names and then the dish price to the cheapest; it refuses to change
  the shape of a dish (`ITEM_HAS_VARIANTS` for one price against a dish with options,
  `VARIANTS_DIFFER` for options that the dish doesn't have), so a price update can never drop an
  option or silently change what a dish costs. A row still marked
  "unknown" needs the owner's "I checked the veg and non-veg marks" and then becomes veg (§20A.5).
  One `menu.imported` audit row with the counts. Committing again returns the counts with
  `already_imported`; a discarded or failed import can't be committed.
- **P7-19 · Who and how much:** the restaurant's owner or manager, or a platform admin (aal2) for
  any restaurant; waiters and kitchen can't. Creating and committing need full access, so a lapsed
  restaurant's import waits until the trial is extended or paid. At most 10 pages an import and
  500 dishes. The 5-a-day limit counts **photo** imports whose pages were actually read: it guards
  the reader's cost, so a CSV (which costs nothing) and photos that were never read don't use it up
  (a deviation from §20A.5, which doesn't tell them apart).
- **P7-20 · Photo cleanup:** a daily `/api/cron/daily` (scheduled in `vercel.json` for 03:00 India
  time) deletes the photos of imports that ended 7 days ago, and of any import started 30 days ago
  and never finished, then marks them (`files_removed_at`); drafts and counts stay. The route wants
  `Authorization: Bearer $CRON_SECRET` and refuses everyone while the secret is unset. Phase 8 adds
  its reminders to the same route.

### Tests (Stop B)

- **pgTAP 350 (96) and 030:** who may create, read and commit; the daily limit (photos only, a
  rolling 24 hours); page recording, retries adding up tokens and cost, unknown cost; the draft and
  failure steps; the commit's matching, hidden categories, `update_price` on plain dishes and on
  options, refusals for every bad field, the 500 cap and read-only restaurants, idempotence and
  the audit row; discard; the cleanup listing; the private bucket with no user policies.
- **Unit:** the CSV reader, page merging, every flag, counts, "Already in menu"; the provider
  chain against a fake `fetch` (retry, fallback, refusal of structured output, cut-off replies,
  timeouts, the page deadline) and the cost rules; the provider settings.
- **E2E (`menu-import.spec.ts`)** against a local stand-in reader started with the test server
  (`tests/e2e/mock-apis.mjs`; a reused dev server has no reader, so the photo test skips
  there): a CSV with bad rows refused, then imported after fixing flagged rows, then imported again
  with everything already on the menu and one price updated; a two-page PDF rendered into two
  pages; a tiny photo refused; a photo read, a missing price filled, unmarked dishes confirmed,
  and the cost recorded; a blank photo failing with its message; a platform admin importing a CSV
  (audited as platform admin); the cleanup route refusing a wrong secret and deleting old photos.

## Phase 8 — subscriptions with Razorpay (2026-09-25)

Plan: two review stops. Stop A = owners pay by Razorpay autopay and webhooks drive the
subscription; Stop B = MenuMesh's tools (payment links and the setup fee, webhook events page,
sync) and reminder emails. User choices: the setup fee goes out as a Razorpay Payment Link from
super-admin; owner invite emails wait for a later phase. Razorpay and Resend keys come from the
user; everything is built and tested against local stand-ins, so CI needs no secrets.

Checked against Razorpay's documentation (2026-09-25): subscriptions take `plan_id`,
`total_count`, `start_at`, `customer_notify` and up to 15 `notes`; a cancel works once and can't be
undone; `PATCH` updates work for cards only, not UPI; Checkout's reply is signed as
HMAC-SHA256(`payment_id|subscription_id`, key secret); webhooks are signed as HMAC-SHA256(raw
body, webhook secret) in `X-Razorpay-Signature`, carry `x-razorpay-event-id`, can arrive twice or
out of order, and can't be delivered to localhost; plans can't be edited once created.

### Razorpay

- **P8-1 · A small client, no SDK:** `src/lib/razorpay/razorpay.ts` calls the five endpoints
  MenuMesh uses (plans, subscriptions create/fetch/cancel, payment links) with plain `fetch`, basic
  auth and a 15 s timeout, and checks both signatures in constant time. `RAZORPAY_API_BASE_URL`
  (default `https://api.razorpay.com/v1`) lets the tests use a stand-in. Paying online is on only
  when `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are both set; otherwise the owner's page keeps
  saying to contact support.
- **P8-2 · What the subscription row remembers:** `razorpay_status` (Razorpay's own state, as last
  seen), `razorpay_event_at` (the newest webhook applied) and `next_plan_id` / `next_billing_cycle`
  (what autopay will charge for). The plan and cycle change only when a payment arrives, so an owner
  who sets up Starter during a Growth trial keeps Growth until the trial ends, and nobody gets a
  bigger plan before paying for it.
- **P8-3 · Events → state**, applied in one database function with the row locked, and only for
  the restaurant's current Razorpay subscription:

  | Razorpay says                        | Subscription                                                                                                                                                    |
  | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | authenticated                        | `razorpay_status`; a new subscription just set up also clears a scheduled end                                                                                   |
  | active (activated, resumed, charged) | `active`, source `razorpay`, plan and cycle from `next_*`, period from `current_start`/`current_end` (the end never moves back), grace cleared                  |
  | charged                              | also a payment row (once per Razorpay payment id) and `cancel_at_period_end` cleared                                                                            |
  | pending / halted                     | `past_due` / `halted`; grace of `platform_settings.grace_days` counted from the event, if not already running; nothing when a longer period is paid another way |
  | cancelled / completed                | `cancelled` / `expired`, but only when the row is `active` on Razorpay and this subscription has charged                                                        |
  | created, expired, paused, updated    | nothing but `razorpay_status` (MenuMesh never pauses or edits one)                                                                                              |

  Razorpay only ends what Razorpay started and charged for: cancelling a trial's mandate, a halted
  subscription (to pay another way) or a replacement that never charged doesn't cut a trial, grace
  or paid period short, and a failed charge doesn't shorten a period paid by bank transfer. A
  webhook older than the last one applied no longer changes the status, and a subscription never
  goes back to an earlier Razorpay state (active is never authenticated again; cancelled is final),
  even within the same second; the payment of an out-of-date event is still recorded, and so is a
  payment for a subscription the restaurant has since replaced (money is never dropped, even if it
  needs a refund). Every change is audited as "Razorpay".

- **P8-4 · Webhook route:** `/api/webhooks/razorpay` reads the raw body (over 1 MB is refused),
  checks the signature (400 when wrong), uses `x-razorpay-event-id` or else a SHA-256 of the body,
  and hands the event to `razorpay_record_webhook`, which stores it once and processes it in a
  sub-transaction: a failure is kept on the stored event and the route still answers 200, so
  Razorpay doesn't retry forever; only failing to store it answers 500. Without
  `RAZORPAY_WEBHOOK_SECRET` the route answers 503.
- **P8-5 · Payment links:** a paid link carries `notes.restaurant_id`, `notes.purpose`
  (`subscription` or `setup_fee`) and, for a subscription, `notes.months` (1–24). It is recorded as
  a `payment_link` payment; a subscription link extends access from the first day not yet paid for
  (the day after the trial's last business day, else the date the paid period ends on, never before
  today: the day super-admin's manual payment form suggests), by whole months, the same business-day
  periods as manual payments (P7-4), and makes the subscription active and manual. A Razorpay period
  can end at any time of day, and the business day it ends in counts as paid. A setup fee is only
  recorded. A payment already recorded changes nothing.
- **P8-6 · Saving what Razorpay says:** `razorpay_save_subscription` is for the server only
  (service role), since owners can call the database directly and must never be able to claim a
  paid subscription. The server checks who is asking (an owner of that restaurant or a platform
  admin, who is also who the audit row names), talks to Razorpay, then saves: a new subscription
  (its notes must name the restaurant, an active plan and a cycle; refused while autopay is on and
  not ending, or while the restaurant is suspended), a scheduled cancel, and any fetched state
  (after Checkout, and from super-admin's Sync). Attaching a new subscription keeps a scheduled
  end until the new one is authorised, so an abandoned checkout doesn't make an ending subscription
  look like it renews. A fetched state is always current, so it applies
  without moving the webhook clock; otherwise a charge webhook from the same second as the checkout
  confirmation was skipped as stale (found by the E2E test).

### Owner and super-admin

- **P8-7 · Subscribing:** the owner's Subscription page shows the active plans that have a
  Razorpay plan, with a Monthly/Yearly choice. Subscribing cancels an unfinished checkout, or a
  subscription whose payments are failing (so the owner can pay with another card or UPI app),
  creates a subscription with notes `{restaurant_id, plan_code, billing_cycle}`, `customer_notify`
  on (Razorpay sends its own receipts and failure notices) and 120 monthly or 10 yearly charges, and
  opens Checkout. The first charge waits until a running trial or paid period ends
  (`start_at`); otherwise it is taken now. Checkout loads only when the owner clicks (a script tag,
  no `next/script`, so the page never waits for Razorpay). Checkout's reply is verified, the
  subscription fetched and saved, and the page says "Activating your subscription…" then shows
  autopay at once, without waiting for the webhook. Plans show while nothing will charge (none, an
  unfinished checkout, failing payments, cancelled or ending autopay).
- **P8-8 · Autopay during a trial:** while trialing with a mandate set up, the first charge is due
  at the trial's end, so access lapses 2 days later (the same buffer as a paid period) and there is
  no "trial ends soon" warning. Without it, the restaurant could be restricted at the next
  business-day start before Razorpay's charge arrived.
- **P8-9 · Plan changes while paying by autopay** (spec §14.3.8): `platform_change_plan` and
  `platform_extend_trial` refuse (`RAZORPAY_MANAGED`) while autopay is on and not ending, because
  Razorpay keeps charging the plan and start date it was set up with, and `PATCH` can't change UPI
  mandates. To change plan, autopay is cancelled at the period end (by the owner, or MenuMesh in
  Stop B), then the owner subscribes to the new plan, which starts when the paid period ends.
  Cancelling ends autopay at the end of the paid cycle once it has charged; a mandate that hasn't
  charged yet (set up during a trial) is cancelled at once. Razorpay can't undo either, and a
  subscription can be cancelled only once: when a cancel fails, the app asks Razorpay whether an
  earlier try went through (status cancelled, or `has_scheduled_changes`) and saves that.
- **P8-10 · Razorpay plans:** the Plans page creates a missing Razorpay plan for a cycle from the
  saved price ("MenuMesh Growth — monthly") and stores its id. Razorpay plans can't change price,
  so a new price clears that cycle's id unless a different id comes with it; restaurants already
  subscribed keep paying the old price.
- **P8-11 · MenuMesh's Razorpay tools** (spec §13.4, §14.5): a restaurant's page can **Send
  payment link**: a subscription for 1–24 months (the amount follows the plan's price, the yearly
  price for whole years) or the setup fee (`platform_settings.setup_fee_paise`, ₹1,499 by default;
  no settings page yet). Razorpay sends the link to the restaurant's email (or the owner's own
  login email) and phone, and the page shows it with a Copy button, saying who got it, or that
  nobody did and the admin must send it. There is no links table: Razorpay keeps the links, the payment
  arrives as `payment_link.paid` (P8-5), and each link sent is audited
  (`platform_audit_payment_link`). A subscription link is refused while autopay is on, so nobody
  pays twice; the server checks before creating the link, since Razorpay sends it at once. A setup
  fee link is always allowed. **Sync with Razorpay** fetches the subscription and saves it;
  **Cancel autopay** does what the owner's button does (the same code), audited as the platform
  admin. The **Webhooks** page lists what Razorpay sent (50 a page, a Failed filter, the payload),
  and **Reprocess** runs a failed event again (`platform_reprocess_webhook`): failed events only,
  so nothing is applied twice; a second failure keeps the new error; audited.
- **P8-12 · Reminder emails** (spec §14.6): the daily cron sends them through Resend (plain
  `fetch`; `RESEND_API_URL` points tests at a mock). The database lists what is due
  (`subscription_reminders_due(p_at)`, service role): the trial ends within 3 days, and within 26
  hours, so a daily run a little late can't skip the last-day one (not when autopay is set up); a payment failed (every day of grace); ordering paused (once,
  and only within 2 days of the pause, so a first run never emails about old lapses). Suspended
  restaurants get none. It goes to the active owners' own login emails (not synthetic staff
  addresses) and the restaurant's email, once each. Each reminder has a key (restaurant, kind,
  day: the trial's end, today, or the pause day), sent as Resend's `Idempotency-Key` and logged in
  `subscription_reminders` after sending, so it goes out once and a missed run catches up; an
  extended trial is reminded again for its new end. A failed send is logged and tried again on
  the next run, and the others still go. One at a time, 0.6 s apart (Resend allows 2 requests a
  second). The emails are plain HTML and text built in TypeScript: **react-email is not used**
  (a deviation from the stack table; four short emails don't need it). Without `RESEND_API_KEY`
  and `EMAIL_FROM` the step is skipped and logged. Each cron step runs on its own: a failed step
  makes the response a 500, but the others still run.
- **P8-13 · Simulator:** `pnpm razorpay:event --restaurant <code> --event <…>` sends a signed
  subscription or payment link event to the local app (attaching a made-up subscription first if
  the restaurant has none), since Razorpay can't deliver webhooks to localhost. It needs only
  `RAZORPAY_WEBHOOK_SECRET`, any string locally.
- **P8-14 · Left out:** no content security policy exists yet; Phase 9's hardening adds one and
  must allow `checkout.razorpay.com` and `api.razorpay.com`. No owner invite emails (user). No
  custom subscription invoices (§14.7). Yearly Pro (₹17,990) is above the ₹15,000 e-mandate limit,
  so its renewals may ask the owner to approve each year: to confirm in Razorpay test mode.

### Review fixes (Stop A)

Four reviewers (database, server, screens, then a verifier) confirmed 17 findings, fixed in
`5212d64`, `05e9164` and `2b00d7f`: a failed charge from an old mandate cut short a year paid by
bank transfer; cancelling a replacement that never charged ended the paid period; attaching a new
subscription cleared a scheduled end even when its checkout was abandoned; a same-second
`authenticated` could follow `active` (and then "Cancel autopay" would have cancelled a charging
subscription at once); a cancel whose reply was lost could never be retried; the owner page
promised renewals nothing would charge, named a past trial in the cancel dialog, showed the trial
plan's price when autopay was set for another, could stay stuck on "Activating…", and offered no
way to pay when no plan had a Razorpay plan. Rejected with reasons: widening the plan-change guard
to failing mandates (P8-9), grace after a failed first charge (spec §14.4), races that need two
admins saving within one Razorpay call.

A manual check with `pnpm razorpay:event` (charged → pending → halted → grace over → charged →
cancelled → payment link → setup fee) then found payment links starting a day early: a link paid
during a trial also paid for the trial's last day, and one after a Razorpay period ending between
midnight and the business-day start paid for that period's last day again. Fixed in
`20260926100200_payment_link_first_unpaid_day`.

### Tests (Stop A)

- **pgTAP 360 (52):** stored once per event id; every event's state change; grace from the event;
  payments once per payment id; stale events keep their payment; replaced subscriptions; unknown
  subscriptions stored with the error; ignored events; trial and grace kept when Razorpay cancels;
  payment links (periods, the day after a trial or a period ending after midnight, duplicates, setup
  fee, bad months, purpose and restaurant); a webhook older than a saved snapshot still applies; no
  going back within a second; a year paid by bank transfer kept when the old mandate fails; a
  replacement that never charged neither clears a scheduled end nor ends the paid period; grants.
- **pgTAP 370 (10):** access through a subscription's life: trial, autopay set up (no warning, +2
  days), charged, payment failed (warning, full through grace), read-only exactly at the next
  business-day start, paid again, ending and ended.
- **pgTAP 380 (22):** saving checks (notes, ids, plans, owners only, suspended, live mandates, a
  new subscription after a cancel, which carries on once authorised), `RAZORPAY_MANAGED` for plan changes and trial extensions, a
  price change clearing the Razorpay plan id.
- **Unit:** signatures (valid, changed body, other secret, missing, short), request bodies and
  errors of the client; autopay rules and the owner page's texts.
- **E2E (`subscription.spec.ts`)** against the stand-in Razorpay in `tests/e2e/mock-apis.mjs` (the
  menu reader's stand-in, renamed) and a Checkout script replaced by one that replies with a
  correct signature: an owner sets up autopay during a trial; signed webhooks make it paid (a
  repeated event and a repeated payment count once), failed (banner), paid again and cancelled at
  the period end (after an earlier cancel already reached Razorpay); a trial's autopay cancelled at
  once; a bad signature refused and not stored; a platform admin creating a Razorpay plan. A reused dev server without the test keys skips them.

### Review fixes (Stop B)

Three reviewers (database, server, screens) and a verifier confirmed 6 findings: a payment made
another way (payment link or manual) while autopay was set to end cleared that, so the app said
autopay renewed while Razorpay was ending it (now kept while the mandate is live, in
`20260927100200_payments_keep_ending_autopay`); the last-day trial reminder's window was exactly
one day wide, so a late cron run could skip it; the hidden Months field could block a setup fee
link; a webhooks page past the end failed (now the first page); the link dialog said Razorpay had
sent the link even with no email or phone; and a pgTAP check depended on the order of two audit
rows written in the same transaction. Rejected with reasons: validating the restaurant phone before
Razorpay does (its refusal is shown), a duplicate email when a sent reminder can't be logged
(send, then log, is the chosen order), and the payment-failed email's wording (the owner page's).

A manual check of the whole loop (charged → pending → reminder email → halted → cancelled →
charged on a new subscription → cancelled → payment link → setup fee) found the owner's deadline a
day late: ordering stops at a business-day start (4 am), but the page, banner and payment-failed
email named that day ("Pay by 4 Oct" when ordering stopped at 4 am on 4 Oct), while a "Pay by" fact
from `grace_until` said 3 Oct. They now name the last day ordering stays on, as "paid until" does,
and the duplicate fact is gone. The simulator also attaches a new made-up subscription once the
current one has ended, as an owner subscribing again would.

### Tests (Stop B)

- **pgTAP 390:** the setup fee setting; logging a payment link (second factor, owners refused,
  months only for subscriptions, amount, https links, restaurant); reprocessing (second factor,
  owners refused, never an event that went through, a second failure keeps its error, applied
  once the subscription is attached, with its payment, audited against the restaurant); a link or
  manual payment keeping autopay's scheduled end; the Razorpay status on the restaurant page;
  grants.
- **pgTAP 400:** reminders by time (trial in 3 days and 1 day, a failed payment each day, the pause
  once, the last-day one for a trial ending 25 hours after a run, none for autopay trials,
  suspended restaurants, old pauses or no email), recipients (real
  owner logins and the restaurant email, once; no synthetic or inactive logins), each once, an
  extended trial reminded again, grants and the hidden log. **010:** the two new platform
  functions and the new tenant table.
- **Unit:** the payment link form (months only for a subscription, amount limits); the Resend
  client (key, idempotency key, body, errors); reminder texts (day in the
  restaurant's time zone, link, escaped names); the send loop (logged only after Resend took it,
  carries on after a failure, sent but not logged counts as failed).
- **E2E (`razorpay-admin.spec.ts`)** against the mock Razorpay and a mock Resend inbox in
  `tests/e2e/mock-apis.mjs`: a 3-month link (amount and description follow the months, notes sent
  to Razorpay) and a setup fee link (from the setting, no months), the paid link extending access,
  both audited; Sync with Razorpay, a subscription link refused while autopay is on, Cancel
  autopay; a failed webhook reprocessed from the Webhooks page; the daily cron emailing a trial
  reminder once over two runs.

## Phase 9 — reliability and polish (2026-09-26)

Plan: four review stops. Stop A = table service (call a waiter, ask for the bill, move a table);
Stop B = menu add-ons; Stop C = the offline status queue, installable staff and admin panels, and
keeping the board screen awake; Stop D = Hindi customer screens, the accessibility and performance
audit, and security hardening. User choices: add-ons are shared groups attached to many dishes
(each group with its pick rules, each option with a price and an in-stock switch); "Call waiter"
works any time, even before ordering, and "Request bill" once the table has an accepted order; the
Hindi text is written here and reviewed by the user; customers see English first and a toggle
remembered on the phone.

### Table service (Stop A)

- **P9-1 · Service requests:** `service_requests` (table, optional session, `call_waiter` or
  `request_bill`, open → acknowledged → resolved, the customer's device, who acknowledged and
  finished it). One active request per table and type (a partial unique index): a second tap, from
  any phone, returns the same request. At most 10 requests per table per hour, so a photo of the QR
  code can't keep every tablet chiming. `customer_create_service_request` (server only) takes a
  call any time, links the open session if there is one, and takes a bill request only once an
  order at the table was accepted (`NOTHING_TO_BILL`); both work while the restaurant is read-only,
  so a customer is never stuck. `staff_update_service_request` is for owners, managers and waiters
  (the kitchen neither sees nor handles requests), moves forward only, and a second tap from
  another tablet changes nothing; it isn't audited (a notification, not a business change).
  Billing a table or closing it without a bill finishes all its requests, including a call made
  before the first order: `private.end_assignment`, which both already call, does it, so the rule
  stays in the functions instead of a trigger.
- **P9-2 · Requests on the board:** `staff_get_board` (the wrapper, not `board_json`) adds the
  active requests; the kitchen gets none. Cards and the drawer show "Calling" and "Bill requested"
  badges in the attention colour, not as a new table state, so the filters and card colours stay as
  they were. The drawer lists them with Acknowledge and Done. A new request toasts ("Table 5 is
  calling a waiter", "Table 5 asked for the bill"), rings the table and chimes, from the same
  board comparison as new orders; one already acknowledged elsewhere stays quiet.
  `service_requests` joins the Realtime publication. The customer's button says "Waiter called" /
  "Bill requested" after a tap; it doesn't follow the request afterwards (a second tap is
  harmless). The support view shows the board without requests.
- **P9-3 · Move table:** `staff_move_session` (owners, managers, waiters) reads the session's
  table, locks both tables in id order, then the session, and checks it is still open at that
  table (`SESSION_NOT_OPEN` if it was billed, closed or moved meanwhile). The new table must be
  active, in the same restaurant (`NOT_FOUND`) and free (`TABLE_BUSY`; the one-open-session index
  backs this up). The session's table and label change; orders keep their session, so the bill
  shows the new table. The guests' requests follow them, except one the new table already has,
  which is finished instead. Audited as `session.moved` with both tables. Allowed while read-only
  (no new session starts). Guests' phones still show the old table's QR code, so the toast asks
  staff to have them scan the new one; the old table starts afresh.

### Review fixes (Phase 9 Stop A)

Three reviewers (database, app logic, screens) and a verifier confirmed 5 findings. A call at a
table that was then switched off stayed open but off the board, and chimed again when the table
came back: switching a table off now finishes its requests (`admin_update_table`). The move's
two-table lock could deadlock with reordering tables, which updated them in any order: reordering
now locks the restaurant's tables in id order first (`admin_reorder`). The Move dialog stayed open
after the guests had left the table (billed or moved on another tablet), with buttons that did
nothing; it now belongs to the session it was opened for and closes when that session is gone, so
a new party is never moved by mistake. Both Acknowledge buttons had the same name for screen
readers. Long table names overflowed the Move dialog's buttons; the grid now fits the names and
lets them wrap. Rejected with reasons: showing "acknowledged" on the card badge (the drawer shows
it; P9-2) and a 44 px customer header button (32 px meets WCAG 2.2 target size; 44 px is the staff
screens' rule).

### Tests (Phase 9 Stop A)

- **pgTAP 410:** a call before the first order (no session), a second tap returning it, no bill
  before an accepted order, unknown or switched-off QR codes, bad type or device; the bill request
  linked to the session; calls while read-only; the kitchen refused and seeing no requests, the
  floor board listing them, acknowledge and Done once each, never back, another restaurant's id;
  a new call after Done; 10 per table per hour; moving (the kitchen refused, busy, same, switched
  off and other restaurants' tables refused, the session, label and bill request follow, a call
  the new table has is kept once, audited, the old table starts afresh, a closed session can't
  move); closing and billing finishing the table's requests; switching a table off finishing its
  call; grants. **010 / 020 / fixture:** the new table, functions and publication, plus
  `menu_imports` and `subscription_reminders` in the isolation lists. **150 / 330:** the board's
  new `requests` key (the support view has none).
- **Unit:** request alerts (once per new request, at free tables too, none once acknowledged).
- **E2E (`table-service.spec.ts`):** a phone calls a waiter before ordering → the board toasts and
  badges table 3 → Acknowledge → Done; after an order the phone requests the bill → the board
  shows it; a waiter moves table 3 to table 5 → the board and database follow, table 5's QR code
  shows the order and table 3's doesn't.

### Menu add-ons (Stop B)

- **P9-4 · Add-ons:** three tables. `menu_addon_groups` (a unique name, `min_select` 0–20 where 0
  makes the group optional, `max_select` 1–20), `menu_addons` (name, price in paise, in-stock
  switch, order) and `menu_item_addon_groups` (which dishes offer which groups). Groups are
  shared: "Toppings" is built once and ticked on many dishes. A dish shows its groups oldest
  first; the options keep the order the owner gave them. Groups and options are deleted for real
  (with their links): orders keep their own copy.
  - **Orders keep a snapshot, not rows:** `order_items.addons_snapshot` holds
    `[{id, group, name, price_paise}]` in the dish's order, and the add-ons' total is added to
    `unit_price_paise`. Bills, totals, discounts, taxes and reports work unchanged, and add-on
    revenue counts towards the dish in reports. The spec named an `order_item_addons` table; one
    jsonb column avoids an insert-and-map step and a join in every read, and a dish's add-ons are
    never queried on their own.
  - **Ordering:** a line takes `addon_ids` (up to 20 distinct uuids, sorted by the database).
    `assert_orderable` checks every chosen option is in stock and in one of the dish's groups, and
    that each group has between `min_select` and `max_select` choices; anything else reads as the
    dish being unavailable (`ITEM_UNAVAILABLE` with its id). The server action then checks the
    lines it sent against a fresh menu and tells the phone or picker which lines to take out, so
    "Pizza" stays when only "Pizza + Olives" ran out (every line of the dish only when the menu
    can't tell). Prices come from the database, never the phone. Customer and staff orders share
    the same helpers. The chosen add-ons are locked (`FOR KEY SHARE`) while the order is saved,
    and one deleted since the check refuses the dish rather than saving it without.
  - **Bills:** `bill_lines` groups by the add-on names too, so the same dish with different
    add-ons is two lines and ones that read the same merge (also after a group was renamed); the
    price, which includes the add-ons, still separates changed prices. Lines carry the add-on
    names ("Pizza (Large) + Olives, Jalapeño"). Bills stored before add-ons read as having none.
  - **Menu data:** `customer_get_table` sends the groups once and each dish lists its group ids;
    the page gives every dish its group objects. A dish whose required group has too little in
    stock shows as not available on the customer menu. There are no Realtime events for add-ons:
    a stale menu is caught when the order is placed.
  - **Managing:** `admin_save_addon_group` (owners and managers, full access) saves a group with
    its options in one call, like dishes and their options; options left out are deleted, new
    ones start in stock. A group must allow its required choices (`min_select` no more than the
    number of options). `admin_save_menu_item` takes `addon_group_ids` and changes the dish's
    groups only when the key is sent, so quick edits and the menu import leave them alone.
    `staff_set_addon_availability` works like the dish switch: any staff role, also while
    read-only.
  - **Screens:** the options sheet (was the variant sheet) shows the dish's options, then each
    group with its rule ("Choose 1", "Optional, up to 3"): radios for exactly one, checkboxes
    otherwise (full groups disable the rest; a group of at most one swaps its choice), with the
    price as chosen and the reason when Add is disabled. Staff "Add dishes" opens the same sheet
    for dishes with add-ons ("Add to round"); dishes with options only keep their quick buttons.
    Waiters, the kitchen, the removal dialog, the bill builder and the printed bill show add-ons
    after the dish. The Availability page lists each group's options with in-stock switches. The
    admin Menu page has an Add-ons section (new, edit, delete with how many dishes use it), and the
    dish form ticks the groups.
  - **Cart:** still version 1. A line may carry `addonIds` and `addonNames`; its key adds the ids
    only when there are some, so carts saved before add-ons keep working. The cart re-prices lines
    from the menu and drops those whose choices no longer fit, with the same rules as the
    database (`selectionError`).

### Review fixes (Phase 9 Stop B)

Three reviewers (database, app logic, screens) and a verifier confirmed 4 findings.
`admin_save_addon_group` accepted the same option id twice, which saved fewer options than
`min_select` counted and made every dish using the group unorderable: a repeated id is now
refused. Options are deleted for real, so one deleted between the order's check and its insert
was silently left out (a lower price, a wrong kitchen ticket): the chosen add-ons are now locked
and re-checked before the insert (P9-4). A refused add-on took out every cart line of the dish,
valid ones too: the server now works out which sent lines no longer fit (P9-4). Bill lines split
dishes that read the same when a group was renamed between rounds: they now merge by add-on
names.

### Tests (Phase 9 Stop B)

- **pgTAP 420:** groups saved with tidy names, rules and options in order; duplicate group and
  option names, impossible rules, no options, bad prices and names refused; editing renames,
  reorders, adds and deletes options, keeping ids; a repeated option id refused; dishes get,
  keep (key absent) and lose (empty list) their groups; another restaurant's group or option
  can't be attached, edited, deleted or moved in; waiters can't manage groups; the customer menu
  sends the groups once in order and each dish's ids; prices add up and the snapshot keeps names,
  groups and prices in the dish's order; a missing required choice, too many choices, an option
  from another group, dish or restaurant, add-ons on a plain dish, repeated or malformed ids and
  more than 20 refused; optional groups skipped and old payloads accepted; stock switched by the
  kitchen (not another restaurant's) and refused when ordering, flagged on the menu; staff orders
  follow the same rules; the board and the orders page show names; bill lines merge the same
  add-ons (also after a group rename) and split different ones; an add-on gone before the insert
  refuses the dish; deleting a group keeps orders and bills intact; read-only blocks managing but
  not stock. **010 / 020 / fixture:** the new tables and functions. **150 / 210:** the new
  `addons` keys.
- **Unit:** group rules and texts, `selectionError` parity, stock for required groups, cart lines
  priced and named with add-ons, merging, keys unchanged for old lines, re-pricing and dropping,
  `addon_ids` in the payload only when present, stored carts old and new, refused lines per line
  with the per-dish fallback.
- **E2E (`menu-addons.spec.ts`):** the owner creates a group and ticks it on a dish, a phone
  picks two add-ons (₹350), and the orders page, the waiter's drawer, the kitchen ticket and the
  bill builder show them; a waiter must choose the required crust (Add stays disabled with the
  reason) and the round is priced by the database; with two crusts in a customer's cart, the
  kitchen switching one off takes only that line out, and the menu then shows it as not
  available.

### Offline, install and wake lock (Stop C)

- **P9-5 · Offline status queue:** TanStack Query already holds mutations while offline, so no
  new sync engine. Mutations now default to `networkMode: 'always'`: Approve, Remove, Add dishes
  and the rest fail at once offline ("Couldn't reach the server") instead of pausing and firing
  minutes later, which could surprise the table. Only dish status moves queue
  (`useStatusChange`: one dish or a ticket forward, or Mark all served): `networkMode: 'online'`
  pauses them offline and a `TypeError` (Wi-Fi up but the server unreachable) retries until the
  server answers. Every board change shares one `scope`, so they reach the server in tap order and
  a Revert or Remove never overtakes a move still waiting; Generate bill waits for them too. The board shows them at once and doesn't
  refetch while any wait, so it doesn't flicker back. Each move is also kept in a small journal in
  localStorage, per member, for a day: saved when tapped, dropped once the server answered, and
  resent (the ones this tab isn't already sending) when a live screen loads and when the network
  comes back, so a reload or another closed tab loses nothing. The spec named
  IndexedDB; the data is a few ids and nothing but the page reads it, so localStorage is simpler.
  Resending is safe because a move is by target status: the database does nothing when a dish is
  already there, and a dish already past it (`INVALID_STATUS_CHANGE`) now counts as done for one
  dish too, not only for a ticket. A dish removed meanwhile or a table billed meanwhile still
  shows its error. An offline banner (on every staff and admin page, and in the table drawer,
  which hides the page) says how many changes wait; "Can't reach the server" shows while they retry online. Offline, the
  buttons that need the server are disabled: approve, reject, add, remove, revert, move, close,
  requests, waiter assignment, stock switches, billing, payments and voids. Known limits: a dish
  served offline records the sync time as `served_at`; a change resent after a deploy that renamed
  its server action fails with an error instead of retrying.
- **P9-6 · Installable panels:** the manifest is a route (`/app.webmanifest`, from `APP_NAME`)
  linked only from the staff and admin layouts, so customer pages are never offered for install.
  It opens on `/login`, which sends a signed-in user to their panel. Icons come from `next/og`
  (`/icon/192`, `/icon/512`, also maskable, and the Apple touch icon): a white "M" on the brand
  colour, no image files. The service worker is hand-written (about 30 lines, no Serwist): for
  page loads under `/login`, `/staff` and `/admin` it goes to the network and, only when that
  fails, shows a small offline page that retries every 15 seconds. It caches nothing: the spec's
  "app-shell caching" would keep signed-in pages that change by the second and belong to one
  user. `LiveProvider` registers it; the proxy skips the install files.
  - **Screen wake lock:** the board, the kitchen view and Live orders keep the screen on while
    visible and take the lock again when the tab comes back; nothing happens where the browser
    doesn't support it.

### Review fixes (Phase 9 Stop C)

Three reviewers (queue logic, install and platform, screens) and a verifier confirmed 6 findings.
A Revert, Remove or bill tapped just after the network came back could reach the server before a
dish move still waiting, so the move then undid the revert: every board change now shares the
queue's scope and Generate bill waits for waiting moves (P9-5). Log out was a server action whose
redirect kept the page, and a move still retrying could then run under the next person to sign in
on the tablet: Log out is now a plain form post to `/logout` and a full page load, which ends the
page and its queue (the moves stay in the journal for that member's next sign-in). Moves left by a
closed tab weren't resent while another tab of the same member stayed open, and managers' moves
were resent only on Live orders: the banner now resends on load and when the network comes back,
and sits in the admin layout. The bill page's Assign waiter button stayed enabled offline. The
banner's live region was hidden while empty, so screen readers could miss its first message.

### Tests (Phase 9 Stop C)

- **Unit (`offline-queue.test.ts`):** the journal keeps changes in tap order and drops them one
  by one, keeps a resent change once in its first place, is per member, forgets changes after a
  day and ignores damaged data.
- **E2E (`offline-queue.spec.ts`):** offline, a waiter marks a dish served, starts another and
  marks the round served: the banner counts 3, the drawer shows them served, the database has
  none, and add, move and remove are disabled; back online, all three reach the database, the
  header returns to Live, no error shows and the journal is empty (`OFFLINE_MS=60000` keeps the
  tablet offline for the full minute of the Phase 9 acceptance check). A move made offline in a
  tab that is then closed is sent when the board is opened again, and by another open tab when
  the network comes back. With the network up but the server unreachable, a move waits with
  the banner saying so, then is sent once the server answers, with no error. The staff panel
  links the manifest, its icons are PNGs, Chrome reports it installable, the service worker is
  active, a reload without a network shows the offline page and Try again returns to
  the board; the customer menu has no manifest.

### Hindi, audit and security (Stop D)

- **P9-7 · Hindi customer screens:** every word on the customer screens lives in
  `src/features/ordering/strings.ts`, an English and a Hindi dictionary. Hindi is typed as the
  English one, so a missing or extra key doesn't compile. Dish, category and restaurant names,
  reasons typed by staff, money and times stay as they are (en-IN, Western digits). English comes
  first; the header's हिन्दी / English switch is a server-action form, so it works before the page's
  JavaScript has loaded, and sets a `lang` cookie with the device cookie's options (path `/t`, one
  year, httpOnly). The root layout reads it for `<html lang>`, so screen readers use the right voice
  for toasts and titles too (the plan put `lang` on a wrapper; the page is more correct). The
  cookie only reaches `/t`, so the staff and admin pages stay English on the same phone. A client
  `LangProvider` hands the dictionary to the customer components; without it the default is
  English, so the staff panel's reuse of the options sheet and quantity stepper is unchanged.
  Server actions answer in the phone's language: the customer refusal messages moved from
  `db-errors.ts` into the dictionaries. The add-on rules (`groupRule`, `selectionError`) and
  `listNames` take their words as a parameter. Both dictionaries ship, a few KB. No new font: Noto
  Sans's Devanagari subset loads only when Hindi text appears. The Hindi is written here; the
  owner reviews it before the pilot.
- **P9-8 · Lighthouse:** mobile, production build, the demo menu (`/t/DEMO0000TABLE001`),
  Lighthouse 12.8 with its default simulated throttling. English and Hindi alike: performance
  92–93, accessibility 100, best practices 100 (with the policy below: no console errors, the CSP
  counts as effective against XSS). SEO is 60 by design: customer pages are `noindex`. Lighthouse
  estimates LCP at 3.2–3.3 s under throttling; the observed LCP was 139 ms, and the `PERF=1` spec
  stays. Nothing needed fixing.
- **P9-9 · Security headers:** a Content-Security-Policy with a fresh nonce per request, set in
  `src/proxy.ts` on the request (Next.js reads the nonce there and puts it on its scripts) and on
  the response; the policy is `src/lib/csp.ts`. Scripts run only by nonce, with `'strict-dynamic'`
  so Razorpay Checkout's script, added by a nonced one, loads; `'unsafe-eval'` only in
  development. Styles stay `'unsafe-inline'`: the UI kit, toasts and the customer accent `<style>`
  need it, and a style nonce would switch it off. Images and connections go to the app, Supabase
  (https, and wss for Realtime) and `https://*.razorpay.com` (Razorpay's own docs allow the whole
  domain); frames only Razorpay; workers only the app (service worker, pdf.js); `object-src
'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`, and
  `upgrade-insecure-requests` only when the app itself is on https. One policy for every page.
  Every page now renders per request (the root layout reads the language cookie, and nonces need
  it anyway), so the home page needs no `connection()`; partial prerendering would need another
  approach later. Static headers in `next.config.ts`: `X-Frame-Options: DENY`, `nosniff`,
  `strict-origin-when-cross-origin`, a `Permissions-Policy` that turns off camera, microphone and
  geolocation (wake lock stays; photo capture uses the file picker, not the camera API), HSTS for
  two years without `includeSubDomains`, and no `X-Powered-By`. Zod 4 tries `new Function` for
  its fast parsers, which the policy reports as a violation even though Zod catches it:
  `src/instrumentation-client.ts` turns on Zod's `jitless` through its global settings object,
  without importing Zod. pdf.js 6 no longer uses eval on the page. Vercel's preview toolbar
  (`vercel.live`) is blocked by the policy; revisit in Phase 10 if it is wanted.
  `pnpm audit --prod --audit-level=high` found nothing (nor did the full tree), and CI now runs
  it right after installing. The RLS isolation test already lists every tenant table (Stops A
  and B).

### Review fixes (Phase 9 Stop D)

Three reviewers (security, language, regressions) and a verifier: 5 confirmed, 1 rejected.

- `upgrade-insecure-requests` followed the Supabase URL's scheme, so an http app on the LAN
  (which the device cookie supports) against a hosted Supabase would have had its own requests
  upgraded to https and failed. The app's URL decides now.
- Importing Zod in `instrumentation-client.ts` put all of Zod (about 89 KB gzipped) in every
  page's first load, the customer menu included. It now sets Zod's global settings object, the
  same one whether Zod loads before or after.
- Sonner's own labels ("Close toast", "Notifications") stayed English on Hindi screens; they
  come from the dictionary now.
- A cart error stayed in the old language after a switch. It is kept with the dictionary it was
  written in and hidden after a switch.
- The header test refused `'unsafe-eval'` even against a reused local dev server; CI only now.
- Rejected: the Hindi cancel button reads "रद्द करें Paneer Tikka · 1:42" to screen readers,
  verb first; it is complete and understandable.

### Tests (Phase 9 Stop D)

- **Unit:** the English wording through the dictionary (cancel notice, dishes taken out,
  "Placed"); Hindi table names, counts, cancel notice and "और"; every customer refusal has its own
  Hindi message; unknown codes, `toString` included, stay unmapped; the CSP builder (https and
  wss, local http with development eval, an http app on the LAN with a hosted Supabase).
- **E2E (`customer-hindi.spec.ts`, phone):** switching to Hindi sets `<html lang="hi">` and
  Hindi labels, and survives a reload; the titles, the cart notice, a dish that ran out, the
  server's "ordering unavailable" refusal, the orders page, a dish status and the Request bill
  toast (with a Hindi close label) are in Hindi; switching back gives English. A bad QR code says
  so in Hindi; `/login` stays English on the same phone.
- **E2E (`security-headers.spec.ts`):** a phone ordering, the waiter's board and drawer, stock
  switches, the kitchen, 14 admin pages and 6 super-admin pages run with no CSP violation; `/login`
  and the customer menu carry the headers and a new nonce on every request, and Next.js's scripts
  carry it. `subscription.spec.ts` checks that Razorpay Checkout loads with no violation.

## Phase 10 — deployment and launch readiness (2026-09-26)

Plan: three review stops. Stop A = everything that needs no accounts (monitoring, analytics,
legal pages, the deploy pipeline, smoke tests, the runbook); Stop B = staging on the owner's
accounts and the real-device run; Stop C = production and the launch checklist. User choices:
GitHub Actions migrates and then deploys, with a separate Vercel project per environment and an
approved Release for production; PostHog on the staff, admin and super-admin panels only;
"the full test run against staging" = read-only smoke tests plus the owner's full flow on real
devices; Sentry on every page, errors only.

### Pipeline and monitoring (Stop A)

- **P10-1 · Migrate, then deploy:** `.github/workflows/deploy.yml` links the Supabase project,
  runs `supabase db push --yes` (never `--include-seed`, so the demo restaurant and its known
  passwords never leave local and CI), then `vercel pull`, `vercel build --prod` and
  `vercel deploy --prebuilt --prod` with the commit built in (`NEXT_PUBLIC_BUILD_SHA`), then
  `pnpm smoke` against the live URL. Vercel's Git deploys are off (`vercel.json`, and since
  P10-14 the projects aren't connected to GitHub) so code never runs ahead of its migrations; functions run in `bom1` (Mumbai), next to the database. Staging
  deploys from the `staging` job in `ci.yml` after the tests pass on `main`, gated by the
  repository variable `DEPLOY_STAGING` so CI stays green before the accounts exist. Production is
  `release.yml`, run by hand: only the repository owner can run it, the word "production" must be
  typed, and the commit must have passed CI on `main`. The repository is private on GitHub's free
  plan, which has no environment secrets and no required reviewers, so the secrets are
  repository secrets named per target (`STAGING_…`, `PRODUCTION_…`, plus shared
  `SUPABASE_ACCESS_TOKEN`, `VERCEL_TOKEN`, `VERCEL_ORG_ID`) and the owner check stands in for an
  approval; the deploy stops at once if any of them is missing. A deploy of one target never runs
  twice at once or gets cancelled halfway; CI on `main` is no longer cancelled by a newer push
  (only pull requests are). Migrations must stay backward-compatible because the old app runs on
  the new schema for about a minute (and, since P10-11, pages opened before a deploy keep using it
  for up to 7 days); rollback is Vercel's Instant Rollback plus a forward-fix
  migration, and the smoke tests fail when the live site isn't the commit just deployed (a
  rolled-back project keeps serving the old build until Undo Rollback). Two Vercel projects
  rather than Vercel's custom environments: each has its own variables, domain and cron, and
  staging's cron exercises the reminders with test keys.
- **P10-2 · Supabase settings:** the hosted Auth settings (sign-ups off, password length 8, TOTP,
  site URL, a higher sign-in rate limit because staff sign in from the app server's IP) are set
  once per project, listed in the runbook. The plan put them in `config.toml` `[remotes.*]`
  blocks for `supabase config push`; that waits for Stop B, because a block without a real
  project ref could break `supabase start` and CI's config parsing.
- **P10-3 · Sentry, errors only:** `@sentry/nextjs` 11 (`withSentryConfig` now comes from
  `@sentry/nextjs/config`). Server: `src/instrumentation.ts` with `onRequestError` and
  `captureConsoleIntegration` for `console.error`, so the existing logs of unexpected database
  errors reach Sentry without touching their call sites. Browser: the SDK was about 50 KB
  gzipped in the customer menu's first load (628 → 795 KB uncompressed), so
  `instrumentation-client.ts` imports it once the page is idle and only when a DSN is set; the
  first load is back to 636 KB, and an error before it loads reaches Sentry only from the server.
  No tracing, replay or session pings (`BrowserSession` is dropped: a request per page view on
  diners' phones). No personal data: Sentry 11 replaced `sendDefaultPii` with `dataCollection`,
  which collects cookies, headers, request bodies, IPs and stack-frame variables by default, so
  all of them are off (the device cookie and staff sessions are credentials, and a server
  action's body can hold a password); the options are typed against `Sentry.init` so a removed
  option fails the typecheck instead of being ignored. The browser sends straight to Sentry (its
  host is added to the CSP from the DSN): the SDK's `/monitoring` relay on our origin would
  forward our cookies too; some ad blockers will drop reports. Source maps upload only where
  `SENTRY_AUTH_TOKEN` is set. One public DSN (`NEXT_PUBLIC_SENTRY_DSN`) serves both sides; the
  unused `SENTRY_DSN` is gone. `NEXT_PUBLIC_SENTRY_ENVIRONMENT` names staging and production,
  which are both Vercel "production" deployments.
- **P10-4 · PostHog, panels only:** `PanelAnalytics` in the staff, admin and super layouts
  imports `posthog-js` after the page, only with a key: pageviews and autocapture with all text
  and element attributes masked (waiters' names are in button labels), no session recording or
  surveys, and people identified by member (or admin) id with their role and restaurant id, never
  names or emails; a different login on the same device starts a new person. The customer panel
  never mounts it. It talks to the region's hosts directly (in the CSP only when a key is set):
  PostHog's `/ingest` rewrite would forward staff session cookies to PostHog.
- **P10-5 · Legal pages:** `/terms` and `/privacy` are placeholder outlines, marked as such, for
  the owner's real text. They are linked in small print from the login page and the foot of the
  customer menu (labels in Hindi too; the pages stay English).
- **P10-6 · Runbook:** `docs/RUNBOOK.md`: environments, one-time setup, variables per
  environment, migrations, rollback, incidents (Realtime, a tablet offline, database or Vercel
  down with the paper fallback, failed webhooks, errors), onboarding, failed subscription
  payments, rotating each secret, backups and restore with a drill, the Razorpay live switch and
  the first platform admin.
- **P10-7 · Smoke tests:** `tests/smoke` is read-only (health with the database and, after a
  deploy, the deployed commit; the login page under the security headers and its nonce; the
  bad-QR page; the install files; the legal pages; the cron and the webhook refusing strangers),
  so it can run against production. It runs in CI as a Playwright project against `next start`,
  and after every deploy through `playwright.smoke.config.ts` (`SMOKE_URL`, `EXPECTED_VERSION`).
  `/api/health` reports the build's commit.
- **P10-8 · Lighthouse with Sentry:** mobile, production build with a DSN: English performance
  99 and Hindi 95, accessibility and best practices 100.

### Review fixes (Phase 10 Stop A)

Three reviewers (pipeline, monitoring, app) and a verifier: 5 confirmed, 4 rejected; one of the
rejected is fixed anyway.

- Sentry 11 no longer has `sendDefaultPii`; the spread options hid that, and its defaults would
  have sent the device cookie, staff session cookies and server-action bodies (a new staff
  password when a reset fails) to Sentry. `dataCollection` turns all of it off, typed.
- PostHog's `mask_all_text` still sent element attributes, and waiters' names are in button
  labels: `mask_all_element_attributes` too.
- An empty `NEXT_PUBLIC_POSTHOG_HOST` threw in the browser; it falls back to the US host.
- The production approval and environment secrets needed a paid GitHub plan: repository secrets
  per target, an owner-only Release with a typed confirmation, and a clear error when a secret is
  missing.
- Promoting an older deployment is Vercel's Instant Rollback, after which new production deploys
  aren't served until it is undone; the runbook says so and the smoke tests check the live
  commit.
- Fixed although rejected: `/ingest` and `/monitoring` were rewrites on our origin, which forward
  the request's cookies (staff sessions, the device cookie) to PostHog and Sentry. Both now send
  directly, with their hosts in the CSP; the rewrites and `skipTrailingSlashRedirect` are gone.
- Rejected: Release run from another branch (a write collaborator can already push to `main` on
  this plan); the runbook's Supabase page names (every setting is listed); the menu-import
  providers missing from the privacy outline (it asks the owner to confirm the list).

### Tests (Phase 10 Stop A)

- **Unit:** PostHog's API and assets hosts for both regions; the CSP names Sentry's and PostHog's
  hosts only when they are on.
- **E2E (`legal.spec.ts`):** the login page links to both pages, which render as placeholders;
  the customer menu links to them, with Hindi labels after switching.
- **Smoke (`tests/smoke`):** as P10-7, in CI against the local build; with a build made with
  `NEXT_PUBLIC_BUILD_SHA=abc123`, `EXPECTED_VERSION=abc123` passes and any other value fails.
- **By hand, with a dummy DSN build:** no Sentry request on a page load, one event when a page
  throws; the typecheck rejects `sendDefaultPii`.

### Staging (Stop B)

- **P10-9 · Secrets at build time:** `vercel pull` can't download Vercel's Secret values; it
  writes `[SENSITIVE]` placeholders, so the pipeline's `vercel build` sees those. The app reads
  its secrets (Supabase secret key, cookie secret, Razorpay, cron, Resend, import keys) only at
  runtime, where Vercel supplies the real values: staging signs the device cookie, which fails
  on the 11-character placeholder. What the build itself needs is Config (`NEXT_PUBLIC_*`,
  `STAFF_EMAIL_DOMAIN`, `SENTRY_ORG`, `SENTRY_PROJECT`) or comes from GitHub: the first deploy
  sent the placeholder as the Sentry token (401), so `SENTRY_AUTH_TOKEN` is a repository secret
  passed to the build step, which wins because `vercel build` loads the pulled file without
  overriding variables already set.
- **P10-10 · The Vercel CLI's install script:** pnpm 12 fails a `dlx` install whose
  dependencies have unapproved build scripts; the CLI needs esbuild's, so the deploy allows
  exactly that one (`pnpm dlx --allow-build=esbuild`).
- **P10-11 · Pages open through a deploy:** a page keeps the server-action IDs of the build that
  served it; after a deploy the new build answers them with 404 and Next.js throws
  `UnrecognizedActionError`, so a staff tablet left open on the board would fail every action
  until someone reloads it. `next.config.ts` sets `deploymentId` from `DEPLOYMENT_ID`, which the
  deploy workflow sets per build (commit prefix, run id and attempt: at most 32 characters, as
  Vercel requires; per build rather than per commit, because two builds of one commit, such as a
  redeploy after changing a variable, have different server-action IDs). Next.js tags the page,
  its assets, navigations and server actions with it, and Vercel's Skew Protection (supported for
  prebuilt deployments with a custom `deploymentId` since January 2026) sends them to the
  deployment that served the page. The guest orders poll, a plain `fetch`, sends the same
  `x-deployment-id` header. Maximum age 7 days, so a tablet open across days keeps working. The
  cost is that old deployments keep running for a week: migrations must not break any deployment
  from the last 7 days, a rollback doesn't stop pages already on the bad deployment (delete it,
  or set a Skew Protection Threshold on the fix), and a rotated secret is revoked only after the
  threshold is set on the deployment that has the new one (runbook). Locally and in CI the ID is
  unset and nothing changes. Not `supportsImmutableAssets`: it is for hosting adapters, and
  Next.js warns that setting it by hand can break deployments.
- **P10-12 · Production on Supabase's free plan, with nightly exports:** the owner starts
  production on the free plan and moves to Pro before charging the first restaurant (a step in
  the runbook's Razorpay live switch). The free plan keeps no backups, so
  `.github/workflows/backup.yml` exports production every night (02:00 IST, on once `BACKUP_PRODUCTION` is `true`;
  staging on demand): `supabase db dump --data-only --use-copy -s public,auth` (the app and the
  logins; Supabase's own storage tables refuse the restore role, and uploaded files are never in a
  database export) plus `supabase migration list`, encrypted with GnuPG (AES-256) under the
  `BACKUP_PASSPHRASE` secret, kept 30 days as a run artifact. A restore is the migrations at the
  backup's version plus the data: the schema, policies, functions and buckets come from the
  migrations, which also insert the default plans and settings, so the restore truncates those two
  tables before loading. Not a schema dump: the migrations are the tested source of the schema and
  of the storage policies. The pause after 7 idle days is a runbook incident until then.
- **P10-2, outcome:** the hosted Auth settings are set by hand from the runbook's list (done on
  staging, checked by the staff-login and login-burst tests), not with `config.toml` remotes and
  `supabase config push`: two projects, set once, with nothing to keep in sync.
- **P10-13 · A Supabase access token per target:** Supabase's personal access tokens are
  scoped to the organizations and projects chosen when they are made, and the shared
  `SUPABASE_ACCESS_TOKEN`, made while only staging existed, couldn't reach production (the first
  Release stopped at `supabase link`: "Your account does not have the necessary privileges").
  The deploy and backup workflows read `<TARGET>_SUPABASE_ACCESS_TOKEN`, each scoped to its own
  project, like the other per-target secrets, so a leaked staging token can't touch production.
  This replaces the shared token in P10-1. A staging deploy and a staging backup passed with the
  staging token before the shared one was deleted. Revoking the old token in Supabase then broke
  the next staging deploy (`Unauthorized`): it had been reused as the staging secret. A new
  staging-only token fixed it.

### Review fixes (Phase 10 Stop B)

Two rounds, each two reviewers with a verifier per finding; every finding was confirmed except
one.

- **Skew Protection (7 confirmed):** the deployment ID is per build, not per commit (two builds of
  one commit have different server-action IDs); the guest orders poll sends `x-deployment-id`;
  the runbook's migration rule, rollback and secret rotation now allow for old deployments that
  keep serving open pages for 7 days (delete the bad deployment or set a Skew Protection
  Threshold).
- **Backups (5 confirmed, 1 rejected):** a restore takes the newest migration with a Remote value
  in `migrations.txt` (main can be ahead of production); after a restore, the new deployment's
  Skew Protection Threshold is set and the old project paused, or open tablets keep writing to
  the old database; the free plan's two projects mean pausing staging to make room for a restore
  target; the artifact downloads as a zip. Rejected: that the Windows steps fail as written (only
  the zip detail held).

### Tests (Phase 10 Stop B)

- **Pipeline on staging:** the dry run listed exactly the 44 local migrations and no seed; the
  first deploy applied them (the remote migration list matches), and every deploy since ran
  migrate → build → deploy → smoke (6 of 6), with `/api/health` reporting the deployed commit,
  served from `bom1`, and the CSP naming Sentry's and PostHog's hosts.
- **Secrets:** the runtime has the real Secret values (staging signs the device cookie); the
  build uploads Sentry source maps with the GitHub token.
- **Sentry:** a browser error from `/login` and a server `console.error` (a cross-origin server
  action, refused before any action runs) both arrived, tagged `staging`.
- **PostHog:** staff pages send pageviews, clicks and web vitals under the member id, with button
  text masked; nothing comes from the customer pages; a browser ad blocker drops it all.
- **Staff logins:** the platform admin and a staff login with a generated email work on hosted
  Supabase (the email-validation risk is gone); the daily cron answers 200.
- **Skew Protection:** with a page loaded from one deployment and a newer one live, the page's
  navigations and pinned requests went to its own deployment (`x-nextjs-deployment-id`), others
  to the new one, and a link click navigated without a full reload.
- **On devices (owner):** the staff app installed on a tablet over HTTPS; with Wi-Fi off the
  board shows it is offline (and the app's offline page on a reload); ordering in English and
  Hindi, approve, serve, bill, print and pay all worked; 20 quick logins were never limited.
- **Restore, rehearsed locally:** a data export (`-s public,auth`) of the local database loaded
  into a throwaway second local stack built from the migrations without the seed: 49 tables and
  40,595 rows, every table's count equal to the export's. The first attempt, with all schemas,
  failed on `storage.buckets_vectors` (permission denied), hence `public` and `auth` only.
- **Backup drill, end to end:** the Backup workflow exported staging (an 11 KB encrypted
  artifact); the owner decrypted it with the runbook's command; restored into the throwaway stack:
  53 tables and 106 rows, all counts equal (the restaurant, its members, 4 logins with an
  authenticator factor, the platform admin, orders and bills). It first failed on
  `auth.mfa_recovery_code_sets`, which hosted Auth (v2.197.0) has and the CLI's default local Auth
  doesn't: a restore target's Auth must be at least the backup's version, which a new hosted
  project always is; a local rehearsal copies the linked project's `supabase/.temp/*-version`
  files first.

### Production (Stop C)

- **P10-14 · Vercel projects disconnected from GitHub:** `vercel.json`'s
  `git.deploymentEnabled: false` held for every push until `a8eb7ff` (2026-09-29), which Vercel's
  GitHub app built on both projects and made live, production included, without a Release. That
  commit was docs only, and the cause isn't visible from outside Vercel. Both projects are now
  disconnected from the repository (the pipeline deploys with the CLI and a token and never
  needed the connection); `vercel.json` keeps the setting in case one is reconnected. A Release of
  `a8eb7ff` put production back on a pipeline build. The runbook says not to use Vercel's
  Redeploy, which skips the migrations and the version check.

### Review fixes (Phase 10 Stop C)

One reviewer with a verifier per finding, on the Stop C records: 4 confirmed, 1 of them wrong on
the facts. Only the secret key can give a health 503 (the health check uses the admin client),
so the runbook no longer names the publishable key there; the pilot's "not yet" table dropped the
deployment row; the production URL and staff email domain in Vercel weren't checked, so that is
its own open item before QR printing. Kept: the production dry run, which the owner ran by hand.

### Tests (Phase 10 Stop C)

- **Pipeline on production:** the owner's dry run (`supabase db push --dry-run`, linked by hand
  and unlinked after) listed the 44 migrations and no seed; the Release
  applied all 44 and deployed, then the smoke tests failed: Vercel's `SUPABASE_SECRET_KEY` was
  another project's (health 503, the bad-QR page 500, and `Invalid API key` from the production
  project in the function log and Sentry). With the production key, a re-run of the same Release
  found the database up to date, deployed and passed smoke 6 of 6, with `/api/health` reporting
  `f6d3331`. The runbook's incidents list now names that message.
- **No demo data:** the seed's six QR codes (`DEMO0000TABLE001`…`006`) answer 404 on
  `menumesh.in`.
- **Domains:** `www.menumesh.in`, `menumesh.app` and `menumesh.co` redirect (308) to
  `https://menumesh.in/`.
- **Platform admin (owner):** made from the runbook's steps; logged in and enrolled an
  authenticator on `/super`.
- **Backups:** a manual production run made a 5 KB encrypted artifact; `BACKUP_PRODUCTION` is on
  for the nightly run.
- **Sentry and PostHog:** the first attempt's server errors arrived in Sentry; `/super` pageviews
  arrived in PostHog once the browser's own ad blocker allowed `menumesh.in` (DevTools showed
  every PostHog request as `(blocked:other)`).
- **Vercel and uptime (owner):** Skew Protection at 7 days, Node.js 24, the daily cron listed and
  run by hand (200), cookie and cron secrets different from staging, `NEXT_PUBLIC_APP_URL` and
  `STAFF_EMAIL_DOMAIN` set to `menumesh.in` (checked after the review); uptime monitors on both
  health URLs are green.

### After launch (October 2026)

- **P10-15 · Next.js 16.3.8:** CI's audit failed on 16.3.5 (the critical `next/og` `ImageResponse`
  RCE; the app's icons pass it fixed values only, so it was likely not exploitable) and 16.3.8
  also fixes a high SSRF in image optimisation, which the customer menu uses. Upgraded, with
  `brace-expansion` 5.0.12 and `fast-uri` 3.1.8 lifted inside their ranges, and released to
  production. The pnpm release-age exemptions moved to the new version.
- **P10-16 · Runners pinned to `ubuntu-24.04`:** `ubuntu-latest` moves to Ubuntu 26 from 19
  October 2026; CI, deploy, release and backup stay on 24.04 until a tested change moves them
  (Playwright's system packages and the Supabase CLI).
- **A test that expired:** `320_platform_actions` paid for September 2026 against a grace period
  counted from `now()`, so from 30 September the payment no longer extended access (correctly)
  and the test failed. Its periods are now months relative to today.

## Hindi names (after launch, 2026-10-02)

The owner read the Hindi customer screens on staging: everything was Hindi except dish names,
which the spec kept as typed "with an optional Hindi name field later". Asked for it now.

- **HN-1 · Scope:** an optional `name_hi` on dishes (≤ 80) and categories (≤ 60), entered in the
  menu editor: a "Hindi name (optional)" field in the dish form and a "Hindi name" action on each
  category. Option names (Half/Full), add-on groups and add-ons stay as typed, and so do the
  menu import (no CSV column; photo and PDF imports keep names as printed) and every staff,
  kitchen, bill and report screen, which read the typed name or the order's snapshot.
- **HN-2 · Older deployments:** `admin_save_menu_item` and `admin_update_category` change
  `name_hi` only when the key is sent (the `addon_group_ids` rule), so a page from an older
  deployment, kept alive by Skew Protection for up to 7 days, saves a dish without erasing it.
  The guest reads only add a key, which their non-strict schemas ignore.
- **HN-3 · Resolved on the server:** `customer_get_table` returns `name_hi` on categories and
  dishes; `getCustomerTable` reads the `lang` cookie and shows it in Hindi (`localName`), keeping
  the typed name as `altName` so a search for "paneer" still finds "पनीर टिक्का". The client
  components are unchanged: the menu, options sheet, announcements and the cart (whose lines are
  refreshed from the menu) all read `name`. Admin search matches either name too.
- **HN-4 · Orders page:** `customer_get_session` adds the dish's current `name_hi` by joining
  `menu_items` rather than snapshotting it at order time (marked `ponytail:`): a rename during a
  meal changes the Hindi name shown, which is harmless for guests; staff and bills keep the
  snapshot.

### Review fixes (Hindi names)

Two reviewers; the verifier was cut short, so each finding was checked by hand: 5 fixed, 1 left.
The orders page kept the old language's dish names until its next poll after the switch, so it
now takes a fresh server render into its polled copy (without remounting, which lost "Bill
requested"). The Hindi name is separated from the typed one by a real space, so screen readers
and accessible names don't run them together. Enter while a Hindi keyboard (IME) is composing no
longer saves a category's Hindi name. The dish form's "हिन्दी" is marked `lang="hi"`. The
database test now checks that null and empty clear a stored name. Left: input of only tabs or
newlines through a direct database call fails the column check instead of clearing, as typed
names already do; the app trims before sending.

### Tests (Hindi names)

- **pgTAP (`430_hindi_names`):** dish and category Hindi names are tidied, kept by saves
  without the key, cleared by null or empty, refused over 80/60 characters or when not text;
  unknown keys are still refused; the guest menu sends them (null when unset) and the orders
  page gets the dish's. The full suite passes locally except the two known `310` local-only
  failures.
- **Unit:** the form keeps and trims the Hindi name and clears an empty one; `localName`; search
  finds dishes and categories by either name.
- **E2E:** the owner adds a dish and a category Hindi name and sees them; a guest in Hindi sees
  them on the menu, the category tabs, the cart and the orders page, finds the dish by its
  typed name, and sees the typed names again in English. A dish without one stays as typed.

## Automatic Hindi names (after launch, 2026-10-02)

On staging the owner asked that dishes without a Hindi name be converted too, when a guest picks
हिन्दी.

- **HN-5 · Sound out, don't translate:** the owner's choice. Butter Chicken → बटर चिकन, Veg Fried
  Rice → वेज फ्राइड राइस, as Hindi menus print them; a translation (मक्खन चिकन, तले हुए चावल)
  reads oddly and mistranslates dish names. Stored as `name_hi_auto` beside the owner's
  `name_hi`; guests get `coalesce(name_hi, name_hi_auto)` from `customer_get_table` and
  `customer_get_session`, so the guest app is unchanged. The editor shows the automatic name
  tagged "(auto)" and as the Hindi field's placeholder; typing a Hindi name overrides it, and
  saving the form never turns the automatic one into the owner's.
- **HN-6 · The menu import model writes them:** spelling rules from English mangle English menu
  words (Butter, Fried Rice, Manchurian), so the names go to the menu import provider chain
  (`chatCompletion`, `menuImportProviders`, same keys and fallback): 100 names a call, about ₹1
  per 100 names. A reply is kept only when it is one line of Devanagari with no Latin letters
  within 80/60 characters; anything else stays empty and is tried again later. Names are data
  in the prompt, and a call only ever carries one restaurant's names, so the worst a crafted
  name can do is give its own restaurant odd Hindi names. Without a key nothing is written and
  guests see the typed names, as before.
- **HN-7 · Stale names:** a trigger clears `name_hi_auto` (and the attempt time below) whenever
  `name` changes, by any path (form, rename, import), so no admin function changed.
  `menu_set_hindi_names` stores a name only while the row still has the name it was made from
  and no automatic name, so a rename during the call drops the stale result and repeats are
  harmless. Claiming and storing bump `updated_at`, which is also the dish photo's cache
  version: a dish's photo is fetched again after a fill.
- **HN-8 · When:** after every menu action that can leave a name missing (add or rename a
  category, the suggested sets, save a dish, commit an import), `after()` fills the whole
  restaurant's missing names (up to 300) once the response is sent, so the first edit after
  this release also fills the existing menu. The daily cron sweeps every restaurant (up to 500,
  five calls at a time) for the rest: default categories of new restaurants and failed calls.
  `menu_hindi_names_claim` hands out names not tried in the last 12 hours, never-tried first,
  and stamps `name_hi_auto_tried_at`. So repeated or overlapping edits don't resend names (the
  cost of a fill is bounded by new or renamed names, not by how often a manager saves), and a
  name the model can't write (digits only, emoji) waits for the next daily sweep instead of
  holding the front of the list.

### Review fixes (automatic Hindi names)

Two reviewers and a verifier: 4 confirmed and fixed, 2 rejected. The daily sweep put several
restaurants' names in one call, so a name written as an instruction could have steered another
restaurant's Hindi names; calls are now per restaurant. Every menu action resent up to 300
missing names with no limit, and names that always fail stayed first in line for good; both are
fixed by claiming with a 12-hour attempt stamp (HN-8). The new E2E test now skips on a reused
dev server without the menu reader stand-in, as the photo import test does. Rejected: the cron
still answers `ok: true` when the model is unreachable, as it does when emails fail (the counts
are in the body and the warnings in the logs); and the dish form's hint mentions the automatic
name even on a deployment without import keys, where nothing breaks.

### Tests (automatic Hindi names)

- **pgTAP (`440_auto_hindi_names`):** only service_role may claim or store; claiming returns
  one restaurant's (or every restaurant's) dishes and categories with no Hindi name, stamps
  them, skips them for 12 hours, puts never-tried names first and respects the limit; storing
  trims, skips an automatic name already there, a stale name, a blank or over-long one and a
  wrong kind; price and visibility changes keep the name, renames clear it and its stamp; the
  guest menu and orders page send the automatic name, and the owner's wins.
- **Unit:** reply checks (one line of Devanagari, no Latin letters, length); numbers mapped
  back; unusable replies dropped and the fallback asked; a refused `response_format` retried
  without it; 100 names a call; never two restaurants in one call; storing only usable names;
  nothing without a provider.
- **E2E:** an owner saves "Masala Chai" with no Hindi name; it gets `मसाला चाय`, tagged
  "(auto)" in the editor and offered as the field's placeholder; a rename writes a new one,
  which a guest sees on the Hindi menu. The mock knows only a few words, so other tests' dishes
  get none.

## Public website (after launch, from 2026-10-02)

The owner asked for an attractive, animated website at menumesh.in that explains everything about
MenuMesh, works on phones, tablets and laptops, and lets a restaurant buy a plan directly; built in
phases on a new branch (`feat/website`), with extra features where they help (SPEC §24).

- **W-1 · Shape:** the same Next.js app in a `(site)` route group, so the site shares plans, auth
  and the subscription flow, and ships with the same pipeline. Phases W1 (shell and home), W2
  (features, pricing, demo, leads), W3 (self-serve signup and autopay), W4 (SEO, analytics,
  performance, launch), W5 (Hindi). Each phase is a PR from `feat/website` to `main`; production
  only through a Release. The owner's choices: trial + autopay (first charge when the 14-day
  trial ends, skippable), email code + Cloudflare Turnstile, a product-led warm look with the
  product's own screens and no stock photos, English first.
- **W-2 · Pages and copy:** the policies move under the site's header and footer, and gain
  refund-and-cancellation and shipping pages, which Razorpay's website review expects with
  contact and pricing; they stay placeholders until the owner's texts arrive, and the contact
  page shows placeholder details until then. All copy lives in `src/features/site/content.ts`
  (one shape for Hindi later) and claims only what the product does today: no testimonials,
  logos or numbers until real, consented ones exist. Until signup exists the call to action is
  "Book a demo".
- **W-3 · Look and motion:** the app's tokens and Noto Sans, plus display sizes (40/48/56 px)
  that only the site uses. The hero is a drawn scene, not a video: a phone, the kitchen tablet
  and the admin laptop rendered from simplified copies of the real screens (`StatusChip`,
  `FoodTypeMark`, `Money`), one order moving from "Add" to "Paid". `motion` 13 drives it and the
  how-it-works picture, through `LazyMotion` with `domAnimation` in strict mode (the small
  bundle). Section reveals are CSS scroll-driven animations where supported and plain content
  elsewhere. The scene plays only on screen with the tab visible, has a pause button (WCAG
  2.2.2), and with reduced motion shows the finished order with no reveals. This departs from
  §16.1's "no decorative motion" for the website only; the panels keep it.
- **W-4 · Devices:** laid out for 360 px phones to wide desktops: the section links move into a
  sheet below 1024 px, phones get a call-to-action bar once the hero's buttons scroll away, and
  on narrow screens the bill appears on the tablet instead of the hidden laptop. E2E runs the
  site spec on the desktop and Pixel 7 projects and a new tablet project (iPad Mini viewport on
  Chromium), including a CSP check of the home page.

### Review fixes (website W1)

Two reviewers (accessibility and layout; correctness and claims); the verifier hit the usage
limit, so each of the 20 distinct findings was checked by hand and all were fixed.

- **Claims:** Growth-only features (kitchen view, discounts, split payments, UPI QR on the bill,
  dish and waiter reports, CSV export) now carry a "Growth plan" badge, and the trial reads
  "free for 14 days on the Growth plan". With first-order approval on by default, the kitchen
  gets a table's first order once a waiter takes it; the hero text, the scene's caption and the
  steps say so. Bills are described as laid out for 80/58 mm receipt printers (there is no A4
  layout, P5-11), and the FAQ no longer says "many restaurants" use a setup.
- **Motion:** `MotionConfig reducedMotion="user"` makes motion's own animations instant for
  reduced motion (the CSS kill switch never reached them); the hero's finger-tap pulse runs only
  while the scene plays, so Pause stops everything; Next 16 needs
  `data-scroll-behavior="smooth"` on `<html>` so page changes don't smooth-scroll.
- **Layout:** grids get an explicit single column on phones, so wide pictures can't stretch them
  (nothing scrolls sideways at 320 px, now tested); the header's "Book a demo" hides below 380
  px (the menu and the hero carry it); the mobile sheet scrolls on landscape phones and has a
  44 px close button; header and footer targets are 44 px; step pictures shrink with the screen.
- **Keyboard and screen readers:** a strong 2 px focus outline on every site control, white on
  the brand panel; scroll padding keeps focused controls clear of the sticky header and the
  phone bar; section links are plain anchors (the browser moves focus), and the mobile sheet
  scrolls to the section and focuses its heading once its scroll lock is released; "हिन्दी" in
  English copy is marked `lang="hi"`; the site wrapper is `lang="en"`, since a guest arriving
  from the Hindi menu keeps the menu's `<html lang>` on client-side navigation.
- **Sticky bar:** rendered by the home page, not the layout, so it never lingers on the contact
  page or misses the hero after navigation. The reduced-motion test now checks the visible
  caption and the visible "Paid" stamp instead of text that the screen-reader list always has.

### W2: features, pricing, demo and leads

- **W-5 · Pricing from the database:** `/pricing` and the home page's "Plans from …" read the
  active `plans` rows and `platform_settings` (trial days, setup fee) with the service-role client
  (`getSitePricing`, a few columns only), because visitors are signed out and `anon` reads no
  table; so the site always shows what `/super/plans` set. Cards list what each plan adds to the
  one before; yearly shows the saving in rupees and the toggle the whole months free that every
  plan gives (computed, not hard-coded). "Which plan fits me?" picks the cheapest plan whose
  limits and features cover the visitor's tables, staff logins and chosen features; nothing fits
  → "Let's talk". The setup fee is shown, since onboarding is still sales-led; W3 decides it for
  self-serve.
- **W-6 · "Book a demo" leads:** a form on `/contact` (name, restaurant, city, mobile, optional
  email, plan, message) checked with Cloudflare Turnstile, then saved by
  `site_create_lead(jsonb, ip_hash)` (service role only) into `site_leads`, which only platform
  admins can read (`/super/leads`). Limits: 5 an hour per network, 3 a day per phone
  (`RATE_LIMITED`); the network is an HMAC of the IP with `CUSTOMER_COOKIE_SECRET`, never the
  address. Each lead is emailed to `platform_settings.support_email` through Resend after the
  response (`after()`), skipped when that address or Resend isn't set; the list is the record.
  Turnstile's script loads from bundle code under `'strict-dynamic'` (CSP gains
  `challenges.cloudflare.com` in script-src and frame-src), siteverify fails closed, and a fresh
  widget renders after every refusal since tokens work once. The form is hidden without
  `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`, except under `next dev`, which uses
  Cloudflare's always-pass test keys. E2E fakes the widget in the browser and points
  `TURNSTILE_VERIFY_URL` at the mock, so tests never reach Cloudflare.
- **W-7 · Real screens on the features page:** `/features` shows each role beside screenshots of
  the real app, taken by `pnpm site:shots` (Playwright, `tests/site-shots`) from a fresh sample
  restaurant on the local stack, and served through `next/image` from
  `src/features/site/shots`. Re-run it when the screens change. It creates a restaurant, so it
  never points at staging or production.
- **W-8 · Demo in the browser:** `/demo` is a small state machine (`src/features/site/demo`) that
  plays one table's order on a guest phone (real English and Hindi guest strings), the kitchen
  tablet and the counter laptop, with a "Next step" hint. Nothing reaches the server. Instead of
  playing itself when idle, a "Show me" button runs the next steps until stopped, off screen or
  hidden, and is absent under reduced motion. Below 1024 px one device shows at a time, with a
  switcher. `RequestBadges` moved to its own module so the site doesn't load the live board.

### Review fixes (website W2)

Three reviewers (security, correctness and claims, accessibility and layout) and a verifier; 14
of 16 findings were confirmed and fixed.

- **Lead limits under concurrency:** `site_create_lead` takes transaction advisory locks (the
  phone, then the network) before counting, so simultaneous requests can't all pass the limits;
  `451_site_leads_concurrency` races two requests over dblink.
- **Claims:** the pricing FAQ counts the setup fee; billing is described as from everything the
  table ordered (the app bills unserved dishes too, "Bill anyway"); the guest menu's Hindi covers
  its buttons and dish names, not descriptions. The draft privacy page names Cloudflare
  Turnstile and Resend's new role, and gains a section for people who book a demo.
- **Demo:** waiter calls are answered on the counter laptop (the admin's live orders, like the
  waiters' board), never on the kitchen view, which has no calls in the app; the bill follows
  the app's maths (CGST and SGST halves, total rounded to the rupee with a round-off line) and
  can be made before every dish is served.
- **Form:** below 300 px the Turnstile widget renders in its compact size and the form's padding
  shrinks, so `/contact` doesn't scroll sideways at 320 px (the fake widget in E2E now takes the
  real widget's room); a refusal moves focus to the first field to fix and announces it; a
  widget that fails to load says so, with a "Try again" button; message line breaks count once,
  as in the textarea.
- **Pricing:** a hidden "Plans" heading keeps the outline in order; the sliders' visible numbers
  are hidden from screen readers (the slider already announces its value); a plan that adds no
  features to the one before reads "Everything in …" without "plus".

### W3: self-serve signup

- **W-9 · Signup with an emailed code:** `/signup` asks for the restaurant's name, city and menu
  style, the owner's name, email and mobile, and agreement to the terms, behind Cloudflare
  Turnstile. `site_signup_start` (service role only) stores them in `site_signups` with an HMAC of
  a random 6-digit code, and the code is emailed through Resend before the visitor moves on;
  the signup's id lives in an httpOnly cookie on `/signup`. Limits: 3 signups an hour per email
  and 10 a day per network (`RATE_LIMITED`, with advisory locks as in W-6). `/signup/verify` takes
  the code and a password: `site_signup_verify` answers ok, or wrong (the try is counted, so it
  never raises), expired (15 minutes) or locked (5 wrong tries). The right code doesn't use the
  signup up: `site_signup_finish` does, once the restaurant exists, so a failure in between (Auth
  refusing the password, a timeout) can simply be tried again. "Send a new code"
  (`site_signup_resend`) replaces the code on the same signup, with fresh tries, at most 3 codes
  per signup and only within its first hour, since it takes no new bot check. Signups older than
  7 days are deleted by `site_signups_cleanup()`, from the daily cron and from each new signup.
  The right code then creates the restaurant with `onboardRestaurant` (owner username `owner`,
  the email as the login, restaurant code from the name, with a 4-character suffix when taken),
  on the platform's default trial (Growth), signs the owner in and opens
  `/admin/subscription?welcome=1` with the plan and cycle chosen on `/pricing` preselected;
  autopay can be set up at once (no charge until the trial ends) or skipped. The welcome email
  gives the restaurant code staff log in with and the first steps. An email that already has an
  account is told so only after its code is entered, so the form never reveals which emails
  exist. Signup is open when Turnstile and Resend are both set up; until then every call to
  action stays "Book a demo". The owner's dashboard lists first steps (menu, tables, staff
  logins, address and GST, autopay when Razorpay is set up), read from the data and gone once
  all are done.
- **W-10 · No setup fee for self-serve:** owners who sign up themselves set up their own menu,
  tables and QR codes, so they pay no setup fee; the one-time fee stays for restaurants we set up
  (with printed QR codes), and `/pricing` says both once signup is open. Charging it at signup
  would also mean a payment before the trial, which the trial-first flow avoids.
- **W-11 · Prices exclude GST, payments include it:** the owner confirmed that plan prices (and
  the setup fee) are before GST, and that autopay charges the price plus GST. `/pricing`, its
  FAQ and the home page's "Plans from …" say prices are before GST; the stored plan prices stay
  before GST. 18% (software services, `FEE_GST_BPS` in `src/features/subscriptions/gst.ts`) is
  added, rounded to the paisa, wherever money is asked for: the Razorpay plan created from
  `/super/plans` charges `withGst(price)` (₹899 → ₹1,060.82 a month), and a payment link
  suggests the fee or months with GST (still editable). The owner's plan cards show the price
  "+ GST" and what each payment is with it. Payments are recorded at what Razorpay took. A
  Razorpay plan created before this change, or typed in by hand, must charge the price with GST;
  clear its id and create it again from `/super/plans` otherwise. A custom GST invoice stays out
  of scope (§14.7).

### Review fixes (website W3)

Three reviewers (security, correctness and claims, accessibility and layout) and a verifier; 12
of 15 findings were confirmed (two were duplicates, one was wrong) and all 12 are fixed.

- **Resend chains:** "Send a new code" used to start a new signup from the stored details, so one
  bot check could keep code emails going for as long as the chain was resumed. It now replaces the
  code on the same signup, at most 3 codes and only within the signup's first hour.
- **Code used up too early:** the right code no longer finishes the signup; a failure while
  creating the restaurant can be retried with it. Passwords are capped at 72 bytes, as Supabase
  Auth reads them (fewer than 72 characters in Hindi), and Auth's weak-password answer shows on
  the password field. When the signup is over (already used, or the email has an account) the
  form gives way to the message and its one link.
- **Retention:** the daily cron deletes signups older than a week, so the privacy page's "at most
  7 days" holds on a quiet site too.
- **Forms:** the verify form posts through the server action before hydration too (never a GET
  with the password in the URL), keeping the code and password after a wrong code with
  controlled inputs; a new code clears the old errors; the terms and privacy links open in a new
  tab so the half-filled form survives; "Start again" and "Use a different email" keep the plan
  chosen on `/pricing`; a long email wraps at 320 px; one rate-limit message covers both limits.
- **Pricing and dashboard:** the plan finder's button also leads to the free trial when signup
  is open (a plan that doesn't exist yet still says "Let's talk"); first steps count only dishes
  on the menu, offer autopay only when a plan can be paid online, and no longer dim finished
  steps below readable contrast.

### Website W4 · Search engines, analytics, budgets and launch

The owner chose (2026-10-04): PostHog on the website without cookies, staging kept out of search
by a header, the full set of structured data, and a launch that prepares everything while the
production Release still waits for the legal texts and contact details. W4 ships as three PRs:
W4a search engines, W4b analytics, W4c budgets and the launch checklist.

- **W-12 · Search engines:**
  - **Only menumesh.in is indexed.** The proxy sends `X-Robots-Tag: noindex` on every other host:
    staging, Vercel's own addresses and local runs. Staging stays public, so the smoke tests,
    Razorpay's test webhooks and device tests keep working, and nothing new is needed on Vercel.
    Robots never says `Disallow: /` on staging, since a crawler that may not fetch a page never
    sees its noindex.
  - **robots.txt** lets crawlers in except for `/admin`, `/staff`, `/super`, `/api/`,
    `/logout` and `/signup/verify`, and names the sitemap. The login page stays indexable, so
    "MenuMesh login" finds it. Customer pages (`/t/…`) stay crawlable so their own noindex is
    seen.
  - **sitemap.xml** lists the home, features, pricing, demo and contact pages and the four
    policies, on this environment's address. Sign-up isn't listed: the pages link to it, and
    while it is closed it redirects to contact.
  - **Canonical and link previews.** The root layout's `metadataBase` is the environment's
    `NEXT_PUBLIC_APP_URL`, so URLs are absolute on each host. The site layout makes every page
    its own canonical (`./`, so `?plan` and `?cycle` drop away). It also sets Open Graph
    (`website`, `en_IN`) and a large Twitter card. Titles and descriptions come from each page,
    and the four policies and the login page now have their own descriptions.
  - **The link preview** is one static English card drawn with `next/og`: the logo, the name and
    one line, on the light paper. It sits in the `(site)` group, so a shared customer-menu link
    shows the restaurant rather than MenuMesh.
  - **Structured data** is JSON-LD in one script per page, with `<` escaped:
    - the home page has Organization (name, web address and logo; contact details once the real
      ones are published), WebSite and FAQPage;
    - the pricing page has SoftwareApplication, with each plan monthly and yearly as an Offer
      before GST (W-11) and read from the same plans the page shows, plus FAQPage.
    Google shows few rich results for these now. They are for understanding, not for stars, so
    there are no ratings or reviews (W-2).
  - **A branded not-found page** replaces Next's default for unknown addresses. It is neutral,
    since mistyped panel addresses land there too, and Next adds noindex to it.
  - **The proxy skips** robots.txt, sitemap.xml and the preview image, so they don't touch the
    session.
  - **Tests.** `seo.spec.ts` checks robots, the sitemap, the noindex header, the home page's
    canonical, preview and structured data (the FAQ matches the page), the pricing offers
    against the prices shown, the canonical of a link with a plan, and the not-found page. The
    smoke suite checks robots and the sitemap after every deploy, and that the noindex header is
    present on staging and absent on menumesh.in.

## Brand refresh (after launch, from 2026-10-03)

The owner finalized the logo: a white "M" in an orange hexagon (`#FF6606`), with a wordmark
in black. They asked for the website and all four panels to take their colours from it, for a
dark mode the user can switch, and for every panel to work well on phones, tablets and laptops,
installed or not. Delivered in four phases, each its own PR: B1 logo and light palette, B2 dark
mode, B3 responsive panels, B4 installed-app polish. The owner chose logo-orange buttons with dark
text, kept restaurant accents on the customer menu, and warm neutrals.

- **B-1 · Logo and icons:** `src/components/shared/logo.tsx` draws the logo's SVGs: `LogoMark`
  (the hexagon, decorative) and `Wordmark` (mark and name, `role="img"`, the name in
  `currentColor` so it reads on any background). The wordmark replaces the drawn "M" on the
  website and the login page; the mark leads the panel header. The customer menu keeps the
  restaurant's own logo. The paths live once in `src/lib/app-icon.tsx`, which also draws the app
  icons with next/og: `/icon/192` and `/icon/512` (the hexagon on transparent, for tabs),
  `/apple-icon` and the manifest's maskable `/maskable-icon.png` (the hexagon in the middle 64%
  of white: inside a maskable icon's safe circle, and opaque as iOS wants). The maskable icon is
  a route of its own, because an `icon.tsx` size would also be linked as a page icon.
  `favicon.ico` (16, 32, 48 px) was redrawn from the logo's PNG. The manifest keeps its `id` and
  `start_url`, so installed apps update in place (iOS shows the new icon after a reinstall).
  The browser and installed-app bar takes the header's white (`THEME_COLOR`), the manifest's
  splash the paper colour. The default restaurant accent becomes `#FF6606`; a migration moves
  restaurants still on the old indigo default (never changed in Settings) with it.
- **B-2 · Palette:** warm neutrals around the orange: ink `#1C1917`, muted `#57534E`, paper
  `#FAF8F5`, surface white, line `#E7E2DC`. White on `#FF6606` is 2.9:1, so the logo orange is a
  fill that carries ink text (6.0:1): `--primary` (buttons, selected chips, the cart bar). As
  text, focus rings and chart marks it is too light on white, so `--brand` became a deeper orange,
  `#C2410C` (4.7:1 or more on every background). Splitting the two kept all `text-brand` and
  `border-brand` uses as they were; the white-on-brand fills (website mockups, the board's
  active filter) moved to `bg-primary text-primary-foreground`, and the `link` variants to
  `text-brand`. Control borders get their own `--input` (`#8C857E`, 3:1 on paper and white) so
  fields stand out, and the dividers stay light. Turmeric moves from `#D98E04` to `#B8860B`:
  the old one was 2.5:1 as a card edge on the new paper and too close to the orange buttons now
  beside its chips; its chips keep ink text (5.4:1). Button hover is `primary/90`, which keeps
  ink at 4.5:1 or more. `tests/unit/theme-tokens.test.ts` reads the tokens from `globals.css` and
  checks every text pair (4.5:1) and every ring, border, status edge and chart colour (3:1), and
  that the default accent and the bar colour match the stylesheet.
- **Customer accent:** besides the text on its fill, the accent now gets a text colour and a
  focus ring of its own, each checked against both page backgrounds (white and paper): the
  accent where it reads (4.5:1 for text, 3:1 for the ring), else ink. A colour that neither
  white nor ink reads on falls back to the MenuMesh orange with ink, which is darker than the old
  ink, so more light accents keep their own colour.

### Review fixes (B1)

Three reviewers (correctness, accessibility and contrast, brand and docs) and a verifier; 7 of
12 findings were confirmed (two were duplicates, three were older than this change) and all 7
are fixed.

- **Selected and checked states:** with indigo, a fill alone told a selected option or a checked
  control apart; the logo orange is under 3:1 against white and paper, so the state now also has
  a deep-orange edge (`--ring`, 4.9:1 or more): checked checkboxes and radios, a pressed or
  current default button (payment mode, report tabs, plan cycle), the board's active filter, and
  the website's cycle and device toggles. A checked switch's track is `--brand`, so its white
  thumb stands out (4.9:1), and the native checkbox uses `accent-brand`.
- **Cached icons:** next/og serves icons with a year-long immutable cache, and `/icon/192` and
  `/icon/512` kept their addresses, so the manifest asks for them with `?v=2`.
- **SPEC:** the restaurants table still named indigo as the default accent.

### B2 · Dark mode

- **B-3 · Theme:** System (the default), Light or Dark, remembered in a `theme` cookie on this
  device (`path=/`, a year, httpOnly; no cookie means System). The root layout reads it and
  writes `<html data-theme>`, the `color-scheme` and the browser-bar colour (one per scheme for
  System) into the first HTML, so there is no flash and no inline script, and the CSP stays as
  it was. globals.css defines the `dark` variant as `data-theme="dark"`, or `"system"` while the
  device is set to dark, on screen only, so printing stays light. The tokens are written once:
  `:root` holds the light values and a nested `@variant dark` the dark ones (warm near-black
  paper `#121110`, surface `#1C1A18`, ink `#F5F2EE`; lighter status colours that carry
  near-black text). The orange buttons don't change. shadcn's own `dark:` classes now work.
  The choice is saved by a `setTheme` server action; with JavaScript the page repaints at once
  and goes back if saving fails (offline). The website's footer and menu sheet and the customer
  menu (at its foot, in Hindi too; the Hindi words need the owner's check) use a plain form of
  System / Light / Dark buttons, which also works before the page's JavaScript, and shows the
  current choice from the server render. The panels have it in a new account menu in the
  header, which also holds the name and role, the other panel and Log out, and the website's
  top bar (laptops) in a theme button; those are dropdowns and need JavaScript, like the rest of
  the panels.
  The offline page follows the device's setting, since a service worker can't read the cookie.
  `theme-tokens.test.ts` checks both themes; `colour-guard.test.ts` fails on a fixed colour
  (`bg-white`, `text-black`, a palette shade or an arbitrary hex) outside its allow-list; and
  `contrast.spec.ts` runs axe's colour-contrast rule over the website, the customer menu and
  every panel in both themes. That sweep caught two things the token test can't see: inactive
  tabs used ink at 60 % on the muted background (4.4:1), now `muted-foreground`, and the
  website's mock menus dimmed "Table 5" on the orange (4.5:1 was 4.48).
- **B-4 · Paper stays paper:** bills, the bill print pages and QR sheets are white paper in
  either theme: `.theme-light` re-declares the light tokens inside them, and the dark variant
  skips them. The authenticator QR code and the logo preview keep their white tile; food marks
  are drawn on a white tile, so their FSSAI colours read on the dark page; dialog and sheet
  scrims are darker in dark mode, and shadows are black instead of ink.
- **B-5 · Customer accent in dark mode:** the restaurant's accent stays the fill (with the same
  text on it) in both themes, but its text and focus-ring colours are chosen again against the
  dark page: the accent where it reads (4.5:1 and 3:1 on `#1C1A18` and `#121110`), else the dark
  ink. The accent `<style>` adds those under the same two conditions as the dark variant, with
  a more specific selector so they win over globals.css. The MenuMesh orange is too light as
  text on white but reads on the dark page, so there it is its own text and ring.

### Review fixes (B2)

Three reviewers (theme mechanism, accessibility and contrast, tests and docs) and a verifier;
12 of 14 findings were confirmed (two were duplicates) and all 12 are fixed.

- **Text in paper areas:** `color` is inherited as a resolved value, so text with no colour of
  its own inside `.theme-light` kept the dark theme's near-white (the print pages' Back and copy
  links were 1.05:1 on the paper). The base layer now sets `.theme-light`'s text colour again;
  utilities such as the bill's `text-black` still win. The UPI QR preview tile is paper too.
  The contrast sweep now also visits the QR sheet and test print pages, sign-up and the cart.
- **The switch's selected option** was only a faint tint (1.1:1); it is now the orange fill with
  a deep-orange edge, like the plan and filter toggles. The server render marks it too: the root
  layout hands the cookie's theme to a context that the switch reads until it hydrates. The
  buttons sit in a `role="group"` inside the form (a form may not take that role).
- **Saving fails:** the page goes back to the theme it had instead of staying on one that wasn't
  saved.
- **shadcn's `dark:` classes, now live:** the unchecked switch track used `input` at 80 %
  (2.8:1), so it keeps the project's `ink-muted` track; the destructive button's dark hover
  lightened its own text's background to 3.8:1, so it fades instead; the call-to-action's Log in
  link took the ghost button's dark hover on the orange panel (2.6:1).
- **The website's menu sheet** was 75 % wide on phones (its `w-80` lost to the sheet's own
  width), too narrow for the switch at 360 px; it is 320 px as intended.
- **Docs:** B-3 now says which switches work without JavaScript, and SPEC §16.2 says what the
  contrast sweep covers.

### B3 · Responsive panels

- **B-6 · From a 360 px phone to a laptop:** a sweep of every panel page at 360, 768 and 1024 px
  found little wrong, and B3 fixes what it found rather than redesigning screens.
  - The admin and platform sidebars show from 1024 px (`lg`). Below that the sections are in the
    menu sheet, so a tablet held upright gets the full width for content. The sheet button is
    44 px, and section links are 44 px tall.
  - On phones the kitchen view shows one column at a time, 85 % wide, so the next one peeks in,
    and it snaps as staff swipe. A row of New / Preparing / Ready buttons above the columns keeps
    every count in sight. A tap scrolls the columns (not the page) to that column and moves focus
    to its heading, so Tab carries on inside it. From 768 px the three columns sit side by side
    as before. Ticket headers no longer break "Round 1" or "0 min" across lines.
  - The worker panel's section tabs fit a 360 px screen without scrolling.
  - On the customer menu, Call waiter, the language link and the Terms and Privacy links are
    44 px tap targets. Call waiter keeps its compact width, so the header doesn't wrap at a
    two-digit table once it reads "Waiter called". The language link keeps the header's height
    by using negative margins. Switches have a 44 px tap area, and the add-dishes note box is
    44 px like the rest of that sheet.
  - Wide tables scroll sideways inside a focusable, named region (`ScrollRegion`, now in
    `components/shared`; the shadcn `Table` uses it and needs a `label`), so a keyboard can
    reach every column. The `label` names the table, and the region is "<label> table" so it
    never repeats the name of the section around it. This now applies to the platform pages, total orders, staff logins,
    waiters and payments too. The scroller is `relative` so screen-reader text in a column off
    to the side can't widen the page: the kitchen's columns had that bug once they held
    tickets. JSON in the audit log and webhooks wraps instead of scrolling. One more overflow
    was fixed: the settings page's logo picker, at 360 px.
  - Not done: total orders keeps every column on phones, scrolling rather than hiding the waiter
    and billed-by columns. The admin panel's row actions (32 px) and the menu editor's controls
    (28 px) stay as they are. The admin panel is desktop-first (spec §13.3), and those controls
    meet WCAG 2.2's 24 px minimum.
  - `panels-responsive.spec.ts` checks every panel page at the three sizes: no sideways scroll,
    44 px header controls, the admin sheet below 1024 px, and the kitchen columns. The tablet
    test project now also runs the admin navigation spec.

### Review fixes (B3)

Three reviewers (layout, accessibility and touch, tests and docs) and a verifier. Of 13
findings, 9 were confirmed; three of those were duplicates, which leaves 6 distinct problems.
All 6 are fixed.

- **The payments tables lost their name.** Moving `label` to the scroll region left the
  `<table>` unnamed, which broke three e2e specs. `Table` now names both.
- **Two regions with the same name.** The payments and menu-import tables sat inside sections of
  the same name, so the region is now "<label> table".
- **The kitchen jump scrolled the whole page** down when the column was taller than the screen,
  pushing the buttons off it. It also left focus behind, so the next Tab scrolled back to New. It
  now scrolls only the columns and focuses the column heading. The test uses a column taller than
  the phone and checks both.
- **The bigger Call waiter made "Table 12" wrap** once it read "Waiter called", so the menu jumped
  16 px. It is 44 px tall but keeps its old width, and a test checks the header at a two-digit
  table.
- **SPEC §16.2's 44 px line** didn't yet hold for the customer menu's Terms and Privacy links or
  the add-dishes note box; both are 44 px now.

### B4 · Installed app

- **B-7 · Installing the panels:**
  - **Install app item.** The staff and admin account menus have an "Install app" item, which
    appears only when this device can install the panel:
    - Where the browser offers its own prompt (Chrome and Edge, on Android and on laptops), the
      item opens that prompt. `beforeinstallprompt` is caught when the menu's module loads, so
      a prompt fired before React hydrates isn't lost. A prompt can be shown only once, so the
      item then goes away.
    - In Safari on an iPhone or iPad (`navigator.standalone === false`), the item explains:
      tap Share (under ••• in the compact layout iOS 26 uses by default), then Add to Home
      Screen. The steps stay on screen until closed. Apps' own in-app browsers, which leave
      "Safari/" out of their user agent and can't add to the Home Screen, don't get the item.
    - Once the app is installed there is nothing to offer, and the platform admin panel, which
      has no manifest, never shows the item.
    - The layouts pass `installable` to the header rather than the menu looking for the
      manifest link: after the client-side navigation from login, Next adds that link to the
      head after the menu has rendered.
  - **Safe areas.** The viewport keeps the default `viewport-fit=auto` and does not switch to
    `cover`. With `auto`, iOS and Android keep the page inside the safe area themselves: clear
    of the notch, the home indicator and the camera cut-out. That is why the safe-area insets
    read 0. `cover` would only draw under those areas, and in return every element along a
    screen edge would have to pad itself: the sheets, the table drawer's footer, the website's
    sticky call to action. The cart bar's and options sheet's `env()` padding stays and takes
    effect if `cover` is ever turned on.
  - **Status bar.** iOS keeps the default status bar style: `black-translucent` would draw
    white text over the light header.
  - **Left out of the manifest.** No shortcuts (they depend on the role), no screenshots, no
    orientation (any is the default).
  - **Tests.** The colour-contrast sweep now also runs on the tablet and phone projects. That
    caught the website still fading in under the OS "reduce motion" setting: the hero jumps to
    its last scene, and its parts faded in, so axe read text mid-fade. `SiteMotion` now also
    gives the whole site a zero-length default transition on reduce motion, so scenes appear at
    once. The demo's tickets and the how-it-works pictures keep their own short fades, which
    follow a click or a scroll.
  - **To check on real devices** (not automated): install on an Android tablet in Chrome and
    on an iPhone or iPad with Add to Home Screen. Check the icon, the splash screen, the theme,
    the edges of the screen and the status bar.

### Review fixes (B4)

Three reviewers (install logic, UX and accessibility, tests and docs) and a verifier. Of 10
findings, 2 were confirmed and they were the same problem, now fixed. The Safari steps said "tap
Share", but iOS 26's default layout keeps Share under •••. The steps now say so and stay on
screen until closed, and in-app browsers that can't install no longer offer it. The verifier
also noted, and B-7 accepts, that catching `beforeinstallprompt` hides Chrome's mini-infobar on
Android. Chrome's own menu still offers Install.
