# MenuMesh

QR-code dine-in ordering for restaurants: customers order from their table, staff track every
dish live, managers bill and review sales. Multi-tenant SaaS built with Next.js and Supabase.

The full specification lives in [`docs/SPEC.md`](docs/SPEC.md); decisions taken while building
are logged in [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Requirements

- Node.js 24 LTS
- pnpm (version pinned in `package.json` → `packageManager`)
- Docker Desktop (running) for the local Supabase stack

## Getting started

```bash
pnpm install
pnpm db:start            # starts local Supabase in Docker (migrations + demo seed)
cp .env.example .env.local   # then fill in values printed by `pnpm supabase status`
pnpm dev
```

`.env.local` also needs `CUSTOMER_COOKIE_SECRET` (signs the customer device cookie): any random
value of 32+ characters, e.g. from `openssl rand -base64 48`.

### Demo logins (local only)

Open http://localhost:3000/login. Every password is `Password123!`.

| Who            | Log in with                                   | Lands on |
| -------------- | --------------------------------------------- | -------- |
| Platform admin | Email `super@local.test`, then a TOTP code    | `/super` |
| Owner          | Email `owner@local.test`, or `demo` / `owner` | `/admin` |
| Manager        | Restaurant code `demo`, username `manager`    | `/admin` |
| Waiter (Ravi)  | `demo` / `waiter1`                            | `/staff` |
| Kitchen        | `demo` / `kitchen1`                           | `/staff` |

Add another restaurant from `/super` → Onboard restaurant, or from the command line (it starts
with the default menu categories for its cuisine: `north_indian` by default, or `south_indian`,
`cafe`, `fast_food`, `bakery`, `multi_cuisine`, `blank`):

```bash
pnpm create-restaurant --name "Sharma Dhaba" --slug sharma-dhaba --owner-name "Vikram Sharma" --owner-username vikram --owner-password "choose-a-password" --cuisine north_indian
```

### Customer ordering

Each table's QR code opens `/t/<qr token>`. The demo tables use fixed tokens, so
http://localhost:3000/t/DEMO0000TABLE001 is table 1 (…002 to …006 for tables 2–6). Customers
browse the menu, add dishes (with options, add-ons and notes), place the order and follow it on "Your
table's orders", where they can cancel their own dishes for a short time. **Call waiter** in the
header works any time; **Request bill** appears on "Your table's orders" once an order is accepted.
**हिन्दी** in the header switches the customer screens to Hindi (and **English** back); the phone
remembers the choice. The demo restaurant asks
staff to confirm a table's first order, so new orders wait until a waiter approves them on the
worker panel (or a manager assigns the table a waiter). Each phone gets a signed device cookie,
which is why `CUSTOMER_COOKIE_SECRET` is required.

### Worker panel and live orders

Staff open `/staff` (waiters and kitchen land there; managers and owners can switch to it). The
**Board** shows every table live: state, waiter, time seated and dishes by status. Tap a table to
approve or reject a waiting order, move dishes on ("Start preparing", "Mark ready", "Mark served"),
remove a dish with a reason, add dishes (or an order for a free table), move the guests to a free
table and close a table without a bill. A customer's call or bill request shows on the card
("Calling", "Bill requested") with a chime; the drawer has Acknowledge and Done, and billing or
closing the table finishes them. **Kitchen** (Growth plan) shows New / Preparing / Ready tickets; **Availability** switches
dishes and add-ons in and out of stock. Managers use **Live orders** in the admin panel for the same board plus
the Unassigned tables queue, the waiter strip, assigning waiters, deleting orders and reverting a
status.

Updates arrive over Supabase Realtime (the header says Live, Reconnecting… or Offline). Browsers
only play sound after a tap, so each device shows **Enable sound** once. To try it locally, open the
demo table on a phone-sized window and `/staff` as `demo` / `waiter1` side by side, then place an
order.

Without a network, dish moves still work: the board shows them at once, a banner counts them, and
they reach the server in order once the tablet is back, even after a reload or a closed tab.
Everything else (approving, adding dishes, billing) waits for the connection and its buttons are
disabled meanwhile. The staff and admin panels install as an app from Chrome (**Install app** or
**Add to Home screen**); a page opened without a network shows an offline page that retries, and
the board, the kitchen view and Live orders keep the screen on.

### Billing and Total orders

Managers and owners bill tables at `/admin/billing`: open tables with their running totals, then a
bill builder with the waiter, the dishes, a discount (Growth plan) and the optional service charge,
previewed live. **Generate bill** numbers the invoice (`INV/2026-27/00001`, per financial year),
frees the table and ends the waiter's assignment. The bill page prints (80 mm or 58 mm, set in
Settings → Bill, which also has **Test print**), records payments (split payments on Growth, with a
change calculator for cash) and voids a bill, optionally reopening the table within the reopen
window. **Total orders** lists bills by business day with filters, a summary strip and the tables
closed without a bill. Print on a real thermal printer by choosing it in the browser's print
dialog, with the paper size set in the printer driver and headers and footers turned off.

