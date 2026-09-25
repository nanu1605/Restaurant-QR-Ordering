# Running a pilot

Phases 0–6 are the pilot milestone (spec §19): enough to run a real restaurant for free. Phase 7
adds the super-admin panel. This is what works, what a pilot still needs from you, and how a pilot
day goes.

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
  (tax, charges, bill options, ordering rules, business-day start, timezone). The menu can be
  imported from photos of the printed menu, a PDF or a CSV file, checked before it is added.
- **Plans** gate features already (Starter / Growth / Pro), and a lapsed subscription turns the
  restaurant read-only without losing data.
- **You** run the platform from `/super` (with an authenticator app): onboard restaurants, extend
  trials, change plans, record payments received by bank transfer or UPI, suspend a restaurant,
  look at its menu, tables, live board and Total orders read-only, edit the plans and read the
  audit log.

## What a pilot does not have yet

| Missing                                                  | Phase | What to do meanwhile                              |
| -------------------------------------------------------- | ----- | ------------------------------------------------- |
| Charging for MenuMesh (built; needs your Razorpay setup) | 8     | Pilots are free; no payment details are collected |
| Hindi customer screens, service requests, offline polish | 9     | English only for now                              |
| Staging and production deployment, Sentry, backups       | 10    | Deploy before the first guest scans a code        |

## Human tasks (only you can do these)

Before the first pilot:

- [x] Choose the product name and buy the domains: MenuMesh, on `menumesh.app`, `menumesh.co` and
      `menumesh.in`.
- [x] Pick the app's domain: `menumesh.in`.
- [ ] At deploy, serve the app on `https://menumesh.in` (`NEXT_PUBLIC_APP_URL`, and
      `STAFF_EMAIL_DOMAIN=menumesh.in` in production) and redirect `www.menumesh.in`,
      `menumesh.app` and `menumesh.co` to it. **QR codes carry this URL, so print them only
      once it is live.**
- [ ] Create the Supabase projects (staging and production, Mumbai region, paid plan for
      production) and a Vercel project, with separate keys everywhere.
- [ ] Set up Sentry, PostHog and Resend (verified sending domain) for the deployed app.
- [ ] Buy or borrow an 80 mm and a 58 mm thermal printer and print a test bill from the browser.
- [ ] Design and print the QR standees for each table.
- [ ] Ask a CA about GST registration for the SaaS business, and about the tax defaults shown to
      restaurants.
- [ ] Write the Terms of Service and Privacy Policy (India's DPDP Act).
- [ ] Recruit 2–3 pilot restaurants.
- [ ] For menu import from photos: create a Command Code API key (Command Code Studio) and,
      as the fallback, an OpenRouter key, each with a monthly spend limit, and set them in Vercel
      (`MENU_IMPORT_API_KEY`, `MENU_IMPORT_FALLBACK_API_KEY`). Set `CRON_SECRET` (a long random
      string) so the daily photo cleanup runs. Without the keys, menus import from CSV only.
- [ ] Make yourself a platform admin on production (a login, then one row in `platform_admins`, in
      the Supabase SQL editor) and enrol an authenticator app on the first visit to `/super`.

Before charging anyone (Phase 8):

- [ ] Razorpay account, KYC with a registered business, bank account, GST details in the Razorpay
      dashboard (Razorpay's receipts carry them), test and live keys, and the webhook URL and secret.
- [ ] With the test keys in `.env.local`: create the Razorpay plans from `/super` → Plans, then
      subscribe as a test restaurant's owner with a test card and try "Charge this now" (success
      and failure) in the Razorpay dashboard.
- [ ] Register the webhook `https://menumesh.in/api/webhooks/razorpay` for the `subscription.*`
      and `payment_link.paid` events, and set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and
      `RAZORPAY_WEBHOOK_SECRET` in Vercel (test keys on staging, live keys on production).
- [ ] Check in test mode whether yearly Pro (₹17,990, above the ₹15,000 e-mandate limit) renews
      without asking the owner to approve it each year.
- [ ] Decide the setup fee (₹1,499 by default: `platform_settings.setup_fee_paise`, in the SQL
      editor).
- [ ] Verify `menumesh.in` as a Resend sending domain and set `RESEND_API_KEY` and `EMAIL_FROM`
      (e.g. `MenuMesh <billing@menumesh.in>`) in Vercel, with `CRON_SECRET`, so reminder emails go
      out from the daily cron.

## Setting a restaurant up

1. Deploy the app and point `NEXT_PUBLIC_APP_URL` at the real domain.
2. Onboard the restaurant at `/super` → Onboard restaurant: details, owner login, tax defaults,
   plan and trial length. Copy the login details from the last step and give them to the owner.
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
