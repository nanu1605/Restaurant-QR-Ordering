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
- **After the move:** until the cut-over (Stop D) rewrites them, the Vercel rules in this runbook
  describe the live deploy path (Deploying, One-time setup, the variables, the 7-day migration rule,
  Rolling back, Rotating secrets, Restore from an export and the Razorpay live switch). After the
  move a deploy replaces the container, so the live screens refresh on their next tap and the other
  pages offer Refresh (VPS-8), and until then their polls and the board's direct Supabase reads run
  the old browser code against the new build: keep their JSON and the tables the board reads
  additive, like migrations (VPS-11). Production deploys are run by the owner on the server,
  `sudo app-deploy menumesh production <prod-ref> <migrate-ref>`; staging deploys from GitHub after
  a merge to `main` (VPS-23). How, and when not to deploy: The shared server (VPS), Deploys on the
  VPS.
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
- There are no down migrations. To undo, write a new migration.
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
Cloudflare (docs/DECISIONS.md VPS-1, VPS-24, and VPS-31 to VPS-42 for the kit). The server team's
host scripts check and run everything: `app-apply` checks a file and installs it, `app-compose` runs
Compose for the project, `app-deploy` deploys one image, and `hostwatch` watches and alerts.
`deploy/vps/` holds every file MenuMesh brings, and its README says what goes where. **None of this
is live yet:** the server isn't bought, Vercel stays the live host until the cut-over (Stop D), and
the CI jobs stay off until the two variables below are set. The server team's runbooks in their
repository (`docs/runbooks/server.md`, `edge.md`, `backups.md`) have the steps that are theirs.

### Who does what, and the server's conf

- **The server's admin** signs in as `ops` (sudo, through the SSH tunnel) and does the server team's
  side: `/etc/apps/menumesh.conf` (below), the deploy user `deploy-menumesh` with its key and the
  Access service token `github-deploy-menumesh`, the edge (the `tls_menumesh` snippet, the Origin CA
  certificate, authenticated origin pulls, the two `MENUMESH_STAGING_AUTH_*` lines of `edge.env`),
  the settings archive's timer, and `/srv/menumesh` with its `config/` folder, which the contract
  leaves to the admin.
- **The owner**, through the same `ops` account (`app-deploy` takes a deploy by hand only from `ops`
  or root), brings what is MenuMesh's: the backup key, the bucket, the alert bot and the monitors,
  the secrets and env files, the compose, site and redaction files through `app-apply`, the
  services, production's deploys and the restore tests; and, off the server, the Cloudflare zone and
  the GitHub settings.
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
here). Every file under `/srv/menumesh` is root's, and nothing on the way up to `/` may be writable
by anyone else, or `app-apply` refuses the compose file.

**The owner, before the server:**

1. **The backup key**, an age key pair, made on a machine of the owner's (the server team's form):

   ```sh
   docker run --rm -v "$PWD:/k" postgres:17-alpine sh -c 'apk add -q age && age-keygen -o /k/menumesh-backup-key.txt'
   ```

   The public key (`age1…`) goes to the admin for `BACKUP_RECIPIENT` and into `.env`. The private
   key goes into the password manager and on paper, then off that machine: it never stays on the
   server, and without it no backup can be restored.

2. **The bucket:** an India-region, S3-compatible bucket, with object lock or versioning that keeps
   objects just under the job's own ages (29 days for `daily/`, 365 for `monthly/`), set with an
   admin login that never goes on the server, and an API token for this bucket only.
3. **Alerts:** a Telegram bot and chat for the backup's failures, and heartbeat monitors: the backup
   (a ping a night, alerting after 26 hours), the daily and the digest calls (a ping a day each),
   the minute job (a ping a minute), and the same three for staging. Each is optional; an empty
   address pings nothing.
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
   for the API keys.
7. **The deploy key** for CI, whose public half goes to the admin and private half to GitHub
   (`VPS_SSH_KEY`): `ssh-keygen -t ed25519 -f gha-menumesh-staging -N '' -C gha-menumesh-staging`.
8. **The zone:** `menumesh.in` on Cloudflare, Full (strict), with zone-level authenticated origin
   pulls ready for the admin's certificate (the server team's `edge.md` §3).

**The server's admin** (the server team's `server.md` §2 and `edge.md` §3 and §5):