### Dashboard and reports

`/admin` opens on today: sales, bills and the average bill for the business day, the open tables and
dishes in progress, orders waiting for approval, tables without a waiter, the waiters on duty and a
compact board of every table. The numbers move as bills are generated, without a reload.

`/admin/reports` covers a range of business days (Today, Yesterday, Last 7 days, This month or your
own dates):

- **Sales**: the summary (gross, discounts, service charge, GST, net sales, total billed, average
  bill), how it was paid, a day-by-day chart and a weekday × hour heatmap of the busy hours.
- **Dishes**: quantities and sales per dish and per category.
- **Tables**: sittings, average table time and sales per table.
- **Waiters** (Growth): the tables each waiter finished, their sales, average table time, rounds and
  dishes, and the tables they are serving right now. A table handed over counts for whoever billed
  it.
- **Activity**: voids and discounts, removed dishes and deleted orders — who did it, their role and
  why.

Every report downloads as a CSV (Growth), written so Excel opens it cleanly. The Starter plan sees
the sales summary for today or yesterday.

### Super-admin panel

`/super` is for running the platform (spec §13.4). Platform admins need an authenticator app
(Google Authenticator, Microsoft Authenticator, 1Password…): the first visit shows a QR code to
scan, and every later login asks for the 6-digit code. Without the code the database shows a
platform admin nothing.

- **Home**: key numbers, what needs attention, charts, the activity stream; an alerts bell and a
  daily digest email.
