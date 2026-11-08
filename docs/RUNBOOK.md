# Runbook

How MenuMesh is deployed and kept running. Decisions behind it: `docs/DECISIONS.md` (Phase 10, and
Self-hosting on the VPS for the web image).

## Environments

| Environment | App                         | Database                         | Deploys                           |
| ----------- | --------------------------- | -------------------------------- | --------------------------------- |
| Local       | http://localhost:3000       | Supabase CLI (Docker), with seed | `pnpm dev`                        |
| Staging     | https://staging.menumesh.in | Supabase project, Mumbai         | automatically, after CI on `main` |
| Production  | https://menumesh.in         | Supabase project, Mumbai (free)  | the **Release** workflow          |

Each environment has its own Supabase project, Vercel project, keys and secrets. Nothing is
shared. The seed (demo restaurant, demo logins) exists only locally and in CI: deploys never
push it.

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
  guest's cart and the kitchen's dish moves are kept, and anything else is tapped again. Admin,
  super, the website and login show "A new version is ready" with a **Refresh** button and keep
  what was typed. A tab refreshes itself at most once in 2 minutes, so a broken deploy can't loop
  it; it then asks instead (docs/DECISIONS.md VPS-8).

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
production, until the deploy stop**, which adds the compose project, the gateway, the Caddy site
file, the scheduler, backups, and the image build and deploys in GitHub Actions. Until then this
section is how to build the image and check it on this machine.

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
| `SENTRY_ORG`, `SENTRY_PROJECT`         | optional | for the source map upload                                          |
| `SENTRY_RELEASE`                       | optional | defaults to the commit                                             |

`NEXT_PUBLIC_SUPABASE_URL` is never the internal address (VPS-20). `DEPLOYMENT_ID` takes letters,
digits, `.`, `-` and `_`, and is made as `<commit 12>-<run id>-<attempt>`, as `deploy.yml` does for
Vercel. The Dockerfile sets `NEXT_OUTPUT=standalone` itself. The one secret is `sentry_auth_token`,
a BuildKit secret (`--secret id=sentry_auth_token,env=SENTRY_AUTH_TOKEN`) and never an argument,
because arguments show in `docker history`; without it no source maps are made or uploaded. Env
files cannot reach the build (`.dockerignore` is an allowlist, and the build stops if one gets in).
The build log shows two `[site] plans not loaded for the home page` traces: the build has no
`SUPABASE_SECRET_KEY` by design, so they are harmless.

- **Runtime variables:** the container takes the server-only variables of the table above, listed in
  `src/lib/env.server.ts` and explained in `.env.example`. Two are for the VPS:
  `SUPABASE_INTERNAL_URL` (the address the server calls Supabase on, `http://api-gw:8000`, on
  production's web only; VPS-20) and `SUPABASE_FORWARD_CLIENT_IP` (`true` only where Auth is the
  VPS's own, with the Auth settings of VPS-4). `NEXT_PUBLIC_*` set at run time do nothing. The image
  sets `PORT=3000`, `HOSTNAME=0.0.0.0` (do not override it) and `KEEP_ALIVE_TIMEOUT=130000`: keep
  the proxy's idle upstream time under 130 s (Caddy's is 2 minutes). Leave
  `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` unset (VPS-10): each build gets new action ids, and open
  pages refresh onto it.
- **What the deploy stop owes the image** (VPS-24):
  - Stop with a 25 s grace period: node is process 1 and gets `SIGTERM`, requests and `after()` work
    finish, and what still runs at 25 s is killed (VPS-22).
  - 1536m of memory for `web` and 768m for `web-staging`, with `NODE_OPTIONS=--max-old-space-size`
    at about 65% of it (1000 and 500). The data export's size limit follows the heap: about 37,000
    bills on `web`, about 25,500 on `web-staging` (VPS-6), so a container without that setting, or
    with less memory, lowers it.
  - Named volumes on `/app/.next/static` (earlier builds' scripts and styles, VPS-21) and
    `/app/.next/cache` (the image optimiser's cache, capped at 500 MB, VPS-18). The image needs no
    capability or privilege: `cap_drop: ALL` and `no-new-privileges`.
  - `api.menumesh.in` must resolve to a public address inside the web containers: `next/image`
    fetches photos from it and refuses private addresses, so an alias to a Docker or loopback
    address would answer 400 for every dish photo (VPS-18).
  - Caddy and Cloudflare must pass `x-nextjs-action-not-found` and `x-nextjs-deployment-id` and
    never cache HTML or RSC (VPS-7).
  - Docker's health check calls `/api/health`, which reaches the database: the deploy waits up to
    120 s for healthy, and a database outage turns the container unhealthy without restarting it
    (VPS-17).
  - The daily cron and digest routes (`maxDuration` 300 and 60 on Vercel, ignored elsewhere) can
    outlast Cloudflare's 100 s, so the scheduler calls the web container directly, not through
    Cloudflare (VPS-22).
- **After the move:** until the deploy stop rewrites them, the Vercel rules in this runbook describe
  the live deploy path (Deploying, One-time setup, the variables, the 7-day migration rule, Rolling
  back, Rotating secrets, Restore from an export and the Razorpay live switch). After the move a
  deploy replaces the container, so every open page refreshes on its next tap (VPS-8), and until
  then its polls and the board's direct Supabase reads run the old browser code against the new
  build: keep their JSON and the tables the board reads additive, like migrations (VPS-11).
  Production deploys are run by the owner on the server,
  `sudo app-deploy menumesh production <prod-ref> <migrate-ref>`; staging deploys from GitHub after
  a merge to `main` (VPS-23).
- **When to deploy, from the move:** no deploys, and no merges to `main` (every merge deploys
  staging), from 02:55 to 03:30 or from 08:40 to 08:50 IST: those are the daily cron and the digest.
  Releases also avoid 12:00 to 15:30 and 19:00 to 23:30 IST, and maintenance runs 01:00 to 07:00 IST
  (VPS-24).
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
    email, charge Razorpay or report to Sentry. A second container, `menumesh-web-bridge`, forwards
    the Supabase port to the host's Supabase. Run it again with another `--tag` to swap images as a
    deploy does: the earlier build's scripts stay served from the volume. With `--internal-url` the
    server calls Supabase on `http://api-gw:8000`, as on the VPS, and the public address is out of
    its reach.
  - `pnpm docker:check` ticks each of 10 checks (12 with `--internal-url`) and exits 1 on any
    failure: healthy; `/` answers 200; `/api/live` names this build and `/api/health` reaches the
    database; pages carry this build's deployment ID; only `menumesh.in` is indexable; log out
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
  (`--pm-on-fail=error` makes a mismatch fail the build).

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
   can't log in once it closes, so they can't do it themselves after that. If the download fails
   every time, look for `[closure] export failed … too big to build in memory` in Sentry or the
   logs: the restaurant is past what one in-memory build allows (docs/DECISIONS.md SA-93 and
   VPS-6, about 37,000 bills on the VPS, where the limit follows the web container's heap). Tell
   the owner the copy needs a developer.
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