9. `/etc/apps/menumesh.conf` as above, `BACKUP_RECIPIENT` filled in.
10. The deploy user with `gha-menumesh-staging.pub`, and the Access service token
    `github-deploy-menumesh` for the tunnel.
11. The edge: the Origin CA certificate for `menumesh.in` and `*.menumesh.in` from a CSR made on the
    server (`sudo app-apply edge cert menumesh origin.pem origin-key.pem`), the snippet of
    `deploy/vps/edge/tls_menumesh.caddy` added to `snippets.caddy`
    (`sudo app-apply edge config snippets.caddy`), and authenticated origin pulls on, **before any
    MenuMesh container runs**. Then the two lines of `deploy/vps/edge/edge.env.example` in
    `/srv/edge/edge.env`, installed with `sudo app-apply edge env edge.env` and
    `sudo app-compose edge up -d`. The hash comes from staging's password and the edge's Caddy
    image:

    ```sh
    docker run --rm caddy:2.11.9-alpine caddy hash-password --plaintext '<password>'
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

**The owner, on the server:**

14. The env files, then `images.env` as it is, five `:none` lines that only `app-deploy` changes
    from then on:

    ```sh
    sudo install -m 0600 -o root -g root ~/incoming/.env /srv/menumesh/.env
    sudo install -m 0600 -o root -g root ~/incoming/web.env /srv/menumesh/env/web.env
    sudo install -m 0600 -o root -g root ~/incoming/web-staging.env /srv/menumesh/env/web-staging.env
    sudo install -m 0644 -o root -g root ~/incoming/images.env.example /srv/menumesh/images.env
    ```

15. `sudo app-apply menumesh compose ~/incoming/compose.yml`. It checks the file and every file it
    mounts, creates the two edge networks and `/srv/menumesh/backup-out`, and pins the file's
    sha256: `app-deploy` refuses to deploy while the installed file differs from it.
16. The database, then the Supabase services: `sudo app-compose menumesh up -d db`, and once it is
    healthy (`sudo app-compose menumesh ps`),
    `sudo app-compose menumesh up -d auth rest realtime storage api-gw`. Auth and Storage make their
    own schemas at their first start, and the first migration needs them (VPS-39).
17. The backup image: Actions → **VPS backup image** → Run workflow on `main`, then, with a GitHub
    token that can read packages typed at the prompt:

    ```sh
    read -rs PAT && printf '%s\n' "$PAT" | sudo app-deploy menumesh backup backup-<sha>@sha256:<digest>
    ```

18. The first deploys, which run the migrations: staging from CI or by hand, production by a release
    (Deploys on the VPS).
19. The schedulers: `sudo app-compose menumesh up -d scheduler scheduler-staging`. Each turns
    healthy at its first answered minute call.
20. A first restore test once a night has run, before the first restaurant (Backups and restore
    (VPS)).
21. Last, after the server rehearsal (below):
    `sudo app-apply menumesh site ~/incoming/menumesh.caddy` and
    `sudo app-apply edge redact menumesh ~/incoming/log-redact.caddy`; then the admin's leak test
    (the server team's `edge.md` §6, with a made-up 16-character `/t/` token, which the log must
    show as `/t/_`); then DNS.

### Secrets (VPS)

`pnpm vps:secrets --out <folder>` writes the server's three secret files from the templates in
`deploy/vps/env/`: every value the stack makes for itself is generated, and the owner's own values
stay empty under `# FILL IN` lines, which Compose refuses to start with.
`pnpm vps:secrets --check <folder>` checks the files by name and prints no value. Copy them to the
server (First install, step 14), keep the values in the password manager, and delete the folder. The
generator never overwrites a file without `--force`, and a running stack keeps its old values: new
ones are for a new install or a planned rotation.

- `/srv/menumesh/.env` (0600): what `compose.yml` reads. Generated: `POSTGRES_PASSWORD`, the
  Supabase keys, `SECRET_KEY_BASE`, `REALTIME_DB_ENC_KEY`, `SITE_URL`, `SUPABASE_PUBLIC_URL` and
  both cron secrets. The owner's: the heartbeat addresses, the backup's key, bucket and token,
  `HEARTBEAT_BACKUP_URL` and Telegram, and hosted staging's pooler login (`STAGING_DB_*`).
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
  staging's password).

Never on the server: the backup key's private half, the bucket's admin login, staging's password
itself (in the password manager; testers get it from the owner) and the GitHub secrets.
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
  `sudo app-compose menumesh up -d web scheduler` (staging: `web-staging scheduler-staging`); the
  minute between the two may log one 401 line.