- **Restaurants**: search, filters (tags, account manager and onboarding among them) and saved
  views, My restaurants and Onboarding first. Each restaurant's page has its state, health, owner,
  tags and account manager over tabs: Overview (with its onboarding checklist), Billing, Usage,
  Activity, Notes (the team's only), Documents, Support view and Menu imports. Its Actions menu extends the trial, changes the plan, records a payment
  received outside Razorpay, sends a Razorpay payment link (months of the plan, or the setup fee),
  syncs with Razorpay, cancels autopay, adds a note, and suspends or unsuspends; the owner's login
  on Overview gets a new password.
- **Onboard restaurant**: details → owner login → tax → plan and trial, then the login details to
  hand over.
- **Support view**: the restaurant's menu, tables, live board and Total orders, read-only. Each
  look is recorded in that restaurant's audit log.
- **Subscriptions**, **Plans** (prices, limits, features, Razorpay plan ids), **Webhooks** (what
  Razorpay sent; a failed one can be reprocessed) and the **Audit log**.
- **Leads**: "Book a demo" requests from the website's contact page.
- **Support inbox**: what restaurants send from Get help, by status, with priority, assignee,
  the screenshot, internal notes and history. A new request emails the support address set in
  Platform settings and shows in the alerts bell.
- **Platform settings**: trial and grace days, the setup fee, its launch discount and the offer's
  last day, and the support phone and email. Every change is in the audit log.

A platform admin who loses their phone can't pass the second factor. Remove their authenticator in
the Supabase SQL editor, and they enrol again on the next login:

```sql
delete from auth.mfa_factors
where user_id = (select id from auth.users where email = 'admin@example.com');
```

To make someone a platform admin, create their login in Supabase Auth, then
`insert into public.platform_admins (user_id) select id from auth.users where email = '…';`.

### Menu import

Menu → **Import menu** (owners and managers; platform admins from a restaurant's Menu imports
tab) turns a
printed menu into dishes without typing them (spec §20A). Photos (or a PDF) of up to 10 pages are
read by a vision model; a CSV file works without one. Either way the owner checks a draft first:
the rows most likely to be wrong come first, every field can be edited, and nothing reaches the
menu until they press Import.

The reader is any OpenAI-compatible `/chat/completions` API. Set in `.env.local`:

| Variable                        | Default                                  |
| ------------------------------- | ---------------------------------------- |
| `MENU_IMPORT_API_KEY`           | none (a key from Command Code Studio)    |
| `MENU_IMPORT_BASE_URL`          | `https://api.commandcode.ai/provider/v1` |
| `MENU_IMPORT_MODEL`             | `google/gemini-3.8-flash`                |
| `MENU_IMPORT_FALLBACK_API_KEY`  | none (an OpenRouter key)                 |
| `MENU_IMPORT_FALLBACK_BASE_URL` | `https://openrouter.ai/api/v1`           |
| `MENU_IMPORT_FALLBACK_MODEL`    | `google/gemini-3.8-flash`                |
| `MENU_IMPORT_USD_INR`           | `96`                                     |

The same keys write the automatic Hindi dish and category names guests see on the Hindi menu
(docs/DECISIONS.md HN-5 to HN-8), after menu edits and in the daily cron; without them, names
the owner gave no Hindi name stay as typed. With neither key set, the Import menu page offers
CSV only. A page costs about ₹0.30 with the
default model; super-admin shows each import's tokens and cost. Five photo imports a day per
restaurant. Photos are deleted 7 days after an import ends by `/api/cron/daily`, which needs
`CRON_SECRET` (`Authorization: Bearer …`; Vercel's scheduler sends it, see `vercel.json`).

CSV columns (first row, any order): `category, name, description, food_type, price, variant_name,
variant_price`. Rows with the same category and name and a `variant_name` are the options of one
dish (Half, Full). The Import menu page has a sample file to download.

### Subscriptions (Razorpay)

Owners pay for MenuMesh on **Subscription** (owners only): pick a plan and Monthly or Yearly, then
authorise autopay by UPI or card in Razorpay Checkout. The first payment waits until a running
trial or paid period ends. Owners can cancel autopay; it stops at the end of the paid period.
Razorpay's webhooks keep the subscription up to date: paid, payment failed (7 days' grace, then
ordering pauses at the next business-day start), paid again, ended.

Set in `.env.local` (test-mode keys from the Razorpay dashboard):

| Variable                  | What it is                                                   |
| ------------------------- | ------------------------------------------------------------ |
| `RAZORPAY_KEY_ID`         | Key id (`rzp_test_…`); online payment is off without it      |
| `RAZORPAY_KEY_SECRET`     | Key secret                                                   |
| `RAZORPAY_WEBHOOK_SECRET` | The secret set on the webhook in the Razorpay dashboard      |
| `RAZORPAY_API_BASE_URL`   | Defaults to `https://api.razorpay.com/v1` (tests use a mock) |

Open **Subscriptions** once in the Razorpay dashboard, in the keys' mode: until then Razorpay
answers `401 {"error":"Unauthorized"}` for plans. Then, in `/super` → **Plans**, press
**Create … plan in Razorpay** for each plan and cycle to sell.
A new price clears a plan's Razorpay id (Razorpay plans can't change price); create it again.

