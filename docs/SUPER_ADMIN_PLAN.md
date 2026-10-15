# Super-admin panel redesign: Phases 12 to 14

Plan for Claude Code, written 2026-10-14 from the project owner's request: rebuild the super-admin panel's UI and UX, and add everything the MenuMesh team needs to know (sales and revenue graphs, which restaurants have paid, who owes money, who is about to leave, where customers come from, whether anything is broken).

It builds on docs/SPEC.md. §13.4 of the spec describes today's super-admin panel; everything listed there keeps working and moves into the new design.

"Project owner" in this file means Tanishq. "Restaurant owner" means the `owner` role inside a restaurant.

---

## 0. How to use this plan

1. Read this whole file, then docs/SPEC.md §0 (working rules, all still apply), §9 (security), §13.4 (current super-admin panel), §14 (subscriptions), §16 (design), §24, and docs/DECISIONS.md for the brand refresh (B1 to B4).
2. Work stop by stop, in order (12a, 12b, … 14e). For each stop: show the project owner a task plan first, use one branch and one PR, get every test green, update PROJECT_STATE.md, then stop for the project owner's review. A standing go to merge on green applies only if the project owner gives it for this phase.
3. In the first PR: commit this file, and add §25 to docs/SPEC.md as a short table of the stops pointing here (like §24). SPEC.md is excluded from Prettier; this file is not.
4. Log every decision this plan leaves open in docs/DECISIONS.md with an `SA-` number.
5. Keep existing behaviour and URLs working. Moved pages redirect. Existing e2e tests keep passing: update selectors where markup changes, never drop coverage.
6. Nothing here blocks the website Release. Stop 12b should reach production as soon as the project owner approves, because the charts depend on the history it starts collecting. Other stops follow the usual staging, review, Release flow.
7. Synthetic data is local only (§4.6). Nothing writes test data to staging or production.

---

## 1. Goals and principles

Every section answers a question the MenuMesh team asks every day:

| Question                                     | Answered by                                   |
| -------------------------------------------- | --------------------------------------------- |
| How much money did we make, and who owes us? | Home, Money (Payments, Dues, Revenue)         |
| Are restaurants actually using MenuMesh?     | Usage, health, each restaurant's page         |
| Who is about to leave, and who is stuck?     | Needs attention, health, onboarding checklist |
| Where do new customers come from?            | Leads, Funnel                                 |
| Is anything broken?                          | System health, webhooks, Needs attention      |
| Who did what?                                | Activity timelines, audit log                 |

Principles:

- **Two kinds of money, never mixed.** MenuMesh revenue is what restaurants pay MenuMesh. GMV is what diners paid restaurants on MenuMesh bills. They never share a chart or a total. Revenue charts always use `--chart-1` and GMV charts always use `--chart-2`, so the two read differently everywhere.
- **Revenue excludes GST** unless labelled "incl. GST". MRR always excludes GST. The payments ledger shows amount, GST and total as separate columns.
- **GMV includes the restaurants' own taxes** (it is what diners paid) and is labelled that way.
- **Time.** Restaurant activity (orders, GMV, bills) uses each restaurant's business day, summed, exactly like the admin panel's reports (`private.business_day_start`, `private.business_day_bounds`). MenuMesh money, signups and leads use IST calendar dates and months.
- **Every number is a link** to the rows behind it.
- **Small numbers stay honest.** A percentage always shows its fraction ("2 of 3, 67%"). With fewer than 5 in the denominator, show the fraction only. Never extrapolate.
- **Empty states say when data starts**, for example "MRR history starts on 15 Oct 2026, when daily snapshots began."
- **Indian number formatting**: ₹1,23,456.00 in tables, compact lakh and crore on chart axes (₹1.2 L, ₹3.4 Cr).
- **Accessible like the rest of the app**: WCAG 2.2 AA (axe sweep in both themes), keyboard reachable, every chart has a "Show as table" toggle, no chart animation, reduced motion respected.
- **Desktop first** (1280 px and up) and denser than the restaurant panels, but Home, Dues and a restaurant's page must read well at 360 px, because the project owner checks numbers on the phone. Wide tables scroll inside `ScrollRegion`.
- **Design**: follow docs/SPEC.md §16 and the brand refresh (logo-orange buttons with ink text, warm neutrals, dark mode). Avoid the generic SaaS card grid: key numbers sit in one compact strip, the Needs attention list is the one prominent element on Home, and charts stay quiet. Tabular numerals for every figure. Status badges always pair colour with an icon and words.
- **Speed**: every page server-renders in under 1.5 s with 500 restaurants and two years of data (checked with the local load data). Charts are lazy-loaded so `/super` stays inside the panels bundle budget.

---

## 2. Navigation and routes

Grouped sidebar (fixed from `lg`, the existing sheet below that). Top bar: search (Ctrl+K), date range on analytics pages, alerts bell, theme, account menu.

| Group       | Page                          | Route                                                      | Stop |
| ----------- | ----------------------------- | ---------------------------------------------------------- | ---- |
|             | Home                          | `/super`                                                   | 12e  |
| Money       | Payments                      | `/super/money/payments`                                    | 12c  |
|             | Dues                          | `/super/money/dues`                                        | 12c  |
|             | Subscriptions (existing list) | `/super/money/subscriptions` (from `/super/subscriptions`) | 12c  |
|             | Revenue                       | `/super/money/revenue`                                     | 13f  |
| Restaurants | Restaurants                   | `/super/restaurants`                                       | 12d  |
|             | Support inbox                 | `/super/support`                                           | 13b  |
|             | Standees                      | `/super/standees`                                          | 14c  |
| Growth      | Leads                         | `/super/leads`                                             | 13d  |
|             | Funnel                        | `/super/funnel`                                            | 13d  |
| Insights    | Usage                         | `/super/usage`                                             | 13e  |
| Finance     | Invoices and GST              | `/super/finance`                                           | 14a  |
|             | Reconciliation                | `/super/finance/reconciliation`                            | 14a  |
|             | Costs                         | `/super/finance/costs`                                     | 14a  |
| System      | Health                        | `/super/system`                                            | 14d  |
|             | Webhooks (existing)           | `/super/webhooks`                                          | —    |
| Settings    | Platform settings             | `/super/settings`                                          | 12a  |
|             | Team                          | `/super/settings/team`                                     | 13g  |
|             | Plans (existing)              | `/super/plans`                                             | —    |
|             | Offers                        | `/super/settings/offers`                                   | 14b  |
|             | Announcements                 | `/super/settings/announcements`                            | 14c  |
|             | Audit log (existing)          | `/super/audit`                                             | —    |

