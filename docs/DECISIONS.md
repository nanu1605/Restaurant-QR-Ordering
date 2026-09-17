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
- **Product name: DineFlow** (user, 2026-09-13; may still change; domain still open). `APP_NAME` is
  `DineFlow`, the package is `dineflow`. Identifiers nobody outside development sees keep
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
- **`upi_vpa` check fixed:** the Phase 1 regex used `{2,256}`, above Postgres' repetition limit of
  255, so every VPA failed at runtime; now `{2,255}`.

### UI and tooling

- **P2-15 · Forms:** react-hook-form with zod schemas shared by the dialog and the server action;
  actions return `{ ok, data } | { ok: false, error, fieldErrors }`. Watching values uses
  `useWatch` (the React Compiler lint rule rejects `watch()`). Toasts use sonner without
  `next-themes` (one light theme).
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