- A value in `env/web.env` or `env/web-staging.env`: the provider's step as in Rotating secrets, the
  edited file installed again, then `up -d web` (or `web-staging`). A new `CUSTOMER_COOKIE_SECRET`
  gives phones new device ids, as on Vercel.
- Production's `SUPABASE_SECRET_KEY`: a new key from a fresh `pnpm vps:secrets --out <new folder>`
  (that value only) in `.env`, then `up -d api-gw web` together; the old key stops working at once.
- The bucket's token, Telegram and the heartbeat addresses: `.env`, then `up -d backup`, and
  `scheduler scheduler-staging` for the heartbeats.
- The backup key: a new pair, the admin's `BACKUP_RECIPIENT` and the owner's `BACKUP_AGE_RECIPIENT`
  changed the same day, then `up -d backup`. Keep the old private key while its backups (366 days)
  can be needed.
- Staging's password: the admin's new hash in `edge.env` (`app-apply edge env`, then recreate
  Caddy), the GitHub secret `STAGING_SMOKE_BASIC_AUTH`, and the testers.
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

An outline; Stop D details it. The contract's order: rehearse with the limits and no site file, then
install the site file, then change DNS last.

1. The first install up to step 20, with the limits on and no site file, so nothing is public.
2. On the server: `sudo hostwatch check` clean; the services healthy; a staging and a production
   deploy, with its pre-deploy dump and a rollback; the night's backup and a restore test; the
   schedulers' first minutes and a day of `jobs.ok`; `docker stop` of the scheduler and `backup`
   under a second each; the journal's lines against the budget; Envoy's
   `cluster.rest.upstream_cx_destroy_remote` staying near 0 (its admin page on `127.0.0.1:9901`
   inside `api-gw`).
3. `docker stop` of `web` with an export building, Hindi names being written and announcement emails
   going out: exit 143 within seconds, the export queued again or ready, a batch's names written
   again within 5 minutes, no email sent twice (docs/DECISIONS.md, Tests (VPS Stop A2)).
4. The site file and the redaction file, the leak test, the data as Stop D decides, and DNS last.
   The rollback is Vercel and the hosted production project, paused but kept: DNS back to them.
   Everyone signs in again either way.
5. After: `CRON_SECRET` out of Vercel, `VPS_DEPLOY_STAGING` on, and the Vercel parts of this runbook
   and the old workflows go (Stop D).

### Deploys on the VPS

- **Staging** follows `main` once `VPS_IMAGES` and `VPS_DEPLOY_STAGING` are `true`. A merge that
  passes CI builds `staging-<sha>` and `migrate-<sha>` (**VPS build**) and deploys them (**VPS
  deploy staging**): through the tunnel, `app-deploy` pulls them by digest, checks their labels,
  runs `migrate-staging` on hosted staging's database and swaps `web-staging`; then the smoke tests
  run against staging with its password. Inside the blackouts below the deploy job fails at once:
  run it again after. `app-deploy` also refuses staging while hostwatch reports the server
  CPU-throttled, and any deploy with under 5 GB of disk free.
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
     previous image by itself and alerts. Migrations that ran stay applied either way.

  3. From this machine: `SMOKE_URL=https://menumesh.in EXPECTED_VERSION=<commit> pnpm smoke`.

- **Rolling back by hand:** `sudo tail -5 /srv/menumesh/deploys.log` names the previous image, and
  deploying it again without a migrate reference brings it back. An image still on the server needs
  no token: `sudo app-deploy menumesh production prod-vX.Y.W@sha256:<digest>`. Migrations are never
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
  `digest`; `scheduler-staging` for staging). A `daily` by hand that gets a 200 writes the day's
  marker, so the 03:30 retry then does nothing. The minute job also answers through Cloudflare
  (Incidents, Run the minute job by hand).
- **After a change:** a crontab or a script under `config/scheduler/` is installed by the admin,
  then `sudo app-compose menumesh restart scheduler` (crond reads its crontab when it starts); a new
  cron secret or heartbeat address in `.env` needs `sudo app-compose menumesh up -d scheduler`,
  since `start.sh` writes the values when the container is made.

### Backups and restore (VPS)

The `backup` container's crond runs `backup.sh` at 20:30 UTC (02:00 IST), and the host's settings
archive runs at 20:20 UTC, ten minutes before (VPS-40).