A group appears in the sidebar once its first page exists. From 13g, pages a team member's role cannot open are hidden.

A restaurant's page (13a): `/super/restaurants/[restaurantId]` with tabs Overview, Billing, Usage, Activity, Notes, Documents, Support view (existing `/support/[section]`) and Menu imports (existing).

---

## 3. Permissions

Built in 12a, roles added in 13g.

- One check for every platform function and page: SQL `private.require_platform_permission(p_permission text)` returning `private.platform_admin_context` (it wraps `private.current_platform_admin()`, so the MFA rules stay), and TS `requirePlatformPermission(permission)` wrapping `requirePlatformAdmin()`.
- Until 13g every platform admin holds every permission. 12a switches all existing platform functions and pages to these checks, so 13g only adds roles.

| Permission            | Allows                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `restaurants.view`    | Restaurants list and pages, subscription state and paid-till, search, support view                |
| `restaurants.manage`  | Onboard, suspend and unsuspend, extend trial, change plan, notes, tags, account manager, standees |
| `restaurants.support` | Support inbox, support sessions, reset a restaurant owner's password, menu import                 |
| `restaurants.close`   | Export a restaurant's data, close accounts                                                        |
| `money.view`          | Money numbers on Home, Payments, Dues, Revenue, Finance, lifetime-paid amounts                    |
| `money.record`        | Manual payments, payment links, cancel autopay, refunds, credits, free days                       |
| `growth.manage`       | Leads, Funnel, abandoned signups                                                                  |
| `insights.view`       | Usage                                                                                             |
| `settings.manage`     | Platform settings, plans, offers, overrides, announcements, webhook reprocess                     |
| `team.manage`         | Team members and roles                                                                            |
| `system.view`         | System health, webhooks list                                                                      |
| `audit.view`          | Audit log                                                                                         |

Roles (13g): **Admin** has everything. **Finance**: restaurants.view, money.view, money.record, audit.view. **Sales**: restaurants.view, restaurants.manage, growth.manage, insights.view. **Support**: restaurants.view, restaurants.support, insights.view, system.view.

---

## 4. Data foundations (stop 12b)

### 4.1 Daily snapshots

Three tables, RLS on, readable by platform admins, written only by the snapshot function.

**`metrics_subscription_daily`**: one row per restaurant per IST date, the state at snapshot time. This cannot be rebuilt later: its history starts the day 12b reaches production.

| Column                                               | Notes                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `day`, `restaurant_id`                               | primary key                                                    |
| `state`                                              | §5.1                                                           |
| `plan_id`, `billing_cycle`, `source`                 |                                                                |
| `mrr_paise`                                          | the restaurant's contribution to MRR (§5.2), 0 when not paying |
| `cancel_at_period_end`, `autopay`                    |                                                                |
| `trial_ends_at`, `current_period_end`, `grace_until` |                                                                |
| `health`                                             | §5.11, filled from 12d                                         |

**`metrics_usage_daily`**: one row per restaurant per business day. Rebuildable: backfilled from the first order, and every run upserts the last 3 business days of every restaurant (late orders, voids). The current business day is computed live and never stored until it ends.

| Column                                                                     | Notes                                       |
| -------------------------------------------------------------------------- | ------------------------------------------- |
| `restaurant_id`, `business_day`                                            | primary key                                 |
| `orders`                                                                   | accepted orders (rounds)                    |
| `customer_orders`, `staff_orders`                                          | by `orders.placed_via`                      |
| `items`                                                                    | quantities, excluding cancelled and removed |
| `sessions_billed`, `avg_session_minutes`                                   |                                             |
| `bills`, `gmv_paise`, `discount_paise`, `tax_paise`                        | active (not void) bills                     |
| `paid_cash_paise`, `paid_upi_paise`, `paid_card_paise`, `paid_other_paise` | bill payments, not void                     |
| `service_requests`                                                         |                                             |
| `hourly_orders`                                                            | 24 integers, accepted orders by IST hour    |

**`metrics_platform_daily`**: one row per IST date, for numbers that would otherwise be lost.

| Column                                 | Notes                                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `day`                                  | primary key                                                                                   |
| `signups_started`, `signups_verified`  | counted from `site_signups`, whose rows are deleted after 7 days                              |
| `signups_completed`                    | restaurants created through signup                                                            |
| `restaurants_onboarded`                | created by the team through the onboarding wizard                                             |
| `leads_created`                        |                                                                                               |
| `website_visitors`, `pricing_visitors` | from PostHog when `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID` are set, otherwise null |

**Snapshot job**: `platform_metrics_snapshot(p_day date)` (service role only, idempotent upserts), called by `/api/cron/daily` as its own `step()`, **before** `site_signups_cleanup`. The cron runs at 03:00 IST, and the state it records counts as the end of the previous IST day (log as an SA decision).

**Backfill**: `platform_metrics_backfill_usage(p_from date, p_to date)` (service role only) plus a `pnpm metrics:backfill` script. RUNBOOK: run once per environment after the migration.

**Cron log**: table `cron_runs` (job, step, started_at, finished_at, ok, detail). The daily job records every step. Home shows failures from 12e; the System page comes in 14d.

### 4.2 Payments: purpose and GST split

On `subscription_payments`:

- `purpose`: `subscription` or `setup_fee`. Backfill: notes `Setup fee` means setup_fee, everything else is subscription.
- `gst_bps`, `base_paise`, `gst_paise`, with a check that base plus GST equals `amount_paise`. Amounts stay what the restaurant paid, GST included. `base = round(amount × 10000 / (10000 + gst_bps))`, `gst = amount − base`.
- `list_price_paise`, `discount_paise` for setup fees, copied from the payment link's notes, so launch-offer use is countable.
- Every insert path sets them (Razorpay `subscription.charged`, `payment_link.paid`, manual payments), using one SQL source for the rate, `private.fee_gst_bps()` returning 1800. A test checks it equals `FEE_GST_BPS` in `src/features/subscriptions/gst.ts`. Backfill existing rows at 18%.
- The manual payment dialog shows the split live; the team enters the total received.

### 4.3 New tracking (start collecting now)

