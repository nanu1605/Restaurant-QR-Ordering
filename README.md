# DineFlow

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
| Platform admin | Email `super@local.test`                      | `/super` |
| Owner          | Email `owner@local.test`, or `demo` / `owner` | `/admin` |
| Manager        | Restaurant code `demo`, username `manager`    | `/admin` |
| Waiter (Ravi)  | `demo` / `waiter1`                            | `/staff` |
| Kitchen        | `demo` / `kitchen1`                           | `/staff` |

Add another restaurant (it starts with the default menu categories for its cuisine: `north_indian`
by default, or `south_indian`, `cafe`, `fast_food`, `bakery`, `multi_cuisine`, `blank`):

```bash
pnpm create-restaurant --name "Sharma Dhaba" --slug sharma-dhaba --owner-name "Vikram Sharma" --owner-username vikram --owner-password "choose-a-password" --cuisine north_indian
```

### Customer ordering

Each table's QR code opens `/t/<qr token>`. The demo tables use fixed tokens, so
http://localhost:3000/t/DEMO0000TABLE001 is table 1 (…002 to …006 for tables 2–6). Customers
browse the menu, add dishes (with options and notes), place the order and follow it on "Your
table's orders", where they can cancel their own dishes for a short time. The demo restaurant asks
staff to confirm a table's first order, so new orders show as waiting until Phase 4's staff
screens (or Studio) approve them. Each phone gets a signed device cookie, which is why
`CUSTOMER_COOKIE_SECRET` is required.

### Admin panel

Owners and managers set the restaurant up at `/admin`:

- **Menu**: categories and dishes (drag to reorder), Half/Full style options, photos, in-stock
  switch, suggested category sets.
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
