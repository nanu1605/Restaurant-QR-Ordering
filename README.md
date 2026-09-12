# tableorder

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

### Demo logins (local only)

Open http://localhost:3000/login. Every password is `Password123!`.

| Who            | Log in with                                   | Lands on |
| -------------- | --------------------------------------------- | -------- |
| Platform admin | Email `super@local.test`                      | `/super` |
| Owner          | Email `owner@local.test`, or `demo` / `owner` | `/admin` |
| Manager        | Restaurant code `demo`, username `manager`    | `/admin` |
| Waiter (Ravi)  | `demo` / `waiter1`                            | `/staff` |
| Kitchen        | `demo` / `kitchen1`                           | `/staff` |

Add another restaurant:

```bash
pnpm create-restaurant --name "Sharma Dhaba" --slug sharma-dhaba --owner-name "Vikram Sharma" --owner-username vikram --owner-password "choose-a-password"
```

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
