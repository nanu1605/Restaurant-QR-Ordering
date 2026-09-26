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
browse the menu, add dishes (with options and notes), place the order and follow it on "Your
table's orders", where they can cancel their own dishes for a short time. **Call waiter** in the
header works any time; **Request bill** appears on "Your table's orders" once an order is accepted. The demo restaurant asks
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
dishes in and out of stock. Managers use **Live orders** in the admin panel for the same board plus
the Unassigned tables queue, the waiter strip, assigning waiters, deleting orders and reverting a
status.

Updates arrive over Supabase Realtime (the header says Live, Reconnecting… or Offline). Browsers
only play sound after a tap, so each device shows **Enable sound** once. To try it locally, open the
demo table on a phone-sized window and `/staff` as `demo` / `waiter1` side by side, then place an
order.

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

- **Overview**: restaurants by state, MRR, orders in the last 24 hours, trials ending this week.
- **Restaurants**: search and filters; each restaurant's profile, owner login, subscription,
  payments, usage and access, with actions to extend the trial, change the plan, record a payment
  received outside Razorpay, send a Razorpay payment link (months of the plan, or the setup fee),
  sync with Razorpay, cancel autopay, suspend or unsuspend, and set a new owner password.
- **Onboard restaurant**: details → owner login → tax → plan and trial, then the login details to
  hand over.
- **Support view**: the restaurant's menu, tables, live board and Total orders, read-only. Each
  look is recorded in that restaurant's audit log.
- **Subscriptions**, **Plans** (prices, limits, features, Razorpay plan ids), **Webhooks** (what
  Razorpay sent; a failed one can be reprocessed) and the **Audit log**.

A platform admin who loses their phone can't pass the second factor. Remove their authenticator in
the Supabase SQL editor, and they enrol again on the next login:

```sql
delete from auth.mfa_factors
where user_id = (select id from auth.users where email = 'admin@example.com');
```

To make someone a platform admin, create their login in Supabase Auth, then
`insert into public.platform_admins (user_id) select id from auth.users where email = '…';`.

### Menu import

Menu → **Import menu** (owners and managers; platform admins from a restaurant's page) turns a
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

With neither key set, the Import menu page offers CSV only. A page costs about ₹0.30 with the
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

Then, in `/super` → **Plans**, press **Create … plan in Razorpay** for each plan and cycle to sell.
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

The setup fee a payment link suggests is `platform_settings.setup_fee_paise` (₹1,499 by default;
change it in the SQL editor).

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
With a real key it emails the addresses in your local database.

### Admin panel

Owners and managers set the restaurant up at `/admin`:

- **Menu**: categories and dishes (drag to reorder), Half/Full style options, photos, in-stock
  switch, suggested category sets, and importing a menu from photos or a CSV file.
- **Tables & QR**: add tables one at a time or as a range (`1-20`), download a table's QR code,
  print A4 sheets of QR cards. QR codes open `NEXT_PUBLIC_APP_URL`, so set it to the real domain
  before printing cards for customers.
- **Waiters**: waiter profiles (no login needed), on/off duty, optional linked login.
- **Staff logins**: logins for managers, waiters and kitchen staff; password resets.
- **Settings**: restaurant details and logo, tax and charges, bill options, ordering rules.

## Scripts

| Script                   | What it does                                  |
| ------------------------ | --------------------------------------------- |
| `pnpm dev`               | Next.js dev server on http://localhost:3000   |
| `pnpm build`             | Production build                              |
| `pnpm lint`              | ESLint                                        |
| `pnpm typecheck`         | Route type generation + `tsc --noEmit`        |
| `pnpm format`            | Prettier (write)                              |
| `pnpm test`              | Unit tests (Vitest)                           |
| `pnpm e2e`               | End-to-end tests (Playwright)                 |
| `pnpm db:start`          | Start local Supabase                          |
| `pnpm db:stop`           | Stop local Supabase                           |
| `pnpm db:reset`          | Recreate local DB from migrations + seed      |
| `pnpm db:test`           | Database tests (pgTAP via `supabase test db`) |
| `pnpm db:types`          | Regenerate `src/types/database.ts`            |
| `pnpm create-restaurant` | Onboard a restaurant + owner login            |
| `pnpm razorpay:event`    | Send a signed Razorpay webhook to the app     |