- **Acquisition channel**: `restaurants.acquisition_channel` (website, website_lead, field_visit, referral, phone, whatsapp, social, other, or null for unknown). Set by signup (website, or website_lead when the phone matches a lead) and by a new required question in the onboarding wizard ("How did they find MenuMesh?"). Editable later. Backfill: `signup_source` present means website.
- **Plan-limit hits**: table `plan_limit_events` (restaurant, kind tables, staff or feature, feature key, user, time). Record from the server actions that receive `PLAN_LIMIT_TABLES`, `PLAN_LIMIT_STAFF` or `FEATURE_NOT_IN_PLAN`, not inside the SQL function: the raise rolls back any insert in the same transaction.
- **QR downloads**: audit rows `tables.qr_downloaded` and `tables.qr_sheet_printed` when a restaurant owner downloads a QR code or opens the print sheet.
- **Cancellation reason**: when a restaurant owner turns off autopay or cancels, ask why (Too expensive, Not using it enough, Missing a feature, Restaurant closing, Moving to another system, Other with text). Store on `restaurant_subscriptions` and in the audit row.

### 4.4 Shared definitions

Write each definition in §5 once, as a SQL function used by every page and by the snapshot. `platform_overview` switches to the shared functions so numbers never disagree. pgTAP covers every edge listed in §5.

### 4.5 Activity stream

`platform_activity(p_restaurant_id, p_kinds, p_before, p_limit)`, built in 12e and extended in later stops. One newest-first stream merged from: restaurants created (signup or team), subscription state changes (from snapshot transitions and audit rows), payments, reminders sent (`subscription_reminders`), leads, support requests, notes, menu imports and platform audit rows. Each item has a time, kind, restaurant, title, detail, amount, actor and link. Cursor pagination.

### 4.6 Local load data

`pnpm seed:platform-load`: local only, refuses to run unless the Supabase URL is the local stack. Creates about 300 synthetic restaurants with 18 months of orders, bills, trials, subscriptions, payments, failed payments, churn, leads and signups, with daily snapshots generated for that history. Used for performance checks, chart development and the screenshots for each review.

---

## 5. Definitions

### 5.1 Subscription state

First match wins. `platform_overview` already uses this order; move it into one function used everywhere.

| State          | Rule                                                        | Badge colour (semantic alias of existing tokens) |
| -------------- | ----------------------------------------------------------- | ------------------------------------------------ |
| Suspended      | `restaurants.status = 'suspended'`                          | `--status-void`                                  |
| Read-only      | `restaurant_access().state = 'read_only'`                   | `--status-placed`                                |
| Trial          | subscription status `trialing`                              | `--status-ready`                                 |
| Payment failed | status `past_due` or `halted` (still full access, in grace) | `--status-preparing`                             |
| Paid           | status `active` and `source` not null                       | `--status-served`                                |
| Cancelled      | anything else                                               | muted                                            |

"Ending" is a modifier on Paid (cancel at period end, or autopay off): the badge reads "Paid, ends 12 Nov". Add aliases such as `--sub-paid` in both themes and check contrast.

### 5.2 MRR, ARR, ARPU