Razorpay can't send webhooks to `localhost`. To try the states locally, send signed events
yourself (with the same `RAZORPAY_WEBHOOK_SECRET`, any string, in `.env.local` and the running
app):

```bash
pnpm razorpay:event --restaurant demo --event charged
pnpm razorpay:event --restaurant demo --event pending
pnpm razorpay:event --restaurant demo --event payment-link --months 3
```

Events: `authenticated`, `activated`, `charged`, `pending`, `halted`, `cancelled`, `completed`,
`payment-link`, `setup-fee`. A restaurant without a Razorpay subscription gets a made-up one first.
For real test-mode webhooks, expose the app through a tunnel Razorpay accepts (zrok) or use
staging, and register `…/api/webhooks/razorpay` with the `subscription.*` and
`payment_link.paid` events.

The setup fee a payment link suggests is the fee (₹999) less the launch discount (₹500 for now),
plus GST; `/pricing` shows both. Change them in `/super` → Platform settings: a discount of 0, or a
last day for the offer, ends it.

#### Reminder emails

The daily cron (`/api/cron/daily`, `CRON_SECRET`) emails owners when the trial ends in 3 days and
in 1 day, every day of grace after a failed payment, and once when ordering pauses. It sends
through Resend; without these the step is skipped:

| Variable         | What it is                                                         |
| ---------------- | ------------------------------------------------------------------ |
| `RESEND_API_KEY` | Resend API key                                                     |
| `EMAIL_FROM`     | Sender on a verified domain, e.g. `MenuMesh <billing@menumesh.in>` |
| `RESEND_API_URL` | Defaults to `https://api.resend.com` (tests use a mock)            |

Run it by hand with `curl -H "Authorization: Bearer <CRON_SECRET>" http://localhost:3000/api/cron/daily`.
A second cron, `/api/cron/digest` at 08:45 India time, emails the platform team yesterday's
numbers and today's Needs attention counts, once a day (docs/DECISIONS.md SA-31).
With a real key it emails the addresses in your local database.

Every email is logged for `/super` → Health (docs/DECISIONS.md SA-87), with the addresses only as
keyed hashes. Optional for that page: `RESEND_WEBHOOK_SECRET` (Resend's bounce and spam reports to
`/api/webhooks/resend`) and `SENTRY_READ_TOKEN` (Sentry's issues, with `SENTRY_ORG` and
`SENTRY_PROJECT`); see `.env.example`.

### Admin panel

Owners and managers set the restaurant up at `/admin`:

- **Menu**: categories and dishes (drag to reorder), Half/Full style options, photos, in-stock
  switch, suggested category sets, and importing a menu from photos or a CSV file. **Add-ons**
  are shared groups (e.g. "Toppings: up to 3" or "Crust: choose 1") ticked on any dish; their
  prices are added to the dish on the order and the bill.
- **Tables & QR**: add tables one at a time or as a range (`1-20`), download a table's QR code,
  print A4 sheets of QR cards. QR codes open `NEXT_PUBLIC_APP_URL`, so set it to the real domain
  before printing cards for customers.
- **Waiters**: waiter profiles (no login needed), on/off duty, optional linked login.
- **Staff logins**: logins for managers, waiters and kitchen staff; password resets.
- **Settings**: restaurant details and logo, tax and charges, bill options, ordering rules.
- **Get help** (account menu, or Settings): ask the MenuMesh team, with a screenshot if it
  helps, and see where each request stands.

### Website

The public site at `/` (`src/app/(site)`, copy in `src/features/site/content.ts`, spec §24): the
home page, `/features`, `/pricing` (plans and prices straight from the `plans` table), `/demo`
(an in-browser simulator; nothing is saved), `/contact` and the policy pages.

