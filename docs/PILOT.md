# Running a pilot

Phases 0–6 are the pilot milestone (spec §19): enough to run a real restaurant for free. This is
what works, what a pilot still needs from you, and how a pilot day goes.

## What the product does today

- **Guests** scan the table QR, browse the menu, order round after round, see each dish move from
  placed to served, cancel within the window, and get the bill message when the table is billed.
  The first order of a session waits for approval when that setting is on.
- **Waiters and kitchen** work from `/staff`: the table board, the kitchen view (Growth), marking
  dishes served, adding or removing dishes, and the in-stock switch.
- **Managers and owners** work from `/admin`: live orders with waiter assignment and approvals,
  billing with discounts and service charge, printing on 80 mm or 58 mm, payments (split on
  Growth), voids with an optional table reopen, Total orders, the dashboard and the reports.
- **Setup** covers the menu, tables and QR codes, waiter profiles, staff logins and settings
  (tax, charges, bill options, ordering rules, business-day start, timezone).
- **Plans** gate features already (Starter / Growth / Pro), and a lapsed subscription turns the
  restaurant read-only without losing data.

## What a pilot does not have yet

| Missing                                                  | Phase | What to do meanwhile                              |
| -------------------------------------------------------- | ----- | ------------------------------------------------- |
| Super-admin panel and the onboarding wizard              | 7     | Onboard with `pnpm create-restaurant`             |
| Menu import from photos                                  | 7     | Type the menu in, or import a CSV later           |
| Razorpay subscriptions and invoices                      | 8     | Pilots are free; no payment details are collected |
| Hindi customer screens, service requests, offline polish | 9     | English only for now                              |
| Staging and production deployment, Sentry, backups, cron | 10    | Deploy before the first guest scans a code        |

## Human tasks (only you can do these)

Before the first pilot:

- [ ] Choose the product name and buy the domain. **QR codes carry `NEXT_PUBLIC_APP_URL`, so decide
      this before printing anything.**
- [ ] Create the Supabase projects (staging and production, Mumbai region, paid plan for
      production) and a Vercel project, with separate keys everywhere.
- [ ] Set up Sentry, PostHog and Resend (verified sending domain) for the deployed app.
- [ ] Buy or borrow an 80 mm and a 58 mm thermal printer and print a test bill from the browser.
- [ ] Design and print the QR standees for each table.
- [ ] Ask a CA about GST registration for the SaaS business, and about the tax defaults shown to
      restaurants.
- [ ] Write the Terms of Service and Privacy Policy (India's DPDP Act).
- [ ] Recruit 2–3 pilot restaurants.

Before charging anyone (Phase 8):

- [ ] Razorpay account, KYC with a registered business, bank account, GST details in the Razorpay
      dashboard, test and live keys, and the webhook URL and secret.

## Setting a restaurant up

1. Deploy the app and point `NEXT_PUBLIC_APP_URL` at the real domain.
2. Onboard the restaurant (`pnpm create-restaurant`): name, code, owner login, plan, cuisine.
3. As the owner: add the tables, print their QR codes, enter the menu, add the waiter profiles and
   the staff logins, then set the tax, charges, bill options and business-day start.
4. Print a test bill from Settings → Bill on the restaurant's own printer, with the paper size set
   in the printer driver and headers and footers turned off.
5. Walk one table through the whole flow before service: scan, order, approve, serve, bill, print,
   record payment.

## A pilot day

- **Before service:** switch the waiters on duty, check the in-stock switches, open the kitchen
  view on the kitchen tablet and Live orders at the counter.
- **During service:** approve first orders, assign waiters to tables, keep an eye on the dishes
  waiting, bill and print at the table's request.
- **After service:** check Total orders against the cash and UPI collected, then look at the
  dashboard and Reports → Sales for the day.
- **Weekly:** Reports → Dishes for what sells, Tables for turnover, Waiters for who is carrying the
  floor, and Activity for removals and discounts.

## What to ask the restaurant

- Did any guest struggle with the QR, the menu or the cancel window?
- Did the kitchen see orders in time, and did the waiters mark dishes served?
- Did the bill match what the staff expected, and did the printer behave?
- What did the owner look at the next morning?
