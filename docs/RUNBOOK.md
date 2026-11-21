# Runbook

How MenuMesh is deployed and kept running. Decisions behind it: `docs/DECISIONS.md` (Phase 10, and
Self-hosting on the VPS for the web image and the shared server).

## Environments

| Environment               | App                         | Database                         | Deploys                           |
| ------------------------- | --------------------------- | -------------------------------- | --------------------------------- |
| Local                     | http://localhost:3000       | Supabase CLI (Docker), with seed | `pnpm dev`                        |
| Staging                   | https://staging.menumesh.in | Supabase project, Mumbai         | automatically, after CI on `main` |
| Production                | https://menumesh.in         | Supabase project, Mumbai (free)  | the **Release** workflow          |
| Staging, from the move    | https://staging.menumesh.in | Supabase project, still hosted   | automatically, after CI on `main` |
| Production, from the move | https://menumesh.in         | Supabase on the same server      | the owner, on the server          |

Each environment has its own Supabase project, Vercel project, keys and secrets. Nothing is
shared. The seed (demo restaurant, demo logins) exists only locally and in CI: deploys never
push it. From the move (Stop D), both web apps run on one shared server in Mumbai, staging behind a
password, and production's database is that server's own Supabase stack on
`https://api.menumesh.in`; staging deploys through the VPS workflows and production by
`sudo app-deploy` on the server: see The shared server (VPS).

## Deploying

A deploy is always: apply migrations → build and deploy on Vercel → smoke tests
(`.github/workflows/deploy.yml`). Neither Vercel project is connected to GitHub (and
`vercel.json` turns Git deploys off too), so new code never reaches a database that lacks its
migrations. Don't use Vercel's **Redeploy** or **Create Deployment**: they skip the migrations
and the version check. Re-run the workflow instead.

- **Staging:** every push to `main` that passes CI deploys staging (the `staging` job in
  `ci.yml`). It is off until the repository variable `DEPLOY_STAGING` is `true`.
- **Production:** GitHub → Actions → **Release** → Run workflow, type `production` in the
  confirm box (optionally a commit; the default is the latest `main`). Only the repository owner
  can run it, and it refuses a commit whose CI on `main` failed.
- After a deploy, the smoke tests check that the live site reports the commit just deployed
  (`/api/health` → `version`).