- **A night** under `daily/` in the bucket, every part age-encrypted to the owner's key:
  `globals-<stamp>.sql.age` (the roles), `postgres-<stamp>.dump.age` (the database),
  `storage-<stamp>.tar.age` (the Storage files, with their content types),
  `manifest-<stamp>.txt.age` (row counts and the Storage files' count, which a restore compares) and
  `config-<stamp>.tar.age` (the settings archive). The night of the 1st is also copied to
  `monthly/`; daily copies go after 30 days and monthly ones after 366, and the bucket's lock keeps
  anyone from deleting them sooner.
- **The settings archive**, `/srv/menumesh/backup-out/config-<stamp>.tar.age`, holds `.env`,
  `images.env`, `env/`, `config/` and `deploys.log`, encrypted to `BACKUP_RECIPIENT`. A night whose
  archive is missing or more than 2 hours old fails, with an alert, after its other parts are up.
  `systemctl list-timers 'app-config-archive@*'`,
  `sudo journalctl -t app-config-archive --since yesterday` and `ls -l /srv/menumesh/backup-out`
  show it, and `sudo systemctl start app-config-archive@menumesh.service` makes one now.
- **Last night's backup:**

  ```sh
  sudo journalctl COM_DOCKER_COMPOSE_PROJECT=menumesh COM_DOCKER_COMPOSE_SERVICE=backup --since yesterday -o cat
  sudo app-compose menumesh exec backup sh -c 'rclone lsf --format sp "backups:$BACKUP_BUCKET/daily/" | tail -5'
  ```

  The first shows `backup <stamp>: 5 parts, N bytes`, or
  `[menumesh] backup failed (exit 1) at <stamp>: <the step>`, which Telegram got too; the second
  lists the newest parts and their sizes. The heartbeat monitor alerts after 26 hours without a
  whole night. One now, as the container runs it:
  `sudo app-compose menumesh run --rm --no-deps -T backup /usr/local/bin/backup.sh`.

- **The monthly restore test**, in the third week of the month (the first one before the first
  restaurant), never while hostwatch reports the server throttled. The private key goes on a ramfs,
  which is never swapped and is gone at unmount:

  ```sh
  sudo install -d -m 700 /run/age
  sudo mount -t ramfs -o mode=700 ramfs /run/age
  sudo tee /run/age/identity.txt >/dev/null     # paste the private key, then Ctrl-D
  sudo chmod 600 /run/age/identity.txt
  sudo app-compose menumesh --profile restore-test run --rm -v /run/age:/run/age:ro restore-test
  sudo app-compose menumesh --profile restore-test rm -sf restore-db
  sudo rm /run/age/identity.txt && sudo umount /run/age
  ```

  It restores the night into a throwaway database in memory, compares it with the manifest, lists
  the Storage archive and the settings archive's file names, and ends with `restore test passed`.
  Counts that moved during the night are listed; only a missing table, an empty one or missing
  Storage files fail it. `app-compose` first checks that the server has the memory. For another
  night add `-e RESTORE_STAMP=<stamp>` (as in the object names, for example `2026-12-17T2030Z`):
  name the night before when the newest one failed, as a failed night may lack its settings archive.
  Record the date, the night and the result.

- **Disaster recovery**, whose database and Storage steps `pnpm vps:backup-test` rehearses on this
  machine (docs/DECISIONS.md, Tests (VPS Stop B)):
  1. A new server: the admin's part of First install, with new deploy keys and the new host key in
     `VPS_KNOWN_HOSTS`. If the old server may still run, stop its `cloudflared` first.
  2. The private key on a ramfs (as above). The newest `daily/config-<stamp>.tar.age`, downloaded
     with the bucket provider's dashboard or a new read-only token (the token on the server is
     inside the archive), unpacked into `/srv/menumesh`; `.env` and `env/` come back root's, 0600:

     ```sh
     age --decrypt --identity /run/age/identity.txt config-<stamp>.tar.age | sudo tar -x -C /srv/menumesh
     ```

  3. `sudo app-apply menumesh compose ~/incoming/compose.yml`, from the commit the server last had.
  4. The backup image that `images.env` names, by the admin form with a token on stdin as in First
     install, step 17: `sudo app-deploy menumesh backup <its tag@digest>`.
  5. The recovery, into new volumes. On a new server they are new; on the same server the old
     `db-data`, `db-config` and `storage-data` must go first, once no container uses them, and
     recovering onto a new server instead keeps them.

     ```sh
     sudo app-compose menumesh --profile recover run --rm -e RESTORE_STAMP=<stamp> -v /run/age:/run/age:ro recover
     sudo app-compose menumesh --profile recover rm -sf recover-db
     ```

     It refuses while `db` runs, onto `db`'s old cluster and onto old Storage files, and ends with
     `recovery of <stamp> done`.

  6. `sudo app-compose menumesh up -d db`, which finds the cluster and skips its init, then
     `sudo app-compose menumesh up -d auth rest realtime storage api-gw`.
  7. The images `images.env` names, by the admin form: production with its migrate image (the
     migrations find nothing to apply), and staging; then
     `sudo app-compose menumesh up -d scheduler scheduler-staging`.
  8. The edge, by the admin: new certificates from fresh CSRs, `aop-ca.pem` and `edge.env` from the
     password manager, then the site and redaction files from this repository, the leak test, and
     DNS to the new address.
  9. The key off the ramfs, and a restore test after the next night.

  A recovery does not bring back what no backup holds: pgsodium's root key (vault secrets come back
  but do not decrypt; the app keeps none) and a few extension settings MenuMesh doesn't use
  (docs/DECISIONS.md VPS-40). WAL archiving, which a nightly dump can't replace, comes in Stop C.

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