- MRR = sum of `private.monthly_paise(plan, billing_cycle)` over Paid restaurants that are active and have full access (today's `platform_overview` rule, moved into `private.restaurant_mrr_paise(restaurant_id)`). It excludes GST, setup fees and one-off payment links. From 14b it uses the effective (discounted or custom) price.
- ARR = MRR × 12. ARPU = MRR ÷ Paid restaurants.

### 5.3 MRR movement

For a period, compare each restaurant's consecutive daily snapshot values (a missing day uses the previous one):

| Movement     | Change                             |
| ------------ | ---------------------------------- |
| New          | 0 to x, and no earlier day above 0 |
| Reactivation | 0 to x, and an earlier day above 0 |
| Expansion    | x to y, where y > x > 0            |
| Contraction  | x to y, where 0 < y < x            |
| Churn        | x to 0, where x > 0                |

Net new MRR = new + reactivation + expansion − contraction − churn, which must equal MRR at the end minus MRR at the start. Test this identity on fixtures and on the load data.

### 5.4 Cash collected

Payments by IST date: base, GST and total, split by purpose (subscription, setup fee) and by method (autopay, payment link, bank transfer, cash, UPI, cheque). Cash differs from MRR because yearly plans pay twelve months at once. From 14a, refunds are subtracted and shown separately.

### 5.5 Paid till and lifetime paid

- Paid till: `current_period_end` for Paid and Payment failed restaurants. Trial restaurants show "Trial till" with `trial_ends_at`.
- Lifetime paid: sum of `base_paise`, by purpose, with GST in a tooltip. Needs `money.view`.

### 5.6 Dues

Each restaurant appears in at most one bucket, in this order:

1. **Payment failed**: status `past_due` or `halted`. Shows grace end, days left, amount due incl. GST, and Razorpay's retry status.
2. **Lapsed**: read-only for non-payment, either a trial that ended unpaid or a paid period that ended. Shows days since and the last plan.
3. **Trial ending**: trial ends within 3 days with no autopay mandate.
4. **Renewal due**: paid period ends within 30 days (filter 7 or 30), split into On autopay (expected), Needs a payment (manual and payment-link restaurants, which never renew on their own), and Ending (cancel at period end or autopay off).

Expected collections for the next 30 days = autopay renewals plus needs-a-payment renewals at plan price incl. GST, shown as two separate figures.

### 5.7 Trial conversion

Cohort by the month the restaurant was created (its trial start). Converted = first subscription payment within trial end plus 30 days. Days to convert = first payment minus creation.

### 5.8 Churn

- Restaurant churn for a month = restaurants with a Churn movement in the month ÷ Paid restaurants on the month's first day.
- Revenue churn = (churn + contraction MRR) ÷ MRR on the month's first day.

### 5.9 Failed-payment recovery

Of restaurants entering Payment failed in the period (from snapshot transitions), the share that reached Paid again before going Read-only.

### 5.10 Usage and GMV

From `metrics_usage_daily`, plus the live current business day.

- GMV = active bills' grand totals, including the restaurants' taxes. Bills = active bills. Average bill = GMV ÷ bills.
- Orders = accepted orders (rounds). QR adoption = customer orders ÷ (customer + staff orders).
- "Today" on Home = each restaurant's current business day, summed, as its own dashboard shows it.
- Heatmap = accepted orders by IST weekday and hour.

### 5.11 Health

Per restaurant, computed live and stored daily from 12d. First match wins. Thresholds are platform settings (a Health group on the settings screen in 12d).

| Health        | Rule                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Setting up    | created less than 14 days ago, no accepted order yet                                                                        |
| Never started | created 14 or more days ago, no accepted order ever                                                                         |
| Inactive      | no accepted order in the last 7 days                                                                                        |
| Slowing       | orders in the last 7 days below 50% of the weekly average over the 4 weeks before, with at least 10 orders in those 4 weeks |
| Active        | everything else                                                                                                             |

Suspended and read-only restaurants still get a health value, shown muted.

### 5.12 Last active

The latest of: last accepted order, last bill, last sign-in by any of the restaurant's logins (`auth.users.last_sign_in_at`).

### 5.13 Onboarding checklist

In order:

1. Menu added (at least 5 active items)
2. Tables created (at least 1 active table)
3. QR codes downloaded or printed (§4.3; from 14c a delivered standee also counts)
4. Team added (a staff login other than the restaurant owner, or a waiter profile)
5. First QR order (an accepted customer order)
6. First bill
7. Paid (first subscription payment) or autopay set up

Stuck = the next step is not done and no step was completed in the last 3 days. Steps shared with the restaurant owner's first-steps card (`src/features/dashboard/components/first-steps.tsx`) use the same rules: move the rules into one SQL function used by both panels, keeping the owner card's steps and wording as they are.

### 5.14 Funnel

For a date range (IST, by event date): Website visitors (PostHog, optional) → Demo requests and signups started → Email verified → Restaurant created (signup, with team-onboarded restaurants as a separate entry) → First order → First payment. The last two steps are a cohort by creation date. Conversion is shown between consecutive steps.

Attribution by `acquisition_channel`, and for website arrivals by `utm_source` and referrer from `restaurants.signup_source` and `site_leads.source`.

---

## 6. Phases at a glance

| Phase                      | Stop | Ships                                                                                             |
| -------------------------- | ---- | ------------------------------------------------------------------------------------------------- |
| 12. Launch essentials      | 12a  | New shell and navigation, shared components, permission layer, Platform settings screen           |
|                            | 12b  | Daily snapshots, payment GST split and purpose, new tracking, cron log, backfill, local load data |
|                            | 12c  | Money: Payments ledger, Dues, Subscriptions moved                                                 |
|                            | 12d  | Restaurants list rebuilt (paid till, health, last active, GMV, saved views), global search        |
|                            | 12e  | Home: key numbers, Needs attention, charts, activity feed, live alerts, daily digest email        |
| 13. Growth and success     | 13a  | Restaurant page with tabs, activity timeline, notes, tags, account manager                        |
|                            | 13b  | Onboarding checklist, Support inbox, Get help in the admin panel                                  |
|                            | 13c  | Assisted setup: support sessions with the restaurant owner's consent                              |
|                            | 13d  | Leads pipeline, Funnel, attribution, abandoned signups, upgrade opportunities                     |
|                            | 13e  | Usage analytics                                                                                   |
|                            | 13f  | Revenue analytics                                                                                 |
|                            | 13g  | Team and roles                                                                                    |
| 14. Finance and operations | 14a  | Invoices and GST, refunds and credits, Razorpay reconciliation, costs                             |
|                            | 14b  | Offers, custom prices, per-restaurant overrides, beta flags                                       |
|                            | 14c  | Announcements, standee tracker                                                                    |
|                            | 14d  | System health                                                                                     |
|                            | 14e  | Close account: data export and deletion                                                           |

Phase 12 is what the team needs at launch. Phase 13 matters as restaurants grow; move 13g earlier if team members join before then. Phase 14a needs the CA's answers first.

---

## 7. Phase 12: launch essentials

### 12a. Shell and foundations

Lean scope approved on 2026-10-14 (docs/DECISIONS.md SA-1): the shared components below are built in the stop that first uses them (12c, 12e), and existing platform functions switch to the permission check in 13g.

Ships:

- New super-admin layout: grouped sidebar (§2), top bar with space for search, date range and alerts (wired up in later stops), breadcrumbs on deep pages. Existing pages move into the shell unchanged; old URLs redirect.
- Shared components, used by every later stop:
  - **Key numbers strip**: value, change against the previous period (arrow plus words for screen readers), optional fraction, link.
  - **Chart panel**: title, one-line description, period, empty state with "data since", Show as table, CSV download. Recharts, lazy-loaded.
  - **Date range**: Today, Yesterday, Last 7 days, Last 30 days, This month, Last month, This quarter, Last 12 months, Custom, plus "Compare with previous period". Kept in the URL (`from`, `to`, `compare`) so a view can be shared.
  - **Data table**: sortable headers, filter bar, column chooser, sticky header, the existing `Pager`, CSV export of the filtered rows (reuse `src/features/reports/csv.ts`, which escapes formulas), and a slot for saved views (12d).
  - **Subscription badge** (§5.1) and **health badge** (§5.11): icon plus text, both themes, contrast-checked.
  - Sparkline, heatmap, funnel chart and timeline: built when first needed, in one shared style.
  - `formatInrCompact` for chart axes.
- Permission layer (§3), with every existing platform function and page switched over.
- **Platform settings** (`/super/settings`, settings.manage): trial days, grace days, setup fee, setup fee discount with an optional end date (new column `setup_fee_discount_ends_at`; once passed, the pricing page and new payment links stop applying it), support phone and email. Every change is audited with before and after values. Update the RUNBOOK: ending the launch offer no longer needs SQL.

Acceptance:

- Every existing `/super` page works in the new shell at 1280, 768 and 360 px; old URLs redirect; the existing super-admin e2e suite passes.
- A non-admin still gets FORBIDDEN and an admin without a second factor still gets MFA_REQUIRED from every platform function (pgTAP).
- Ending the launch offer from the settings screen changes `/pricing` and the next setup-fee payment link, and writes an audit row.
- Contrast sweep and bundle budget pass.

### 12b. Data foundations

Ships: everything in §4.1 to §4.4 and §4.6, the SQL definitions §5.1, §5.2, §5.5 and §5.10 (health and dues arrive with their stops), the restaurant owner's cancellation-reason prompt, the acquisition-channel question in the onboarding wizard, QR download tracking, plan-limit events, and RUNBOOK steps. No new super-admin pages: one line under MRR on the current overview says when history starts.

Acceptance:

- Running the daily job twice for the same day changes nothing. The snapshot runs before the signup cleanup. A failing step is recorded in `cron_runs` and does not stop the others.
- Backfilled usage matches the admin panel's own reports for the same restaurant and dates (test).
- Every payment insert path stores purpose and the GST split; base plus GST equals the amount; the SQL rate equals `FEE_GST_BPS` (test).
- A restaurant owner cannot turn off autopay without choosing a reason, and the reason is in the audit log.
- Human: the project owner approves releasing 12b to production promptly.

### 12c. Money: Payments and Dues

Ships:

- **Payments** (`/super/money/payments`, money.view): the ledger (§4.2, §5.4). Columns: date, restaurant, purpose, plan and cycle, amount, GST, total, method, Razorpay payment ID (copy button), period covered, recorded by, notes. Filters: period, restaurant, purpose, method, plan. A totals row for the filtered rows. CSV export. A row opens the restaurant's Billing tab (its current page until 13a).
- **Dues** (`/super/money/dues`): the buckets from §5.6 as tabs with counts. Each row shows the restaurant, the restaurant owner's phone with Call and WhatsApp buttons, state badge, dates, amount due incl. GST and the last reminder sent. Actions, all existing: Send payment link and Record payment (money.record), Extend trial (restaurants.manage). Expected collections for the next 30 days at the top.
- WhatsApp opens `https://wa.me/91<phone>?text=…` with an editable message for the bucket, in English or Hindi. Message templates live in code for now.
- The Subscriptions list moves to `/super/money/subscriptions` (old URL redirects), with the new state badges.

Acceptance:

- With fixtures, a restaurant in each bucket appears in exactly one bucket. The totals row equals the sum of the rows. The CSV equals the screen. No figure mixes GST unless labelled.
- Payments and Dues read well at 360 px (rows stack).

### 12d. Restaurants list and global search

Ships:

- The Restaurants list rebuilt on the data table. Columns: name and city, state badge, plan, paid till, lifetime paid (money.view only), GMV for the last 30 days, a 7-day orders sparkline, health, last active, the restaurant owner's phone (Call and WhatsApp), acquisition channel, created. Tags and account manager arrive in 13a.
- Health (§5.11) as a SQL function, stored in the daily snapshot from this stop, with a Health group on the settings screen for the thresholds.
- Filters: subscription state, plan, health, city, Indian state, acquisition channel, created range, paid-till range.
- **Saved views**: built-in ones (Payment failed, Trial ending, Lapsed, No orders in 7 days, Never started, Slowing, Paid) plus personal and shared views (table `platform_saved_views`: owner, page, name, query, shared).
- **Global search** (Ctrl+K, and a search button for touch screens): restaurants by name, code, city, the restaurant owner's email or phone, GSTIN, FSSAI number; payments by Razorpay payment or subscription ID; leads by name, phone or restaurant name. Later stops add invoices and support requests. `platform_search(q)` with `pg_trgm` (already installed). Results grouped, keyboard navigable, with recent items.

Acceptance:

- The list renders in under 1.5 s with the local load data. Search finds a restaurant by part of a phone number and by GSTIN. Fixtures cover every health rule.

### 12e. Home

```
┌──────────────┬───────────────────────────────────────────────────────────────────────┐
│ MenuMesh     │ [Search restaurants, phones, payments  Ctrl K]    Alerts (3)  Theme   │
├──────────────┼───────────────────────────────────────────────────────────────────────┤
│ Home         │ Home                                        [Today] [This month]      │
│ Money        │ MRR ₹42,180 (+8%)  Collected ₹61,240  Paid 38  Trials 9               │
│ Restaurants  │ GMV ₹3.1 L  Orders 1,204  Open tables now 57                          │
│ Growth       │                                                                       │
│ Insights     │ Needs attention (12)                                                  │
│ Finance      │ ┌───────────────────────────────────────────────────────────────────┐ │
│ System       │ │ Payment failed (3)                                                │ │
│ Settings     │ │   Restaurant A    grace ends Fri    ₹1,060.82      [Send link]    │ │
│              │ │ Trial ends in 3 days, no autopay (2)                              │ │
│              │ │   Restaurant B    ends Thu                         [WhatsApp]     │ │
│              │ │ No orders in 7 days (4)                            [Call]         │ │
│              │ │ Leads not contacted in 24 hours (3)                [Open]         │ │
│              │ └───────────────────────────────────────────────────────────────────┘ │
│              │ MRR, 12 months    │ GMV and orders, 30 days │ New restaurants, weekly │
│              │ [line]            │ [bars and line]         │ [bars]                  │
│              │                                                                       │
│              │ Activity                                                              │
│              │ 10:42  Payment received  Restaurant A  ₹899.00 + GST ₹161.82          │
│              │ 10:15  New signup        Restaurant C, Indore                         │
└──────────────┴───────────────────────────────────────────────────────────────────────┘
```

Ships:

- **Key numbers** with a Today / This month toggle: MRR (against the same day last month), cash collected this month, Paid restaurants, trials, GMV, orders, open tables right now. Money figures need money.view.
- **Needs attention**: grouped, each item with one action:
  - Payment failed, soonest grace end first: Send payment link
  - Trial ends in 3 days with no autopay: Call or WhatsApp
  - Needs a payment within 7 days (manual or payment-link restaurants): Send payment link
  - Leads not contacted in 24 hours (from 13d; until then, leads received in the last 24 hours): Open
  - Inactive or Slowing restaurants: Call
  - Possible duplicate signups to review: Review
  - Failed webhooks and failed cron steps: Open
  - From 13b: stuck onboarding, support requests open for more than 24 hours
  - Each item can be snoozed (1 day, 3 days, 1 week) per team member (table `platform_snoozes`). Items clear themselves when resolved. The count shows as a badge on Home in the sidebar.
- **Charts** (lazy-loaded): MRR over 12 months (with the "history starts" note), GMV and orders over 30 days, new restaurants per week (signup and team-onboarded as two series).
- **Activity feed**: `platform_activity` (§4.5), filterable by kind.
- **Live alerts**: poll every 60 s while a `/super` page is visible. The alerts bell shows unread events; toasts for payment received, payment failed, new signup, new lead and (from 13b) new support request.
- **Daily digest email** at 08:45 IST (a second Vercel cron protected by `CRON_SECRET`, sent once per day, recorded in `cron_runs`): yesterday's key numbers, today's Needs attention counts, links. Sent to every platform admin until 13g adds a per-person opt-in.

Acceptance:

- Each Needs attention rule has a fixture. A snoozed item comes back after its snooze. The digest renders correctly (email preview test) and is never sent twice for the same day.

---

## 8. Phase 13: growth and customer success

### 13a. Restaurant page

Built 2026-10-14 (docs/DECISIONS.md SA-33 to SA-40). Features in use on the Usage tab arrive with 13e, which defines them; the onboarding checklist with 13b.

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Restaurants / Restaurant A                                                           │
│ Restaurant A   [Paid, ends 12 Nov]  [Active]   Growth, monthly   Paid till 12 Nov    │
│ Owner: name, +91 98xxx xxxxx [Call] [WhatsApp], email     Tags: Pilot, Indore        │
│ Account manager: Tanishq                                              [Actions]      │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Overview  Billing  Usage  Activity  Notes  Documents  Support view  Menu imports     │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Orders, 30 days 612   GMV, 30 days ₹2.4 L   Average bill ₹392   QR orders 71%        │
│ Last active 2 hours ago                                                              │
│ [orders and GMV, 90 days]                             │ Onboarding: 6 of 7 done      │
│                                                       │ Next: first payment          │
│ Pinned note: prefers calls after 4 pm                 │ Latest activity              │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Ships:

- **Header**: name, code, city, state badge, health, plan and cycle, paid till, restaurant owner (name, phone with Call and WhatsApp, email), tags, account manager, an Actions menu (all existing actions plus Send payment link and Add note).
- **Tabs**:
  - Overview: 90-day orders and GMV chart, key numbers (orders and GMV for 30 days, average bill, QR adoption, last active), onboarding checklist (from 13b), pinned and latest notes, latest activity.
  - Billing: subscription facts (existing), payments, dues state, reminders and payment links sent, plan history, cancellation reason.
  - Usage: features in use (as defined in 13e), this restaurant's weekday and hour heatmap, tables, staff and waiters against plan limits, plan-limit hits.
  - Activity: the timeline (`platform_activity` for this restaurant) with filters by kind.
  - Notes: notes with author and time; pin; edit your own note within 15 minutes; audited.
  - Documents: profile, FSSAI, GSTIN, storefront photo, possible duplicates (existing sections).
  - Support view and Menu imports (existing).
- **Tags**: `platform_tags` (name, colour from a fixed accessible set) and `restaurant_tags`. Manage inline; filter and column on the Restaurants list.
- **Account manager**: `restaurants.account_manager_user_id` (a platform admin). A built-in "My restaurants" saved view.

Acceptance:

- Every fact and action on today's detail page is still there. The timeline merges at least five kinds of item in time order with paging. The page reads well at 360 px.

### 13b. Onboarding checklist and support inbox

Built 2026-10-14 (docs/DECISIONS.md SA-41 to SA-45). The QR step's audit actions are `table.qr_downloaded` and `table.qr_sheet_printed` (SA-14); a QR order also counts.

Ships:

- **Onboarding checklist** (§5.13) on the restaurant page, and an Onboarding saved view on the Restaurants list showing the current step and a Stuck filter. The restaurant owner's first-steps card switches to the shared rules.
- **Get help** in the admin panel (account menu and Settings), for restaurant owners and managers: topic (Billing, Menu, Printing, Orders and tables, Staff, Other), message, an optional screenshot (image up to 5 MB, private bucket), preferred contact (call, WhatsApp or email), and context attached automatically (page, app version, browser, user, role). The restaurant owner sees their requests and each status.
- **Support inbox** (`/super/support`, restaurants.support): status (Open, In progress, Waiting on restaurant, Resolved), priority, assignee, age. Each request shows its context, internal notes (never shown to the restaurant) and status history. A new request emails the support address (Resend) and raises a Home alert.
- Tables: `support_requests`, `support_request_events`.

Acceptance:

- A request goes from the admin panel to the inbox to Resolved, and the restaurant owner sees each status. Screenshots are private (signed URLs). RLS: a restaurant sees only its own requests (pgTAP).

### 13c. Assisted setup (support sessions)

Built 2026-10-15 (docs/DECISIONS.md SA-46 to SA-52). A session acts as a manager membership without a `restaurant_members` row (SA-46); live service, Get help and the settings that move money are refused too (SA-49); the consent wording was approved on 2026-10-15 (SA-52).

Lets the team fix a restaurant's setup during a call, with the restaurant owner's consent.

Ships:

- **Consent**: in the admin panel, Settings, "MenuMesh support access", the restaurant owner allows access for 1, 4 or 24 hours. The page shows the active session, who has it, until when, and an End now button. The onboarding wizard can start the first session (24 hours) for a restaurant the team is setting up in person; the audit row records that consent was given during onboarding.
- **Session**: a team member with restaurants.support starts working in a restaurant that granted access. They get a temporary restaurant membership (role manager, linked to the session) and open `/admin` for that restaurant. One session per team member at a time. Support memberships never appear in the restaurant's Staff list and never count toward `max_staff`.
- Every admin-panel page shows a banner during a session: which restaurant, when it ends, End session. Sessions end on time (checked on every request, cleaned up by the daily cron).
- **Allowed**: menu (including menu import), tables and QR codes, waiters, staff logins (except changing the restaurant owner's account), restaurant profile, ordering and bill-appearance settings.
- **Refused** during a session: generating or voiding bills, payments, tax settings, the subscription. One SQL check, `private.refuse_in_support_session()`, in the relevant admin functions.
- Everything done is audited as the team member, with the session id. The restaurant owner sees "Changes made by MenuMesh support" in their activity.

Acceptance:

- Without consent, the team cannot open `/admin` for the restaurant. A session ends on time. Audit rows carry the team member and session. Refused actions return a clear message (pgTAP and e2e).

### 13d. Growth: leads, funnel, opportunities

Ships:

- **Leads** (`/super/leads`, growth.manage), as a table and a board:
  - Stages: New, Contacted, Demo scheduled, Demo done, Trial, Won, and Lost with a reason (Price, Not interested, Using another system, No response, Closed down, Other).
  - Assignee, next follow-up (date and time) with an overdue flag, demo date, notes, stage history.
  - Call and WhatsApp buttons; after either, a "Mark as contacted?" prompt.
  - A lead links to its restaurant when a signup or onboarding matches its phone (automatically), or by hand.
  - Duplicate warning when the phone matches an existing restaurant or lead.
  - Add lead by hand for field visits, calls, referrals and WhatsApp enquiries, with the source.
- **Abandoned signups**: signups started but not finished, only within their 7-day retention (rows are still deleted after 7 days). Shows contact details as collected, the step reached and when. "Add as lead" only once the privacy policy covers following up (human check).
- **Funnel** (`/super/funnel`): §5.14 for a date range, and a channel table (leads, trials, Paid, conversion, MRR from the channel).
- **Upgrade opportunities**: Starter restaurants with plan-limit hits (tables, staff or features) or heavy use. Listed on the Funnel page, optional Home alert.
- **Website visitors** from PostHog when the optional key is set; otherwise the funnel starts at demo requests and signups.

Acceptance:

- Fixtures for each funnel step. The 24-hour lead alert fires on time. Channel totals reconcile with restaurant counts.

### 13e. Usage analytics

Ships (`/super/usage`, insights.view, with date range and compare):

- Key numbers: GMV, orders, bills, average bill, items, active restaurants (at least one order in the period), QR adoption.
- Charts: GMV and orders over time (day, week, month); by city, by Indian state, by plan; top and bottom 10 restaurants by GMV and by orders, with their share of the total; weekday and hour heatmap; payment-mode share; average table time.
- **Feature adoption**: the share of active Paid restaurants using, in the period, the kitchen view, waiter assignment, UPI QR on bills, the Hindi worker panel, the Hindi customer menu, add-ons, call waiter and request bill, discounts, split payments and menu photo import. Each feature's rule (setting on, or used at least once) recorded in DECISIONS.
- Restaurants by city and by Indian state (a ranked list; a map is future work).

Acceptance:

- Totals equal the sum of `metrics_usage_daily` plus the live day, and a restaurant's figures match its own admin reports.

### 13f. Revenue analytics

Ships (`/super/money/revenue`, money.view):

- Key numbers: MRR, ARR, net new MRR, Paid restaurants, ARPU, trial conversion, restaurant and revenue churn, failed-payment recovery, expected collections for the next 30 days.
- Charts: MRR over time with movement bars (§5.3); cash collected by month, split subscription and setup fee (base, with GST shown separately); plan mix; monthly against yearly; trial cohorts (conversion by month); cancellation reasons; launch-offer use (count and total discount).
- Clicking a movement bar lists the restaurants in it with MRR before and after.

Acceptance:

- The movement identity holds for every month in fixtures and in the load data. Cohort fixtures pass. Before history exists, each chart says when it starts.

### 13g. Team and roles

Move this stop earlier if team members join before Phase 13.

Ships (`/super/settings/team`, team.manage):

- `platform_admins` gains role (admin, finance, sales, support), display name, invited by and at, disabled at, digest opt-in. Existing platform admins become Admin.
- Invite by email (Supabase invite); first sign-in sets a password, then a second factor on the existing `/super/mfa` page. Change role. Disable (ends their sessions). The last Admin cannot be disabled or demoted.
- Members list: name, email, role, second factor set up, last sign-in, invited by. Each member's activity (audit filtered by actor).
- Permissions from §3 enforced in SQL and on pages. The navigation hides what a role cannot open; search results respect permissions.

Acceptance:

- pgTAP matrix of every role against every permission-checked function. E2E: each role sees only its pages. The last-Admin guard holds.

---

## 9. Phase 14: finance and operations

### 14a. Finance and GST

Prerequisite (human): the CA's answers on GST registration and MenuMesh's GSTIN, whether MenuMesh issues its own tax invoices and their numbering, the SAC code, place of supply, how to treat restaurants without a GSTIN, and how long records must be kept. Do not start until these are recorded in DECISIONS.

Ships:

- **Invoices** for every payment: a series per financial year (for example `MM/2026-27/00001`); supplier details (MenuMesh legal name, address, GSTIN, from settings); recipient (restaurant legal name, address, state, GSTIN when present); place of supply; SAC; base; CGST and SGST for the same state, or IGST for another state; total; amount in words. Print and PDF view, emailed to the restaurant owner and downloadable from their Subscription page. Earlier payments get invoices only if the CA says so.
- **Credit notes** for refunds.
- **GST summary** by month: invoices to restaurants with a GSTIN (listing the GSTIN), totals by state for the rest, tax totals. CSV export in the columns the CA asks for.
- **Refunds and credits**: record a refund (Razorpay refund API for autopay and payment-link payments, manual otherwise) as a negative entry with a credit note. "Give free days" to a Paid restaurant: extends its period, reason required, audited, MRR unchanged.
- **Razorpay reconciliation**: a daily fetch of settlements and payment fees from the Razorpay API. Shows captured against settled, fees and net, and flags anything unmatched.
- **Costs**: menu-import AI cost (already tracked), Razorpay fees, and monthly costs entered by hand (category, month, amount). Shows gross margin by month and cost per Paid restaurant.

Acceptance:

- Invoice maths tests (same state, other state, rounding). CSV equals the screen. A reconciliation fixture with an unmatched payment.

### 14b. Offers, custom prices, overrides

Ships:

- **Offers** (`/super/settings/offers`): code, percentage or flat discount, plans and cycles it applies to, first N billing cycles, valid from and until, maximum redemptions, new restaurants only. Applied at the restaurant owner's subscribe step, or by the team for one restaurant. Verify Razorpay's current support for offers on subscriptions on this account; otherwise create a dedicated Razorpay plan for the discounted amount.
- **Custom price** for one restaurant (negotiated deals), with reason, implemented the same way.
- MRR uses the effective price (stored as the subscription's effective monthly value). Revenue pages show discount totals.
- **Per-restaurant overrides**: grant a feature, raise maximum tables or staff, with an optional expiry and a reason. `private.has_feature` and `private.plan_limits` merge the plan with overrides. Shown on the restaurant page and audited.
- **Beta flags**: feature keys that belong to no plan, switched on per restaurant (for pilots).

Acceptance:

- In Razorpay test mode, subscribing with an offer charges the discounted amount plus GST for N cycles, then the full price. An expired override restores the plan's limits (pgTAP).

### 14c. Announcements and standees

Ships:

- **Announcements** (`/super/settings/announcements`): title and text in English, optional Hindi for Hindi logins; audience (everyone, plans, cities or chosen restaurants); panels (admin, worker or both); start and end; dismissible or not; optional email to restaurant owners. Shown as a banner in the chosen panels, with dismissals per user, a preview, and audit rows.
- **Standees** (`/super/standees`): for each restaurant, the number of standees (default: active tables), status To print, Printed, Dispatched, Delivered, Installed with dates, vendor, cost and notes, linked to the setup-fee payment. Filters by status. The restaurant page shows it, and Delivered completes the QR step of the onboarding checklist.

Acceptance:

- Audience targeting fixtures. An announcement shows only between its start and end. Standee status history is audited.

### 14d. System health

Ships (`/super/system`, system.view):

- Scheduled jobs: last runs per job and step from `cron_runs`, failures and durations, and an alert when an expected run is missing.
- Webhooks: failures in the last 24 hours, linking to the existing page.
- Email: a send log (`email_log`: kind, hashed recipient, status, provider id, error) for signup codes, password resets, reminders and digests. Optional Resend webhook for bounces and complaints.
- Errors: Sentry issue count for 24 hours and the top issues, through the Sentry API (optional read-only token).
- Database and storage size against plan limits (limits entered in settings), with a warning at 80%.
- Menu import: count, failure rate and AI cost this month.
- Versions: the commit running on staging and production, from `/api/health`.
- Every failure here also appears in Home's Needs attention.

Acceptance:

- A failed cron step shows on Home and on System. A missing run is detected.

### 14e. Close account

Ships:

- **Export**: a ZIP of JSON and CSV files (profile, menu, tables, staff without secrets, waiters, orders, bills, payments, invoices), built on the server into a private bucket, with a download link valid for 24 hours. Audited. Available to the team (restaurants.close) and to the restaurant owner (Settings, Download my data).
- **Close**: confirmed by typing the restaurant code. A new restaurant status `closed`: logins disabled, autopay cancelled, read-only. A 30-day hold with a Reopen action. After the hold, personal data is removed (restaurant owner and staff names, phones, emails, auth users, storefront photo) while financial records stay for the period from 14a's CA answers.

Acceptance:

- Export contents test. A closed restaurant cannot sign in. The removal job leaves bills and invoices intact (pgTAP).

---

## 10. Payments ledger layout

```
Money / Payments                         [This month]  [Compare]          [Export CSV]
Collected ₹61,240.00 + GST ₹11,023.20 = ₹72,263.20
Subscriptions ₹57,750.00     Setup fees ₹3,490.00
[Purpose] [Method] [Plan] [Restaurant…]                         Saved view: [All payments]
┌────────┬──────────────┬─────────────────┬───────────┬─────────┬───────────┬───────────────┬───────────────────────────┐
│ Date   │ Restaurant   │ For             │ Amount    │ GST     │ Total     │ Method        │ Period                    │
├────────┼──────────────┼─────────────────┼───────────┼─────────┼───────────┼───────────────┼───────────────────────────┤
│ 14 Oct │ Restaurant A │ Growth, monthly │ ₹899.00   │ ₹161.82 │ ₹1,060.82 │ Autopay       │ 14 Oct – 13 Nov 2026      │
│ 13 Oct │ Restaurant B │ Setup fee       │ ₹499.00   │ ₹89.82  │ ₹588.82   │ Payment link  │ —                         │
│ 12 Oct │ Restaurant C │ Starter, yearly │ ₹3,990.00 │ ₹718.20 │ ₹4,708.20 │ Bank transfer │ 12 Oct 2026 – 11 Oct 2027 │
└────────┴──────────────┴─────────────────┴───────────┴─────────┴───────────┴───────────────┴───────────────────────────┘
```

---

## 11. Testing (every stop)

- **pgTAP**: every new SQL function, with fixtures for each edge in §5; permissions (FORBIDDEN, MFA_REQUIRED, and from 13g each role); idempotency of the snapshot, backfill and digest.
- **Unit**: compact INR formatting, date ranges (IST month edges, compare periods, business days), chart data shaping, CSV.
- **E2E**: every new page at 1280, 768 and 360 px; the axe contrast sweep includes the new pages in both themes; the existing super-admin suite keeps passing.
- **Performance**: server time under 1.5 s per page with the local load data (opt-in, like the site performance spec).
- **Bundle budget**: `/super` stays inside the panels budget; charts are lazy-loaded.
- **Review**: the usual reviewer and verifier pass on each PR.

---

## 12. Human tasks

- Approve releasing 12b to production early, so history starts.
- Optional: a read-only PostHog personal API key and the project ID (website visitors in the funnel).
- Optional: a read-only Sentry token, and the Supabase plan's database and storage limits (System page).
- Decide who joins the team and their roles (13g). Move 13g earlier if needed.
- Privacy policy and terms: cover the MenuMesh team viewing restaurants' usage and sales data, support sessions with consent, following up on unfinished signups (if wanted), and what happens to data after an account closes.
- ~~Approve the support-session consent wording (13c).~~ Approved 2026-10-15 (SA-52).
- The CA's answers before 14a.
- Razorpay: confirm whether offers on subscriptions are available on the account (14b).
- Choose the digest time and recipients (default below).

---

## 13. Defaults to confirm

| Topic                | Default                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health               | Active: an order in the last 3 days. Inactive: none in 7 days. Slowing: below 50% of the 4-week weekly average (at least 10 orders). Setting up: first 14 days |
| Stuck in onboarding  | No step completed in 3 days                                                                                                                                    |
| Lead follow-up alert | Not contacted within 24 hours                                                                                                                                  |
| Live updates         | Poll every 60 seconds                                                                                                                                          |
| Daily digest         | 08:45 IST to every platform admin                                                                                                                              |
| Support sessions     | 1, 4 or 24 hours, chosen by the restaurant owner; one at a time per team member                                                                                |
| MRR                  | List price without GST (effective price from 14b)                                                                                                              |
| GMV                  | Restaurants' bill totals including their taxes                                                                                                                 |
| Snapshot day         | The state at 03:00 IST counts as the end of the previous day                                                                                                   |
| Small numbers        | Fraction only when the denominator is below 5                                                                                                                  |
| Account closure      | 30-day hold, then personal data removed; financial records kept for the CA's period                                                                            |
