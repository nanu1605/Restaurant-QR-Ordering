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