- Pages already open (staff tablets, guests' phones) keep their navigations, server actions and
  the guest orders poll on the deployment that served them, for up to 7 days (Skew Protection);
  they move to the new one on their next reload. So an old deployment keeps running for a week:
  see the migration, rollback and secret rules below.
- A page that does reach a newer build (open for more than 7 days, or past a Skew Protection
  Threshold) is refused its next server action and refreshes onto the new build. The worker panel,
  the live board (`/admin/live`) and guests' phones do it by themselves on their next tap: the
  guest's cart and the kitchen's dish moves are kept, and anything else is tapped again (a guest's
  second Place order reuses the first order's key, so a reply lost in the deploy doesn't give a
  second order). Admin, super, the website and login show "A new version is ready" with a
  **Refresh** button that cannot be closed: the tap that met the newer build stays pending behind it
  and the page keeps what was typed, so copy anything typed first, then press Refresh. The toast
  also says that anything just changed was not saved, and nothing will be until Refresh: from that
  first tap the page's buttons, switches, menu items, drag handles and selects stop taking taps and
  dim, so that nothing looks saved that was not (links, typed text, tabs, the buttons that only
  open a menu or a sheet, such as the panel's navigation on a phone, and the toast's Refresh keep
  working; a keyboard or a screen reader can still press a control, which is never sent either). A
  link on the page, or Back, loads the new build in full too, typed text lost as with Refresh, and a
  link to a place on the same page scrolls there. A page that refreshes its own data on a timer (a
  download being prepared on `/admin/settings`, a support board in `/super`) reloads by itself at
  its next tick, whatever was typed. A tab refreshes itself at most once in 2 minutes, so a broken
  deploy can't loop it; it then asks instead (docs/DECISIONS.md VPS-8).

### One-time setup per environment

1. **Supabase:** a project in Mumbai (`ap-south-1`); staging in its own free organization (a
   Pro organization bills every extra project's compute). Note the project ref and the database
   password. In Authentication: sign-ups and anonymous sign-ins off, minimum password length 8,
   TOTP on, Site URL = the app URL, and the sign-up and sign-in rate limit raised to 1000 per 5
   minutes (every staff login comes from the app's servers, so they share IPs; the VPS's own Auth
   gets the visitor's address instead, docs/DECISIONS.md VPS-4).
2. **Vercel:** a project (`menumesh-staging` or `menumesh`) on the Pro team, imported from
   GitHub (that first deploy may fail) and then disconnected from it: Settings → Git →
   **Disconnect** (the pipeline deploys with the CLI; a connected project once deployed a push to
   production despite `vercel.json`), Node.js 24.x, Settings → Advanced → Skew Protection on (the default for new
   projects) with a maximum age of 7 days, the domain attached, and the environment variables below
   under "Production" (a staging project's production is staging). `NEXT_PUBLIC_*`,
   `STAFF_EMAIL_DOMAIN`, `SENTRY_ORG` and `SENTRY_PROJECT` are of type Config, because the
   pipeline's build reads them, and the rest are Secret: the pipeline's build only gets
   placeholders for Secret values, which the app reads at runtime instead.
3. **GitHub** → Settings → Secrets and variables → Actions (repository level: a free plan's
   private repository has no environment secrets). Once: the secrets `VERCEL_TOKEN`,
   `VERCEL_ORG_ID` and `SENTRY_AUTH_TOKEN` (the build uploads source maps with it). Per target,
   with the prefix `STAGING_` or `PRODUCTION_`: the secrets `…SUPABASE_ACCESS_TOKEN` (Supabase
   account → Access Tokens: a token scoped to that target's project only), `…SUPABASE_PROJECT_REF`,
   `…SUPABASE_DB_PASSWORD` and `…VERCEL_PROJECT_ID`, and the variable `…APP_URL`. Then the
   variable `DEPLOY_STAGING` = `true` turns on staging deploys.
4. **Sentry and PostHog** (once, shared by both environments): a Sentry project for Next.js
   with IP addresses not stored and the data scrubber on, and an organization token for
   `SENTRY_AUTH_TOKEN`; a PostHog project with client IP data discarded. Both talk to their own
   domains, so a browser with an ad blocker sends them nothing: allow the app's domain in the
   blocker on restaurant tablets if their usage should count. The website uses the same project
   without cookies (docs/DECISIONS.md W-13). Staging shares the project too (PostHog's free plan
   has one), so keep it out of the numbers: in PostHog, Settings → Project → Filter out internal
   and test users, add the event property `$host` equals `menumesh.in`, turn on Enable this
   filter on all new insights, then Turn on for existing insights. Every event, from the browser
   or the server, carries `$host`. Staging events still show in Activity.
5. **Backups** (production, while on Supabase's free plan): the secret `BACKUP_PASSPHRASE`, a
   long random passphrase also kept in the owner's password manager, and, once production exists,
   the variable `BACKUP_PRODUCTION` = `true` (see Backups and restore).
6. **Uptime:** a monitor on `https://<app>/api/health` every minute, alerting by email or phone.
   It answers 200 with `"db":"ok"`, or 503 when the database can't be reached.

### Environment variables (Vercel)

| Variable                                        | Staging                         | Production                 |
| ----------------------------------------------- | ------------------------------- | -------------------------- |
| `NEXT_PUBLIC_APP_URL`                           | `https://staging.menumesh.in`   | `https://menumesh.in`      |
| `NEXT_PUBLIC_SUPABASE_URL`, keys                | staging project                 | production project         |
| `STAFF_EMAIL_DOMAIN`                            | `staging.menumesh.in`           | `menumesh.in`              |
| `CUSTOMER_COOKIE_SECRET`                        | 32+ random bytes                | different 32+ random bytes |
| `RAZORPAY_KEY_ID`, `_SECRET`, `_WEBHOOK_SECRET` | test keys                       | live keys                  |
| `CRON_SECRET`                                   | random                          | different random           |
| `RESEND_API_KEY`, `EMAIL_FROM`                  | optional                        | required before charging   |
| `TURNSTILE_SITE_KEY`, `_SECRET_KEY`             | optional                        | required for the demo form |
| `MENU_IMPORT_API_KEY`, `_FALLBACK_API_KEY`      | optional                        | as needed                  |
| `NEXT_PUBLIC_SENTRY_DSN`                        | the project's DSN               | the same DSN               |
| `NEXT_PUBLIC_SENTRY_ENVIRONMENT`                | `staging`                       | `production`               |
| `SENTRY_ORG`, `SENTRY_PROJECT`                  | for readable stack traces       | same                       |
| `SENTRY_READ_TOKEN`                             | optional, for System health     | same                       |
| `RESEND_WEBHOOK_SECRET`                         | optional, bounce reports        | its own webhook's secret   |
| `NEXT_PUBLIC_POSTHOG_KEY`, `_HOST`              | the project key and region host | same                       |

Generate a secret with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
`NEXT_PUBLIC_*` values are built into the app: change them, then deploy again.

Two server-only variables are for the VPS and stay empty on Vercel: `SUPABASE_INTERNAL_URL` and
`SUPABASE_FORWARD_CLIENT_IP` (docs/DECISIONS.md VPS-20 and VPS-4; see The web image below).

### The web image (Docker, not live yet)

The web app also builds as a Docker image, for the planned move to a shared VPS (docs/DECISIONS.md,
Self-hosting on the VPS). **Nothing deploys it yet: Vercel stays the live host, for staging and
production, until the cut-over (Stop D).** The compose project, the gateway, the Caddy site file,
the scheduler, backups, and the image build and deploys in GitHub Actions are written and rehearsed,
and switched off until the server exists: The shared server (VPS), below. This section is how to
build the image and check it on this machine.

`Dockerfile` builds the Next.js standalone server on Node 24 (Debian 13), run as the non-root `node`
user on port 3000. It makes one image per environment, because `NEXT_PUBLIC_*` values are built in
(VPS-13): staging and production are separate builds of one commit, an image can't be promoted from
one to the other, and a rollback needs the previous production image kept. Build arguments (a
missing required one fails the build with `error: build argument NAME is required`):

| Argument                               | Needed   | Value                                                              |
| -------------------------------------- | -------- | ------------------------------------------------------------------ |
| `NEXT_PUBLIC_APP_URL`                  | required | the environment's address, no trailing slash                       |
| `NEXT_PUBLIC_SUPABASE_URL`             | required | staging: the hosted project; production: `https://api.menumesh.in` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | required | the project's publishable key                                      |
| `NEXT_PUBLIC_BUILD_SHA`                | required | the commit; `/api/health` and `/api/live` report it                |
| `DEPLOYMENT_ID`                        | required | one per build, not per commit                                      |
| `NEXT_PUBLIC_SENTRY_DSN`               | optional | the project's DSN                                                  |
| `NEXT_PUBLIC_SENTRY_ENVIRONMENT`       | optional | `staging` or `production`; required with a DSN                     |
| `NEXT_PUBLIC_POSTHOG_KEY`, `_HOST`     | optional | as on Vercel                                                       |
| `SENTRY_ORG`, `SENTRY_PROJECT`         | optional | for the source map upload, and at run time for System health       |
| `SENTRY_RELEASE`                       | optional | defaults to the commit                                             |

`NEXT_PUBLIC_SUPABASE_URL` is never the internal address (VPS-20). `DEPLOYMENT_ID` takes letters,
digits, `-` and `_` only (`next build` refuses a dot, so the Dockerfile stops the build first), and
is made as `<commit 12>-<run id>-<attempt>`, as `deploy.yml` does for Vercel. The Dockerfile sets
`NEXT_OUTPUT=standalone` itself. The one secret is `sentry_auth_token`, a BuildKit secret
(`--secret id=sentry_auth_token,env=SENTRY_AUTH_TOKEN`) and never an argument, because arguments
show in `docker history`; without it no source maps are made or uploaded. Env files cannot reach
the build (`.dockerignore` is an allowlist, and the build stops if one gets in). The build log
shows two `[site] plans not loaded for the home page` traces: the build has no
`SUPABASE_SECRET_KEY` by design, so they are harmless.

- **Runtime variables:** the container takes the server-only variables of Environment variables
  (Vercel), as listed in `src/lib/env.server.ts` and explained in `.env.example`. Of the build
  arguments, `SENTRY_ORG` and `SENTRY_PROJECT` are runtime variables too: with `SENTRY_READ_TOKEN`
  they are what System health reads for Sentry's issues, and without them its Sentry card says
  "Not set up". Two are for the VPS: `SUPABASE_INTERNAL_URL` (the address the server calls Supabase
  on, `http://api-gw:8000`, on production's web only; VPS-20) and `SUPABASE_FORWARD_CLIENT_IP`
  (`true` only where Auth is the VPS's own, with the Auth settings of VPS-4). `NEXT_PUBLIC_*` set at
  run time do nothing. The image sets `PORT=3000`, `HOSTNAME=0.0.0.0` (do not override it) and
  `KEEP_ALIVE_TIMEOUT=130000`: keep the proxy's idle upstream time under 130 s (Caddy's is 2
  minutes). Leave `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` unset (VPS-10): each build gets new action
  ids, and open pages move onto it by a refresh (VPS-8).
- **What the shared server gives the image** (VPS-24; the kit in `deploy/vps/` does all of it, as
  The shared server (VPS) describes):
  - Stop with a 25 s grace period: node is process 1 and gets `SIGTERM`, requests and `after()` work
    finish, and what still runs at 25 s is killed, exit 137 (VPS-22). A stop that finds work in
    flight takes as long as the work, exit 143: with a pooled keep-alive client an idle stop
    measured 0.6 s, one with a 9 s request in flight 7.8 s and one with an open upgrade request that
    nothing answers 0.6 s (VPS-16). That holds only while the container runs the image's own `CMD`,
    which loads a preload (`/usr/local/lib/menumesh-drain.cjs`) that ends connections as the server
    closes: the answers still in flight, the idle ones and the sockets an upgrade request left. A
    compose `command:` replaces it, and every stop under traffic then runs the full 25 s and ends in
    the kill.
  - A stop with job work in flight takes seconds, not as long as the work (VPS-25): at `SIGTERM` the
    jobs claim nothing more, an export being built goes back to the queue, model calls are aborted
    and an email being sent is finished. Two things in an export cannot be aborted, and the stop
    waits for both: building the file in hand in memory (2.6 s measured for a file of 60,000 rows,
    about 6 s for the largest at the memory cap) and the upload of its ZIP. What a kill cuts off is
    taken up again by its lease: an export within 90 s, Hindi names within 5 minutes, emails within
    a minute. This depends on the server adding its own `SIGTERM` listener before the app starts (a
    unit test and `pnpm docker:check` watch for that), so the rehearsal runs `docker stop` with an
    export building. Expect exit 143 within seconds, and the row `queued` again with `attempts` 0,
    or `ready` with one file if the stop came during the upload; never left `building`, never
    `attempts` 1. A pilot restaurant's export builds in 2 to 6 s, mostly reading, so to land the
    stop inside a build use one of 10 s or more: a throwaway restaurant with a very large menu,
    deleted afterwards. Then `docker kill` with an export building (once its lease has run out, or
    `lease_until` is set to the past, the minute job builds it: the row ends `ready` with `attempts`
    1). Both were tried on the local image (DECISIONS, Tests (VPS Stop A2)).
  - The scheduler's every-minute line (VPS-29, VPS-38): `GET /api/cron/jobs` on `http://web:3000`
    with the `CRON_SECRET` bearer, which curl reads from its standard input, and 25 s to answer
    (the route answers at once), then a heartbeat ping when the call succeeds. `scheduler-staging`
    calls `http://web-staging:3000` under staging's own secret. Never through Cloudflare. The
    rehearsal checked the job's shell: crond passes its environment, and `cron-call` reads the
    values from a file anyway.
  - 1536m of memory for `web` and 768m for `web-staging`, with `NODE_OPTIONS=--max-old-space-size`
    at about 65% of it (1000 and 500). The data export's size limit follows the heap: Node's limit
    in the container is 1096 MiB on `web` and 548 MiB on `web-staging`, so `web` allows the 512 MiB
    cap, about 37,800 bills, and `web-staging` 274 MiB, about 20,200 (VPS-6). A container without
    that setting, or with less memory, lowers it.
  - Named volumes on `/app/.next/static` (earlier builds' scripts and styles, VPS-21) and
    `/app/.next/cache` (the image optimiser's cache, capped at 500 MB, VPS-18). The image needs no
    capability or privilege: `cap_drop: ALL` and `no-new-privileges`. The container refuses to start
    without this build's static files: if it cannot add them to the volume it exits 1 with an
    `error: … static files are missing or cut short` line (a read-only volume that already holds
    them unchanged is fine). So a static volume created or seeded before the first start must be
    owned by uid 1000: seed it with `docker run --user 1000:1000`, or `chown -R 1000:1000` it. A
    volume seeded as root, or a full disk, makes the new container exit, which `app-deploy` sees as
    one that never turns healthy. A fresh named volume copies the image folder's owner and needs
    nothing.
  - `api.menumesh.in` must resolve to a public address inside the web containers: `next/image`
    fetches photos from it and refuses private addresses, so an alias to a Docker or loopback
    address would answer 400 for every dish photo (VPS-18).
  - Caddy and Cloudflare must pass `x-nextjs-action-not-found` and `x-nextjs-deployment-id` and
    never cache HTML or RSC (VPS-7).
  - The Caddy site file refuses `Upgrade` requests to the web container (a header matcher and a
    400): the app serves no WebSockets, and an upgrade request that nothing answers keeps its
    connection open for as long as the client waits, up to Cloudflare's 100 s. The image's preload
    already ends such sockets when a stop begins, so this is defence in depth (VPS-16, VPS-24).
  - Docker's health check calls `/api/health`, which reaches the database: the deploy waits up to
    120 s for healthy, and a database outage turns the container unhealthy without restarting it
    (VPS-17).
  - The daily cron and digest routes (`maxDuration` 300 and 60 on Vercel, ignored elsewhere) can
    outlast Cloudflare's 100 s, so the scheduler calls the web container directly, not through
    Cloudflare (VPS-22).
- **After the move:** until the Vercel parts retire, 14 days after the production night (The server
  rehearsal and the cut-over, part 6), the Vercel rules in this runbook stay: the live deploy path
  until each environment's night, and its way back after it (Deploying, One-time setup, the
  variables, the 7-day migration rule, Rolling back, Rotating secrets, Restore from an export and
  the Razorpay live switch). After the move a deploy replaces the container, so the live screens
  refresh on their next tap and the other pages offer Refresh (VPS-8), and until then their polls
  and the board's direct Supabase reads run the old browser code against the new build: keep their
  JSON and the tables the board reads additive, like migrations (VPS-11). Production deploys are
  run by the owner on the server, `sudo app-deploy menumesh production <prod-ref> <migrate-ref>`;
  staging deploys from GitHub after a merge to `main` (VPS-23). How, and when not to deploy: The
  shared server (VPS), Deploys on the VPS.
- **Checking an image here** (Docker Desktop, `pnpm db:start`, and `.env.local` pointing at the
  local stack):
  - `pnpm docker:build [--tag menumesh-web:local] [--deployment-id <id>]` builds it with the local
    Supabase address and key and the commit; a local build's deployment ID is unique to the build,
    so two builds can be swapped like a deploy.
  - `pnpm docker:run [--tag menumesh-web:local] [--internal-url]` starts `menumesh-web` on
    `http://localhost:3100` (this machine only) under the shared server's limits, with the volumes
    `menumesh-web-static` and `menumesh-web-cache`, and waits up to 90 s for healthy. Of
    `.env.local`, only `SUPABASE_SECRET_KEY`, `CUSTOMER_COOKIE_SECRET` and `STAFF_EMAIL_DOMAIN`
    reach it, by name through Docker's environment: the other keys stay out, so it cannot send
    email, charge Razorpay or report to Sentry. Its `CRON_SECRET` is its own,
    `local-only-cron-secret` (in `scripts/docker-local.mts`), so the minute job can be called by
    hand with `Authorization: Bearer local-only-cron-secret`. A second container,
    `menumesh-web-bridge`, forwards the Supabase port to the host's Supabase. Run it again with
    another `--tag` to swap images as a deploy does: the earlier build's scripts stay served from
    the volume. With `--internal-url` the server calls Supabase on `http://api-gw:8000`, as on the
    VPS, and the public address is out of its reach.
  - `pnpm docker:check` ticks each of 12 checks (14 with `--internal-url`) and exits 1 on any
    failure: healthy; `/` answers 200; `/api/live` names this build and `/api/health` reaches the
    database; pages carry this build's deployment ID; only `menumesh.in` is indexable; the minute
    job answers 401 without its secret and 200 with it; the logs hold no
    `[jobs] no SIGTERM listener` warning (a stop would run job work to the kill, VPS-25); log out
    redirects to a relative address; the prerendered files and `sw.js` are in the image; sharp
    resizes an image and its disk cache works; this build's scripts are served for a year; the app
    runs as `node` with only `.next/cache` and `.next/static` writable. If the build's last step
    (loading sharp) fails, libvips is missing from the standalone output (VPS-18).
  - Then a Playwright subset, which reuses the container on port 3100 instead of building:
    `SMOKE_URL=http://localhost:3100 EXPECTED_VERSION=$(git rev-parse HEAD) pnpm smoke`;
    `pnpm e2e --project=desktop --no-deps` on `tests/e2e/smoke.spec.ts`, `auth.spec.ts`,
    `seo.spec.ts`, `fonts.spec.ts`, `theme.spec.ts` and `admin-tables.spec.ts`; and
    `pnpm e2e --project=mobile --no-deps tests/e2e/customer-ordering.spec.ts`. Specs that need the
    mock APIs are left out: the mock server binds 127.0.0.1 on the host. With `--internal-url`,
    `auth.spec.ts`, `staff-board.spec.ts` and the export download test of
    `super-close-account.spec.ts` (`-g 'an owner downloads a ZIP'`) prove sign-in, the board and the
    export link.
  - `pnpm docker:stop` removes both containers and both volumes.
- **Updating the pins:** the base image's tag and digest move together
  (`docker buildx imagetools inspect <tag>` shows the digest), monthly and on advisories, once a
  release is 14 days old; the pnpm image's tag and digest move whenever `packageManager` changes
  (`--pm-on-fail=error` makes a mismatch fail the build). The BuildKit frontend on the Dockerfile's
  first line (`# syntax=docker/dockerfile:1.27.1@sha256:…`) is pinned the same way: bump it by hand
  together with the Node digest, to a release at least 14 days old (1.10 or later, for the secret
  mount's `env=`; VPS-14). The floating `:1` is refused by the pin test.

## Database migrations

- Every schema change is a new file in `supabase/migrations`, tested locally and in CI first.
- Old code keeps running against the new schema: for the minute between migrating and
  deploying, and for pages opened before a deploy, up to 7 days after it. So a migration must not
  break any deployment from the last 7 days: add columns, tables and functions freely; rename or
  drop only once no deployment from the last 7 days uses the old name.
- There are no down migrations. To undo, write a new migration; but after a recovery past a bad
  release on the shared server, a rewind or a night from before it, make its harmful migration
  harmless in its own file instead (Backups and restore (VPS), Disaster recovery, step 7).
- To see what a deploy would apply: `pnpm exec supabase link --project-ref <ref>` then
  `pnpm exec supabase db push --dry-run`.
- **Once per environment after the super-admin metrics migration** (stop 12b,
  `20261015100100_metrics_snapshots.sql`): fill past days' usage in that project's Supabase SQL
  editor, a month at a time from the first order to yesterday, for example
  `select public.platform_metrics_backfill_usage('2026-10-01', '2026-10-31');`. It recounts each
  day, so running a range twice is harmless. (Locally, `pnpm metrics:backfill` does the same
  against the stack in `.env.local`; never point `.env.local` at staging or production for it.)
  Subscription history can't be backfilled: it starts with the first nightly snapshot (03:00
  India time).
- **Once per environment after the usage analytics migration** (stop 13e,
  `20261023100000_usage.sql`): run the same usage backfill again over the days already stored,
  so they get the feature counts (waiter bills, split bills, add-ons) that days stored before had
  at zero. Orders from the Hindi menu can't be recovered: orders record it from this release on.
  Where 12b's backfill hasn't run yet, running it once after this release does both.

## Rolling back

- **App:** Vercel → the project → Deployments → the last good one → **Instant Rollback**. It is
  instant and keeps the database as it is (fine, since migrations are backward-compatible). It
  also stops new production deploys from going live: after the fix is released, press **Undo
  Rollback** on the project page (or run `vercel promote <new deployment URL>`). Until then the
  deploy's smoke tests fail, because the live site still reports the old commit.
- **Pages already open on the bad deployment keep using it** (Skew Protection, up to 7 days); a
  rollback doesn't stop them. When it must stop at once (wrong data, a security hole), delete the
  bad deployment (Deployments → ⋯ → Delete) and ask staff to reload their tablets; release the fix
  with `vercel promote <fix URL>` (Undo Rollback would bring back the deleted one). Otherwise,
  once the fix is live, open its deployment → ⋯ → **Skew Protection Threshold** → **Set**: older
  deployments stop answering, and open pages refresh onto the fix on their next tap (the live
  screens by themselves, other pages through a Refresh button; docs/DECISIONS.md VPS-8).
- **Database:** a forward-fix migration through the normal pipeline. Restoring a backup is for
  lost data, not bad code (see Backups).

## Incidents

- **Live updates stop (Realtime down):** boards refetch every 30 seconds on their own and show
  "Reconnecting…"; staff can refresh. Guests' order pages poll every 10 seconds anyway.
- **A tablet loses Wi-Fi:** dish moves are kept on the tablet and sent when it is back; other
  actions are disabled until then.
- **Database paused** (Supabase's free plan, after 7 days without use; staging or a production
  not yet in use): the site and deploys fail. Supabase → the project → **Restore project**.
- **Health 503 with `Invalid API key`** in Vercel's function log: `SUPABASE_SECRET_KEY` belongs
  to another Supabase project. Put in the project's own key and deploy again: a changed variable
  reaches only new deployments.
- **A daily cron step failed:** `cron_runs` has one row per step with `ok` and the error in
  `detail` (SQL editor: `select * from cron_runs order by started_at desc limit 20;`). Each step
  is independent; the next night's run repeats it. If `metrics snapshot` failed, the day's
  subscription snapshot and platform counts are missing: the same day, run
  `select public.platform_metrics_snapshot('<yesterday>');` in the SQL editor (it states the day
  as of now, close enough on the morning after; signups older than a week can no longer be
  counted). A failed `usage snapshot` needs nothing: the next night recounts the last four days.
  Home's Needs attention lists a failed step until a later run of it works.
- **The daily digest didn't arrive** (08:45 India time, `/api/cron/digest`): `cron_runs` rows
  with `job = 'digest'` say what happened (`skipped` when Resend isn't set up). Run it by hand
  with `curl -H "Authorization: Bearer <CRON_SECRET>" https://<domain>/api/cron/digest`; it goes
  out once a day, so a second run answers "already sent".
- **A download stays on Preparing** (Settings, or the restaurant's Account tab; VPS-26): exports
  wait in a queue that builds one at a time. What waits, in the SQL editor:
  ```sql
  select id, restaurant_id, status, attempts, lease_until, last_error, created_at
  from restaurant_exports where status in ('queued', 'building') order by created_at;
  ```
  `queued` is waiting its turn: a build takes seconds, so a queue clears fast. `building` with a
  `lease_until` in the future is running. A `lease_until` in the past means the build was cut off (a
  deploy, a crash): the next claim, from the minute job or the next request, queues it again within
  a minute, and `attempts` counts the cuts. Three cuts (`last_error` says "the build was cut off")
  usually mean the server ran out of memory: look at the web container's restarts. A request still
  queued or building 15 minutes after it was made shows as failed on the card, and the owner may ask
  again. To build what waits now, run the minute job (below). To give up on one:
  ```sql
  update restaurant_exports set status = 'failed', lease_until = null, finished_at = now(),
    last_error = 'stopped by hand' where id = '<id>';
  ```
- **Hindi names are missing** (guests see the typed name, which is safe; HN-8, VPS-27): they are
  written after a menu edit, by the daily run and by the minute job, and only where a menu reader
  key (`MENU_IMPORT_API_KEY` or the fallback key) is set. How many wait:
  `select count(*) from menu_items where name_hi is null and name_hi_auto is null;`, and the same on
  `menu_categories`. A name leased in the last 5 minutes (`name_hi_auto_lease_until` in the future)
  is being worked on, and one tried in the last 12 hours (`name_hi_auto_tried_at`) waits until the
  12 hours pass, which includes a name the model could not write. When every reader is down, a batch
  is no try (no connection, a 401, 402, 404, 408, 429 or 5xx, or a 403 without OpenRouter's fields
  for a refusal of what was asked, VPS-27): the logs say `[hindi-names] every provider is down`,
  the minute job then leaves the names alone for 30 minutes when its run wrote none (it logs
  `[hindi-names] the minute job leaves the names alone until <time>` once), and they are written
  within about 30 minutes of a reader answering again (a lasting outage is usually the key). A
  reader that hangs still makes it a try: the logs say
  `[hindi-names] <reader> did not answer in time`, and its names wait 12 hours unless they are
  cleared as below. To try a restaurant's names at once, clear `name_hi_auto_tried_at` and
  `name_hi_auto_lease_until` on its rows that have neither `name_hi` nor `name_hi_auto` (after a
  reader that hung, on every restaurant's such rows), then run the minute job. Until the time in
  that pause line, the minute job still answers that it started `hindi_names` but leaves the names
  alone: restart the web container first, which ends the pause, or edit the restaurant's menu
  instead (save a dish), whose fill does not pause. A reader that refuses one restaurant's batch
  for what it says, with a 403 that carries none of those fields (another provider's, or a shape
  OpenRouter does not document), is taken for an outage too: each `every provider is down` line
  follows the same `[hindi-names] <reader> answered 403: <message>` line, and the names still
  leased just after it are that batch's:
  ```sql
  select restaurant_id, count(*) from menu_items
  where name_hi_auto_lease_until > now() group by restaurant_id;
  ```
  and the same on `menu_categories`. To leave that restaurant's waiting names alone, stamp them as
  tried a week ahead, on both tables (the fills pass over a name until 12 hours after its time):
  ```sql
  update menu_items set name_hi_auto_tried_at = now() + interval '7 days',
    name_hi_auto_lease_until = null
  where restaurant_id = '<id>' and name_hi is null and name_hi_auto is null;
  ```
  A rename starts a name again, and clearing `name_hi_auto_tried_at` as above tries them at once.
- **Announcement emails stopped part way** (SA-83, VPS-28): the minute job sends the rest within a
  minute, so look at why it stopped. The `[announcements]` lines in the logs say: Resend unavailable
  (the minute job's run ends and the next minute tries again; a save's or the daily run goes on past
  one such answer and ends at the third since an email last went, and where no minute job runs, as
  on Vercel, the rest waits for the next save or the 03:00 run), a pair refused, or "three emails
  refused in a row, so none goes for 30 minutes: check EMAIL_FROM". A refused pair is in
  `announcement_email_failures` (with Resend's answer and `tries`) and is left alone for 20 hours,
  and `email_log` (`/super` → Health) shows every send. After fixing `EMAIL_FROM` or the sending
  domain, clear the refusals with `delete from public.announcement_email_failures;` and run the
  minute job.
- **Run the minute job by hand** (VPS-29), for exports, Hindi names or announcement emails that
  wait: `curl -H "Authorization: Bearer <CRON_SECRET>" "https://<domain>/api/cron/jobs"`. It answers
  at once, `{"ok":true,"started":[…]}`, with the kinds it started (an empty list means nothing
  waits, or this server can't do it: no menu reader key, no Resend), and the work goes on after the
  answer: watch the logs for `[closure] export ready`, `[hindi-names]` and `[announcements] emails`.
  While the Hindi names are paused (above), `hindi_names` is still listed, but nothing is written or
  logged until the pause ends. `?kinds=data_exports` (or `hindi_names`, `announcement_emails`,
  several with commas) keeps it to those kinds; a wrong secret is 401, an unknown kind 400, and
  `{"ok":false}` with 500 means it could not ask the database. It writes no `cron_runs` rows, so
  System health doesn't show it: the scheduler's heartbeat monitor is its alarm.
- **Database or Vercel down:** the health monitor alerts. Tell pilot restaurants to switch to
  paper order pads and bill by hand until it is back; nothing already recorded is lost. Check
  status.supabase.com and vercel-status.com.
- **A Razorpay webhook failed:** `/super` → **Webhooks** shows it; **Reprocess** runs it again.
  Razorpay also retries on its own for a day.
- **Create … plan in Razorpay says `401: {"error":"Unauthorized"}`:** Subscriptions isn't
  switched on in that mode yet, while the other APIs already work. Open **Payments →
  Subscriptions** in the Razorpay dashboard once, in the same mode as the keys, and try again.
  `Authentication failed` instead means the key id and secret aren't one pair: regenerate the
  key and set both.
- **A page says "Something went wrong" with an error code** (the app's own error page, VPS-9): the
  code is the error's digest and matches the server's log line for it. **Try again** fetches the
  page again and **Refresh** reloads it. A page that says "A new version is ready" is not an
  error: see Deploying.
- **Errors:** Sentry (errors only, no personal data). The server's `console.error` lines for
  unexpected database errors arrive there too.
- **System health** (`/super` → **Health**, Admin and Support; SA-86 to SA-92): scheduled jobs
  (a job missed when nothing ran for 26 hours, a step that didn't finish), webhooks, every email
  sent (find one address's emails there, e.g. "did my reset code go out?"), Sentry's issues of
  the day, database and storage size, menu imports this month, and the commit each environment
  runs. Failures also show on Home. To see how full the database and storage are, enter the
  Supabase plan's limits in Platform settings (in MB; the Pro plan's 8 GB is 8192).
  - Sentry's issues need `SENTRY_READ_TOKEN`: in Sentry, Settings → Auth Tokens (personal) or
    an internal integration, with the **event:read** scope only. Set it in Vercel for both
    environments (`SENTRY_ORG` and `SENTRY_PROJECT` are already there) and deploy.
  - Bounce reports: in Resend, Webhooks → Add endpoint
    `https://<domain>/api/webhooks/resend` with the events `email.bounced`,
    `email.complained`, `email.failed` and `email.suppressed`; copy its signing secret
    (`whsec_…`) into `RESEND_WEBHOOK_SECRET` for that environment and deploy. Staging and
    production each have their own endpoint and secret.

## Onboarding a restaurant

Follow `docs/PILOT.md` → "Setting a restaurant up": onboard at `/super`, hand over the owner
login, then the owner adds tables, prints QR codes (only once production is live on
`menumesh.in`: the codes carry `NEXT_PUBLIC_APP_URL`), enters the menu and installs the staff
app on each tablet.

## Closing an account

An owner asks through Get help; only a team member with Admin closes it (`/super` → the
restaurant → **Account**; SA-93 to SA-100).

1. **A copy first, if they want one.** Prepare a download on the Account tab and copy its link for
   them (24 hours, and anyone with the link can open it). It works during the hold too, but they
   can't log in once it closes, so they can't do it themselves after that. One asked for just
   before a deploy or a restart carries on by itself a minute or two later (the queue builds it
   again, VPS-26); if it stays on Preparing, see Incidents. If the download fails every time, look
   for `[closure] export failed … too big to build in memory` in Sentry or the logs: the restaurant
   is past what one in-memory build allows (docs/DECISIONS.md SA-93 and VPS-6, about 37,800 bills
   on the VPS's `web` and about 20,200 on staging, where the limit follows the web container's
   heap). Tell the owner the copy needs a developer.
2. **Close account:** a reason and the typed restaurant code. Anything that could still charge is
   cancelled first: if Razorpay refuses, nothing closes and it says so; try again in a minute. If
   it says autopay changed while closing, the owner set it up just then: close again. A refund for
   paid time is separate, in Razorpay. If it says no email went out, tell the owner yourself: they
   will only see "Wrong email or password".
3. **Reopen account** on the same tab until the end of the date it shows. Logins and QR codes
   return; autopay doesn't, so the owner sets it up again. One that was suspended goes back to
   suspended.
4. **After 30 days** the nightly job removes personal data (the list is SA-97), for good, and any
   download link stops working with it. If its `closed account removal` step fails, Home's
   scheduled jobs group says which restaurant and it tries again the next night.

Bills, payments and orders stay, with no end date until the CA's answers (SA-98). A returning owner
is onboarded by the team: their GSTIN and FSSAI number still refuse a self-signup trial.

## Support requests

Restaurants ask from **Get help** in the admin panel. Each request emails the support address in
`/super/settings` (set it, or only the inbox and the alerts bell show them) and lands in
`/super/support`. Take it (**Assignee**), set **In progress**, reach them the way they asked (the
Call, WhatsApp or email link on the request), and **Resolved** when done; use **Waiting on
restaurant** while they owe an answer. Internal notes are the team's only. Requests open or in
progress for more than a day show on Home under Needs attention.

## Support sessions

To fix a restaurant's setup with them on the phone: ask the owner to open **Settings → MenuMesh
support access** and allow 1, 4 or 24 hours. On the restaurant's page in `/super`, **Actions →
Start support session**, give the name they will see, and you are in its admin panel as a
manager until the window ends; the banner has **End session**. Bills, payments, live service,
Get help and the tax, invoice and UPI settings are refused; menu, tables and QR codes, waiters,
waiter and kitchen logins and the restaurant's details work. Everything you change is listed for
the owner. Tell them any password you set for a login. When onboarding in person, tick the owner's
agreement on the wizard's last step instead: the session starts as soon as the restaurant is
created. A team account that is also a restaurant login can't start sessions.

## Failed subscription payments

- Razorpay retries the autopay charge. Meanwhile the restaurant has 7 days' grace (a banner for
  the owner, a reminder email each day); then ordering pauses at the next business-day start.
  Billing open tables always works.
- To help an owner pay: `/super` → the restaurant → **Actions** → **Send payment link** (months
  of the plan), or **Record payment** for money received by bank transfer or UPI. Its Billing tab
  shows the links sent and whether each was paid.
- When a paid webhook arrives, the restaurant is active again at once.

## Rotating secrets

On Vercel, as today. On the shared server, from the move: The shared server (VPS), Secrets (VPS).

| Secret                        | Where                                 | What happens                                                                              |
| ----------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `SUPABASE_SECRET_KEY`         | Supabase → API keys, then Vercel      | Create a new secret key, set it in Vercel, deploy, then revoke the old one.               |
| `CUSTOMER_COOKIE_SECRET`      | Vercel                                | Phones get new device ids: they can't cancel dishes ordered before.                       |
| `RAZORPAY_KEY_SECRET`         | Razorpay dashboard, then Vercel       | Regenerate, set, deploy. Checkout keeps working with the new pair.                        |
| `RAZORPAY_WEBHOOK_SECRET`     | Razorpay webhook settings and Vercel  | Change both together; events in between fail and are retried by Razorpay.                 |
| `CRON_SECRET`                 | Vercel                                | Vercel Cron sends the new one after the next deploy.                                      |
| `RESEND_API_KEY`, import keys | the provider, then Vercel             | Create the new key, set, deploy, delete the old key.                                      |
| `RESEND_WEBHOOK_SECRET`       | Resend webhook settings and Vercel    | Roll it in Resend, set, deploy; reports in between are refused and retried by Resend.     |
| `SENTRY_READ_TOKEN`           | Sentry, then Vercel                   | Create the new token, set, deploy, revoke the old one.                                    |
| GitHub deploy secrets         | GitHub repository secrets             | Replace; the next deploy uses them.                                                       |
| `BACKUP_PASSPHRASE`           | GitHub repository secrets             | New backups use it; keep the old one while its backups (30 days) matter.                  |
| `…SUPABASE_ACCESS_TOKEN`      | Supabase → Access Tokens, then GitHub | Create a token scoped to that target's project, replace the secret, revoke the old token. |

After changing any Vercel variable, deploy again (a Release for production). Each deployment
keeps the values it was built with, and pages opened before the deploy keep using the old one for
up to 7 days, so after deploying a rotated secret set the new deployment's **Skew Protection
Threshold** (Deployments → ⋯) before revoking or deleting the old value.

## Backups and restore

As on hosted Supabase today. On the shared server, from the move: The shared server (VPS), Backups
and restore (VPS).

- **Production starts on Supabase's free plan, which keeps no backups.** The **Backup** workflow
  exports it every night at 02:00 IST once the variable `BACKUP_PRODUCTION` is `true` (Actions →
  Backup → Run workflow makes one at any time, for staging too). Each run keeps one encrypted file
  for 30 days (the run's Artifacts), holding the app's data and the logins (`public` and `auth`)
  and the list of applied migrations. Not in it: uploaded files (menu photos, logos), which owners
  re-upload after a restore. Only the `BACKUP_PASSPHRASE` opens it: keep the passphrase in the
  owner's password manager. GitHub's free plan stores 500 MB of run files; lower
  `retention-days` in `backup.yml` if they approach it. A failed night emails the owner.
- **Supabase Pro** (before the first charge, see Razorpay live switch) adds daily backups for 7
  days (Database → Backups; point-in-time recovery is a paid add-on). Keep the nightly export as a
  second copy. **Restore in place:** Database → Backups → pick a day → Restore; the project is down
  for minutes to hours and everything after the backup is lost, so tell restaurants first.
- **Restore from an export** into a new project (rehearsed locally, Phase 10 Stop B):
  1. Download the run's artifact (a zip; `gh run download <run id>` unpacks it), then in Git Bash
     `gpg --pinentry-mode loopback --output backup.tar.gz --decrypt menumesh-production-<date>.tar.gz.gpg`
     (it asks for the passphrase) and `tar xzf backup.tar.gz`: `data.sql` and `migrations.txt`.
  2. Create a new Supabase project and set it up as in One-time setup. On the free plan the
     account's two free projects are staging and production: pause staging first (its Settings →
     General → Pause project, and restore it afterwards), or move production to Pro.
  3. Apply the migrations at the backup's version: the newest row of `migrations.txt` with a
     value in the **Remote** column (a row with an empty Remote was on `main` but never released:
     skip it). `git log --diff-filter=A --format=%H -- supabase/migrations/<version>_*.sql` gives
     the commit that added it. `git switch --detach <commit>`, then
     `pnpm exec supabase link --project-ref <new ref>` and `pnpm exec supabase db push`, then
     `git switch main`.
  4. Load the data. With the local stack running (`pnpm db:start`, for its `psql`) and the new
     project's session-pooler connection string (Connect → Session pooler):
     `docker exec -i supabase_db_tableorder psql "<connection string>" -v ON_ERROR_STOP=1 --single-transaction -c "truncate public.plans, public.platform_settings cascade" -f - < data.sql`
     (the migrations insert default plans and settings; the backup has the real ones). It is one
     transaction: an error loads nothing, so fix it and run it again.
  5. Point the Vercel variables (Supabase URL and keys) and the `PRODUCTION_SUPABASE_*` secrets at
     the new project, then Release. Then open the new deployment → ⋯ → **Skew Protection
     Threshold** → **Set**, pause the old project if it still runs, and ask staff to reload their
     tablets: pages opened before the Release would otherwise keep using the old project for up
     to 7 days. Everyone signs in again; passwords still work. If an authenticator code is
     refused, delete that user's factor (Authentication → Users) and enrol again.
- **Drill:** after big schema changes, export staging (Run workflow → `STAGING`) and restore it
  into a throwaway project the same way, then delete the throwaway (on the free plan, pause
  staging while the throwaway exists, then restore it). A restore target's Auth must be at least
  the backup's version: a new hosted project always is; a local stack isn't unless it runs the
  hosted versions (copy the linked project's `supabase/.temp/*-version` files).

## The shared server (VPS)

From the move, both web apps and production's Supabase run on one shared server, a Hostinger KVM 4
in Mumbai, as the compose project `menumesh` in `/srv/menumesh`, behind the server's one Caddy and
Cloudflare (docs/DECISIONS.md VPS-1, VPS-24, and VPS-31 to VPS-146 for the kit). The server team's
host scripts check and run everything: `app-apply` checks a file and installs it, `app-compose` runs
Compose for the project, `app-deploy` deploys one image, and `hostwatch` watches and alerts.
`deploy/vps/` holds every file MenuMesh brings, and its README says what goes where. **None of this
is live yet:** the server isn't bought, Vercel stays the live host until the cut-over (The server
rehearsal and the cut-over, below), and the CI jobs stay off until the two variables below are set.
The server team's runbooks in their repository (`docs/runbooks/server.md`, `edge.md`, `backups.md`,
`launch.md`, `cloudflare.md`) have the steps that are theirs.

### Who does what, and the server's conf

- **The server's admin** signs in as `ops` (sudo, through the SSH tunnel) and does the server team's
  side: `/etc/apps/menumesh.conf` (below), the deploy user `deploy-menumesh` with its key and the
  Access service token `github-deploy-menumesh`, the edge (the redaction file, the `tls_menumesh`
  snippet, the Origin CA certificate, authenticated origin pulls, the two `MENUMESH_STAGING_AUTH_*`
  lines of `edge.env`), the settings archive's timer, and `/srv/menumesh` with its `config/` folder,
  which the contract leaves to the admin. On this server the owner is also the admin.
- **The owner**, through the same `ops` account (`app-deploy` takes a deploy by hand only from `ops`
  or root), brings what is MenuMesh's: the backup key, the bucket, the alert bot and the monitors,
  the secrets and env files, the compose and site files through `app-apply`, the services,
  production's deploys and the restore tests; and, off the server, the Cloudflare zone with its
  origin pulls' CA and client certificate, and the GitHub settings.
- **CI**, once switched on, builds the images and deploys staging.

The admin writes `/etc/apps/menumesh.conf` (root, 0644) as below; the server team's
`apps/app.conf.example` explains each line. It is `deploy/vps/test/menumesh.conf`, the file
`pnpm vps:check` installs, without its header, and a unit test keeps the two the same.
`BACKUP_RECIPIENT` is the owner's age public key, the same as `BACKUP_AGE_RECIPIENT` in `.env`
(hostwatch alerts while they differ), and `app-deploy` refuses production while it is empty, since
each production deploy starts with an encrypted dump. The `edge.env` lines go in only once this file
exists.

```sh
PROJECT_DIR=/srv/menumesh
APP_COMPOSE_FILE=compose.yml
ENV_FILES=".env images.env"
CI_USER=deploy-menumesh
CI_ENVS="staging"
REPO=ghcr.io/nanu1605/menumesh
REGISTRY_USER=nanu1605
env_config() {
  case $1 in
    staging)
      SERVICE=web-staging VAR=STAGING_IMAGE TAG='staging-[0-9a-f]{40}'
      MIGRATE_SERVICE=migrate-staging MIGRATE_VAR=MIGRATE_STAGING_IMAGE ;;
    production)
      SERVICE=web VAR=WEB_IMAGE TAG='prod-v[0-9]+\.[0-9]+\.[0-9]+'
      MIGRATE_SERVICE=migrate MIGRATE_VAR=MIGRATE_IMAGE ;;
    backup) SERVICE=backup VAR=BACKUP_IMAGE TAG='backup-[0-9a-f]{40}' ;;
    *) return 1 ;;
  esac
}
EXTRA_TAG='migrate-[0-9a-f]{40}' EXTRA_MODE=migrate EXTRA_KEEP=3
HEALTH_TIMEOUT=120
LOG_LINE_BUDGET=45000
LOG_REDACT=1
PREDEPLOY_DB="db supabase_admin postgres"
BACKUP_RECIPIENT=           # age1..., sent when the key exists; same as BACKUP_AGE_RECIPIENT in .env
CONFIG_ARCHIVE_FILES=".env images.env env config deploys.log"
ZONE=menumesh.in
UPSTREAMS="menumesh-web:3000 menumesh-gw:8000 menumesh-web-staging:3000"
ENV_PREFIX=MENUMESH_
EDGE_NETWORKS="edge-menumesh edge-menumesh-staging"
```

### First install, in order

Files go to the server in `~/incoming` (`scp` through the tunnel), from this repository at the
commit being installed, after `pnpm vps:check` and `pnpm vps:edge` passed on it (Checking the kit
here); the edge's `snippets.caddy` alone comes from the server team's repository (step 11). Every
file under `/srv/menumesh` is root's, and nothing on the way up to `/` may be writable by anyone
else, or `app-apply` refuses the compose file.

**The owner, before the server:**

1. **The backup key**, an age key pair, made on a machine of the owner's (the server team's form):

   ```sh
   docker run --rm -v "$PWD:/k" postgres:17-alpine sh -c 'apk add -q age && age-keygen -o /k/menumesh-backup-key.txt'
   ```

   The public key (`age1…`) goes to the admin for `BACKUP_RECIPIENT` and into `.env`. The private
   key goes into the password manager and on paper, then off that machine: it never stays on the
   server, and without it no backup can be restored. The backup's **signing key** is a second pair,
   made in step 6; keep its public half beside this key, in the password manager and on paper, in a
   file of its own and never inside `menumesh-backup-key.txt`: age reads the file of its key as
   keys, comments and blank lines alone, so a restore given the list in it would refuse it. After
   each rotation the whole new list takes its place (Secrets (VPS), Rotation). It is not secret,
   but a recovery on a new server checks the night it takes against it, and trusts no other copy.

2. **The bucket:** an India-region, S3-compatible bucket, set up with an admin login that never goes
   on the server, and an API token for this bucket only. How it keeps a stolen token from deleting
   the nights is the owner's choice when the bucket is picked (docs/DECISIONS.md VPS-40):
   - **Retention just under the job's own ages** (29 days for `daily/`, 365 for `monthly/`, and 15
     days for `wal/`, which holds each night's WAL files) needs lock rules scoped to a prefix,
     which some providers have (R2's bucket locks, as the server team's own bucket uses), or a
     retention date on each object at upload, which the job does not set yet. The shipper never
     rewrites a WAL object (an identical one already there means no request at all), so a rule
     that refuses overwrites costs it nothing; and when a rule on `wal/` refuses what it writes,
     the WAL alert says so after 10 minutes. An S3 Object Lock default is one period for the whole bucket: 29 days would leave the
     monthly copies unlocked after a month, 365 would keep every night a year.
   - **Versioning** protects only if the server's token can't delete object versions or change the
     bucket's settings: on S3, a policy for its user that allows listing, reading, writing and
     deleting objects only (no `s3:DeleteObjectVersion`, and nothing that changes the bucket's
     versioning, lifecycle or policy). The old versions then need a lifecycle rule for each prefix
     that removes them after those ages.

   A restore reads a night from the one folder whose lock still holds it: `daily/` while the night
   is younger than 29 days, `monthly/` from then to 365 days (Backups and restore (VPS)). Only
   locks that refuse overwrites and deletes, prefix-scoped bucket locks such as R2's, keep a stolen
   token from replacing or deleting what a restore reads. A retention date on each object (S3
   Object Lock) keeps the old
   versions only, and a restore reads the current one: as with versioning alone, the token can put a new version over a recent night's part. A restore then
   refuses it, since each night's seal, signed by the backup's key, holds the size and sha256 of
   every part it lists (docs/DECISIONS.md VPS-43), but that night can't be restored until the
   part is put back. The admin login is also what removes what a token holder wrote (A stolen or leaked bucket token
   (VPS)).

3. **Alerts:** a Telegram bot and chat for the backup's failures, and heartbeat monitors: the backup
   (a ping a night, alerting after 26 hours), the daily and the digest calls (a ping a day each),
   the minute job (a ping a minute), and the same three for staging, and one for the WAL: the
   shipper pings it every 5 minutes while it is healthy, so give that monitor a period of 5
   minutes and a grace of 10 (`HEARTBEAT_WAL_URL`). Each is optional; an empty address pings
   nothing. The backup's ping carries the night's line, `backup <id>: …`, which the
   monitor keeps in its log (healthchecks.io shows a ping's body): with the server gone, it is the
   record of each whole night's id that a recovery names, and of the month's copy each names
   (Disaster recovery, step 2). Try each monitor's alert once before the first night, with its own
   test notification, so that a missed ping is known to reach the owner.
4. **Production's locale**, one read-only query in hosted production's SQL editor:

   ```sql
   select datname, datlocprovider, datcollate, datctype, datlocale from pg_database where datname = 'postgres';
   ```

   The server's database gets ICU `en-US` (`en_US.UTF-8`), as the local stack has. If production
   differs, `compose.yml` must set `POSTGRES_INITDB_ARGS` for `db` before its first start (VPS-34):
   changing it later takes a dump and a restore.

5. **Supabase's CA certificate** for staging's migrations: `deploy/vps/config/migrate/README.md`.
6. **The secrets** (Secrets, below): `pnpm vps:secrets --out <a folder outside the repository>`,
   fill each `# FILL IN` line, then `pnpm vps:secrets --check <that folder>`. Note the date it gives
   for the API keys. It also makes the backup's **signing pair** (Ed25519) and prints the public
   half once, as `BACKUP_SIGNING_PUBLIC_KEY=<key>`: keep that line beside the age key (step 1),
   alone in a plain text file of its own, never in the age key's file. A recovery on a new server
   checks its night with that file (`pnpm vps:verify-night … --keys <file>`, Disaster recovery,
   step 2), which refuses a file that holds the age key. The private half, `BACKUP_SIGNING_KEY`,
   goes into `.env` and the password manager like the other generated values, and is read by the
   `backup` service alone; it is never printed. `web-staging.env` then takes Vercel staging's own
   `STAFF_EMAIL_DOMAIN` and `CUSTOMER_COOKIE_SECRET`, and each env file the secrets of its Razorpay
   and Resend webhooks as Vercel has them (The server rehearsal and the cut-over, part 3);
   production's generated `CUSTOMER_COOKIE_SECRET` suits its fresh start.
7. **The deploy key** for CI, whose public half goes to the admin and private half to GitHub
   (`VPS_SSH_KEY`): `ssh-keygen -t ed25519 -f gha-menumesh-staging -N '' -C gha-menumesh-staging`.
8. **The zone:** `menumesh.in` on Cloudflare, moved from GoDaddy with its settings (The server
   rehearsal and the cut-over, part 1), Full (strict), with zone-level authenticated origin pulls
   from MenuMesh's own CA (the server team's `edge.md` §3, Authenticated origin pulls, whose steps 1
   and 2 are the owner's here, as the zone's), never Cloudflare's shared certificate, which proves
   only that a request came through Cloudflare. On the owner's own machine (Git Bash on Windows, or a terminal on macOS or
   Linux), in a folder only the owner can read: the CA, for 10 years, and the client certificate it
   signs, for 825 days, both RSA 2048, the client's marked for client authentication, without which
   Caddy refuses it. `MSYS_NO_PATHCONV=1` keeps Git Bash from turning `-subj`'s `/CN=…` into a
   Windows path, and changes nothing elsewhere:

   ```sh
   umask 077 && mkdir ~/aop && cd ~/aop
   printf 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n' > ca.ext
   printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n' > client.ext
   MSYS_NO_PATHCONV=1 openssl req -new -newkey rsa:2048 -nodes -subj '/CN=MenuMesh origin pulls CA' -keyout aop-ca-key.pem -out aop-ca.csr
   openssl x509 -req -sha256 -days 3650 -in aop-ca.csr -signkey aop-ca-key.pem -extfile ca.ext -out aop-ca.pem
   MSYS_NO_PATHCONV=1 openssl req -new -newkey rsa:2048 -nodes -subj '/CN=menumesh.in origin pulls' -keyout aop-client-key.pem -out aop-client.csr
   openssl x509 -req -sha256 -days 825 -in aop-client.csr -CA aop-ca.pem -CAkey aop-ca-key.pem -CAcreateserial -extfile client.ext -out aop-client.pem
   openssl verify -CAfile aop-ca.pem -purpose sslclient aop-client.pem
   openssl x509 -noout -enddate -in aop-client.pem
   ```

   `openssl verify` prints `aop-client.pem: OK` (a client certificate without client authentication
   fails it with `unsuitable certificate purpose`), and the last line the client certificate's
   expiry, which goes on the calendar. Then Cloudflare → `menumesh.in` → SSL/TLS → Origin Server →
   Authenticated Origin Pulls → Zone-level → **Upload certificate**, with `aop-client.pem` and
   `aop-client-key.pem` pasted: the client certificate itself and its key, as a CA certificate is
   refused (`missing leaf certificate`). Once its status has gone from `pending_deployment` to
   `active`, zone-level pulls go on (in the API,
   `PUT /zones/<zone id>/origin_tls_client_auth/settings` with `{"enabled": true}`, which needs SSL
   and Certificates Write), never the global toggle, Cloudflare's shared certificate. They cover
   every proxied record of the zone, and none is proxied yet: Vercel's stay DNS only. The four
   files go into the password manager; then `aop-ca-key.pem` and `aop-client-key.pem` go off the
   disk with the rest of the folder, and the CA's key never goes to a server. The admin gets only
   `aop-ca.pem` and `aop-client.pem` (step 11). Cloudflare also alerts 30 and 14 days before the
   client certificate expires, and never deletes an expired one itself. The next one is made the
   same way, from `aop-ca.pem` and the CA's key out of the password manager, without the lines that
   make the CA, and uploaded beside the old one; once it is `active`, the old one is deleted there
   (of two active ones, the one deployed last is used), and the admin puts the new `aop-client.pem`
   in the old one's place (step 11).

**The server's admin** (the server team's `server.md` §2 and `edge.md` §3 and §5):

9. `/etc/apps/menumesh.conf` as above, `BACKUP_RECIPIENT` filled in:
   `grep '^BACKUP_RECIPIENT=' /etc/apps/menumesh.conf` prints the owner's `age1…` key. Right after
   it, the redaction file, which needs only the conf:
   `sudo app-apply edge redact menumesh ~/incoming/log-redact.caddy`. From the conf on, hostwatch's
   daily run raises a critical
   `redact: LOG_REDACT=1 but no /srv/edge/config/log-redact.d/<app>.caddy for: menumesh` every day
   the file is missing. It goes in before step 11's `edge.env` lines: from those until Caddy is
   recreated, `app-apply` refuses it (step 11). Until the settings archive's timer is enabled
   (step 13), the same run also warns `timers: not enabled: app-config-archive@menumesh.timer`,
   which wants nothing then.
10. The deploy user with `gha-menumesh-staging.pub`, and the Access service token
    `github-deploy-menumesh` for the tunnel. Step 17's **VPS ping** proves both.
11. The edge: the Origin CA certificate for `menumesh.in` and `*.menumesh.in` from a CSR made on the
    server, then the server team's `snippets.caddy` with `tls_menumesh` in it, and authenticated
    origin pulls on, **before any MenuMesh container runs**: the CSR and the order are `edge.md`
    §3's, and its origin test, a TLS connection to the server without the client certificate
    refused (its step 5, §6, step 4), follows the site file, as their §3 has it for another app's
    zone. The certificate goes in with `aop-ca.pem`, the owner's CA (step 8), which Caddy checks
    Cloudflare's client certificate against; then `aop-client.pem`, that client certificate without
    its key, goes beside it by hand, as `edge.md` §3 does for theirs, so that hostwatch's daily run
    warns before it expires too:

    ```sh
    sudo app-apply edge cert menumesh ~/csr/origin.pem ~/csr/origin-key.pem ~/incoming/aop-ca.pem && shred -u ~/csr/origin-key.pem && rm -r ~/csr
    sudo install -m 0644 -o root -g root ~/incoming/aop-client.pem /srv/edge/certs/menumesh/
    ```

    The CSR's key goes only once the install has worked, as in their §3, step 4: when `edge cert`
    refuses, the key stays in `~/csr` (and the second line fails while `/srv/edge/certs/menumesh/`
    doesn't exist), and both lines are run again once what it named is mended.

    Then the snippet, as their `edge.md` §5, step 5, installs it: their own `snippets.caddy`, which
    holds `tls_menumesh` with `client_auth` on since their `66c8c61`, as MenuMesh's origin pulls
    are on before any of its containers runs. The admin copies it from the root of their
    repository, at that commit or a later one, on the admin's own machine, then installs it, which
    checks every installed site again. MenuMesh's kit never adds a snippet to the server's file:
    Caddy refuses a snippet declared twice, and the file stays the same as their repository's,
    whose next `edge config` would drop a snippet added here:

    ```sh
    scp docker/edge/config/snippets.caddy ops@<the tunnel's SSH host>:incoming/     # on the admin's machine, in their repository's root
    sudo app-apply edge config ~/incoming/snippets.caddy
    ```

    For `menumesh.in` that test proves nothing yet: until MenuMesh's site file is in, no site
    imports `tls_menumesh`, so its `client_auth` guards none of MenuMesh's hosts, whatever the test
    prints. The test that proves it runs right after the site file, on the staging night (The
    server rehearsal and the cut-over, part 3, step 1).

    Then the server team's digest pin of Caddy (their `edge.conf`'s `CADDY_IMAGE`, VPS-130), as
    their `edge.md` §5, **A new Caddy image**, steps 1 to 3, puts it in: its
    `app-apply edge compose` goes before `edge.env` too. `install.sh` never overwrites a conf, so
    `/etc/apps/edge.conf` keeps the image it had until the admin sets its `CADDY_IMAGE`, tag and
    digest, as their `docker/host/apps/edge.conf` has it; then the image is pulled, and their
    `docker/edge/compose.yml`, copied as the snippet is, goes in, which `app-apply` refuses while
    its image differs from `CADDY_IMAGE`. It goes to `~/incoming` under a name of its own, as
    MenuMesh's `compose.yml` goes there for step 15:

    ```sh
    scp docker/edge/compose.yml ops@<the tunnel's SSH host>:incoming/edge-compose.yml     # on the admin's machine, in their repository's root
    sudoedit /etc/apps/edge.conf     # CADDY_IMAGE= as their docker/host/apps/edge.conf has it
    grep '^CADDY_IMAGE=' /etc/apps/edge.conf
    sudo docker pull "$(sed -n 's/^CADDY_IMAGE=//p' /etc/apps/edge.conf)"
    sudo app-apply edge compose ~/incoming/edge-compose.yml
    ```

    `grep` prints
    `CADDY_IMAGE=caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0`,
    the index the server runs, which the kit's checks pin too (VPS-130), and `edge compose`
    validates the live tree with that image. The recreate below starts Caddy on it.

    `edge.env` comes last. From `app-apply edge env` until Caddy is recreated, `app-apply` refuses
    a site file and `edge cert`, `config`, `ranges`, `redact` and `reload`, the server team's own
    among them (`edge.env differs from what edge-caddy-1 was created with`). So
    the order is the certificate, then the snippet, then (the redaction file in since step 9)
    `edge.env`, then the recreate, the last two on the same night, with nothing of the edge between
    them, as the server team's `edge.md` §5, steps 6 and 7, has it. `app-apply edge env` puts the
    file it is given in place of the live one, so `edge.env` is one merged file, made as their
    step 6 makes it: a copy of the live file that only the admin can read, its last line given a
    line end if it has none, so that the first line added can't join the last value, then the two
    lines of `deploy/vps/edge/edge.env.example`, the owner's hash (below) between the single
    quotes, pasted into `cat >> ~/incoming/edge.env`, then Enter and Ctrl-D. `cat` expands nothing,
    which matters for a hash full of `$`:

    ```sh
    (umask 077; sudo cat /srv/edge/edge.env > ~/incoming/edge.env)
    [ -z "$(tail -c1 ~/incoming/edge.env)" ] || echo >> ~/incoming/edge.env
    cat >> ~/incoming/edge.env     # paste the two lines, press Enter, then Ctrl-D
    ```

    Then their check of the names and lengths, which prints no value:

    ```sh
    awk '/^[A-Za-z_][A-Za-z0-9_]*=/ {i = index($0, "="); k = substr($0, 1, i - 1); n[k]++; printf "%s(%d) ", k, length($0) - i} END {for (k in n) if (n[k] > 1) printf "TWICE:%s ", k; print ""}' ~/incoming/edge.env
    ```

    Every app's names show, the server team's `JAINAV_…` ones among them, none with `(0)`, no
    `TWICE:`, then `MENUMESH_STAGING_AUTH_USER(8)`, for the user `menumesh` of `edge.env.example`,
    and `MENUMESH_STAGING_AUTH_HASH(62)`: a 60-character bcrypt hash and its two quotes. Then the
    install, and the copy goes only if it worked:

    ```sh
    sudo app-apply edge env ~/incoming/edge.env && shred -u ~/incoming/edge.env
    ```

    If it refuses, the copy is fixed and the command run again. When the admin stops, either way,
    the copy goes with `shred -u ~/incoming/edge.env`: it holds the server team's values too. The
    two lines also go into the password manager, as the edge has no settings archive. Then the
    recreate, and Caddy and the live tree checked:

    ```sh
    sudo app-compose edge up -d     # between 01:00 and 07:00 IST, on the night the owner picks
    sudo app-compose edge ps
    sudo app-apply edge validate
    ```

    `edge-caddy-1` is `Up` and turns `(healthy)` within about a minute, and `validate` prints
    `the live edge tree is valid`. If `up -d` fails or Caddy doesn't turn healthy, its output and
    Caddy's journal (`sudo journalctl CONTAINER_NAME=edge-caddy-1 -n 20 -o cat --no-pager`) say
    why; no site answers while Caddy is down. The way back puts back the `edge.env` this install
    replaced and recreates Caddy again: `app-apply` keeps the last five it replaced as
    `edge.env.<time>`, the time in UTC (`YYYYMMDDTHHMMSSZ`), in `/var/lib/app-apply/srv/edge/`
    (`sudo ls` lists them), the newest the one from before this install. It holds until MenuMesh's
    site file is in, whose `{$MENUMESH_…}` names need the two lines:

    ```sh
    sudo app-apply edge env /var/lib/app-apply/srv/edge/edge.env.<time>
    sudo app-compose edge up -d     # between 01:00 and 07:00 IST, the same night
    ```

    The recreate drops every connection on the shared edge, hence the window. It also takes the
    server team's digest pin of Caddy, put in before `edge.env` (above), as their `edge.md` §5,
    step 7, says: one recreate for both. That night comes only after:
    - (a) the server team's two PRs, their scripts and their onboarding, are merged, and their kit
      is refreshed on the server with their fix of hostwatch's alerts in it, merged as `ccb9388`
      (nanu1605/jainav-infotech#87), which the server team confirms in their chat, as for step 16
      (their kit records no commit on the server): until then the alerts that hostwatch's 5-minute
      and daily runs raise reach no one on Telegram, and the staging night's leak test and `backup`
      turning unhealthy (Logs and alerts (VPS), WAL alerts) rely on them. The refresh and their word
      come before that night's `edge.env` lines: on an earlier night, or as that night's first step,
      as the server team plans it for their re-apply night (VPS-146);
    - (b) `menumesh.in` is on Cloudflare (step 8), its Origin CA certificate made from a CSR
      generated on the server (above);
    - (c) the owner has the staging hash, `aop-ca.pem` and `aop-client.pem`, and the client pair is
      uploaded for `menumesh.in` (step 8);
    - (d) steps 9 to 11 are done up to the `edge.env` lines: the conf, the deploy user and its
      token, the redaction file, the certificate with `aop-ca.pem`, the snippet and the digest
      pin.

    Steps 12 to 21 need not wait for that night; the staging night does (The server rehearsal and
    the cut-over, part 3, Before it). The hash comes from the owner, who makes it on their own
    machine with the edge's pinned Caddy image and bcrypt, the only kind `app-apply` takes, never on
    the server: there staging's password would stay in the shell's history and show in the process
    list. Without `--plaintext`, Caddy reads the password from the terminal without echoing it, and
    the admin gets only the hash:

    ```sh
    docker run --rm -it caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0 caddy hash-password --algorithm bcrypt
    ```

12. `/srv/menumesh` and `config/`:

    ```sh
    sudo install -d -m 0750 -o root -g root /srv/menumesh /srv/menumesh/env
    sudo cp -R ~/incoming/config /srv/menumesh/config     # deploy/vps/config as it is
    sudo install -m 0644 ~/incoming/prod-ca-2021.crt /srv/menumesh/config/migrate/supabase-ca.crt
    sudo chown -R root:root /srv/menumesh/config
    sudo find /srv/menumesh/config -type d -exec chmod 0755 {} +
    sudo find /srv/menumesh/config -type f -exec chmod 0644 {} +
    ```

13. The settings archive's timer at 20:20 UTC, ten minutes before the backup:
    `sudo systemctl edit app-config-archive@menumesh.timer` with these lines (the empty
    `OnCalendar=` clears the default time), then, once `.env` is in place (step 14),
    `sudo systemctl enable --now app-config-archive@menumesh.timer`:

    ```ini
    [Timer]
    OnCalendar=
    OnCalendar=*-*-* 20:20:00 UTC
    ```

    `systemctl list-timers 'app-config-archive@*'` then shows its next run at 20:20 UTC. Until the
    first deploy (step 18) writes `deploys.log`, a run archives the rest without it and alerts
    `app-config-archive menumesh: archived without deploys.log, which do not exist`, which wants
    nothing then. The order is step 9's `BACKUP_RECIPIENT` (its `grep` prints the key), then this
    drop-in, then the enable: before the key, every run fails and alerts; without the drop-in, the
    timer runs at 20:50 UTC, after the 20:30 backup. So the
    `systemctl enable --now app-config-archive@menumesh.timer` that the server team's `install.sh`
    prints among its timers waits for this step too.

**The owner, on the server:**

14. The env files, then `images.env` as it is, five `:none` lines that only `app-deploy` changes
    from then on:

    ```sh
    sudo install -m 0600 -o root -g root ~/incoming/.env /srv/menumesh/.env
    sudo install -m 0600 -o root -g root ~/incoming/web.env /srv/menumesh/env/web.env
    sudo install -m 0600 -o root -g root ~/incoming/web-staging.env /srv/menumesh/env/web-staging.env
    sudo install -m 0644 -o root -g root ~/incoming/images.env.example /srv/menumesh/images.env
    ```

    Then the three copies `scp` left in `~/incoming`, which hold every secret of the install, go
    (`~/incoming` is `ops`' own, 0700, as the server team's `install.sh` makes it, so no other user
    could read them meanwhile):

    ```sh
    shred -u ~/incoming/.env ~/incoming/web.env ~/incoming/web-staging.env
    ```

15. `sudo app-apply menumesh compose ~/incoming/compose.yml`. It checks the file and every file it
    mounts, checks that the two edge networks exist and are internal (they do: the server's Caddy
    has joined them since 2026-11-16; it would create a missing one), creates
    `/srv/menumesh/backup-out`, and pins the file's sha256: `app-deploy` refuses to deploy while the
    installed file differs from it. Before it, the server team's check of the two networks (their
    `edge.md` §5, step 2), whose two lines each show `internal=true` and `edge-caddy-1`; where one
    doesn't, their chat hears of it before the install:

    ```sh
    sudo docker network inspect -f '{{.Name}} internal={{.Internal}}:{{range .Containers}} {{.Name}}{{end}}' edge-menumesh edge-menumesh-staging
    ```

16. Not before the server team confirms in their chat that authenticated origin pulls are on and
    tested for every zone of the server, `jainavinfotech.in` included (their gate before an app's
    first container; on 2026-11-21 `tls_jainav`'s `client_auth` was still commented out): until
    then this step, and every step after it, waits. Then, on the server and before `db`'s first
    container, the proof their `edge.md` §5, step 8, gives: a TLS connection without a client
    certificate to each of Jainav's four hosts must fail in the handshake, every line ending in an
    exit status other than 0:

    ```sh
    for h in jainavinfotech.in www.jainavinfotech.in staging.jainavinfotech.in analytics.jainavinfotech.in; do curl -sk -o /dev/null --max-time 5 --resolve "$h:443:127.0.0.1" "https://$h/"; echo "$h exit $?"; done
    ```

    If one ends in 0, stop: the server team's round of origin pulls comes first, and this step
    waits for it. Then the database, then the Supabase services:
    `sudo app-compose menumesh up -d db`, and once it is healthy
    (`sudo app-compose menumesh ps --format '{{.Service}} {{.Status}}'` shows `db Up … (healthy)`),
    `sudo app-compose menumesh up -d auth rest realtime storage api-gw`, each `(healthy)` in the same
    list within a minute. Auth and Storage make their own schemas at their first start, and the
    first migration needs them (VPS-39).

17. **GitHub** (Secrets (VPS), below): the variables, `VPS_IMAGES` set to `true`, and the secrets;
    then Actions → **VPS ping**. While `VPS_IMAGES` is off, the backup image's and the release's
    workflows skip their job and push nothing; once it is on, each merge to `main` also builds the
    staging and migrate images (a few billed minutes), so it may go off again between the
    rehearsal's builds. `PRODUCTION_SUPABASE_URL` (`https://api.menumesh.in`) and
    `PRODUCTION_SUPABASE_PUBLISHABLE_KEY` (the server's own) are set before the first **VPS
    release**, which builds them in. `VPS_DEPLOY_STAGING` waits for the staging night (The server
    rehearsal and the cut-over, part 3): it moves staging's deploys off Vercel.
18. The backup image: Actions → **VPS backup image** → Run workflow on `main`, then, with a GitHub
    token that can read packages typed at the prompt:

    ```sh
    read -rs PAT && printf '%s\n' "$PAT" | sudo app-deploy menumesh backup backup-<sha>@sha256:<digest>
    ```

19. The first deploys, which run the migrations: production by a release (Deploys on the VPS), and
    staging by hand until the staging night turns CI's deploy on, as in Production, step 2, there,
    with `staging` in place of `production` and the two references that a **VPS build** run's
    summary printed. No smoke test reaches a deploy before DNS, so check each from inside its
    container (`web-staging` in place of `web` for staging): the line printed is `200` and
    `{"status":"ok","db":"ok","version":"<commit>",…}`.

    ```sh
    sudo app-compose menumesh exec -T web node -e "fetch('http://127.0.0.1:3000/api/health').then(async (res) => console.log(res.status, await res.text()))"
    ```

20. Production's scheduler: `sudo app-compose menumesh up -d scheduler`, healthy at its first
    answered minute call. It runs on a fresh database: no restaurant to remind, no digest until the
    first admin joins (it goes to joined admins only: The server rehearsal and the cut-over, part
    4), and the rest cleans up or counts what is there. `scheduler-staging` starts only on the
    staging night, once Vercel staging's cron jobs are disabled (part 3, step 5): until then those
    run staging's `daily` and `digest` on the same hosted database at the same minutes, and
    `web-staging` keeps the image deployed here by hand while each merge moves Vercel staging and
    that database on. It stays without a container until then: `up -d` creates only the services
    it names and what they depend on, nothing depends on `scheduler-staging`, and `app-deploy`
    swaps one service with `--no-deps`. So leave it out of every command that names it until that
    step (Secrets (VPS), Rotation; The scheduler (VPS), A call by hand and After a change; Backups
    and restore (VPS), Disaster recovery, step 7), and never run `up -d` without service names.
    hostwatch checks only the containers there are, so its absence raises nothing.
21. A first restore test and point-in-time drill once a night has run and the WAL has been
    shipping for an hour, before the first restaurant (Backups and restore (VPS)).
22. At the staging night (The server rehearsal and the cut-over, part 3):
    `sudo app-apply menumesh site ~/incoming/menumesh.caddy` (the redaction file is in since
    step 9), then the origin test of authenticated origin pulls for its four hosts (part 3, step 1);
    then the admin's leak test (the server team's `edge.md` §6 with MenuMesh's own pieces, through a
    temporary `leaktest.menumesh.in` record, with a made-up 16-character `/t/` token, which the log
    must show as `/t/_`), before any app record moves; then DNS, staging's that night and
    production's on a night of its own (part 4).

### Secrets (VPS)

`pnpm vps:secrets --out <folder>` writes the server's three secret files from the templates in
`deploy/vps/env/`: every value the stack makes for itself is generated, and the owner's own values
stay empty under `# FILL IN` lines, which Compose refuses to start with.
`pnpm vps:secrets --check <folder>` checks the files by name and prints no value. Copy them to the
server (First install, step 14), keep the values in the password manager, and delete the folder. The
generator never overwrites a file without `--force`, and a running stack keeps its old values: new
ones are for a new install or a planned rotation.

- `/srv/menumesh/.env` (0600): what `compose.yml` reads. Generated: `POSTGRES_PASSWORD`, the
  Supabase keys, `SECRET_KEY_BASE`, `REALTIME_DB_ENC_KEY`, `SITE_URL`, `SUPABASE_PUBLIC_URL`, both
  cron secrets and the backup's signing pair (`BACKUP_SIGNING_KEY`, `BACKUP_SIGNING_PUBLIC_KEY`).
  The owner's: the heartbeat addresses, the backup's key, bucket and token,
  `HEARTBEAT_BACKUP_URL`, `HEARTBEAT_WAL_URL` and Telegram, and hosted staging's pooler login (`STAGING_DB_*`).
- `/srv/menumesh/env/web.env` (0600): production's app settings. Generated: `STAFF_EMAIL_DOMAIN` and
  `CUSTOMER_COOKIE_SECRET`. The owner's: Razorpay's live keys, Resend, the menu readers, Turnstile
  and Sentry's read token.
- `/srv/menumesh/env/web-staging.env` (0600): hosted staging's `SUPABASE_SECRET_KEY`, its own
  `STAFF_EMAIL_DOMAIN` and `CUSTOMER_COOKIE_SECRET` (generated), Razorpay's test keys, and the
  optional rest.
- `/srv/menumesh/images.env` (0644): the five image references, `:none` at first, then
  `app-deploy`'s.
- The admin's: `BACKUP_RECIPIENT` in `/etc/apps/menumesh.conf` (the backup key's public half), and
  `MENUMESH_STAGING_AUTH_USER` and `MENUMESH_STAGING_AUTH_HASH` in `/srv/edge/edge.env` (the hash of
  staging's password, which the owner makes off the server: First install, step 11).

Never on the server: the backup key's private half, the bucket's admin login, staging's password
itself (in the password manager; testers get it from the owner) and the GitHub secrets. The
signing key's private half is on the server, in `.env`, since the nightly job signs with it, and
in the password manager, from which a recovery from an older settings archive takes the current
one (Disaster recovery, step 2): a reached server means a new pair, and the old public key out of
the list (Rotation).
`SUPABASE_PUBLISHABLE_KEY` is also the production image's built-in key, the GitHub variable below.

**GitHub** (Settings → Secrets and variables → Actions, at the repository level), for the VPS
workflows:

- Variables: `VPS_IMAGES` and `VPS_DEPLOY_STAGING`, the two switches (`true` turns each on: the
  first builds and pushes images, the second deploys staging too and turns the Vercel staging job
  off); the build values `STAGING_SUPABASE_URL` and `STAGING_SUPABASE_PUBLISHABLE_KEY` (the hosted
  staging project's), `PRODUCTION_SUPABASE_URL` (`https://api.menumesh.in`) and
  `PRODUCTION_SUPABASE_PUBLISHABLE_KEY` (`SUPABASE_PUBLISHABLE_KEY` from the server's `.env`),
  beside the existing `STAGING_APP_URL` and `PRODUCTION_APP_URL`; and `SENTRY_DSN`, `SENTRY_ORG`,
  `SENTRY_PROJECT`, `POSTHOG_KEY` and `POSTHOG_HOST`, the public values Vercel has today.
- Secrets: `SENTRY_AUTH_TOKEN` (there already); `VPS_SSH_HOST` (the tunnel's SSH host name),
  `VPS_SSH_USER` (`deploy-menumesh`), `VPS_SSH_KEY` (the private half of `gha-menumesh-staging`),
  `VPS_KNOWN_HOSTS` (the host name, a space and the server's `/etc/ssh/ssh_host_ed25519_key.pub`),
  `VPS_ACCESS_CLIENT_ID` and `VPS_ACCESS_CLIENT_SECRET` (the Access service token
  `github-deploy-menumesh`), and `STAGING_SMOKE_BASIC_AUTH` (`user:password` of staging's basic
  auth).
- Then Actions → **VPS ping** → Run workflow must print `pong menumesh staging` (one billed minute).

**Rotation.** After changing `.env` or an env file, `up -d` the services that read it, which
recreates them; a `restart` keeps the old values.

- `CRON_SECRET` or `STAGING_CRON_SECRET`: a new 32-byte base64url value in `.env`, then
  `sudo app-compose menumesh up -d web scheduler` (staging: `web-staging scheduler-staging`, or
  `web-staging` alone until the staging night's step 5 has started `scheduler-staging`: First
  install, step 20); the minute between the two may log one 401 line.
- A value in `env/web.env` or `env/web-staging.env`: the provider's step as in Rotating secrets, the
  edited file installed again and its copy in `~/incoming` shredded (First install, step 14), then
  `up -d web` (or `web-staging`). A new `CUSTOMER_COOKIE_SECRET` gives phones new device ids, as on
  Vercel.
- Production's `SUPABASE_SECRET_KEY`: a new key from a fresh `pnpm vps:secrets --out <new folder>`
  (that value only) in `.env`, then `up -d api-gw web` together; the old key stops working at once.
- Hosted staging's pooler login (`STAGING_DB_*`): a new database password for hosted staging (its
  dashboard's database settings), then `STAGING_DB_PASSWORD` in `.env` and the GitHub secret
  `STAGING_SUPABASE_DB_PASSWORD`; only `migrate-staging` reads it, at the next staging deploy.
- The bucket's token, Telegram and the heartbeat addresses: `.env`, then `up -d backup`, and
  `scheduler scheduler-staging` for the heartbeats (`scheduler` alone until the staging night's
  step 5: First install, step 20). A bucket token someone else may hold, or a
  leaked `.env`: A stolen or leaked bucket token (VPS). A leaked `.env` leaked every value in it,
  so the backup's heartbeat addresses and the bot's token go new with the token, and so, each by
  its step here, do both cron secrets, the schedulers' heartbeat addresses, hosted staging's
  pooler login and, in the planned window below, the API keys and `POSTGRES_PASSWORD`.
- The backup key: a new pair, the admin's `BACKUP_RECIPIENT` and the owner's `BACKUP_AGE_RECIPIENT`
  changed the same day, then `up -d backup`. Keep the old private key while its backups (366 days)
  can be needed. A night's settings archive (20:20 UTC, to `BACKUP_RECIPIENT`), its parts (20:30
  UTC, to `BACKUP_AGE_RECIPIENT`) and the WAL already in the outbox at `up -d backup` can then be
  on either side of the switch, so a restore test, drill or recovery that reads backups from both
  sides needs both private keys in `identity.txt`, one after the other (age tries each): with one,
  it stops at the first file only the other opens.
- The signing key (after the server may have been reached, or yearly if the owner likes): a new pair
  from a fresh `pnpm vps:secrets --out <new folder>` (those two values only). In `BACKUP_SIGNING_KEY`
  put the new private key, and in `BACKUP_SIGNING_PUBLIC_KEY` the new public key **first**, then a
  space and each old public key whose nights or WAL may still be needed (366 days for the monthly
  copies, 15 for the WAL): a restore accepts any key listed, the backup signs with the first and
  checks it against the first. The new private key also goes into the password manager, in the old
  one's place: a recovery on a new server from a settings archive made before this rotation takes
  it from there (Disaster recovery, step 2). Check the pair with the one-off of Disaster recovery,
  step 4, then `up -d backup`; the nights and WAL files signed from now on carry the new key, and
  the old ones stay readable while its public key stays in the list. Drop an old key from the list
  when none of its nights is left. A key a thief may have held leaves the list at once, though the
  real nights it signed go with it: anything it signed could be the thief's, and a point-in-time
  recovery has no other guard. So does every other key of the list whose private half was on the
  server since the trouble could have begun, the first among them where the thief's was an older
  one, while one whose private half had left the server before the trouble could have begun stays,
  after the new key. Their public keys are then kept apart, in a file of their own marked stolen,
  for the one-run uses of A stolen or leaked bucket token (VPS), step 5. Each time, the whole new
  list, as `BACKUP_SIGNING_PUBLIC_KEY=<list>`, takes the place of the kept one, in its file of its
  own beside the age key: a recovery on a new server trusts that copy and no other.
  Then run the restore test and the point-in-time drill, since both read the list. Where root
  may have reached the server, they run on the rebuilt server only, as both put the backup key's
  private half on it (A stolen or leaked bucket token (VPS), step 5).
- Staging's password: a new hash, made off the server as in First install, step 11, which the admin
  puts in `edge.env` through that step's merged copy, its old `MENUMESH_STAGING_AUTH_HASH` line
  taken out of the copy before the newline guard, as a second line of that name is refused
  (`sed -i '/^MENUMESH_STAGING_AUTH_HASH=/d' ~/incoming/edge.env`), and the new line alone pasted;
  then that step's check of the names and lengths and its install and shred (`app-apply edge env`);
  then recreate Caddy between 01:00 and 07:00 IST, as it drops every connection on the shared
  edge, and check it as that step does. The new line takes the old one's place in the password
  manager; then the GitHub secret `STAGING_SMOKE_BASIC_AUTH`; and the testers.
- The deploy key or the Access token: a new key pair (the admin swaps the public half) or token,
  then the GitHub secrets.

The rest are set once at install, and changing any of them is a planned window that has not been
rehearsed yet: rehearse it with `pnpm vps:rehearse` first.

- **The API keys expire** five years after `pnpm vps:secrets` made them (the date is in `.env`'s
  header). Take a whole new set of keys from a fresh `pnpm vps:secrets --out <new folder>`:
  `JWT_SECRET`, `JWT_KEYS`, `JWT_JWKS`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `ANON_KEY_ASYMMETRIC`,
  `SERVICE_ROLE_KEY_ASYMMETRIC`, `SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` go together,
  and every other value stays. Set the GitHub variable `PRODUCTION_SUPABASE_PUBLISHABLE_KEY` and run
  a release, then in one window put the new `.env` in place,
  `up -d auth rest realtime storage api-gw` and deploy the release. Tokens signed with the old key
  stop working, so expect sessions to need a new sign-in.
- **`POSTGRES_PASSWORD`** is set only when the database volume is made: changing it takes
  `ALTER ROLE … PASSWORD` for `supabase_admin`, `postgres`, `authenticator`, `supabase_auth_admin`,
  `supabase_storage_admin`, `supabase_functions_admin` and `pgbouncer`, then `.env`, then `up -d` of
  every service. `SECRET_KEY_BASE` and `REALTIME_DB_ENC_KEY` belong to Realtime's stored tenant:
  leave them.

### The server rehearsal and the cut-over

The cut-over in six parts, in order (docs/DECISIONS.md VPS-109 to VPS-129, VPS-135 to VPS-137,
VPS-139, VPS-142 and VPS-143). Production starts fresh on the server: nothing is copied from hosted
production, the first platform admin comes from a one-time link made on the server, and the
settings edited by hand in `/super` are typed again (VPS-110). Staging moves on a night of its own
before production's. For 14 days after production's night, Vercel and the paused hosted project
stay the way back (part 5); then the Vercel parts go, in a stop of their own (part 6). The
contract's order holds: rehearse with the limits and no site file, then install the site file, then
change DNS last. Each step says what it must show and its way back. The server team's steps stay in
their runbooks, named where they come: `edge.md` §3 (the Origin CA certificate from a CSR,
authenticated origin pulls and their origin test), §5 (adding an app) and §6 (the leak test),
`launch.md` and `cloudflare.md`.

#### 1. Before the server (any day, each step reversible)

1. **Hosted production, read-only.** In its SQL editor (Supabase → the production project → SQL
   Editor), the rows of each of the app's tables, and the logins, in one statement, as the editor
   shows only the last statement's result:

   ```sql
   select table_schema, table_name,
     (xpath('/row/n/text()', query_to_xml(
       format('select count(*) as n from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint as rows
   from information_schema.tables
   where table_schema in ('public', 'private') and table_type = 'BASE TABLE'
   union all
   select 'auth', 'users', (select count(*) from auth.users)
   order by rows desc, 1, 2;
   ```

   The logins are the `auth` `users` row; every other row is a table of the app's.
   `restaurants` must have 0 rows. If any restaurant exists, stop: the fresh start no longer fits,
   and moving its data needs a plan of its own (VPS-110). Note whether `site_leads` has rows (they
   are exported on the production night) and run the locale query of First install, step 4. Way
   back: nothing changed.

2. **The zone, from GoDaddy to Cloudflare** (`menumesh.in`'s DNS is at GoDaddy today):
   - GoDaddy → the domain's DNS: export the zone file. If DNSSEC is on there, turn it off and wait a
     day before the nameservers change: a change while DNSSEC is on can make the domain
     unreachable. Cloudflare's own DNSSEC can go on once the zone is active.
   - Cloudflare → add the domain `menumesh.in` and import the zone file (DNS → Records → Import and
     Export). Compare every record with GoDaddy's, one by one, and add what the
     import missed: Vercel's apex, `www` and `staging`; Resend's sending records (its DKIM `TXT`,
     and the `MX` and SPF `TXT` of its sending subdomain); DMARC (`_dmarc`), if it exists; the `MX`
     records of GoDaddy's mail forwarding; Search Console's `TXT`; and any other.
   - Vercel's records stay **DNS only** (the grey cloud), so that Vercel serves them as today, with
     its own certificates; the mail and verification records are DNS only too. Write down each of
     Vercel's records, its name, type and value, in the password manager: they are the way back
     (part 5).
   - GoDaddy → the domain's nameservers: Cloudflare's two, as its Overview page names them.
     Cloudflare emails once the zone is active, within 24 hours.
   - Once it is active: `nslookup -type=ns menumesh.in 1.1.1.1` names Cloudflare's nameservers;
     `https://menumesh.in` and `https://staging.menumesh.in` load from Vercel as before; a mail to a
     forwarded address arrives; and Resend → Domains still shows `menumesh.in` verified.

   Way back: GoDaddy's own nameservers again, with the exported file's records put back there if
   its DNS page lost them.

3. **`menumesh.app` and `menumesh.co`** (docs/DECISIONS.md VPS-24, Other domains): each zone moves
   to Cloudflare as in step 2, then gets proxied `A` records for its apex and `www` to the
   placeholder `192.0.2.1` (never the server's address), one Single Redirect for every request to
   `concat("https://menumesh.in", http.request.uri.path)` with status 308 and the query string kept,
   and Always Use HTTPS. They need nothing from the server. Check:
   `curl -sI 'https://www.menumesh.co/pricing?a=1'` answers 308 with
   `location: https://menumesh.in/pricing?a=1`, and so do both apexes and `www.menumesh.app`. Way
   back: their nameservers as they were, where Vercel redirects them as today.
4. **The zone's settings for `menumesh.in`.** They act on proxied records only, so Vercel's DNS-only
   ones are untouched:
   - SSL/TLS: Full (strict). Edge Certificates: Always Use HTTPS on, Minimum TLS Version 1.2, and
     HSTS off here: the app sends its own (`max-age=63072000`).
   - Security: Bot Fight Mode off, since no rule can exempt the webhooks from it, and a WAF custom
     rule with the Skip action of the server team's `cloudflare.md` for
     `starts_with(http.request.uri.path, "/api/webhooks/")`, Razorpay's and Resend's calls.
   - Nothing that rewrites pages: Email Address Obfuscation, Rocket Loader, Web Analytics'
     automatic setup and Zaraz off. Each puts a script into the page, which the
     Content-Security-Policy refuses.
   - Caching → Cache Rules: one rule, Eligible for cache, for the menu photos and logos, and no
     other: nothing may cache HTML or `RSC: 1` answers (VPS-7). Its expression:

     ```text
     http.host eq "api.menumesh.in" and starts_with(http.request.uri.path, "/storage/v1/object/public/")
     ```

   - Authenticated origin pulls come zone-level, with MenuMesh's own client certificate, which the
     owner makes and uploads (First install, step 8), and its CA, which the admin installs on the
     server (step 11).

   Way back: each setting as it was.

#### 2. The server rehearsal (nothing public)

No record points at the server and the site file waits for the staging night, so nothing here is
public, and Vercel and hosted Supabase serve as before. Way back, for the whole part: none needed.

1. First install, steps 1 to 21, in order, each with its check. Step 16 waits for the server team's
   word in their chat that authenticated origin pulls are on for every zone of the server, and
   step 11's `edge.env` and recreate may come after step 21, on their own night before the staging
   night. Production's first deploy (step 19) is a **VPS release** of a commit whose **VPS build**
   ran on `main`, so that it reuses that run's migrate image; a version used here is never used
   again.
2. On the server, each with what it must show:
   - `sudo hostwatch check`: its last line is `hostwatch check: clean`.
   - `sudo app-compose menumesh ps --format '{{.Service}} {{.Status}}'`: every long-running service
     `Up … (healthy)` except `scheduler-staging`, which has no container until the staging night
     (First install, step 20).
   - A staging and a production deploy (Deploys on the VPS), each with its line in `deploys.log`,
     production's with its pre-deploy dump (`sudo ls -l /srv/menumesh/predeploy`); then a rollback
     by hand to the release before, and the newer one deployed again.
   - The night's backup (Last night's backup), then the first restore test and point-in-time drill
     (First install, step 21).
   - Production's scheduler's first minutes: healthy within about 2 minutes of its start, and a day
     later still healthy, with one line each for `daily` and `digest`,
     `cron-call daily: HTTP 200 in N s` and `cron-call digest: HTTP 200 in N s` (staging's come
     on the staging night, part 3, step 9):

     ```sh
     sudo journalctl COM_DOCKER_COMPOSE_PROJECT=menumesh COM_DOCKER_COMPOSE_SERVICE=scheduler --since -1d -o cat
     ```

   - The stops of `scheduler` and `backup`, about a second each with exit 143, never a kill:

     ```sh
     time sudo app-compose menumesh stop scheduler
     sudo docker inspect --format '{{.State.ExitCode}}' menumesh-scheduler-1
     sudo app-compose menumesh start scheduler
     ```

     and the same three for `backup` (`menumesh-backup-1`).

   - A whole day's lines in the journal, well under the budget of 45,000, as hostwatch's daily
     report counts them too:

     ```sh
     sudo journalctl COM_DOCKER_COMPOSE_PROJECT=menumesh --since yesterday --until today -o cat | wc -l
     ```

   - Envoy's `cluster.rest.upstream_cx_destroy_remote` staying near 0, read from its admin page on
     `127.0.0.1:9901` inside `api-gw`, whose image has no curl; the answer holds the line
     `cluster.rest.upstream_cx_destroy_remote: <n>`:

     ```sh
     sudo app-compose menumesh exec -T api-gw bash -c 'exec 3<>/dev/tcp/127.0.0.1/9901 && printf "GET /stats?filter=upstream_cx_destroy_remote HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n" >&3 && cat <&3'
     ```

3. The stop of `web` with work in flight waits for the staging night (part 3, step 8), where the
   owner's test restaurant makes that work; production's fresh database has none.

#### 3. The staging night

Staging moves first, on a night of its own (VPS-116): any quiet night outside the blackouts (Deploys
on the VPS, When to deploy), with no merge to `main` while it runs other than step 6's. Before it:

- Caddy recreated since `edge.env` took MenuMesh's two lines (First install, step 11). This prints
  `2`, counting names only, never showing the hash; until it does, step 1's site file is refused:

  ```sh
  sudo docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' edge-caddy-1 | grep -c '^MENUMESH_STAGING_AUTH_'
  ```

- A day ahead, the TTL of Vercel's `staging` record set to 1 min (Cloudflare → DNS → the record), so
  that resolvers drop Vercel's answer within a minute of the change.
- `web-staging.env` holds Vercel staging's own `STAFF_EMAIL_DOMAIN` (`staging.menumesh.in`) and
  `CUSTOMER_COOKIE_SECRET`, from the password manager, so that the staff logins, codes, invite links
  and device ids staging's database already holds keep working (a new secret only ends them), and
  the `RAZORPAY_WEBHOOK_SECRET` and `RESEND_WEBHOOK_SECRET` of the Razorpay and Resend dashboards'
  staging webhooks (First install, step 6). Where a value differs, the file is installed again,
  then `up -d web-staging` (Rotation).
- **The same day**, with no merge to `main` between it and step 6's, `web-staging` on the commit
  Vercel staging serves, `main`'s newest: a by-hand deploy as in First install, step 19, of the
  staging and migrate references of the **VPS build** run of that commit (so `VPS_IMAGES` is on
  for that merge; with it off, none was built), checked from inside as there, its `version` that
  commit. Until then `web-staging` keeps the image last deployed there by hand (First install,
  step 19, or the rehearsal's deploys), which CI never replaces while `VPS_DEPLOY_STAGING` is off,
  though each merge moved Vercel staging on and migrated staging's database, and migrations stay
  compatible for one release only; step 3 sends testers to it, and step 6's deploy comes after.

Then, in order:

1. **The site file** (First install, step 22; the redaction file is in since step 9):
   `sudo app-apply menumesh site ~/incoming/menumesh.caddy`. Caddy serves the four hosts
   from now on, but no record sends it anything yet. Then, on the server, the origin test of
   authenticated origin pulls for this zone (the server team's `edge.md` §6, step 4), which only
   now tests these hosts (First install, step 11). Each host `menumesh.caddy` serves, every block
   of it importing `tls_menumesh`, must fail in the handshake, its exit not 0:

   ```sh
   for h in menumesh.in www.menumesh.in staging.menumesh.in api.menumesh.in; do curl -sk -o /dev/null --max-time 5 --resolve "$h:443:127.0.0.1" "https://$h/"; echo "$h exit $?"; done
   ```

   An exit 0 means the server's `tls_menumesh` has no `client_auth`, so its `snippets.caddy` is not
   the server team's of `66c8c61` or later: stop. The night goes no further until the admin has
   installed theirs again (First install, step 11) and every exit is not 0. Way back: none needed,
   as no record sends the server anything yet.

2. **The leak test**, by the admin (the server team's `edge.md` §6), through a temporary `A` record
   `leaktest.menumesh.in` to the server's IPv4, proxied, which the owner adds, before any app record
   moves (VPS-115), with MenuMesh's pieces in place of theirs: an app has one site file, whose hosts
   stay in its `ZONE` and whose upstreams are its `UPSTREAMS`. The admin, who runs the server's
   steps, tells the server team's chat before the container starts. First, on the server, as their
   §6 begins, in this order: `menumesh-leaktest:80` goes into `UPSTREAMS` in
   `/etc/apps/menumesh.conf` for the test (`sudoedit /etc/apps/menumesh.conf`; the image listens on
   port 80); the throwaway container that answers with the request's headers runs on
   `edge-menumesh` as `menumesh-leaktest` (an upstream is `menumesh-<name>:<port>`), from an image
   pinned by its index digest and pulled first, so that a failed pull shows on its own, with no
   capability, no new privileges and a read-only root, and without the `kit.throwaway` label, which
   only `app-apply`'s own containers carry (`--rm` removes it once it is stopped):

   ```sh
   sudo docker pull traefik/whoami:v1.12.0@sha256:c4717a8d1f0134a7444e24f881160e033991f23027c6c5a9a3f8fd22e70d1d44
   sudo docker run -d --rm --name menumesh-leaktest --network edge-menumesh --network-alias menumesh-leaktest --memory 64m --cpus 0.25 --cap-drop ALL --security-opt no-new-privileges --read-only traefik/whoami:v1.12.0@sha256:c4717a8d1f0134a7444e24f881160e033991f23027c6c5a9a3f8fd22e70d1d44
   ```

   then a copy of the installed `menumesh.caddy` (with `sudo`: `/srv/edge` is root's alone), kept
   for step 5, and a second copy with one more block, which imports what the others import,
   installed in its place:

   ```sh
   sudo cat /srv/edge/config/sites/menumesh.caddy > ~/incoming/menumesh-live.caddy
   cp ~/incoming/menumesh-live.caddy ~/incoming/menumesh-leaktest.caddy
   cat >> ~/incoming/menumesh-leaktest.caddy <<'EOF'

   https://leaktest.menumesh.in {
       import site_common
       import tls_menumesh
       reverse_proxy menumesh-leaktest:80 {
           import upstream
       }
   }
   EOF
   sudo app-apply menumesh site ~/incoming/menumesh-leaktest.caddy
   ```

   While the container runs, hostwatch's 5-minute check reports
   `networks: edge network rules broken: menumesh-leaktest@edge-menumesh:wrong-project` on every
   run, as critical (a container started with `docker run` is no service of a compose project),
   which the chat expects, as for the server team's own test: Telegram gets it once, then again
   every 6 hours while it lasts. Nothing else should show: its `--network-alias`, listed in
   `UPSTREAMS`, keeps hostwatch from adding `not-an-upstream` (hostwatch reads the container's
   network aliases, not its name), and its `--memory` and `--cpus` keep it out of the limits alert.
   Their steps 1 to 4 must then show, with `zone=menumesh.in` set on the admin's machine for step
   1's `curl`:
   - forged headers replaced: the echo server prints the headers it got, their names as Go writes
     them (`X-Real-Ip`, `Cf-Connecting-Ip`), and the four address headers, `X-Real-IP`,
     `X-Forwarded-For`, `CF-Connecting-IP` and `Sb-Forwarded-For`, each hold the admin's own
     address, `X-Forwarded-Host` is `leaktest.menumesh.in`, and `True-Client-IP`, `X-Client-IP` and
     `Forwarded` are absent. The server team's `upstream` snippet sets and removes them, and
     `menumesh.caddy` adds no header of its own, so these are what `menumesh-web`, `menumesh-gw`
     and `menumesh-web-staging` get;
   - the log line without an address, a header or a query, and a made-up 16-character `/t/` token
     in it shown as `/t/_`;
   - nothing answering straight on the server's addresses: `curl -4` and `curl -6` (from an
     IPv6-capable host) time out, and again with a temporary hPanel accept rule for the admin's own
     address, removed after, as the host's `DOCKER-USER` rules are a layer of their own;
   - and a TLS connection without the client certificate refused (step 1's test, the leak test's
     host added).

   Their step 5 here, in their order: first `menumesh.caddy` back as it was installed, from the
   kept copy (never removed: it is the zone's only site file), as the test block needs its
   `UPSTREAMS` entry, and `app-apply edge validate`, which hostwatch runs daily, refuses a site
   whose upstream isn't listed; then the container stopped (`--rm` removes it), so that hostwatch
   never sees it outside `UPSTREAMS`; then its `UPSTREAMS` entry taken out:

   ```sh
   sudo app-apply menumesh site ~/incoming/menumesh-live.caddy
   sudo docker stop menumesh-leaktest
   sudoedit /etc/apps/menumesh.conf     # menumesh-leaktest:80 out of UPSTREAMS
   ```

   The owner deletes the `leaktest` record. Then the two copies and the image go:

   ```sh
   rm ~/incoming/menumesh-live.caddy ~/incoming/menumesh-leaktest.caddy
   sudo docker image rm traefik/whoami@sha256:c4717a8d1f0134a7444e24f881160e033991f23027c6c5a9a3f8fd22e70d1d44
   ```

   hostwatch's next run is clean, and the one after it sends "resolved". Way back: step 5, as
   above, from wherever the test stopped.

3. **The `staging` record**: Vercel's record replaced by an `A` record to the server's IPv4,
   proxied. Way back: Vercel's written-down value again, DNS only.
4. **GitHub's variables**: `VPS_IMAGES` `true` (it may be already), `VPS_DEPLOY_STAGING` `true` and
   `DEPLOY_STAGING` `false`. From now on each merge to `main` builds staging and deploys it on the
   server, about 8 to 10 billed minutes, and never on Vercel. Way back: the three as they were.
5. **Vercel's staging project**: Schedules → Cron Jobs → **Disable Cron Jobs**.
   `CRON_SECRET` stays (part 6 takes it out). Then, with Vercel's calls stopped, `scheduler-staging`
   starts and runs staging's jobs alone: `sudo app-compose menumesh up -d scheduler-staging`, and
   within about 2 minutes `sudo app-compose menumesh ps --format '{{.Service}} {{.Status}}'` shows
   it `Up … (healthy)`. Way back: `sudo app-compose menumesh stop scheduler-staging` first, then
   **Enable Cron Jobs** there.
6. **The first deploy**: a merge to `main` runs CI, **VPS build** and **VPS deploy staging**, whose
   smoke job must pass. Way back: steps 3 to 5's.
7. **From this machine**, staging's pair (`user:password`) typed at the prompt, never on the command
   line, and `<commit>` the deploy's whole commit (40 hex characters, as `git rev-parse` prints it;
   the probe refuses a short one):

   ```sh
   read -rs SMOKE_BASIC_AUTH && export SMOKE_BASIC_AUTH
   pnpm vps:probe staging --version <commit>
   SMOKE_URL=https://staging.menumesh.in EXPECTED_VERSION=<commit> pnpm smoke
   ```

   The probe (docs/DECISIONS.md VPS-112) reads the pair from `SMOKE_BASIC_AUTH` alone and refuses
   to run without it, sends it over https to `staging.menumesh.in` only, and never prints it. It
   prints one line a check, `ok <check>`, `bad <check>: <why>` or `skip <check>: <why>`, then
   `vps:probe staging: 22 checks, 0 failed, 0 skipped`, and exits 0 only when no line is `bad`. Its
   checks: the record resolves only to Cloudflare's published addresses; https with a certificate
   Node trusts, and http redirected to it; 401 with `WWW-Authenticate: Basic` without the pair and
   200 with it; HSTS of a year or more; `/api/health` on `<commit>`; HTML and RSC answers never from
   Cloudflare's cache, and the RSC answer's `x-nextjs-deployment-id`; an unknown server action
   answered 409 with `x-nextjs-action-not-found: 1`; an Upgrade refused with 400; the seven open
   paths answering 200 without the pair, and both webhooks reaching the app without it (its refusal
   of a body without a valid signature, so nothing is stored); and `x-robots-tag` noindex. A `bad`
   line says what came instead: a Cloudflare error with its meaning, such as
   `522 (Cloudflare's connection to the origin timed out)`, `(Cloudflare challenged the request)`
   for a security rule in the way, or, for the record, the addresses outside Cloudflare's ranges,
   which a resolver can hold for the TTL's minute after the change: run it again. The smoke tests
   all pass.

8. **A stop with work in flight**, on the owner's test restaurant on staging: a data export asked
   for, Hindi names being written (where staging has a menu reader's key) and an announcement's
   emails going out to that restaurant (where it has Resend), then at once:

   ```sh
   time sudo app-compose menumesh stop web-staging
   sudo docker inspect --format '{{.State.ExitCode}}' menumesh-web-staging-1
   sudo app-compose menumesh start web-staging
   ```

   Exit 143 within seconds; the export queued again or ready; the batch's names written again within
   5 minutes; no email sent twice, as Resend's log shows (docs/DECISIONS.md, Tests (VPS Stop A2)).

9. **A day later**: `scheduler-staging` healthy, its `daily` and `digest` lines `HTTP 200`, and
   staging's heartbeat monitors quiet. Then hostwatch's daily digest line
   `lines (24 h, against budget): … menumesh <n>/45000 …` goes to the server team's chat. The three
   budgets, the server team's 30,000, the edge's 10,000 (the host's lines included) and MenuMesh's
   45,000 (Caddy's lines for its hosts included), fill the journal's 24G for its 187 days exactly,
   with no margin, so they are set again from real counts: these, and production's after its first
   week (part 4, step 9), as staging's alone understate production.

Way back, for the whole night: `scheduler-staging` stopped
(`sudo app-compose menumesh stop scheduler-staging`); the `staging` record to Vercel's value, DNS
only; the three variables as they were; then Vercel's staging cron jobs on.

#### 4. The production night

From 03:35 to 06:30 IST on a quiet weekday (VPS-117): after the server's 02:00 night and the 03:00
daily runs, inside maintenance (01:00 to 07:00 IST), clear of the blackouts (02:55 to 03:30 and
08:40 to 08:50) and hours before breakfast service. Before it:

- **The release**: a **VPS release** of a commit of `main` that went through VPS staging (its
  `migrate-<sha>` is staging's: VPS-41), such as `v1.0.0`, deployed on the server (Deploys on the
  VPS, Production) and healthy by the check from inside (First install, step 19). Its commit is the
  one the checks below expect.
- **The first admin's link**, made on the server with the tool within the 7 days before the night
  (The first platform admin (production)), kept in the password manager until it is opened.
- **The settings to type again**, noted from hosted production's `/super` while it still serves
  `menumesh.in` (step 4 lists them).
- **A day ahead**, the TTL of Vercel's apex and `www` records set to 1 min.
- `sudo hostwatch check` clean, and production's monitors (First install, step 3) on.

Then, in order:

1. **The records**, Cloudflare → DNS: first a new `A` record `api` to the server's IPv4, proxied
   (nothing uses it yet: Vercel's build calls hosted Supabase); then the apex and `www`, Vercel's
   records replaced by `A` records to the server's IPv4, proxied. From here `menumesh.in` is the
   server. Way back: part 5.
2. **From this machine**, with `<commit>` the release's whole commit (40 hex characters) and
   production's publishable key (`sb_publishable_…`, public: the GitHub variable
   `PRODUCTION_SUPABASE_PUBLISHABLE_KEY`), which lets the probe open Realtime's WebSocket through
   Cloudflare:

   ```sh
   PROBE_PUBLISHABLE_KEY=<production's publishable key> pnpm vps:probe production --origin <server IPv4> --version <commit>
   SMOKE_URL=https://menumesh.in EXPECTED_VERSION=<commit> pnpm smoke
   ```

   The probe ends with `vps:probe production: 31 checks, 0 failed, 1 skipped` and exits 0, and
   every smoke test passes. Its checks: `menumesh.in`, `www` and `api` resolve only to Cloudflare's
   published addresses, none to `--origin`, and each answers https with a certificate Node trusts
   and redirects http to it; on `menumesh.in` HSTS, `/api/health` on `<commit>`, HTML and RSC
   answers never from Cloudflare's cache, the RSC answer's `x-nextjs-deployment-id`, the unknown
   server action and the Upgrade, as on staging; `www` 308 to `https://menumesh.in`, the path and
   query kept; on `api`, 404 for `/`, `/pg/`, `/graphql/v1` and `/functions/v1/`, 401 for
   `/auth/v1/admin/users` and `/rest/v1/` without a key, and Realtime's WebSocket open;
   `menumesh.app`, `menumesh.co` and their `www` 308 to `https://menumesh.in`, the path and query
   kept; and the server's address taking no connection on 443 or 80 within 5 s, the leak test's
   step 3 from outside. A refusal there is `bad` too, as it shows the address answers; a connection
   on port 80 alone can be this machine's network: run it from another. The `skip` is the cache
   rule's, as no public object exists yet: after a restaurant's first photo, run it again with
   `--object <bucket>/<path>`, as in the object's URL after `/storage/v1/object/public/`
   (`menu-images/…`), whose second request must come from Cloudflare's cache. A resolver still
   holding Vercel's answer fails a DNS check for up to a minute, the TTL: run it again.

3. **The first platform admin**: open the link and choose the password, which signs in and goes on
   to enrol the authenticator (`/super/mfa`). Rename the authenticator app's old entry first (for
   example to `MenuMesh (hosted)`), so that the two don't mix during the 14 days.
4. **The settings typed again** in `/super`, as noted:
   - Platform settings: trial days, grace days, the setup fee, its launch discount and its last
     day, the support email and phone, the four restaurant-health values, and the database and
     storage limits (no Supabase plan sets them on the server: leave them empty, or set the size at
     which System health should warn).
   - Plans: each plan's name, monthly and yearly prices, table and staff login limits, order on the
     plans page, features and Active; and its Razorpay plan ids, monthly and yearly, only where
     hosted had them, typed in as they are and never made again with **Create … plan in Razorpay**,
     which would make a second plan in Razorpay's account.
   - Offers: each running offer's code, description, discount, plans, cycles, first charges, first
     and last day, most uses, and whether it is only for restaurants that haven't paid yet.
   - Team: each member hosted production had, invited again from Settings → Team with their role.
5. **Vercel's production project**: Schedules → Cron Jobs → **Disable Cron Jobs**. `CRON_SECRET`
   stays in its settings, so that the way back is one button (part 6 takes it out). Way back:
   **Enable Cron Jobs**.
6. **The leads**, if `site_leads` had rows (part 1, step 1): hosted production's dashboard → Table
   Editor → `site_leads`, then `lead_events`, each exported as CSV and kept offline. They are
   personal data: delete the files once they are no longer needed. Way back: nothing.
7. **Hosted production paused**: Supabase → the project → Settings → General → **Pause project**.
   It stays the way back for the 14 days. Way back: **Restore project** (part 5).
8. **`BACKUP_PRODUCTION`** `false` (GitHub → Settings → Secrets and variables → Actions →
   Variables), before 02:00 IST: the **Backup** workflow can't export a paused project, and its
   failed night emails the owner. Way back: `true`.
9. **That morning and the next night**: the 08:45 digest, from the server alone when Resend is set
   (`cron-call digest: HTTP 200 in N s` in `scheduler`'s lines); at 02:00 IST the server's night and
   its heartbeat (Last night's backup); the WAL's heartbeat quiet; `scheduler` healthy; hostwatch's
   daily report; a week later, its `lines` digest sent to the server team as on the staging night
   (part 3, step 9), from which the owner and the server team set `LOG_LINE_BUDGET` again; and the
   uptime monitor on `https://menumesh.in/api/health` up.

Everyone signs in again on the server: its keys and its session cookie (`sb-api-auth-token`,
VPS-20) are not hosted's.

#### 5. The way back, and the point of no return

For 14 days after the production night, Vercel and the paused hosted project stay the way back
(VPS-120). It loses nothing until the first real write on the server after its records moved: a
restaurant's signup, a demo request or a payment's webhook (`/super`'s Restaurants, Leads and
Webhooks show them; the owner's own setup in part 4 does not count, as hosted has its own). That
write is the point of no return. Nothing is copied back to hosted, so going back after it loses what
the server took: fix forward instead (Deploys on the VPS, Rolling back by hand; Backups and restore
(VPS)), and go back only when the server cannot run, accepting the loss. If the server still answers
then, note from `/super` whom it took (Leads, Restaurants), to contact them.

1. Supabase → the paused production project → **Restore project**, then wait until its dashboard
   shows it running. A paused free project can be restored for a limited time (90 days by
   Supabase's note of 2024, a year by its current page): the 14 days are well inside it.
2. Cloudflare → DNS: the apex and `www` back to Vercel's written-down values, DNS only, and the
   `api` record deleted (Vercel's build never calls it). Resolvers holding the server's answer keep
   it for up to 5 minutes.
3. Vercel's production project: Schedules → Cron Jobs → **Enable Cron Jobs**.
4. `BACKUP_PRODUCTION` `true`.
5. On the server, production's `web` and `scheduler` stopped, so that nothing runs on its database
   beside hosted's, and production's heartbeat monitors (`daily`, `digest`, `jobs`) paused:
   `sudo app-compose menumesh stop web scheduler`. `db`, the Supabase services and `backup` keep
   running, so that the nights keep what the server took. Staging stays on the server.
6. `SMOKE_URL=https://menumesh.in EXPECTED_VERSION=<the commit Vercel serves> pnpm smoke`, every
   test passed; then sign in with hosted's login and the authenticator's hosted entry.

A later production night is part 1's count and part 4 again, without the first admin's link and
step 3 when the server's database still holds the first night's admin: sign in with that login
instead. Step 4 then types again only what differs from hosted's `/super` that night (a setting,
plan, Razorpay plan id, offer or team member changed while hosted served during the way back),
compared with the server's `/super`. It comes once the server's trouble is fixed and
`sudo app-compose menumesh up -d web scheduler` has brought them back.

#### 6. After the 14 days (a stop of its own)

Not Stop D's: once the server has served production for the 14 days, the Vercel parts retire
(VPS-121):

- `CRON_SECRET` out of both Vercel projects.
- `deploy.yml`, `release.yml`, the `staging` job of `ci.yml` and `vercel.json` deleted, and
  `backup.yml` deleted or kept for its manual staging run (staging's database stays hosted),
  decided then.
- The Vercel-only parts of this runbook (Environments, Deploying, One-time setup per environment,
  Environment variables (Vercel), Rolling back, the Vercel lines of Incidents, Rotating secrets,
  Backups and restore, Razorpay live switch, the hosted way of The first platform admin
  (production) and Launching the website), README's Deployment and SPEC's §4 and §20, rewritten for
  the server.
- The owner removes or downgrades the Vercel projects, and decides about the paused hosted project:
  deleting it is permanent.

Apart from these, the four functions kept for Vercel's older deployments,
`restaurant_export_finish`, `menu_hindi_names_claim`, `menu_set_hindi_names` and
`announcement_emails_due`, drop in the first release after the production night, in a migration of
its own, with pgTAP 440, 660 and 680 changed with it (VPS-25, VPS-121).

### Deploys on the VPS

- **Staging** follows `main` once `VPS_IMAGES` and `VPS_DEPLOY_STAGING` are `true`, from the staging
  night (The server rehearsal and the cut-over, part 3), which also turns `DEPLOY_STAGING` off;
  until then each merge deploys staging on Vercel. A merge that
  passes CI builds `staging-<sha>` and `migrate-<sha>` (**VPS build**) and deploys them (**VPS
  deploy staging**): through the tunnel, `app-deploy` pulls them by digest, checks their labels,
  runs `migrate-staging` on hosted staging's database and swaps `web-staging`; then the smoke tests
  run against staging with its password. Inside the blackouts below the deploy job fails at once:
  run it again after. `app-deploy` also refuses staging while hostwatch reports the server
  CPU-throttled, and any deploy with under 5 GiB of disk free.
- **Production**, by the owner:
  1. Actions → **VPS release** → Run workflow: the version (`vX.Y.Z`, never one used before),
     optionally a commit of `main` whose CI passed, and `production` in the confirm box. Its summary
     prints the line to run.
  2. On the server, with a GitHub token that can read packages (a classic token with
     `read:packages`), typed at the prompt and never on the command line:

     ```sh
     read -rs PAT && printf '%s\n' "$PAT" | sudo app-deploy menumesh production \
       prod-vX.Y.Z@sha256:<digest> migrate-<sha>@sha256:<digest>
     ```

     It dumps the database first (age-encrypted, in `/srv/menumesh/predeploy/`, the newest three
     kept), runs `migrate` for at most 10 minutes (a failure switches nothing), switches `web` and
     waits up to 120 s for it to turn healthy. If it never does, `app-deploy` goes back to the
     previous image by itself and alerts. Migrations that ran stay applied either way. Then note,
     off the server, the time the deploy began (UTC), read from its `deploying` line
     (`sudo journalctl -t app-deploy --utc -o short-iso`) rather than from memory, the time it went
     live, from its new line in `deploys.log` (`sudo tail -1 /srv/menumesh/deploys.log`), the
     release and whether it stayed live: that is the owner's own note of the day, which a recovery
     on a new server goes by (Backups and restore (VPS), Disaster recovery, steps 5 and 7).

  3. From this machine: `SMOKE_URL=https://menumesh.in EXPECTED_VERSION=<commit> pnpm smoke`.

- **Rolling back by hand:** `sudo tail -5 /srv/menumesh/deploys.log` names the previous image, and
  deploying it again without a migrate reference brings it back. An image still on the server needs
  no token: `sudo app-deploy menumesh production prod-vX.Y.W@sha256:<digest>`. Note it off the
  server too, as for a release (Production, step 2): the times it began and went live (UTC), the
  release brought back, and that the one rolled back did not stay live. Migrations are never
  undone, which is why they stay backward-compatible for one release (Database migrations).
- **When to deploy:** no deploys, and no merges to `main` (every merge deploys staging), from 02:55
  to 03:30 or from 08:40 to 08:50 IST: those are the daily run and the digest. Releases also avoid
  12:00 to 15:30 and 19:00 to 23:30 IST, and maintenance runs 01:00 to 07:00 IST (VPS-24).
- **`/srv/menumesh/deploys.log`** has one line per deploy (the time, the environment, the service,
  the old and new image, and who), and a failed or rolled-back one says what happened, for example
  that the migrations of a new image stay applied. It goes into the nightly settings archive.
- **The other services** never change with a deploy: a changed `compose.yml` goes through
  `pnpm vps:check` and `app-apply` again, then `sudo app-compose menumesh up -d <service>`; a file
  under `config/` is installed by the admin, then `sudo app-compose menumesh restart <service>` for
  the services that mount it (the init SQL runs only on an empty volume); an env file is installed
  again, then `up -d` of the services that read it; an edge file goes through `app-apply` again and
  Caddy reloads; the backup image through `app-deploy menumesh backup`.
- **The journal:** a service's lines, and the deploys':

  ```sh
  sudo journalctl COM_DOCKER_COMPOSE_PROJECT=menumesh COM_DOCKER_COMPOSE_SERVICE=web --since -1h -o cat
  sudo journalctl -t app-deploy --since today
  ```

### The scheduler (VPS)

`scheduler` calls the production web container and `scheduler-staging` the staging one, never
through Cloudflare (VPS-38). Times are UTC:

| Line          | IST          | Job            | Calls              | Limit  | Prints                               |
| ------------- | ------------ | -------------- | ------------------ | ------ | ------------------------------------ |
| `30 21 * * *` | 03:00        | `daily`        | `/api/cron/daily`  | 1740 s | one line: the status and the seconds |
| `0 22 * * *`  | 03:30        | `daily-retry`  | `/api/cron/daily`  | 1800 s | nothing if 03:00 got a 200           |
| `15 3 * * *`  | 08:45        | `digest`       | `/api/cron/digest` | 300 s  | one line                             |
| `45 3 * * *`  | 09:15        | `digest-retry` | `/api/cron/digest` | 300 s  | nothing if 08:45 got a 200           |
| `* * * * *`   | every minute | `jobs`         | `/api/cron/jobs`   | 25 s   | nothing on a 200                     |

- A call without a 200 prints one line, `cron-call <job>: HTTP <code> in N s` or
  `no answer in N s (curl exit N: …)`, and a daily or digest call still running when the next starts
  makes it say `skipped`. A healthy minute prints nothing.
- After each 200 the job pings its heartbeat (`HEARTBEAT_DAILY_URL`, `HEARTBEAT_DIGEST_URL`,
  `HEARTBEAT_JOBS_URL`, and staging's `STAGING_HEARTBEAT_*`); an empty address pings nothing.
- The container turns unhealthy 12 to 13 minutes after its last answered minute call, which
  hostwatch alerts on, and healthy again at the next one.
- **A call by hand**, with the scheduler's own values, so the bearer is never typed:
  `sudo app-compose menumesh exec scheduler /bin/sh /opt/menumesh/cron-call jobs` (or `daily`,
  `digest`; `scheduler-staging` for staging). A `daily` or `digest` by hand that gets a 200 writes
  the day's marker (the UTC day's), so a retry after it does nothing; a daily or digest call
  without a 200 takes the marker away, so after a failed 03:00 call the 03:30 retry runs, whatever
  an earlier call that day got. So a failed call by hand after a good 03:00 call makes the 03:30
  retry run the route a second time that day, which is safe: `daily`'s reminders and announcements
  skip what their logs say went out (and each goes under Resend's idempotency key), its snapshot
  keeps the day's first, its usage counts are rebuilt and the rest are clean-ups of what is due;
  `digest` skips a day already sent. The minute job also answers through Cloudflare (Incidents,
  Run the minute job by hand).
- **After a change:** the admin installs the file, then the schedulers that mount it restart, since
  `install` writes a new file, which a running container never sees:
  `sudo app-compose menumesh restart scheduler scheduler-staging` for `start.sh` or `cron-call`,
  which both mount, `scheduler` alone for `production.crontab` and `scheduler-staging` alone for
  `staging.crontab`. A new cron secret or heartbeat address in `.env` needs `up -d` of the scheduler
  that reads it, since `start.sh` writes the values when the container is made: `scheduler` for
  production's, `scheduler-staging` for the `STAGING_*` ones once the staging night's step 5 has
  made it (First install, step 20), each with its web container for a cron secret (Rotation).

### Backups and restore (VPS)

The `backup` container's crond runs `backup.sh` at 20:30 UTC (02:00 IST), and the host's settings
archive runs at 20:20 UTC, ten minutes before (VPS-40). Its other crond line ships the database's
WAL every minute (WAL shipping, below), and a night is sealed with the signing key (VPS-43).

- **A night** under `daily/` in the bucket, every part age-encrypted to the owner's key:
  `globals-<id>.sql.age` (the roles), `postgres-<id>.dump.age` (the database),
  `storage-<id>.tar.age` (the Storage files, with their content types), `manifest-<id>.txt.age`
  (row counts and the Storage files' count, which a restore compares), `base-<id>.tar.zst.age` (the
  whole cluster, which a point-in-time recovery starts from) and `config-<id>.tar.age` (the
  settings archive), and last `seal-<id>.txt`, plain text: the night's list of parts with each
  one's sha256 and size, and the signature of the backup's key over it. A seal means a whole
  night: it goes up after every part, and a night that stopped before it has none and is never
  restored. A night whose base failed says `base none` in its seal, fails with the alert at the
  end, is never the month's copy, and may leave a partial `base-<id>` object that nothing reads and
  the 30-day removal takes. `<id>` is the night's id: its stamp and 8 random hex characters, such as
  `2026-12-17T2030Z-3f9c0a1b`. Nobody can know it before the night runs, so nobody can put an object
  under one of its names ahead of it, where the bucket's locks would refuse the backup's own
  uploads. Before the first upload the job looks for each of the night's names in both folders,
  its copy's record among them: one that is there means someone else wrote to the bucket, and the
  night stops with `someone else wrote to the bucket: …` (A stolen or leaked bucket token (VPS)).
  A whole night stamped the 1st (UTC) is also copied to `monthly/`, whatever `monthly/` already
  holds; when the 1st's night failed, the next whole night is, while `monthly/` holds no whole
  copy of the month. A night whose settings archive was missing or stale is never the month's
  copy, and neither is one whose base failed. The copy is every part, then the seal, then, once
  the job has found each of them in `monthly/` under its exact name at the size it went up and the
  seal byte for byte, its **record** last, `copy-<id>.txt`: two lines,
  `menumesh copy 1 <id> <sha256 of the night's seal>` and the signature of the backup's key over
  that line, 204 bytes (a copy is eight objects in `monthly/`). The job counts a night already in
  `monthly/` as the month's copy only with that record, byte for byte the line it builds from the
  night and the seal it checked, signed by a key of `BACKUP_SIGNING_PUBLIC_KEY` (so a rotation
  keeps the old copies counted), and only when its seal verifies, lists a base, a settings archive
  and each database's dump, and every part it lists is in `monthly/` under its exact name at its
  size (each looked up by that name, of at most 5 of the month's seals there). A copy without its
  record is never counted, whether cut short, made by hand, or objects someone else put under a
  night's names beside its real seal: the next whole night copies itself again. The night that
  makes the copy says so in a line of its own as soon as the record is up, and every later whole
  night of the month names the copy it found (Last night's backup). A restore never reads a
  record: it reads a month's copy by its names, as it reads a night of `daily/` (docs/DECISIONS.md
  VPS-59, VPS-60). Daily copies go after 30 days
  and monthly ones after 366, by the bucket's own time of each upload, so an object someone else
  put in with an old modification time is tried only once its lock has ended. Only the bucket's
  own protection, the owner's choice (First install, step 2), keeps a stolen token from deleting
  them sooner. A restore reads a night from `daily/` until it is 29 days old, then
  only the month's copy, from `monthly/`, until 365 days, as long as the bucket's locks hold them:
  from 29 days on, a night that is not a month's copy can't be restored, though `daily/` keeps it
  until the job removes it a day or two later.
- **WAL shipping.** `db` finishes a WAL file at least once a minute while anything is written
  (`archive_timeout=60`) into the `wal-spool` volume, and the `backup` service's other crond line
  compresses, encrypts, signs and uploads each one to `wal/<cluster>/…` in the bucket, so a crash
  or a bad release loses at most about 2 minutes. A healthy shipper is silent: it writes no log
  line, and sends the heartbeat `HEARTBEAT_WAL_URL` every 5 minutes with
  `wal <cluster>: last sent <walfile>, <n> waiting` as the ping's body. About a file a minute
  reaches the bucket, 1 to 2 KiB each when idle (about 43,200 writes a month on the bucket's
  bill), WAL older than 15 days goes in the nightly removal, and the history files stay. Look at
  it:

  ```sh
  sudo app-compose menumesh exec db psql -U supabase_admin -d postgres -c "select last_archived_wal, last_archived_time, failed_count from pg_stat_archiver"
  sudo app-compose menumesh exec -u 100 backup sh -c 'ls /wal-spool | wc -l; ls /wal-spool/.ship/out | wc -l'
  ```

  The first shows the newest file `db` handed over; the second, how many wait (the spool is
  postgres's, so as uid 100): 0 to 2 in each when healthy.

- **The settings archive**, `/srv/menumesh/backup-out/config-<stamp>.tar.age`, holds `.env`,
  `images.env`, `env/`, `config/` and `deploys.log`, encrypted to `BACKUP_RECIPIENT`. A night whose
  archive is missing or more than 2 hours old when it is checked, right after the manifest and
  before the base (which may take 2 hours), fails, with an alert, after its other parts are up.
  `systemctl list-timers 'app-config-archive@*'`,
  `sudo journalctl -t app-config-archive --since yesterday` and
  `sudo ls -l /srv/menumesh/backup-out` show it, and
  `sudo systemctl start app-config-archive@menumesh.service` makes one now.
- **Last night's backup:**

  ```sh
  sudo journalctl COM_DOCKER_COMPOSE_PROJECT=menumesh COM_DOCKER_COMPOSE_SERVICE=backup --since yesterday -o cat
  sudo app-compose menumesh exec backup sh -c 'rclone lsf --format sp --separator " " --include "*-$1.*" "backups:$BACKUP_BUCKET/daily/"' sh <id>
  ```

  The first shows `backup <id>: 6 parts, N bytes, the month's copy is <id of the copy>` (the parts
  the seal lists, the seal itself not counted, then the night the job found whole in `monthly/` as
  the month's copy), or, on the night that made the copy,
  `backup <id>: kept in monthly/ as the month's copy` as soon as its record is up and then
  `backup <id>: 6 parts, N bytes, kept in monthly/ as the month's copy`; or
  `[menumesh] backup failed (exit 1) at <id>: <the step>`, which Telegram got too. The heartbeat's
  ping carries the last line, so the monitor's log names the month's copy as well. The second lists
  that night's parts and their sizes, `<id>` from the first: seven objects for a whole night (six
  parts and the seal). A failed night shows what got there: no manifest when it failed before the
  manifest went up, no seal when it failed before the end, no `config-` part when its settings
  archive was missing or stale, a `base-` part that its seal doesn't list when its base failed,
  and, when it stopped on a name someone else
  wrote, only that name (the listing is by the id, so a part planted in `daily/` under it shows
  there, as the planter's, not the job's). The heartbeat monitor alerts after 26 hours without a
  whole night. One now, as the container runs it, with a settings archive made for it first: a
  night whose archive is more than 2 hours old fails and seals none. The archive's start waits
  until the archive is written and prints nothing when it worked
  (`sudo journalctl -t app-config-archive --since -10min` shows its line,
  `menumesh: archived … into config-<stamp>.tar.age (<bytes> bytes), newest 3 kept`):

  ```sh
  sudo systemctl start app-config-archive@menumesh.service
  sudo app-compose menumesh run --rm --no-deps -T backup /usr/local/bin/backup.sh
  ```

  The night's own alerts, each naming the step: `the base backup failed or ran past 2 hours`, with
  `pg_basebackup`'s lines (db unreachable, the replication line in `pg_hba.conf` missing, a full
  disk; the other parts are safe and the next night makes a base);
  `db would not hold the WAL for the base backup in a replication slot`, with psql's lines (all 5
  of `max_replication_slots` are in use: look in `db` with
  `select slot_name, slot_type, temporary, active from pg_replication_slots`, and free one);
  `BACKUP_SIGNING_PUBLIC_KEY is not one Ed25519 public key or several, …`,
  `BACKUP_SIGNING_KEY is not an Ed25519 private key, …` or
  `BACKUP_SIGNING_KEY does not sign what BACKUP_SIGNING_PUBLIC_KEY's first key checks`, each said
  before anything is uploaded (a value in `.env` is not as `pnpm vps:secrets` writes it, or the
  two are not a pair: the first public key must be the private key's own; Disaster recovery,
  step 4, checks them); and `the removal of old copies`, which comes after the night's
  `kept in monthly/` line when it made the copy: that copy is whole, and the next night names it.
  While a base runs (at most 2 hours) a temporary slot keeps `db`'s WAL, at most 4 GB.

  The month's copy has steps of its own, each with its reason, and a night stopped at one of them
  is whole in `daily/`. Each alert names one of these: a step's reason (rclone's lines before it
  in the journal say why), or in its place what the step found:
  - `someone else wrote to the bucket: monthly/ holds <names> before tonight's copy`: right
    before the copy went up, the job looked its names up in `monthly/` (its parts', its seal's and
    its record's) and found these there, so nothing of the night's own went there;
  - `the monthly copy`: copying a part or the seal into `monthly/` failed, or that look did, with
    rclone's lines: what went up stays there, with no record;
  - `the check of the month's copy`, or in its place
    `monthly/<name> is not in the bucket as it went up` or
    `monthly/seal-<id>.txt is not the night's seal`: the copy is there but not as it went up,
    with no record;
  - `someone else wrote to the bucket: monthly/ holds copy-<id>.txt before the record of tonight's copy`,
    or `the record of the month's copy`, or in its place
    `no sha256 of seal-<id>.txt for the record`, `the record could not be signed (openssl)` or
    `monthly/copy-<id>.txt is not in the bucket as it went up`:
    the copy's parts and seal are in `monthly/`, checked, where a restore reads them by name, with
    no record of the job's. When only the record's confirmation failed, the record may be up,
    and the next night then names the copy.

  Otherwise the next whole night copies itself again. Once may be the provider's. But
  `someone else wrote to the bucket`, a lock's refusal among rclone's lines in the journal, or the
  same step of the copy failing two nights running means someone is putting objects under
  tonight's `monthly/` names while the night runs, as a holder of the bucket's token can (a night's
  names show in `daily/` from its first upload), and the month can end with no copy: follow
  A stolen or leaked bucket token (VPS). An object put in after the look still fails that step of
  the copy, with that step's reason.

- **The monthly restore test**, on the second weekend of the month, its Saturday (the 8th to the
  14th) or the Sunday after, or on the third if the second is missed, as the server team's drills
  take the first (the first one before the first restaurant); outside 20:20 to 21:30 UTC, the
  shared server's backups; never while hostwatch reports the server throttled; and never beside
  another one-off of the server's, as `app-compose`'s memory rule refuses it beside the server
  team's restore test (docs/DECISIONS.md VPS-132). First the month's copy: the newest whole night
  names a copy of this month, its line ending `, the month's copy is <id>`, an id of this month, or
  `, kept in monthly/ as the month's copy` on the night that made it:

  ```sh
  sudo journalctl COM_DOCKER_COMPOSE_PROJECT=menumesh COM_DOCKER_COMPOSE_SERVICE=backup --since -25d -o cat | grep -E "the month's copy is |kept in monthly/" | tail -1
  ```

  The night that made the copy also says `kept in monthly/ as the month's copy` in a line of its
  own as soon as its record is up, so its copy shows even when that night failed after it (at
  `the removal of old copies`). The check needs a night of this month: on the 1st before
  20:30 UTC the newest line still names last month's copy, so wait for the 1st's night. When no
  line names a copy of this month, none of its nights made one. Nights that failed before their
  seal were not whole: mend what their alerts name (Last night's backup), and the next whole night
  copies itself (A night, above). Nights that failed at a step of the month's copy were whole in
  `daily/`: that step's alert says what it left (Last night's backup), and the same step failing
  night after night means someone is putting objects under the copy's names
  (A stolen or leaked bucket token (VPS)). Nights sealed and then failed at the end, their
  settings archive missing or stale or their base failed, are never the month's copy: mend what
  their alerts name, and the next whole night copies itself. Then the test. The private key goes
  on a ramfs, which is never swapped and is gone at unmount:

  ```sh
  sudo install -d -m 700 /run/age
  sudo mount -t ramfs -o mode=700 ramfs /run/age
  sudo tee /run/age/identity.txt >/dev/null     # paste the private key, then Ctrl-D
  sudo chmod 600 /run/age/identity.txt
  sudo app-compose menumesh --profile restore-test run --rm -v /run/age:/run/age:ro restore-test
  sudo app-compose menumesh --profile restore-test rm -sf restore-db
  sudo rm /run/age/identity.txt && sudo umount /run/age
  ```

  It checks the night's seal first, then restores the night into a throwaway database in memory,
  compares it with the manifest, lists the Storage archive and the settings archive's file names,
  and ends with `restore test passed: the night of <id>, from <folder>/`. After the seal it prints
  `its seal is signed by the backup's key, and the <n> parts read match it (<bytes> bytes)`. It
  downloads the whole logical night (not the base) into the container's own files first, so the
  server's disk needs that plus 1 GiB free, or it is refused at once with the sizes
  (`the parts of <id> need N MiB in this container's files ... and M MiB are free`). Counts that
  moved during the night are listed; only a missing table, an empty one or missing Storage files
  fail it. `app-compose` first checks that the server has the memory. It names the night it takes
  first (`restore: the night of <id>, from daily/, …`): unasked, the newest seal in `daily/`
  younger than 29 days, but never one stamped later than now, which it names as not taken (three,
  then how many more). Check that id, and the one its last line names, against the backup's own
  journal line (Last night's backup), since anyone holding the bucket's token can add a night under
  any stamp.
  Everything it prints loses its control characters, so a night's own text (psql's notices, for
  one) can add a line but not erase or rewrite one, and nothing of it comes after the last line.
  For another night add `-e RESTORE_STAMP=<id>`, the id as the night's journal line prints it (for
  example `2026-12-17T2030Z-3f9c0a1b`; a stamp alone is refused): name the night before when the
  newest one failed, as a failed night may lack its settings archive. A named night is looked for
  and read part by part, by name, and no folder is listed: a token holder can fill a folder with
  names. Unasked, rclone lists `daily/` once to find the newest id. The folder a night is read from
  hangs on its age alone, from the stamp in its id and the server's clock (`timedatectl` says
  whether it is synchronized), never on what the bucket holds, which a stolen token can add to:
  - **Younger than 29 days**, `daily/` only, whose lock keeps every night that long: it shows
    `from daily/`. A night `daily/` has no seal of is refused, whatever `monthly/` holds, as no
    backup finished it (one that stopped before its seal, or an id no backup wrote):
    `daily/ keeps every night of the last 29 days under its lock; this one has no seal there, so it is not signed by the backup's key`.
  - **29 days old or more**, `monthly/` only, which keeps the month's copies a year: it shows
    `from monthly/`. Name such a night only when the backup's lines name it as the month's copy:
    its own `kept in monthly/ as the month's copy`, or a later night's
    `the month's copy is <id>`. One that isn't a month's copy has no seal there and is refused
    (`only the month's copy is kept past 29 days; … this one has no seal there, so it is not signed by the backup's key`).
    A night someone put in `monthly/` under its id is read only through its seal, which no key of
    `BACKUP_SIGNING_PUBLIC_KEY` signed: it is refused as `not signed by the backup's key` (below),
    and nothing of it is read.
  - **365 days old or more**, none: past `monthly/`'s lock its parts could have been replaced.

  A part that can't be read or restored ends the run with a line naming it and its folder, under
  what rclone, age, psql, pg_restore or tar said, such as
  `the manifest of <id> (manifest-<id>.txt.age in daily/) could not be read (see above)`.
  Each of these lines means a night, or part of one, that no backup wrote, or that the bucket no
  longer holds as the backup wrote it:
  - `is not signed by the backup's key`: the seal (`seal-<id>.txt`) is not signed by any key of
    `BACKUP_SIGNING_PUBLIC_KEY`, or the night has no seal, or the seal is malformed; the
    line says which. A night with no seal may be one that stopped before its seal (the journal
    names the nights it sealed); either way nothing of it was read;
  - `is not the part the backup sealed`: a part's size or sha256 differs from the seal's (put over
    its own or damaged), and `is not in the seal … it is never read`: a part someone added;
  - `has no settings archive in its seal`: that night's settings archive was stale (name the night
    before);
  - `backslash commands are restricted`: a roles file with a psql command other than pg_dumpall's
    own `\restrict` and `\unrestrict` lines, which no backup writes;
  - `holds links or special files`: Storage writes only files and folders (refused before
    anything is restored).

  Someone else wrote to the bucket: A stolen or leaked bucket token (VPS). Record the date, the
  night and the result.

- **The monthly point-in-time drill**, right after the restore test has ended, in the same
  terminal, and with the same key on its ramfs (after `rm -sf restore-db`, before the `rm` and
  `umount` of the key), as the memory rule refuses the two together:

  ```sh
  sudo app-compose menumesh --profile pitr-test run --rm -v /run/age:/run/age:ro pitr-test
  ```

  It takes the newest sealed night with a base, checks and unpacks the base, takes the WAL after
  it from the bucket (each file only if its signature verifies, and at each position the file of
  the timeline Postgres reads there), replays it with Postgres in a throwaway tmpfs to the latest
  point, and compares the counts with the night's manifest, shown side by side (writes since the
  night move them, so they inform and don't fail). The replay runs without the live cluster's own
  settings, what `ALTER SYSTEM` set there: the base carries them, and they wait aside. It takes
  about 5 seconds on the rehearsal and ends with
  `pitr test passed: the night of <id> and the WAL after it, replayed to <point>, its last transaction at <UTC>`;
  for `latest` that last transaction must be within about 12 minutes of the drill's start. Check
  that id against the backup's own journal line, as for the restore test (Last night's backup): a
  night that none of the backup's own records names is a sign of theft (A stolen or leaked bucket
  token (VPS)). For a point instead, add `-e PITR_TARGET=<point>`: `YYYY-MM-DDTHH:MM:SSZ`, or with
  an offset such as `+05:30`. It restores no files and writes nothing to the bucket. Its failure
  lines:
  - `the chain of WAL files is cut at <file>: …`: a WAL file is missing or isn't the backup's, with
    the backup's WAL after it: someone else wrote to or removed from the bucket (A stolen or leaked
    bucket token (VPS)); the line names the file;
  - `the last transaction the replay reached committed at …, N minutes before the drill began`:
    WAL is not reaching the bucket: see the WAL alerts (Logs and alerts (VPS));
  - `the replay ended at <file>, though the chain of WAL files goes on to <file>: …`: Postgres
    stopped short of the WAL the chain checked, so this is not the latest the bucket holds: as
    for a cut chain;
  - `no night of daily/ … has a seal signed by the backup's key with a base backup that ended before …`:
    there is no good night: the base failed, or the seals are not ours;
  - `the backup's WAL of the timelines X is in the bucket, but not those timelines' history files`:
    someone removed a history file, and the replay would follow the wrong history (it may name
    several timelines);
  - `the base backup of <id> is of the timeline X, …, which was left for a later one at …, before the base began`:
    the night's base is from before a rewind past it (below);
  - `the base backup of <id> is of the timeline X, …, which was left for a later one at …, before the base ended`:
    a rewind went back to a point while that night's base ran, so the rewind's timeline begins
    inside the WAL the base brought along, which Postgres would read on along the abandoned
    timeline (below);
  - `the replay reached the end of the WAL it was given before the first transaction past <point> (…)`,
    to a point: the WAL doesn't reach it, for the reason in brackets (a cut chain, as above, the
    end of the bucket's WAL, or a WAL file a late shipper sent more than 30 minutes past it);
  - `the history file of the timeline X holds a line Postgres does not write` or
    `names its timelines out of order`: a history file signed by the backup's key that Postgres
    never wrote: take the signing key for stolen (A stolen or leaked bucket token (VPS), step 5);
  - `<part> in daily/ is not the part the backup sealed`: as for the restore test.

  A drill to a point more than 14 days back, or later than now, is refused. Record the date, the
  night, the point and the result. After a rewind (a recovery, below) to a point before the last
  night's base ended, before it or while it ran, make a settings archive and run `backup.sh` by
  hand before the next drill:

  ```sh
  sudo systemctl start app-config-archive@menumesh.service
  sudo app-compose menumesh run --rm --no-deps -T backup /usr/local/bin/backup.sh
  ```

  Until a night of the new timeline exists, the drill and a recovery to `latest` pick that base,
  whose timeline the rewind left, and refuse it before they replay anything
  (`… which was left for a later one at …, before the base began`, or `ended`). A drill to a point
  after the base of any night the rewind left ended, and before the base of that night by hand
  ended, picks such a night too, even once that night exists (Disaster recovery, step 5).

- **Disaster recovery**, whose database and Storage steps, step 2's check of the settings archive
  and step 4's check of the signing pair, `pnpm vps:backup-test` rehearses on this machine
  (docs/DECISIONS.md VPS-40, VPS-44, VPS-51 and VPS-63). The first choice is a point-in-time
  recovery to `latest`, which loses about 2 minutes instead of a day and keeps the invoice
  counters; a night's logical recovery is the fallback, and the only way to bring Storage's files
  back on a new server:
  1. A new server: the admin's part of First install, with new deploy keys and the new host key in
     `VPS_KNOWN_HOSTS`. If the old server may still run, stop its `cloudflared` first. Where the
     backup key counts as stolen (2.2), its new pair is made before this step, and the admin's
     `BACKUP_RECIPIENT` (First install, step 9) is the new public key.
  2. The night's id, from the backup's own records and never from the names in the bucket, since
     anyone holding the bucket's token can add a night under any stamp: the journal's
     `backup <id>: …` lines if the old server still runs, else the backup monitor's log, where each
     ping carries that line (First install, step 3), and in it only a ping from the old server's own
     address inside its night's window (from its stamp to a day after it, so a long base's late ping
     counts), as A stolen or leaked
     bucket token (VPS), step 2, reads it: a ping from elsewhere, or two naming different ids in one
     night's window but for a run by hand, is a sign the `.env` leaked, so follow that section's
     step 5 before anything of the bucket is downloaded. Telegram's failure lines, which that `.env`
     can send too, name no night here. After a theft of the signing key, a night from before the
     trouble is named only from records made before the trouble could have begun, since the leaked
     `.env` let its holder post to the monitor and to Telegram too (A stolen or leaked bucket token
     (VPS), step 5). Its `<id>` names the settings archive here and the recovery in step 5, which
     refuses to run without one. (A point-in-time recovery names no night: it takes the newest one
     itself, so this step's id is for the settings archive.) The archive becomes the server's
     settings, and `db` runs its `config/db/wal-spool.sh` as root, but none of the kit's scripts can
     run on the new server before an archive is unpacked there: so it is checked against the night's
     seal on the owner's own machine first, and only an archive that passes goes to the server
     (docs/DECISIONS.md VPS-51).
     1. **Download**, on the owner's machine, into an empty folder: the night's `seal-<id>.txt`
        and `config-<id>.tar.age`. For a night from before a theft of the signing key (2.2),
        where the bucket keeps versions, first make the versions of that night's objects that
        went up before the trouble (its seal, its settings archive and its parts) the current
        ones again, with the admin login, and download only then: the stolen key could have
        signed others put over them, and the stolen key's file takes whatever that key signed.
        Both come from `daily/` while the night is younger than 29 days, else from `monthly/`,
        for a month's copy only (the backup's lines name it so: its own
        `kept in monthly/ as the month's copy`, or a later night's `the month's copy is <id>`),
        with the bucket provider's dashboard or a new read-only token (the token on the server is
        inside the archive). Byte for byte: a seal opened and saved again with CRLF line ends is
        refused.

     2. **Check** them, from a checkout of this repository (Node 24), against the
        `BACKUP_SIGNING_PUBLIC_KEY` list kept beside the age key, in a file of its own (First
        install, step 6), never the archive's or the old server's:

        ```sh
        pnpm vps:verify-night <id> <folder> --keys <the list's file>
        ```

        It checks the seal's signature against each key of the list, that the seal lists a
        settings archive, and that every part in the folder is the one the seal lists, by size and
        sha256. It decrypts nothing and needs no age key and no network. A pass prints a line for
        each part, then this one, with the sha256 to compare on the server:

        `verify-night: the seal of <id> is signed by the backup's key, and the 1 part here matches it: copy config-<id>.tar.age to the server, where sha256sum must print <sha256> for it before it is unpacked`

        Anything else is one line, exit 1, and nothing of the folder goes to the server.
        `has no settings archive in its seal`: that night's archive was stale, so name the night
        before. `is not signed by the backup's key`, `is not the part the backup sealed` or
        `is not in the seal`: someone else wrote to the bucket (A stolen or leaked bucket token
        (VPS)), so take an earlier night, or put the bucket right first.

        After a theft of the signing key (A stolen or leaked bucket token (VPS), step 5) the kept
        list holds the new key first, then only the older keys whose private half had left the
        server before the trouble could have begun, never the stolen one: it takes the nights
        made since, the first of them the one run by hand with a fresh settings archive, and none
        the stolen key signed. Where the old server may have been reached as root, nothing it made
        after the trouble could have begun is taken, that night and its archive included, as they
        hold whatever the server held by then: take the last night from before the trouble, named
        only from records made before it could have begun, its versions of then made current
        before 2.1's download, and check it with the stolen key's file, kept apart, which takes
        only the nights its keys signed:

        ```sh
        pnpm vps:verify-night <id> <folder> --keys <the stolen key's file>
        ```

        That file holds the stolen key and every other key the list held whose private half was
        on the server since the trouble could have begun, its first among them (that section's
        step 5), and is for a night one of them signed: one that an older key of the kept list
        signed is checked with the kept list, as any
        night, and that file refuses it. That archive's `.env` holds the values of before the
        trouble, the stolen key in its list among them: 2.4 puts in the kept list and the private
        half of its first key, never the stolen one it holds, and each value rotated since (the
        bucket's token, the backup's heartbeat addresses and the bot's token at least) goes in
        from the password manager too. After a reach as root, those values and the kept list's
        first key went into the reached server's `.env` as well, so this server gets new ones of
        its own instead: a fresh signing pair among them (A stolen or leaked bucket token (VPS),
        step 5). If the backup key's private half was on that server since the trouble could
        have begun (a monthly restore test or drill, a recovery, or step 4 of A stolen or leaked
        bucket token (VPS)), the backup key counts as stolen too: this server then also gets a
        new backup pair, made before this recovery began, its public key the admin's
        `BACKUP_RECIPIENT` from step 1 and `.env`'s `BACKUP_AGE_RECIPIENT` from 2.4, before the
        settings archive's timer and `backup` start, so that nothing this server makes is
        encrypted to the stolen key (the old private key still opens this night); and every
        older key leaves the kept list for the stolen key's file, as that section's step 5 says.

     3. **Unpack** it on the server, once that one file is copied to `~/incoming` and the private
        key is on a ramfs (as above): `sha256sum` must print the sha256 the pass named, or nothing
        is unpacked. Then the archive is listed, only `.env`, `images.env`, `env/`, `config/` and
        `deploys.log`, each entry a file (`-`) or a folder (`d`), and unpacked into
        `/srv/menumesh`; `.env` and `env/` come back root's, 0600:

        ```sh
        sha256sum ~/incoming/config-<id>.tar.age
        sudo age --decrypt --identity /run/age/identity.txt ~/incoming/config-<id>.tar.age | tar -tv
        sudo age --decrypt --identity /run/age/identity.txt ~/incoming/config-<id>.tar.age | sudo tar -x -C /srv/menumesh
        ```

     4. **The key list and the signing key**, since a restore trusts the list it is given:
        `BACKUP_SIGNING_PUBLIC_KEY` in the restored `.env` against the list kept beside the age
        key, which every rotation replaces. A restored list that lacks a key of the kept one is
        from before a rotation: put the kept list in. A key that only the restored list holds is an
        alarm, never one to keep: put the kept list in, and find out how it got there before going
        on (a rotation never written down, or someone on the old server: A stolen or leaked bucket
        token (VPS), step 5). The restored `BACKUP_SIGNING_KEY` is the private half of the
        restored list's first key: when that is not the kept list's first (an archive from before
        a rotation, or from before a theft), put in `BACKUP_SIGNING_KEY` the private half of the
        kept list's first key, from the password manager (Secrets (VPS), Rotation). Never keep a
        restored private key whose public key is not the kept list's first: the backup signs with
        it and checks it against the list's first key, so no night would be sealed and no WAL
        shipped. The pair is checked once the backup image is here, right after step 4. After a
        theft of the signing key, an archive from before the trouble lacks the new key and holds
        the stolen one: both as 2.2 says, and the kept list goes in. `BACKUP_AGE_RECIPIENT`
        becomes the newest backup public key here, whatever the archive held: the new pair's where
        the backup key counts as stolen too (2.2), else the one whose private half is the newest
        in the password manager, as an archive from before a rotation of the backup key names
        the old one (Secrets (VPS), Rotation).

        Then, on a new server, the settings archive's timer, whose drop-in the admin made in step
        1 (First install, step 13), so that every night has a fresh archive. Each archive is
        encrypted to the admin's `BACKUP_RECIPIENT`, so first check that it is that same key: the
        two commands print the same `age1…` key, or the admin puts that key in the conf (root's,
        0644, which holds the public key only) before the timer goes on:

        ```sh
        grep '^BACKUP_RECIPIENT=' /etc/apps/menumesh.conf
        sudo grep '^BACKUP_AGE_RECIPIENT=' /srv/menumesh/.env
        ```

        Then the timer; the second command shows its next run, at 20:20 UTC:

        ```sh
        sudo systemctl enable --now app-config-archive@menumesh.timer
        systemctl list-timers 'app-config-archive@*'
        ```

  3. `sudo app-apply menumesh compose ~/incoming/compose.yml`, from the commit the server last had.
  4. The backup image that `images.env` names, by the admin form with a token on stdin as in First
     install, step 18: `sudo app-deploy menumesh backup <its tag@digest>`. Its switch starts
     `backup` without `db`, which on a new server first starts at step 6, so stop it right after;
     step 6 starts it again, after `db`:

     ```sh
     sudo app-compose menumesh stop backup
     ```

     The deploy sees `backup` healthy within seconds, its healthcheck's first probe coming 2 s
     after the start. If the shipper's first run, at the next full minute, comes before the stop,
     it sends one WAL alert, which wants nothing:
     `[menumesh] WAL is not reaching the bucket (cluster (unknown)): the WAL spool, /wal-spool, is not db's postgres's to write: db makes it so as it starts`.
     Left running, `backup` would send it every hour and fail a night at 20:30 UTC at
     `the list of databases`. The spool the deploy made stays empty, and `db`'s wrapper makes it
     postgres's at step 6. Then the signing pair (step 2.4): a one-off of the backup image with
     `.env`'s values holds `BACKUP_SIGNING_PUBLIC_KEY` and `BACKUP_SIGNING_KEY` to the shapes
     `pnpm vps:secrets` writes, then signs a probe with the private key and checks it with the
     list's first key, as the backup and the shipper do before they sign anything, and prints one
     line of its own and no key (Compose may print its own `Container …` lines around it;
     `--no-deps` keeps `db` from starting):

     ```sh
     sudo app-compose menumesh run --rm --no-deps -T backup sh -c '. /usr/local/share/menumesh/seal.sh; seal_public_keys_ok || { echo "signing pair: BACKUP_SIGNING_PUBLIC_KEY is not one Ed25519 public key or several, as pnpm vps:secrets writes it (base64 SPKI DER, separated by single spaces): put the kept list in as it is" >&2; exit 1; }; seal_private_key_ok || { echo "signing pair: BACKUP_SIGNING_KEY is not an Ed25519 private key, as pnpm vps:secrets writes it (base64 PKCS #8 DER): put in the private half of the first key of the kept list" >&2; exit 1; }; if seal_self_check; then echo "signing pair: BACKUP_SIGNING_KEY signs what the first key of BACKUP_SIGNING_PUBLIC_KEY checks"; else echo "signing pair: BACKUP_SIGNING_KEY does not sign what the first key of BACKUP_SIGNING_PUBLIC_KEY checks, so no night could be sealed and no WAL shipped: put in the private key of that first key" >&2; exit 1; fi'
     ```

     It must print
     `signing pair: BACKUP_SIGNING_KEY signs what the first key of BACKUP_SIGNING_PUBLIC_KEY checks`.
     Anything else is one line on stderr, exit 1, naming the value to mend in `.env` (step 2.4)
     before it runs again; nothing has been signed yet:
     - `signing pair: BACKUP_SIGNING_PUBLIC_KEY is not one Ed25519 public key or several, as pnpm vps:secrets writes it (base64 SPKI DER, separated by single spaces): put the kept list in as it is`:
       the list is not the kept list's line as it is (a doubled space, a space at either end, a
       key cut short, or the file's whole line pasted after the name);
     - `signing pair: BACKUP_SIGNING_KEY is not an Ed25519 private key, as pnpm vps:secrets writes it (base64 PKCS #8 DER): put in the private half of the first key of the kept list`;
     - `signing pair: BACKUP_SIGNING_KEY does not sign what the first key of BACKUP_SIGNING_PUBLIC_KEY checks, so no night could be sealed and no WAL shipped: put in the private key of that first key`:
       a private key of another pair, such as one from before a rotation, or a list shaped as
       keys but not as the kept file has it: its keys out of order (the new key goes first), or
       its first key mistyped. Put the kept list in as it is first.
       A mistyped later key passes this check, and only a restore of that key's nights refuses
       them, as someone else's writing, so compare the list with the kept file's line either way.
       A private key of the right shape that openssl can't load prints openssl's own lines and
       `seal: openssl could not sign probe` before this one, never a key.

  5. The recovery, into new volumes. **First choice, point in time:** `PITR_TARGET` is `latest`, or
     a time before the loss as `YYYY-MM-DDTHH:MM:SSZ` or with an offset such as `+05:30`, at most
     14 days back: for a deletion the minute just before it, and for a bad release a time before
     its deploy began, as its line in `deploys.log` comes only after its migrations ran. That is
     before the first `deploying <ref> to web (menumesh production)` line naming it in
     `sudo journalctl -t app-deploy --utc -o short-iso`, of any attempt, `FAILED` and
     `ROLLED BACK` ones included, as the migrations an attempt ran stay applied; or the stamp
     (UTC, `YYYYMMDDTHHMMSSZ`) in the name of the pre-deploy dump that attempt made,
     `/srv/menumesh/predeploy/production-<stamp>-postgres.dump.age`, made before its migrations;
     or, closer, before the first `running migrate on migrate-<sha>` line after that one, as no
     migration runs before it (a `migrate: applied <file>` line comes only after its file
     committed). On a new server, without that journal, it
     is 35 minutes before the first line naming it in the `deploys.log` step 2 unpacked, as
     `app-deploy`'s own limits bound an attempt (300 s for each pull and for the dump, 600 s for
     `migrate`, 120 s for the switch and 120 s for the health wait, twice with a rollback), or
     as the owner's own note of the day has it. After a recovery to a state from before a bad
     release's deploy, a rewind past it or a night from before it (the fallback, below), no
     release made since that deploy began goes out again, ever, and one built from `main` only
     once its harmful migration is made harmless in its own file (step 7).

     It restores the database alone, from the newest sealed night's base and the bucket's signed
     WAL after it. On the same server `db-data` and `wal-spool` go, with everything stopped and
     `db` and `backup` removed (`storage-data` and `db-config` stay: Storage's files and the
     image's settings are not in the WAL; the rehearsal proves this order). If the old server
     still runs, let `backup` ship what waits first (`ls /wal-spool` as in WAL shipping): the
     spool goes with the volume.

     ```sh
     sudo app-compose menumesh stop
     sudo app-compose menumesh rm -sf db backup
     sudo docker volume rm menumesh_db-data menumesh_wal-spool
     sudo app-compose menumesh --profile recover run --rm -e PITR_TARGET=latest -v /run/age:/run/age:ro recover-pitr
     ```

     It takes 5 seconds or so on the rehearsal, more on the real size. It refuses a `db-data` that
     is not empty, a run without `PITR_TARGET`, a point later than now or more than 14 days
     back; and a point the bucket's WAL doesn't reach is refused after the replay, with the
     reason (a cut chain names the missing or refused file, a late shipper's 30-minute rule
     says so): recover to an earlier point, or to `latest`. A recovery to `latest` starts from the
     newest night, whose base may lie past the cut, so it need not meet it; after a cut the line
     says so:

     `…: recover to an earlier point, or to latest; if that recovery is cut at <file> too, it ends there only with PITR_ACCEPT_CUT=<file>`

     From a newer night past the cut, a recovery to `latest` goes through without it, and
     `PITR_ACCEPT_CUT` is refused there
     (`PITR_ACCEPT_CUT is <file>, but the chain of WAL files is not cut: run again without it, …`);
     where it meets the same cut, it is refused as below. A run refused once the replay began
     ends with `the recovery stopped after it began to write to db-data`: make `db-data` new
     before the next (`sudo docker volume rm menumesh_db-data`). A recovery to `latest` whose
     chain of WAL files is cut (a WAL file missing or not the backup's, with the backup's WAL after
     it) is refused before it writes anything, since it would end at the cut:

     `pitr: a recovery to latest would end at the cut at <file> and leave out the backup's WAL after it: … nothing was written to db-data`

     Put the bucket's WAL back as the backup wrote it where the bucket kept it (an old version,
     with the admin login: A stolen or leaked bucket token (VPS)) and run it again. Or, to recover
     to the cut and no further, run it again with `-e PITR_ACCEPT_CUT=<file>` too, the file that
     line named: it says `PITR_ACCEPT_CUT is <file>: the recovery ends at the cut, …`, and a
     `PITR_ACCEPT_CUT` with another file, with a point, or with no cut is refused.

     A rewind to a point (a recovery to it, as here) leaves every night whose base ended after
     that point on the timeline it abandoned, and a recovery that takes one of those nights refuses
     it before it writes anything, naming it
     (`… which was left for a later one at …, before the base began`, or `ended`); it never
     passes over one for the night before. So:
     - until a night of the rewind's timeline exists, a recovery to `latest` takes the newest of
       them and is refused: step 9 makes such a night right after a rewind. The refusal needs the
       rewind's history file in the bucket, which reaches `wal/` within a minute or two of step 6:
       a server lost before that leaves the bucket no trace of the rewind, and a recovery to
       `latest` then follows the abandoned timeline to its end and undoes the rewind, as with a
       timeline removed whole (A stolen or leaked bucket token (VPS)), so recover to the rewind's
       point again instead;
     - a point after the base of any of them ended, and before the base of the first night of the
       rewind's timeline ended (on the same server, step 9's), takes one of them and is refused,
       even once that night exists;
     - a point before the rewind's point takes a night from before it and reaches that point on
       the old timeline, short of the fork; a point on the abandoned timeline after the rewind's
       point, up to when the rewind ran, reaches the rewind's point at most, whichever seals are
       out, as the old timeline's WAL after the fork is never replayed: the replay follows the
       rewind's timeline from there and stops before its first transaction, which came when the
       rewind ran. Once the seal of every left night whose base ended before that point is out, it
       ends `done` (a drill `passed`); one still in is taken and refused, as in the bullet above.
       Only the time of its last transaction, which `pitr.sh` prints with it, shows where, as the
       rehearsal shows with the seals aside; where the rewind ran more than 30 minutes after that
       point, and its first WAL file holds no transaction, the late shipper's rule refuses it
       instead (reasoned, not rehearsed). Only a night's logical recovery holds that stretch;
     - to get past them (on a new server that lost the old one before step 9's night, or to a point
       of the second kind), the seal of each night a refusal names leaves `daily/`, kept aside so
       that it can go back (its parts may stay), with the admin login as in A stolen or leaked
       bucket token (VPS), step 3, and the recovery runs again: each run takes the next older
       night, and once every night whose base ended after the rewind's point is out, the newest
       night whose base ended before it recovers to `latest` across the fork, or to a point of the
       second kind on the rewind's timeline (after the rewind ran), as the rehearsal shows. On a
       new server, see step 7 for the release to deploy: the settings archive of step 2 is then
       from before the rewind;
     - the seals go back once a night of the timeline that recovery made exists: put back before
       it, they make a recovery or drill to `latest` refuse again, and a point of the second kind
       takes them again, so take them out again for such a recovery.

     It ends with `point-in-time recovery to <point> done: start db with a new wal-spool …`, the
     live cluster's own settings (what `ALTER SYSTEM` set, which the replay ran without) put back
     for `db`. After a theft of the signing key it has no night to start from until the new key
     signs one, and where the old server may have been reached as root none of that server's
     nights may be taken by a point-in-time recovery, the new key's included: their base and WAL
     carry that server's data folder, whose `postgresql.auto.conf` a recovery puts back for `db`,
     with any file planted beside it. Recover the last night from before the trouble logically
     instead (the fallback, below, with the stolen key's file for that one run when a key of that
     file signed it: A stolen or leaked bucket token (VPS), step 5). Whichever night it took, check
     the one its line `pitr: to <point>, from the night of <id>: …` names against the backup's own
     records, as A stolen or leaked bucket token (VPS), step 2, reads them (on the same server the
     journal's lines and the server's own pings inside the night's window), before step 6 starts
     `db`: one they don't name, but for a night
     that sent no ping, as the monitor alerted that day (A stolen or leaked bucket token (VPS),
     step 2), is a sign of theft, and `db` stays stopped while that section is followed.

     The volumes of a new server are new already, but then Storage's files come only from a night:
     do the logical recovery below first (into the new `storage-data`, `db-data` and `db-config`,
     without starting `db`), then make `db-data` new again
     (`rm -sf db backup`, `docker volume rm menumesh_db-data`) and run the point-in-time recovery
     into it. That two-pass is reasoned, not rehearsed; the rehearsal's rewind keeps
     `storage-data` and `db-config`. A new `db-config` means vault secrets don't decrypt, as in
     the logical recovery.

     **The fallback, a night's logical recovery** of that night, into new volumes, from the one
     folder its age gives, as in the restore test: `daily/` while it is younger than 29 days,
     `monthly/` from then on. On a new server they are new. On the same server the old `db-data`,
     `db-config`, `storage-data` and `wal-spool` go first, with everything stopped, once the
     containers that hold them are gone, `backup` included (it reads `storage-data` and ships from
     `wal-spool`); recovering onto a new server instead keeps them:

     ```sh
     sudo app-compose menumesh stop
     sudo app-compose menumesh rm -sf db storage backup
     sudo docker volume rm menumesh_db-data menumesh_db-config menumesh_storage-data menumesh_wal-spool
     ```

     Then, on either server:

     ```sh
     sudo app-compose menumesh --profile recover run --rm -e RESTORE_STAMP=<id> -v /run/age:/run/age:ro recover
     sudo app-compose menumesh --profile recover rm -sf recover-db
     ```

     A night from before a theft of the signing key (step 2.2) that the stolen key, or an older
     key that may have leaked, signed is refused by `.env`'s list, which no longer holds that key:
     its versions of before the trouble made current first, as in step 2.1, give it the stolen
     key's file's list for that one run, quoted as it may hold several keys, and never put that
     list back in `.env`. These two take the place of the two above, and a restore test of that
     night takes the same two `-e`:

     ```sh
     sudo app-compose menumesh --profile recover run --rm -e RESTORE_STAMP=<id> -e "BACKUP_SIGNING_PUBLIC_KEY=<the stolen key's file's list>" -v /run/age:/run/age:ro recover
     sudo app-compose menumesh --profile recover rm -sf recover-db
     ```

     One that an older key of the kept list signed is recovered with `.env`'s list, as any night,
     with the two above (its versions of before the trouble made current first all the same):
     the stolen key's file refuses it.

     It refuses while `db` runs, onto `db`'s old cluster and onto old Storage files, and stops at a
     night no backup made (a psql command in its roles, a manifest line a backup doesn't write, a
     link in its Storage archive, this one before anything is written), and without
     `RESTORE_STAMP` it refuses to run at all; it ends with `recovery of <id> done`. One that stops
     after `restore: roles` says `stopped after it began to write`: part of the night is in the
     volumes, so all three go again, as above, before another night is recovered.

  6. `wal-spool` must be new after any recovery before `db` starts, as step 5 makes it on the same
     server: an old spool with files waiting and a new cluster stops the shipper, with an alert at
     once (a changed identifier), and nothing mixes. Then `sudo app-compose menumesh up -d db`,
     which finds the cluster and skips its init (after a point-in-time recovery it archives the
     new timeline: its history file reaches `wal/` within a minute or two), then
     `sudo app-compose menumesh up -d auth rest realtime storage api-gw backup` (on a new server
     this starts `backup`, stopped since step 4, after `db`).
  7. Production's image, by the admin form, and staging's; then
     `sudo app-compose menumesh up -d scheduler scheduler-staging` (`scheduler` alone before the
     staging night's step 5, on the same server or a new one: First install, step 20).
     Production's release follows from the recovered state, whatever kind of recovery brought it
     back, in this order:

     1. **The release live then**: the one live at the recovered state's last transaction, a
        night's stamp, the point, or after `latest` the last transaction `pitr.sh` printed,
        deployed without a migrate reference, as the database already holds its migrations.
        After a recovery to `latest` on the same server, unless it ended at a cut
        (`PITR_ACCEPT_CUT`) or before `deploys.log`'s last production line (as when WAL stopped
        reaching the bucket before the loss), that is the release `images.env`'s `WEB_IMAGE`
        names, never with the image its `MIGRATE_IMAGE` names, which can still be that of a
        release a rewind undid, since a rollback by hand passes no migrate reference: its
        migrate run would apply that release's migrations again. Otherwise it is the new image
        of the last production line of `deploys.log` before that time. On the same server that
        is the server's own `deploys.log`, as `images.env` is the server's own file, which names
        any release made since, whose migrations the recovered state lacks: after a night, the
        last production line of `deploys.log` before the night's stamp. On a new server it is
        the `deploys.log` step 2 unpacked, which ends at its archive, made at 20:20 UTC: after a
        night's logical recovery, it is the release `WEB_IMAGE` names in the `images.env` that
        step 2 unpacked from that night's own settings archive, and a release made since the
        archive is only in the owner's own notes of each deploy since it. After a rewind to a point
        before a release, such as the bad release it undid, it is the release before it, the last
        production line of `deploys.log` before that point, and never the entry of `images.env` that
        the rewind undid: that file still names the release, whose migrate run would apply its
        migrations again and switch `web` back to it. So too when a rewind past a release came after
        the night whose settings archive step 2 unpacked, as on a new server that took the way past
        the nights a rewind left (step 5): that archive's `images.env` and `deploys.log` still name
        the release the rewind undid, so production's is the release before it, the last production
        line of the archive's `deploys.log` before the rewind's point.

        `deploys.log` is `/srv/menumesh/deploys.log`, on a new server the one step 2 unpacked,
        and no script cuts it, so it still names an old night's release. Its lines are in UTC,
        each image as `<tag>@sha256:<digest>`:
        `2026-12-17T04:30:12Z production web <old> -> <new> by ops`. Compare them with the
        night's stamp, or with the point in UTC, as `pitr.sh` prints it in brackets after a
        point given with an offset, and with the last transaction it prints, in UTC too. On a new
        server the owner's notes count a release as live at a time, or as gone live since it, by the
        time it went live, as these lines do; step 5's bound goes by the time its deploy began. A
        line with `FAILED` or `ROLLED BACK` after its two images never left the new one live: the
        release is its old one. An image no longer on the server, as on any new server or two
        releases back on the same one, needs the token of Production, step 2 (Deploys on the VPS),
        but not its migrate reference: without a token `app-deploy` stops at `couldn't pull …` and
        switches nothing.

        ```sh
        read -rs PAT && printf '%s\n' "$PAT" | sudo app-deploy menumesh production \
          prod-vX.Y.Z@sha256:<digest>
        ```

     2. **From before a bad release's deploy**: where the recovered state is from before a bad
        release's deploy began, or at least before its migrations ran (step 5), whatever kind of
        recovery brought it back, a rewind past it, a night from before it, or `latest` that
        ended at a cut before it, no release made since that deploy began goes out again, ever,
        as each holds that release's migrations, and neither does any release built from `main`
        until the harmful migration is made harmless in its own file, under its own version
        (Database migrations). Never delete the file: hosted staging's history holds that version,
        and `migrate.sh` refuses a database with a version its image lacks (exit 2). In 3 the
        release that stayed live is then the one live just before that deploy began, read from
        `deploys.log` as in 1.

     3. **The release that stayed live**: if a release went live since the recovered state's
        time and stayed live, the newest of them goes out again by Production, step 2, with its
        own migrate reference, the one its **VPS release** run printed: its migrate run applies
        every migration the recovered database lacks, the older releases' among them. On the
        same server that is the release `images.env`'s `WEB_IMAGE` named before step 7's deploy,
        the new image of the last production line of `deploys.log` before step 7's deploy
        that is neither `FAILED` nor `ROLLED BACK` (the old image of step 7's own line), when
        that line is later than that time; on a new server, the one the owner's own notes of each
        deploy since step 2's archive leave live, step 7's own not counted, or with none since, the
        one that archive's `deploys.log` leaves live, read as on the same server, when it went live
        later than that time, never the **VPS release** runs alone, which list each release built,
        not whether it stayed live. One older than step 1's, as after a rollback by hand since, goes
        out as step 1's did instead, without a migrate reference, as the database holds step 1's
        migrations. If none did, or it is step 1's own, step 1's deploy is all.

  8. The edge, by the admin: the redaction file right after step 1's conf (First install, step 9),
     then new certificates from fresh CSRs, `aop-ca.pem`, `aop-client.pem` and `edge.env` from the
     password manager, in First install, step 11's order: MenuMesh's two lines merged into the new
     server's `edge.env` through that step's copy, newline guard and `cat >>`, its check of the
     names and lengths and its install and shred, unless that check, run on the copy first, shows
     them there already; then Caddy's recreate and its checks, as there. Then the site file from
     this repository, the leak test, and DNS to the new address. The origin pulls' CA and client
     certificate stay as they were, the client pair at Cloudflare too.
  9. The key off the ramfs, then a settings archive and `backup.sh` run once by hand, so that a
     night of the new state exists, its base and its archive sealed (Last night's backup):

     ```sh
     sudo systemctl start app-config-archive@menumesh.service
     sudo app-compose menumesh run --rm --no-deps -T backup /usr/local/bin/backup.sh
     ```

     Then a restore test and a point-in-time drill after the next night.

  A recovery does not bring back what no backup holds: pgsodium's root key (vault secrets come back
  but do not decrypt; the app keeps none) and a few extension settings MenuMesh doesn't use
  (docs/DECISIONS.md VPS-40). A logical recovery also rewinds the database to its night; the
  point-in-time one does not, and a rewind to a time before the last night's base ended makes the
  drill and a recovery to `latest` fail until that run of `backup.sh`.

### A stolen or leaked bucket token (VPS)

The bucket's API token is in the server's `.env`. Whoever holds it can list and read the bucket and
add objects to it, and replace or delete any object its locks don't hold (First install, step 2).
It does not hold the signing key, which is on the server only, so an object it adds is refused
by every restore, however well it is encrypted: each night is read through its seal, and each
WAL file is taken only if the signature in its name verifies (docs/DECISIONS.md VPS-43). What the
holder can still do is delete what no lock holds, flood the bucket with names (a recovery then
refuses past 2,048 names in a WAL folder), plant one of tonight's names first so the night fails
where the locks refuse overwrites (in `monthly/`, one of its copy's names or its record's, which
stops that night's copy, every night it is done: Last night's backup), and make the month's copy
repeat. Where the bucket keeps versions, objects of a month's copy's sizes put over its parts
pass the job's check for them, and only a restore refuses them, by their sha256. Where no lock
holds `wal/`, a timeline that a rewind began, removed whole (its history file with all its WAL),
leaves a recovery to `latest` nothing to tell it by: it follows the abandoned timeline and undoes
the rewind, so lock `wal/` (First install, step 2), or make the removed versions current again
first. Take it as stolen when a restore, or `pnpm vps:verify-night` on a downloaded night, prints
`is not signed by the backup's key`,
`is not the part the backup sealed` or `is not in the seal`, when a restore prints
`backslash commands are restricted` or `holds links or special files`, when a drill or recovery
prints `the chain of WAL files is cut`, when a night stops with `someone else wrote to the bucket`,
when a step of the month's copy fails on a lock's refusal, or at the same step night after night
(Last night's backup), when the WAL alert says a lock refuses what the shipper writes, when a
restore test, drill or recovery takes a night that none of the backup's own records names (on the
same server the journal's lines and the backup monitor's pings from the server's own address
inside the night's window, never a Telegram message; after a rebuild, those pings alone:
step 2), names one stamped later
than now (`restore: not taking the night of <id>, stamped later than now`), or passes over a night
(`pitr: not taking the night of <id>: its seal …, so it is not the backup's`) or WAL objects
(`<n> objects passed over, not the backup's`, n above 0, or once a key has left the list, n above
what the first drill since printed) as not the backup's, when the
bucket holds names the backup never writes, or when the token was seen anywhere it shouldn't be. A
flood of names slows every listing; a large one can stop the job's check for the month's copy,
failing each night after its uploads with the alert, and the restore test unasked, while a named
restore lists nothing.

1. **Rotate the token** with the bucket's admin login, never on the server: a new token for this
   bucket only, into `.env`, then `sudo app-compose menumesh up -d backup` (Rotation), and the old
   token revoked. Nothing more can be written with it.

2. **Check the bucket's nights** by their seals. The backup's own lines name its nights: each
   `backup <id>: …` line in the journal a whole night, as the backup monitor's log does, and each
   `[menumesh] backup failed (exit …) at <id>: …` line a night that failed, its seal up or not:

   ```sh
   sudo journalctl COM_DOCKER_COMPOSE_PROJECT=menumesh COM_DOCKER_COMPOSE_SERVICE=backup --since -180d --utc -o short-iso
   ```

   Such a line, an alert or a ping only keeps the night it names, and never condemns one: a leaked
   `.env` holds the bot's token and the monitor's address, root can write or empty the journal, a
   rebuilt server's journal begins at the rebuild, and a night stopped after its seal has none. So
   nothing goes because no line names it, or because an alert names it. Every other id in `daily/`
   and `monthly/` is judged by its seal alone. Download its `seal-<id>.txt` and
   `config-<id>.tar.age` from that folder into an empty folder, as in Disaster recovery, step 2.1,
   with the provider's download, byte for byte and never from a text preview, and check that the
   seal's size is the one the bucket lists (else download it again). Then check them on the owner's
   machine as in step 2.2, with the kept list's file, then, if that refuses the seal, with each
   stolen key's file kept (one for each theft: step 5):

   ```sh
   pnpm vps:verify-night <id> <folder> --keys <the list's file>
   ```

   Only a seal that every list refuses, as
   `its seal (seal-<id>.txt) is signed by none of BACKUP_SIGNING_PUBLIC_KEY's keys` or for its form
   (any other words after `its seal (seal-<id>.txt)`, which a copy saved with CRLF line ends or cut
   short gets too: hence the size), is the token holder's: delete it, or, where the bucket kept an
   older version of it that a list verifies, make that one current again instead (after a leaked
   `.env`, step 5, only a version from before the trouble, as the stolen key could sign a later
   one). Its record and parts stay, as they may be the backup's: a cost only, until the backup's
   own removal, as does an id with no seal at all. A pass, or a refusal past the seal (of the
   settings archive or a part), means a key of a list signed its seal: that id stays. Names the
   backup never writes, and floods, are the holder's, in any folder. A part put over its own is
   refused by its seal, and a WAL file put over its own by its signature, so that night can't be
   restored, nor the WAL replayed past that file, until its older version is made current again
   (the restore test, step 4, names the part, and a cut chain the file). The drill passes over any
   other name in `wal/` whose signature does not verify (it names how many): a cost only.

   Where the bucket keeps versions (versioning, or S3 Object Lock), list each folder's versions too,
   delete markers among them, with the admin login in the provider's dashboard: the backup writes
   each name once, so a name with more than one version, or a delete marker, is one someone else
   wrote over or deleted, but for the backup's own removal, which in a night's run removes what
   went up more than 30 days before in `daily/`, 366 days before in `monthly/` and 15 in `wal/`,
   never a history file. A delete marker over such a version, set during a night's run (from its
   stamp to its line in the journal), is that removal and stays, as does one over such a version
   set at another time, which took only what the next night takes, and one with no version left
   under it. Only a marker over a younger version or a history file, or a second version not alike
   byte for byte, is someone else's.

   For each such name, whether or not a line keeps its night, make current again, with the admin
   login, its version that is the backup's: for a seal, the one that went up in the backup's own
   run, by its upload time against the night's stamp and its line in the journal, and that a list
   verifies as above (by a stolen key's file only for a night from before its theft; after a leaked
   `.env`, step 5, only a version from before the trouble); for a part, the one whose size and
   sha256 its night's seal lists (`pnpm vps:verify-night` checks it, the seal and the settings
   archive beside it); for a WAL file, its first, as nobody can name one before its upload (a cut
   chain names one written over or deleted). Delete what someone else put over it to make it
   current, where the provider allows, rather than copy it, which puts it up anew: a recovery to a
   point past a WAL file so copied, and more than 30 minutes before the copy, ends its chain there
   and is refused (docs/DECISIONS.md VPS-100). Two versions of a seal that a list verifies, not
   alike byte for byte, mean a key of that list signed one the backup never wrote: take that key
   for stolen (step 5), after which only a version from before the trouble counts.
   A line only keeps an id from going, never a version put over the backup's: step 4 then finds the
   night it tests whole.

   A seal a list verifies that no record of the backup names means, where those records are whole
   and reach its stamp (no reach as root, and not a night that sent no ping, killed or failed after
   its seal or its ping lost, as the monitor alerted that day unless a run by hand pinged first: on
   the same server the journal's failure line names a failed one, and after a rebuild a night of the
   old server's stamped from a nightly's 20:30 UTC to the next, where no ping from its address names
   a night of that stamp (a run by hand's ping names its own, stamped at another time, and does not
   count), is judged by its seal alone and is no sign of theft), that a
   key of that list signed a night the backup never ran: take that key for stolen (step 5). On the
   same server those records are the journal's lines above, over its 180 days, or from the first
   line the command prints where it holds less (a full journal or a vacuum cuts it short:
   hostwatch's daily `journal:` line gives its oldest line), never a Telegram message, and the
   backup monitor's pings from the server's own address inside the night's window (from its stamp to
   a day after it, so a long base's late ping counts), which none can send without root, so a
   night whose line journald dropped to its rate limit is named all the same; only where the journal
   can't reach, after a rebuild, those pings alone, the server's own address being the old server's
   for nights before the rebuild, as sub-step 4 reads them. Such a ping names its own night and the
   month's copy its line names. An older month's copy, stamped before the records reach, is judged
   by its seal alone and is no sign of theft. A ping from elsewhere, two `backup` pings naming
   different ids in one night's window but for a run by hand, or an alert naming a night inside the
   journal's reach that the journal does not name, on a day journald dropped no lines (hostwatch's
   daily `suppressed:` line), is itself a sign the `.env` leaked (step 5). To find which key of a
   list of several signed a seal, check it with each key of the list alone, in a file of one key
   each: only the signer's gets past the seal, the others print
   `is signed by none of BACKUP_SIGNING_PUBLIC_KEY's keys`. Where that is not the list's first key,
   as from an old copy of `.env`, each other key of the list whose private half was on the server
   since the trouble could have begun, the first among them, goes into the stolen key's file with it
   (step 5). That id stays all the same, as any whose seal a list verifies.

3. **Remove what the token holder wrote**, with the admin login, off the server: lift the lock rule
   of the folder that holds it, delete only what step 2 found to be the holder's (seals every list
   refuses, names the backup never writes, floods), or make its older version current where step 2
   says so, and put the rule back as it was (29 days on `daily/`, 365 on `monthly/`, 15 on `wal/`).
   The backup's own nights, month's copies and WAL stay. Where root may have reached the
   server (step 5), lift no lock while a token that server held or could read is valid: this step
   waits for sub-step 5's rebuild, once step 1's token is revoked and the only token that can write
   or delete is the rebuilt server's, which the reached one never held; and step 2 is done again
   first, its versions among them, as root could write with step 1's token until then.

4. **A restore test of a named night**, the newest the journal names, with
   `-e RESTORE_STAMP=<id>` (Backups and restore (VPS)), then the point-in-time drill. Record the
   date, what was found, what was removed and the result. Where root may have reached the server
   (step 5), they run on the rebuilt server only, not here: both put the backup key's private half
   on the server, which root may still hold.

5. **If the server itself may have been reached** (a leaked `.env`, not only the token), the
   signing key was reachable too, and with it a holder could sign a night or a WAL file under any
   name, or over a night's own where no lock refuses it. A base of their own cluster, sealed so,
   would be replayed into `db-data` by a point-in-time recovery, which has none of a logical
   restore's guards. The leaked `.env` also held what the backup's own records go through, its
   heartbeat addresses and the Telegram bot's token: with them a holder can post a
   `backup <id>: …` line of a night of their own to the backup monitor, as if the backup had run
   it. And the leaked `.env` leaked every value in it: besides the backup's, both cron secrets,
   the schedulers' heartbeat addresses, hosted staging's pooler login (`STAGING_DB_*`) and, in a
   planned window not rehearsed yet, the API keys' set and `POSTGRES_PASSWORD` go new, each by its
   step in Secrets (VPS), Rotation. Where root may have reached the server, no private key that
   outlives the rebuild (sub-step 5) goes on it: step 4's restore test and drill, the two that
   close Rotation's signing key step, and sub-step 4's recovery and restore test put the backup
   key's private half on its ramfs, so they run on the rebuilt server only. So, with the token and
   the bucket's admin steps above (step 3, where root may have reached the server, only after
   sub-step 5's rebuild):

   1. **The signing key**, rotated with the stolen key out of the list at once (Secrets (VPS),
      Rotation): in `BACKUP_SIGNING_KEY` the new private key, which also goes into the password
      manager, and in `BACKUP_SIGNING_PUBLIC_KEY` the new public key first, then each older key of
      the list whose private half had left the server before the trouble could have begun (it
      left at the rotation that replaced it), never the stolen key. The same line takes the kept
      list's place in its file of its own beside the age key. The stolen key and every other key of
      the list whose private half was on the server since the trouble could have begun, the list's
      first among them, are kept apart, as
      `BACKUP_SIGNING_PUBLIC_KEY=<the stolen key> <each key of the list it does not keep>` in a file
      of their own marked stolen, never in the kept list's file or the age key's: from then on no
      restore, drill or point-in-time recovery takes a night or a WAL file one of them signed, the
      real ones included, unless that file's list is given for one run.

   2. **The backup's records.** First copy the backup monitor's log off it, each ping's time,
      address and line: a monitor keeps only its newest pings, and the leaked address lets its
      holder push the old ones out. Then a new address for `HEARTBEAT_BACKUP_URL` and for
      `HEARTBEAT_WAL_URL` (new monitors, the old ones kept for their logs) and a new token for the
      Telegram bot, into `.env` with the bucket's new token (Rotation). Check the pair (Disaster
      recovery, step 4, its one-off), then `up -d backup`.

   3. **A night of the new key**: a settings archive of the rotated `.env`, its journal line, and
      `backup.sh` once by hand (Last night's backup), so that a night of the new key exists with
      that archive sealed:

      ```sh
      sudo systemctl start app-config-archive@menumesh.service
      sudo journalctl -t app-config-archive --since -10min
      sudo app-compose menumesh run --rm --no-deps -T backup /usr/local/bin/backup.sh
      ```

      The journal shows
      `menumesh: archived … into config-<stamp>.tar.age (<bytes> bytes), newest 3 kept`.
      Without a fresh archive the night fails (`the settings archive … is more than 2 hours old`)
      and seals none, and on a new server no night would then pass Disaster recovery, step 2. No
      copy the stolen key recorded counts once it is out of the list, so the first night of the new
      key makes the month's copy again and prints
      `backup <id>: kept in monthly/ as the month's copy`, then
      `backup <id>: 6 parts, <n> bytes, kept in monthly/ as the month's copy`, unless an older key
      the list still holds recorded this month's copy (before a rotation this month): it then
      names that copy instead,
      `backup <id>: 6 parts, <n> bytes, the month's copy is <id of the copy>`, and a night of the
      1st copies itself all the same. A point-in-time recovery, and on a new server Disaster
      recovery, step 2, with the kept list, start from it or from a later night of the new key.

   4. **A night from before the trouble**, for a recovery before the night of the new key exists,
      or to a point before it: a night's logical recovery (Disaster recovery, step 5, the
      fallback) of the last night from before the trouble could have begun. Name it only from
      records made before the trouble could have begun: a ping the backup monitor received then,
      from the server's own address and inside its night (from its stamp to a day after it, so a
      long base's late ping counts), or
      the old server's journal from then, unless root may have reached the server, as root can write
      the journal; never a ping received since. Two `backup` lines naming different ids in one
      night's window but for a run by hand, or an id that no record from before names, mean a night
      of the thief's: take the night before it. Where the bucket keeps versions, make the versions
      of that night's objects that went up before the trouble (its seal, its settings archive and
      its parts) the current ones again, with the admin login, before anything of it is downloaded
      or recovered: one signed with the stolen key could have been put over each, and the stolen
      key's file would take it. Then recover it, when a key of that file signed it, with that file's
      list given for that one run, quoted as it may hold several keys, and never put back in `.env`:

      ```sh
      sudo app-compose menumesh --profile recover run --rm -e RESTORE_STAMP=<id> -e "BACKUP_SIGNING_PUBLIC_KEY=<the stolen key's file's list>" -v /run/age:/run/age:ro recover
      ```

      Its restore test, in step 4, takes the same two `-e`. That file is for such nights alone:
      one that an older key of the kept list signed is recovered with `.env`'s list, as any night
      (Disaster recovery, step 5, the fallback), and the stolen key's file refuses it. Where root
      may have reached the server, this recovery and its restore test run on the rebuilt server
      only (sub-step 5), as both put the backup key's private half on it.

   5. **If root may have reached the server**, nothing it made after the trouble could have begun
      is trusted, not only the settings archive of sub-step 3's night: that night's base and WAL
      carry the server's data folder (a point-in-time recovery puts its `postgresql.auto.conf`
      back for `db`, and any file planted beside it comes back too), and the new key itself, with
      the new token and addresses of sub-step 2, went into that server's `.env`. So the server is
      rebuilt (Disaster recovery). On the new one the night of sub-step 4 is checked (Disaster
      recovery, step 2) and recovered logically (Disaster recovery, step 5, the fallback), with
      the stolen key's file and its list for one run where a key of that file signed it, and
      never by a point-in-time recovery from the reached server's nights. The new server gets a
      fresh signing pair, from a fresh `pnpm vps:secrets --out <new folder>` on the owner's machine
      (those two values only, as in Rotation), put in at Disaster recovery, step 2.4: its list, in
      `.env` and in the kept list's file, is the fresh key first, then the older keys of sub-step 1
      (none when the backup key counts as stolen too, below), without the key the reached server
      held, which goes into no list and not into the stolen key's file, and no night that key
      signed is used. The bucket's token goes new once more, into the rebuilt server's `.env`
      alone, and step 1's token is revoked before Disaster recovery, step 2, reads the bucket: root
      could read it in the reached server's `.env`, and with it put a night of the stolen key over
      the versions step 2.1 makes current, or delete under a lock step 3 lifts, so only then is
      step 2 done again, its versions among them, and only then does step 3 lift a lock. From the
      revocation until Disaster recovery, step 8, moves the DNS, the reached server's shipper
      alerts every hour that `the upload of <walfile> to the bucket failed (rclone)`, its nightly
      backup fails at `reaching the bucket`, and sub-step 2's monitors alert: that is expected,
      and it gets no token. The heartbeat addresses and the bot's token go new once more too,
      and what else the reached server held is Rotation's (Secrets (VPS)).

      If the backup key's private half was on that server since the trouble could have begun (a
      monthly restore test or drill, a recovery, step 4), the backup key counts as stolen too: it
      opens the settings archives of the nights each older key signed, and their `.env` holds that
      key's private half. So the new server also gets a new backup pair, made as in First install,
      step 1, before Disaster recovery begins: its public key goes to the admin for
      `BACKUP_RECIPIENT` at Disaster recovery, step 1, and into `.env`'s `BACKUP_AGE_RECIPIENT` at
      step 2.4, before 2.4 checks the admin's conf and enables the settings archive's timer and
      before step 6 starts `backup`, so that nothing the new server makes is encrypted to the stolen
      key. The old private key is kept offline for the old backups, the night of sub-step 4 among
      them, which only it opens (it is the one on the rebuilt server's ramfs for that night); and
      every older key of sub-step 1 goes into the stolen key's file, not the rebuilt list.

### Logs and alerts (VPS)

Every container logs to journald, the server's default, and the journal keeps a line 180 to 187
days, which the privacy text must say.

```sh
sudo journalctl COM_DOCKER_COMPOSE_PROJECT=menumesh --since -1h -o cat
sudo journalctl COM_DOCKER_COMPOSE_PROJECT=menumesh COM_DOCKER_COMPOSE_SERVICE=db --since today -o cat
sudo journalctl -t app-deploy --since today
sudo journalctl -t app-config-archive --since yesterday
sudo journalctl CONTAINER_NAME=edge-caddy-1 --since -1h -o cat | grep menumesh.in
```

- **The budget** is `LOG_LINE_BUDGET=45000` lines a day for the project, Caddy's lines for
  MenuMesh's hosts included; hostwatch's daily report counts them. The stack writes nothing while
  idle, boards open or not, so lines come from events (measured in the rehearsal): a web start 5, a
  database restart about 200, a failed sign-in or code 1, a QR code that doesn't work 2 a view, a
  gateway error 1, a minute call without a 200 1. A day over budget means an error loop (find it
  with the commands above) or a noisy successful route (`log_skip` it in the site file).
- **Never in a line:** statement text or DETAIL from the database, query strings (Envoy and Caddy
  drop them), tokens and keys (the scripts print none), a visitor's address in Caddy's lines, and
  `/t/<token>` (redacted to `/t/_`). Auth's lines for failed sign-ins, failed codes and 429s do hold
  the visitor's address.
- **Alerts that concern MenuMesh:** hostwatch's (every 5 minutes, on Telegram, and its daily
  report): a container unhealthy (`web` in a database outage, the scheduler 12 to 13 minutes without
  an answered minute call), restarts (Realtime restarts once after a database stop), memory kills
  and the memory sum, lines over budget, the redaction file missing, `BACKUP_RECIPIENT` and
  `BACKUP_AGE_RECIPIENT` differing, `app-config-archive@menumesh.timer` not enabled, a certificate
  near expiry and an edge config that no longer validates. Also `app-deploy`'s rollback alerts, the
  backup's own Telegram line, the heartbeat monitors and Sentry. Auth's "rate limiting is not
  applied" or "error processing Sb-Forwarded-For" warnings mean a call without the visitor's
  address: a bug to fix (VPS-4).
- **WAL alerts** (the `backup` service's Telegram line, at most one an hour, and one line when it
  is over): `[menumesh] WAL is not reaching the bucket (cluster <id>): <reasons>`; the tool's own
  first lines are in the journal. After 10 minutes of waiting:
  - `the oldest WAL file waited N minutes, M wait now`: the bucket, its token or a lock on `wal/`
    refuses or can't be reached. Check the bucket and the token (Rotation), and that no lock rule
    refuses a new object under `wal/`. Nothing is lost while the spool and the outbox fill (an
    outbox file is about 1 KiB idle); they drain, oldest first, once it works.
  - `db's archiver has failed for N minutes`: `db` can't copy into `/wal-spool` (full disk,
    wrong owner). Look at `pg_stat_archiver` (WAL shipping, above) and the disk. A full disk wants
    the owner: free it at once, since `db` keeps its own WAL while it can't archive. The shipper
    sends this from a full disk too: its own files are in the `backup` service's 16 MiB tmpfs at
    `/tmp`, where it also keeps its record while the spool takes no write.
  - A WAL file that can't be compressed, encrypted, put in the outbox, read, signed or uploaded, or
    `db's system identifier, <id>, could not be kept in /wal-spool/.ship` (when the shipper takes a
    new identifier, as on its first run on a new spool): almost always a full disk or the signing
    key.

  At once, because no wait mends them: `db archives no WAL` (`archive_mode` off: a `db` started
  with a command other than the compose file's); the spool is not postgres's to write (the
  volume's owner: restart `db` so its wrapper fixes it; once in Disaster recovery's step 4 on a
  new server, before `db` exists, it is expected); a variable not set;
  `BACKUP_SIGNING_PUBLIC_KEY is not one Ed25519 public key or several, …`,
  `BACKUP_SIGNING_KEY is not an Ed25519 private key, …` or
  `BACKUP_SIGNING_KEY does not sign what BACKUP_SIGNING_PUBLIC_KEY's first key checks` (a value
  in `.env`, which the check of Disaster recovery, step 4, names too); a segment of another
  cluster, `db`'s identifier changed while files wait, or an outbox without a kept identifier: a
  recovery or a new `db-data` without a new `wal-spool`. The spool is made new with `db` and
  `backup` both gone, as both mount it and Docker removes no volume a container holds. That takes
  the database down for about a minute and drops what waits, and `db`'s wrapper makes the new
  volume postgres's:

  ```sh
  sudo app-compose menumesh rm -sf backup db
  sudo docker volume rm menumesh_wal-spool
  sudo app-compose menumesh up -d db
  sudo app-compose menumesh up -d backup
  ```

  What waits includes the new cluster's own WAL since `db` started, so a base taken before this has
  a cut chain until the next night: make a settings archive and run `backup.sh` right after (Last
  night's backup):

  ```sh
  sudo systemctl start app-config-archive@menumesh.service
  sudo app-compose menumesh run --rm --no-deps -T backup /usr/local/bin/backup.sh
  ```

  `HEARTBEAT_WAL_URL` silent for 15 minutes means the shipper isn't running (`backup` down or its
  crond stuck: `ps`, then `up -d backup`) when nothing else says so, or that one of the alerts
  above holds, such as `db`'s archiver failing on a full disk, whose alert comes first. For a
  stopped `backup` that silence is the only signal: hostwatch reads only running containers.
  **A dead shipper fills the spool by about 0.94 GiB an hour**, a whole 16 MiB file for each minute
  that wrote anything (every minute here). The spool is on the server's one root filesystem
  (193 G), with every volume, the journal and both apps' Postgres. From the 6% used on 2026-11-21,
  hostwatch warns at 80% of `/` after about 6 days and is critical at 90% after about 7,
  `app-deploy` refuses both apps' deploys once under 5 GiB is free, after about 7.4, and then the
  disk is full for everyone. A running `backup` whose shipper sends nothing turns unhealthy long
  before: its healthcheck (`wal-health.sh`) fails once a WAL file has waited over 20 minutes,
  nothing has gone up for 10 and the container has seen it so for 10 more, about 33 minutes after
  the last upload (the WAL alert comes after about 10), and hostwatch reports it within its next
  5-minute run. Bring `backup` back at once (it drains oldest first). One line,
  `[menumesh] WAL shipping resumed (cluster <id>)`, says it is healthy again.

### Checking the kit here

Each needs only Docker Desktop, runs throwaway containers named `menumesh-kit-*` or the project
`menumesh-rehearsal`, publishes on `127.0.0.1` only, and calls no outside service. The local
Supabase stack is only ever read.

- `pnpm test` pins what each kit file must keep (`tests/unit/vps-kit.test.ts`,
  `tests/unit/vps-secrets.test.ts`), what `pnpm vps:verify-night` takes and refuses
  (`tests/unit/vps-verify-night.test.ts`), what `pnpm vps:probe` checks and refuses, against a
  stand-in edge (`tests/unit/vps-probe.test.ts`), what the first-admin tool asks of a stand-in app
  and gateway and prints, and the values file its maker writes
  (`tests/unit/vps-first-admin.test.ts`), and the steps of this runbook that no script runs, such
  as the settings archive before each `backup.sh` by hand, the signing pair's check, the release a
  recovery deploys, the steps after a theft of the signing key and the cut-over's order
  (`tests/unit/vps-runbook.test.ts`).
- `pnpm vps:check` (about 20 s, and 46 s more the first time, for its checker image) runs the
  server's own `app-apply` checks on `deploy/vps/` as root in a throwaway container, then the
  contract's rules, Caddy's and Envoy's validation and shellcheck. Run it after any change under
  `deploy/vps/` and before every install.
- `pnpm vps:edge` (about 10 s) puts the site file in the server's Caddy tree, in front of stub apps
  on `127.0.0.1:8443`, and tests how it answers. Run it after any change under `deploy/vps/edge/`.
- `pnpm vps:rehearse [--fresh] [--rebuild]` (2 to 4 minutes, 6 to 8 from empty since it watches
  the WAL ship for 3 minutes) runs the whole stack as the server would, as project
  `menumesh-rehearsal`, with throwaway secrets in `.vps-rehearsal/` (gitignored):
  the app on `http://localhost:3300` and the gateway on `http://127.0.0.1:8300`. It needs 6 GiB
  available in Docker Desktop's VM. Its step 8 runs `deploy/vps/tools/first-admin.mjs` in `web` as
  the owner runs it on the server, behind the values file `first-admin-values.mjs` makes on its
  stdin and with no `-e` (The first platform admin (production)), the seed's platform admin set
  aside meanwhile, and follows the link through the join page to a sign-in with the new password;
  then the seed's admin is back. A rerun keeps the stack, its secrets and an image nothing changed
  for; `--fresh` starts over with new secrets and empty volumes; `--rebuild` builds every image. A
  look inside:

  ```sh
  docker compose -p menumesh-rehearsal --project-directory .vps-rehearsal \
    -f .vps-rehearsal/compose.yml -f deploy/vps/local/compose.rehearsal.yml \
    --env-file .vps-rehearsal/.env --env-file .vps-rehearsal/images.env ps
  ```

  The smoke tests run against it with `SMOKE_URL=http://localhost:3300` and `EXPECTED_VERSION` set
  to the web image's revision:

  ```sh
  docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' menumesh-web:rehearsal
  ```

  A Playwright subset ran by hand with `E2E_PORT=3300` and the rehearsal's address and keys in the
  environment, through a copy of `playwright.config.ts` without its `webServer`; specs that need the
  mock APIs can't run against it.

- `pnpm vps:backup-test` (about 35 minutes, on a running rehearsal) runs the shipper and the
  nightly backup into a local S3, then the restores and the point-in-time recovery: WAL shipped and
  signed, a shipper outage with its alert and its "resumed", the shipper's failure paths against a
  Postgres of their own (a full disk among them, alerting from its tmpfs), every night's seal
  checked with Node's crypto, the month's copy made past objects named like its parts, its record
  (a night beaten at its own check stopped as someone else's writing, and the next night copying
  itself; a name of the copy, and its record's, put in `monthly/` while the night runs, each
  stopping that night; a copy without its record and records someone else put in, each copied
  again; five copies cut short before their records, which hide no recorded one; a rotation
  keeping the old key's copy; a 1st whose removal fails still naming its copy; every record read
  with Node's crypto), the restores' refusals (a seal another key signed, a night with no seal, a
  part changed or longer or not listed, a night too big for the disk), Disaster recovery's step 2
  (`pnpm vps:verify-night` on a night downloaded by name, then on a settings archive of someone
  else's put over it and on one put under a night that sealed none), a rotation and a theft of the
  signing key with `backup.sh` by hand (no night that passes step 2 without a fresh settings
  archive, one with it) and the signing pair's check, with signing values that are not keys named
  by it, by `backup.sh` and by the shipper, a base a checkpoint overtakes, the drill to a point and
  to `latest` against rows and a table written and dropped, a base holding an `ALTER SYSTEM`
  setting, a changed WAL byte, a recovery to `latest` refused at the cut and taken to it with
  `PITR_ACCEPT_CUT`, a recovery to a point cut short while a newer night exists (from that night,
  `PITR_ACCEPT_CUT` refused and `latest` through without it), `recover-pitr` into new volumes with
  the stack started on the result, a gap on the new timeline that an abandoned one's file must not
  fill, and a rewind that leaves two nights behind it, one whose base it ran inside: the drill and
  a recovery to `latest` refuse each in turn before they write, each seal kept aside, until the
  night before recovers across the fork, a point before the rewind's point and one on its timeline
  are reached from that night, one on the stretch the rewind abandoned only to the rewind's point,
  and with the seals back before a night of the new timeline both refuse again. And, as before: a
  night whose settings archive is stale, then the month's copy in `monthly/` past names planted
  there and a whole-looking copy with its record, both another key's, refused at its seal, no
  second copy, and a 1st's copy (stamped by a stand-in `date`); a night whose id someone else
  wrote a name of first (a stand-in `od` gives the random part), stopped before its first upload;
  the monthly restore test; planted nights and names the restore must refuse, or not read, each
  night read from the one folder its age gives (a night younger than 29 days that only `monthly/`
  holds is refused); and a disaster recovery of the 1st's copy, two months old, from `monthly/`,
  on the rehearsal's own volumes, after one without `RESTORE_STAMP` is refused. A rehearsal left
  running also runs its own night at 20:30 UTC, which fails (it has no settings archive) and logs
  its lines; the checks never wait for it.
- `pnpm vps:down [--images]` removes the rehearsal's containers, networks and volumes (and its three
  images with `--images`), and nothing else. `.vps-rehearsal/` stays for the next run.
- **Copying the server team's files again**, whenever they change `app-apply`, the edge's
  `Caddyfile`, snippets or ranges, or the confs, and before every install:
  1. For each file `deploy/vps/test/vendor/jainav-infotech/SOURCE` lists:
     `git -C <their checkout> show <commit>:<path> > deploy/vps/test/vendor/jainav-infotech/<file>`,
     byte for byte; nothing there is ever edited.
  2. In `SOURCE`, the commit, the date and the sha256 lines (`sha256sum` of the six files in that
     folder); `app-apply` keeps its mode, 100755 (`git update-index --chmod=+x`).
  3. If their `edge.conf` names a new Caddy image, `CADDY` in `scripts/vps-kit.mts` becomes it: the
     tag with the digest `docker buildx imagetools inspect caddy:<tag>` shows, or exactly their
     `<tag>@sha256:<digest>` when `edge.conf` pins one. `pnpm test` and `vps:check` refuse an
     `edge.conf` that names neither `CADDY`'s tag nor exactly `CADDY`. The owner's hash command in
     First install, step 11, and in `edge.env.example` names `CADDY` and moves with it, as
     `pnpm test` requires.
  4. `pnpm test`, `pnpm vps:check` and `pnpm vps:edge`. A new refusal is a change for the kit, or a
     question for the server team.

  `MEMTOTAL_MIB` in `scripts/vps-kit.mts` holds the MemTotal the server reports, 15,992 MiB. After a
  resize or on a new server it becomes what `awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo`
  prints there.

## Razorpay live switch

1. Move production to Supabase Pro (daily backups, no pausing when idle); keep the nightly export.
2. KYC approved; live mode enabled in the Razorpay dashboard. Open **Payments → Subscriptions**
   once in live mode: that switches the product on (step 6 fails until then).
3. Create live keys; set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in the production Vercel
   project.
4. Add the webhook `https://menumesh.in/api/webhooks/razorpay` with the `subscription.*` and
   `payment_link.paid` events and a new secret; set `RAZORPAY_WEBHOOK_SECRET`.
5. Release production (a changed variable reaches only new deployments).
6. `/super` → **Plans** → **Create … plan in Razorpay** for each plan and cycle (live plans are
   separate from test ones).
7. Subscribe a real test restaurant with a small plan, check the webhook arrives and the
   payment shows at `/super`, then cancel it.

## The first platform admin (production)

**On the shared server**, made in the days before the production night and opened during it (The
shared server (VPS), The server rehearsal and the cut-over, part 4), with
`deploy/vps/tools/first-admin.mjs` (docs/DECISIONS.md VPS-111 and VPS-134):

1. The tool goes to the server's `~/incoming` like every file of the install, and is never
   installed under `/srv/menumesh`.
2. After production's first deploy, the owner, on their own machine, makes the values file with
   `deploy/vps/tools/first-admin-values.mjs` (Node 24, in Git Bash, PowerShell or any other
   shell). It asks for the owner's email and name (1 to 80 characters), refuses what the tool would
   refuse, and writes two lines of plain ASCII, which any shell's pipe passes unchanged, to `ssh`,
   which takes them to `ops` through the tunnel, as First install's `scp` does. That `ssh` must ask
   nothing: it starts with the maker and shares the terminal the maker reads the two values from,
   so its passphrase or host key prompt could take a value typed for the maker, or give the maker
   the passphrase as a value. So the owner's key goes into ssh's agent first (`ssh-add` with the
   key's file, with an agent running: in Git Bash `eval "$(ssh-agent -s)"` starts one, and
   Windows' own ssh needs its `ssh-agent` service on), and the first line below, a login through
   the tunnel with `-o BatchMode=yes`, which makes ssh fail wherever it would ask, must exit 0
   before the second:

   ```sh
   ssh -o BatchMode=yes ops@<the tunnel's SSH host> true
   node deploy/vps/tools/first-admin-values.mjs | ssh -o BatchMode=yes ops@<the tunnel's SSH host> 'umask 077 && cat > ~/incoming/first-admin.values.mjs'
   ```

   The first login through Access opens the browser, and `cloudflared` keeps its token. When the
   first line fails (`Permission denied`, `Host key verification failed`), the agent or
   `known_hosts` is mended before the second runs. The file is made only with this tool: a
   hand-written one brings back the quoting problems, as an apostrophe or a backslash in a quoted
   value changes what the file says. When `first-admin-values.mjs` refuses a value it writes
   nothing, and the empty file left on the server makes the tool refuse: run the second line
   again. Then, through `ops`, the owner runs the tool once inside the `web` container, which gives
   it that container's own keys, with the values file before it on its stdin, and then removes the
   values file, whether the tool succeeded or not:

   ```sh
   cat ~/incoming/first-admin.values.mjs ~/incoming/first-admin.mjs | sudo app-compose menumesh exec -T web node --input-type=module -
   shred -u ~/incoming/first-admin.values.mjs
   ```

   Neither the journal (sudo logs the command line, `app-compose` only `menumesh: exec`) nor any
   shell history holds the email or the name.

   It makes the login, without a password of its own, and the invite as Settings → Team does (the
   Admin role, invited by nobody, valid 7 days), then prints the link once and exits 0, with the
   run's own dates:

   ```text
   first-admin: owner@example.com (Owner name) is invited as the platform's first Admin. The join link:

     https://menumesh.in/login/join?token=<43 characters>

   It works once, until 2026-12-08 21:00 UTC (2026-12-09 02:30 IST), and is shown only here: the
   server keeps only its hash. Warning: until it is used or expires, whoever opens it becomes
   the platform admin. Keep it to yourself and open it only once menumesh.in is served
   from this server; choose the password there, and /super then asks for an authenticator app.
   ```

   The address is the one production's build serves (the sitemap line of its own `robots.txt`), as
   on the Team page. The link goes into the password manager and nowhere else; then close that
   terminal or clear its scrollback, since the link stays there until it is used, and only there:
   `docker exec`'s output never reaches the container's log, and the server keeps only the token's
   hash. It refuses with one line, `first-admin: refused: <why>`, exit 2, having made nothing: once
   the platform has any team member, joined or not (everyone after comes from Settings → Team), for
   an email that already has a login, for an email or a name the Team page would refuse, and for a
   name with control or format characters, which the Team page doesn't check yet. A failure is one
   line, `first-admin: failed: <why>`, exit 1, which says what is left: a login it made is removed
   again when the invite can't be added, or named with its user id when that fails too. When the
   answer to making the login was lost (no answer, or the gateway's own 502, 503 or 504 instead of
   GoTrue's), the login may exist without its invite: it never says that nothing was made then, but
   to remove that login if there is one (A new link, below).

3. Once production's records point at the server, open the link and choose the password, which
   signs in and goes on to enrol an authenticator app (`/super/mfa`).

**A new link**, when one expires unused or is lost before it is used: the waiting invite makes the
tool refuse, so remove it with its login, then run step 2 again. The command removes nothing once
anyone has joined (it prints `DELETE 0` then), and the invite's row goes with its login:

```sh
sudo app-compose menumesh exec -T db psql -U supabase_admin -d postgres -c "delete from auth.users u using public.platform_admins a where a.user_id = u.id and a.joined_at is null and not exists (select 1 from public.platform_admins j where j.joined_at is not null)"
```

It prints `DELETE 1`. A login that a failed run named is removed the same way, with
`delete from auth.users where id = '<user id>'` as the command's SQL.

A login that a failed run could not confirm, when its line ends
`if <email> has a login now, remove it before running this again`, is removed by that email, only
while no one has joined, and only as a login with no `platform_admins` row; then run step 2 again:

```sh
sudo app-compose menumesh exec -T db psql -U supabase_admin -d postgres -c "delete from auth.users where email = '<email>' and id not in (select user_id from public.platform_admins) and not exists (select 1 from public.platform_admins where joined_at is not null)"
```

It prints `DELETE 1` when the lost answer had made the login, and `DELETE 0` when it had not, or
once anyone has joined. Unlike step 2's commands, its command line, with the email in it, stays in
sudo's journal for up to 187 days, and it is needed only after a lost answer.

**On hosted Supabase**, for Vercel's production until its parts retire (The shared server (VPS),
The server rehearsal and the cut-over, part 6):

1. In Supabase → Authentication → Users, add the user (email and a strong password).
2. In the SQL editor:
   `insert into public.platform_admins (user_id) select id from auth.users where email = '…';`
3. Log in at `https://menumesh.in/login`; the first visit to `/super` asks to enrol an
   authenticator app.

Offers (SA-77 to SA-81): to check one on staging with the Razorpay test keys, make a code in
Settings → Offers for a plan whose cycle has a Razorpay plan, apply it on a test restaurant's
Subscription page and subscribe with a test card. Razorpay's dashboard then shows a new plan at
the discounted price with GST and a subscription with the offer's charge count; the first
charge lands at that price. The months after can't be hurried in test mode; the e2e suite covers
them against the mock.

Announcements (SA-82, SA-83): Settings → Announcements puts a banner in restaurants' panels,
for example before planned maintenance. Choose the panels and who sees it, set when it ends and
check the preview; for a test, choose one test restaurant. The email option needs
`RESEND_API_KEY` and `EMAIL_FROM`; without them the banner still shows and nobody is emailed.
End now takes the banner down everywhere at once.

Standees (SA-84, SA-85): Restaurants → Standees lists every restaurant whose setup fee is paid.
Mark each step as it happens (on the restaurant's Overview or in the list); Finance adds the
cost. Delivered standees tick the QR step of the restaurant's onboarding checklist.

Everyone after that is invited from Settings → Team (an Admin): the invite email needs
`RESEND_API_KEY` and `EMAIL_FROM`, and without them the Admin sends the link shown on the page.
Turning a member off there blocks their login; their lost phone is still fixed as in the README.

## Launching the website

Production keeps its current build until the owner's legal texts and contact details are ready
(docs/DECISIONS.md W-2). Then, in this order:

1. **Texts** (a normal PR): replace the placeholders.
   - The four policies in `src/app/(site)/(en)/(legal)/`, and the placeholder banner in its
     `layout.tsx` (`tests/e2e/legal.spec.ts` checks for the banner, so update it too).
   - The support email, phone and WhatsApp in `contact.ways` of both dictionaries,
     `src/features/site/content.ts` and `content-hi.ts`, and the `contact.placeholder` note.
   - The owner approved the Hindi website as written on 2026-10-14 (`content-hi.ts`,
     `DEMO_WORDS.hi` in `src/features/site/demo/machine.ts`, the Hindi code and welcome emails,
     DECISIONS W-20). If the texts above change, their Hindi changes with them.
   - The Organization's contact details in `src/features/site/structured-data.tsx` (W-12).
2. **Production Vercel variables:**
   - `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`, from a Cloudflare Turnstile widget whose
     hostnames include `menumesh.in`. Without both, the demo form is hidden and signup stays
     closed.
   - `RESEND_API_KEY` and `EMAIL_FROM`, with `menumesh.in` verified in Resend. They send each
     demo request to the support email, and together with Turnstile they open self-serve signup
     (W-9). Without them the site launches with "Book a demo" only, and requests are kept in
     `/super/leads` without an email.
   - `NEXT_PUBLIC_POSTHOG_KEY` and `_HOST`: the same project as staging (W-13).
3. **Support email** (production `/super` → Platform settings), where each demo request is
   emailed when Resend is set; without it, requests are only kept in `/super/leads`.
4. **DNS** (GoDaddy, for `menumesh.in`):
   - DMARC: a TXT record `_dmarc` with `v=DMARC1; p=none; rua=mailto:dmarc@menumesh.in`. The
     domain has SPF and Resend's DKIM but no DMARC record, which mailbox providers look for
     (Gmail and Yahoo require it of bulk senders). The report address must be at `menumesh.in`
     (a GoDaddy forward to any inbox is enough): providers only send reports to another domain
     when that domain allows it. Move to `p=quarantine` once the reports look clean.
   - Google Search Console: add a Domain property for `menumesh.in` and the TXT record it asks
     for. It covers `www` and staging too.
5. **Release:** Actions → Release, typing `production`. Smoke then checks the version, the home
   page, the plans and prices, the policies, robots and the sitemap, that `menumesh.in` may be
   indexed, and that PostHog loads without keeping anything (on `menumesh.in` it fails without
   the PostHog key).
6. **After the Release:**
   - In a normal browser, open `https://menumesh.in`, `/pricing` and `/contact`. Send one demo
     request, then find it in `/super/leads` and, when Resend is set, the support inbox.
   - If signup is open, sign up once with a real address, then suspend that restaurant from
     `/super`.
   - Search Console: submit `https://menumesh.in/sitemap.xml`. Bing Webmaster Tools: import the
     site from Search Console.
   - If Google lists staging pages, use Search Console → Removals for `staging.menumesh.in`
     (staging already sends noindex).
   - PostHog: pageviews from `menumesh.in` show with the internal and test users filter on.