The "Book a demo" form on `/contact` is protected by Cloudflare Turnstile and shows only when both
keys are set; `pnpm dev` uses Cloudflare's always-pass test keys instead. Each request is listed
in `/super/leads` and emailed to the support email (`/super` → Platform settings) when
Resend is set up.

With both Turnstile and Resend (`RESEND_API_KEY`, `EMAIL_FROM`) set, visitors can also sign up
themselves at `/signup`: an emailed 6-digit code, then a password, creates the restaurant on a
free trial and opens autopay with the plan they picked (docs/DECISIONS.md W-9). Until then every
"Start free trial" button reads "Book a demo" instead.

| Variable               | What it is                                             |
| ---------------------- | ------------------------------------------------------ |
| `TURNSTILE_SITE_KEY`   | The Turnstile widget's site key (public)               |
| `TURNSTILE_SECRET_KEY` | Its secret key, for siteverify                         |
| `TURNSTILE_VERIFY_URL` | Defaults to Cloudflare's siteverify (tests use a mock) |

The pictures on `/features` are real screens: with `pnpm dev` running, `pnpm site:shots` builds a
sample restaurant in your local database and saves fresh screenshots to
`src/features/site/shots`.

### Security headers

Every page gets a Content-Security-Policy with a new script nonce per request (`src/proxy.ts`,
policy in `src/lib/csp.ts`) and the static headers in `next.config.ts` (no framing, `nosniff`,
referrer policy, permissions policy, HSTS). A new third-party script, image host or frame needs
an entry in the policy; `tests/e2e/security-headers.spec.ts` fails on any violation. CI also runs
`pnpm audit --prod --audit-level=high`.

### Deployment

Staging and production each have their own Supabase project (Mumbai) and Vercel project.
GitHub Actions migrates, then deploys, then runs the read-only smoke tests
(`tests/smoke`): staging after every green CI run on `main`, production through the
**Release** workflow, which only the repository owner can run. `docs/RUNBOOK.md` covers the setup, the
environment variables, rollbacks, incidents, backups, secret rotation and the Razorpay live
switch. `pnpm smoke` with `SMOKE_URL` checks any deployed site.

Errors go to Sentry (errors only, no cookies, headers or request bodies; the browser SDK loads
once the page is idle); staff and admin usage goes to PostHog, never from diners' phones. Both
are off while their keys are empty, as locally and in CI, and the Content-Security-Policy only
lets the browser reach them when they are on. `/terms` and `/privacy` are
placeholders to replace before launch.

## Scripts

| Script                    | What it does                                  |
| ------------------------- | --------------------------------------------- |
| `pnpm dev`                | Next.js dev server on http://localhost:3000   |
| `pnpm smoke`              | Read-only checks of the site at `SMOKE_URL`   |
| `pnpm build`              | Production build                              |
| `pnpm lint`               | ESLint                                        |
| `pnpm typecheck`          | Route type generation + `tsc --noEmit`        |
| `pnpm format`             | Prettier (write)                              |
| `pnpm test`               | Unit tests (Vitest)                           |
| `pnpm e2e`                | End-to-end tests (Playwright)                 |
| `pnpm db:start`           | Start local Supabase                          |
| `pnpm db:stop`            | Stop local Supabase                           |
| `pnpm db:reset`           | Recreate local DB from migrations + seed      |
| `pnpm db:test`            | Database tests (pgTAP via `supabase test db`) |
| `pnpm db:types`           | Regenerate `src/types/database.ts`            |
| `pnpm create-restaurant`  | Onboard a restaurant + owner login            |
| `pnpm razorpay:event`     | Send a signed Razorpay webhook to the app     |
| `pnpm metrics:backfill`   | Fill super-admin usage history for past days  |
| `pnpm seed:platform-load` | Load 300 test restaurants into the local DB   |
| `pnpm site:shots`         | Retake the website's app screenshots (local)  |