### Checking the kit here

Each needs only Docker Desktop, runs throwaway containers named `menumesh-kit-*` or the project
`menumesh-rehearsal`, publishes on `127.0.0.1` only, and calls no outside service. The local
Supabase stack is only ever read.

- `pnpm test` pins what each kit file must keep (`tests/unit/vps-kit.test.ts`,
  `tests/unit/vps-secrets.test.ts`).
- `pnpm vps:check` (about 20 s, and 46 s more the first time, for its checker image) runs the
  server's own `app-apply` checks on `deploy/vps/` as root in a throwaway container, then the
  contract's rules, Caddy's and Envoy's validation and shellcheck. Run it after any change under
  `deploy/vps/` and before every install.
- `pnpm vps:edge` (about 10 s) puts the site file in the server's Caddy tree, in front of stub apps
  on `127.0.0.1:8443`, and tests how it answers. Run it after any change under `deploy/vps/edge/`.
- `pnpm vps:rehearse [--fresh] [--rebuild]` (2 to 4 minutes) runs the whole stack as the server
  would, as project `menumesh-rehearsal`, with throwaway secrets in `.vps-rehearsal/` (gitignored):
  the app on `http://localhost:3300` and the gateway on `http://127.0.0.1:8300`. It needs 6 GiB
  available in Docker Desktop's VM. A rerun keeps the stack, its secrets and an image nothing
  changed for; `--fresh` starts over with new secrets and empty volumes; `--rebuild` builds every
  image. A look inside:

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

- `pnpm vps:backup-test` (about 2.5 minutes, on a running rehearsal) runs the nightly backup into a
  local S3, the monthly restore test, and a disaster recovery on the rehearsal's own volumes.
- `pnpm vps:down [--images]` removes the rehearsal's containers, networks and volumes (and its three
  images with `--images`), and nothing else. `.vps-rehearsal/` stays for the next run.
- **Copying the server team's files again**, whenever they change `app-apply`, the edge's
  `Caddyfile`, snippets or ranges, or the confs, and before every install:
  1. For each file `deploy/vps/test/vendor/jainav-infotech/SOURCE` lists:
     `git -C <their checkout> show <commit>:<path> > deploy/vps/test/vendor/jainav-infotech/<file>`,
     byte for byte; nothing there is ever edited.
  2. In `SOURCE`, the commit, the date and the sha256 lines (`sha256sum` of the six files in that
     folder); `app-apply` keeps its mode, 100755 (`git update-index --chmod=+x`).
  3. If their `edge.conf` names a new Caddy image, pin its digest as `CADDY` in
     `scripts/vps-kit.mts` (`docker buildx imagetools inspect caddy:<tag>`): `vps:check` refuses a
     tag the copy no longer names.
  4. `pnpm test`, `pnpm vps:check` and `pnpm vps:edge`. A new refusal is a change for the kit, or a
     question for the server team.

  Once the server exists, `MEMTOTAL_MIB` in `scripts/vps-kit.mts` becomes the MemTotal it reports
  (`awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo`).

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
