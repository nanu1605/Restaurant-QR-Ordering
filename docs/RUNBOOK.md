# Runbook

How MenuMesh is deployed and kept running. Decisions behind it: `docs/DECISIONS.md` (Phase 10).

## Environments

| Environment | App                         | Database                         | Deploys                           |
| ----------- | --------------------------- | -------------------------------- | --------------------------------- |
| Local       | http://localhost:3000       | Supabase CLI (Docker), with seed | `pnpm dev`                        |
| Staging     | https://staging.menumesh.in | Supabase project, Mumbai         | automatically, after CI on `main` |
| Production  | https://menumesh.in         | Supabase project, Mumbai (Pro)   | the **Release** workflow          |

Each environment has its own Supabase project, Vercel project, keys and secrets. Nothing is
shared. The seed (demo restaurant, demo logins) exists only locally and in CI: deploys never
push it.

## Deploying

A deploy is always: apply migrations → build and deploy on Vercel → smoke tests
(`.github/workflows/deploy.yml`). Vercel's own Git deploys are off (`vercel.json`), so new code
never reaches a database that lacks its migrations.

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

### One-time setup per environment

1. **Supabase:** a project in Mumbai (`ap-south-1`); staging in its own free organization (a
   Pro organization bills every extra project's compute). Note the project ref and the database
   password. In Authentication: sign-ups and anonymous sign-ins off, minimum password length 8,
   TOTP on, Site URL = the app URL, and the sign-up and sign-in rate limit raised to 1000 per 5
   minutes (every staff login comes from the app's servers, so they share IPs).
2. **Vercel:** a project (`menumesh-staging` or `menumesh`) on the Pro team, imported from
   GitHub (that first deploy may fail; later ones come from the pipeline, as `vercel.json` turns
   Git deploys off), Node.js 24.x, Settings → Advanced → Skew Protection on (the default for new
   projects) with a maximum age of 7 days, the domain attached, and the environment variables below
   under "Production" (a staging project's production is staging). `NEXT_PUBLIC_*`,
   `STAFF_EMAIL_DOMAIN`, `SENTRY_ORG` and `SENTRY_PROJECT` are of type Config, because the
   pipeline's build reads them, and the rest are Secret: the pipeline's build only gets
   placeholders for Secret values, which the app reads at runtime instead.
3. **GitHub** → Settings → Secrets and variables → Actions (repository level: a free plan's
   private repository has no environment secrets). Once: the secrets `SUPABASE_ACCESS_TOKEN`
   (Supabase account → Access tokens), `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `SENTRY_AUTH_TOKEN`
   (the build uploads source maps with it). Per target, with the prefix `STAGING_` or
   `PRODUCTION_`: the secrets `…SUPABASE_PROJECT_REF`, `…SUPABASE_DB_PASSWORD` and
   `…VERCEL_PROJECT_ID`, and the variable `…APP_URL`. Then the variable `DEPLOY_STAGING` =
   `true` turns on staging deploys.
4. **Sentry and PostHog** (once, shared by both environments): a Sentry project for Next.js
   with IP addresses not stored and the data scrubber on, and an organization token for
   `SENTRY_AUTH_TOKEN`; a PostHog project with client IP data discarded.
5. **Uptime:** a monitor on `https://<app>/api/health` every minute, alerting by email or phone.
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
| `MENU_IMPORT_API_KEY`, `_FALLBACK_API_KEY`      | optional                        | as needed                  |
| `NEXT_PUBLIC_SENTRY_DSN`                        | the project's DSN               | the same DSN               |
| `NEXT_PUBLIC_SENTRY_ENVIRONMENT`                | `staging`                       | `production`               |
| `SENTRY_ORG`, `SENTRY_PROJECT`                  | for readable stack traces       | same                       |
| `NEXT_PUBLIC_POSTHOG_KEY`, `_HOST`              | the project key and region host | same                       |

Generate a secret with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
`NEXT_PUBLIC_*` values are built into the app: change them, then deploy again.

## Database migrations

- Every schema change is a new file in `supabase/migrations`, tested locally and in CI first.
- Old code keeps running against the new schema: for the minute between migrating and
  deploying, and for pages opened before a deploy, up to 7 days after it. So a migration must not
  break any deployment from the last 7 days: add columns, tables and functions freely; rename or
  drop only once no deployment from the last 7 days uses the old name.
- There are no down migrations. To undo, write a new migration.
- To see what a deploy would apply: `pnpm exec supabase link --project-ref <ref>` then
  `pnpm exec supabase db push --dry-run`.

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
  deployments stop answering, and open pages reload onto the fix.
- **Database:** a forward-fix migration through the normal pipeline. Restoring a backup is for
  lost data, not bad code (see Backups).

## Incidents

- **Live updates stop (Realtime down):** boards refetch every 30 seconds on their own and show
  "Reconnecting…"; staff can refresh. Guests' order pages poll every 10 seconds anyway.
- **A tablet loses Wi-Fi:** dish moves are kept on the tablet and sent when it is back; other
  actions are disabled until then.
- **Database or Vercel down:** the health monitor alerts. Tell pilot restaurants to switch to
  paper order pads and bill by hand until it is back; nothing already recorded is lost. Check
  status.supabase.com and vercel-status.com.
- **A Razorpay webhook failed:** `/super` → **Webhooks** shows it; **Reprocess** runs it again.
  Razorpay also retries on its own for a day.
- **Errors:** Sentry (errors only, no personal data). The server's `console.error` lines for
  unexpected database errors arrive there too.

## Onboarding a restaurant

Follow `docs/PILOT.md` → "Setting a restaurant up": onboard at `/super`, hand over the owner
login, then the owner adds tables, prints QR codes (only once production is live on
`menumesh.in`: the codes carry `NEXT_PUBLIC_APP_URL`), enters the menu and installs the staff
app on each tablet.

## Failed subscription payments

- Razorpay retries the autopay charge. Meanwhile the restaurant has 7 days' grace (a banner for
  the owner, a reminder email each day); then ordering pauses at the next business-day start.
  Billing open tables always works.
- To help an owner pay: `/super` → the restaurant → **Send payment link** (months of the plan),
  or **Record payment** for money received by bank transfer or UPI.
- When a paid webhook arrives, the restaurant is active again at once.

## Rotating secrets

| Secret                        | Where                                | What happens                                                                |
| ----------------------------- | ------------------------------------ | --------------------------------------------------------------------------- |
| `SUPABASE_SECRET_KEY`         | Supabase → API keys, then Vercel     | Create a new secret key, set it in Vercel, deploy, then revoke the old one. |
| `CUSTOMER_COOKIE_SECRET`      | Vercel                               | Phones get new device ids: they can't cancel dishes ordered before.         |
| `RAZORPAY_KEY_SECRET`         | Razorpay dashboard, then Vercel      | Regenerate, set, deploy. Checkout keeps working with the new pair.          |
| `RAZORPAY_WEBHOOK_SECRET`     | Razorpay webhook settings and Vercel | Change both together; events in between fail and are retried by Razorpay.   |
| `CRON_SECRET`                 | Vercel                               | Vercel Cron sends the new one after the next deploy.                        |
| `RESEND_API_KEY`, import keys | the provider, then Vercel            | Create the new key, set, deploy, delete the old key.                        |
| GitHub deploy secrets         | GitHub repository secrets            | Replace; the next deploy uses them.                                         |

After changing any Vercel variable, deploy again (a Release for production). Each deployment
keeps the values it was built with, and pages opened before the deploy keep using the old one for
up to 7 days, so after deploying a rotated secret set the new deployment's **Skew Protection
Threshold** (Deployments → ⋯) before revoking or deleting the old value.

## Backups and restore

- Supabase Pro keeps daily backups for 7 days (Database → Backups). Point-in-time recovery is a
  paid add-on that restores to any second; worth it once restaurants rely on it every day.
- **Restore in place:** Database → Backups → pick a day → Restore. The project is down for
  minutes to hours depending on size, and everything after the backup is lost; tell restaurants
  first.
- **Restore to a new project** (safer for looking at old data): restore the backup into a new
  project, check it, then point the Vercel variables at it and deploy.
- **Drill:** restore staging's backup into a scratch project once, and time it.

## Razorpay live switch

1. KYC approved; live mode enabled in the Razorpay dashboard.
2. Create live keys; set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in the production Vercel
   project.
3. Add the webhook `https://menumesh.in/api/webhooks/razorpay` with the `subscription.*` and
   `payment_link.paid` events and a new secret; set `RAZORPAY_WEBHOOK_SECRET`.
4. Release (or redeploy) production.
5. `/super` → **Plans** → **Create … plan in Razorpay** for each plan and cycle (live plans are
   separate from test ones).
6. Subscribe a real test restaurant with a small plan, check the webhook arrives and the
   payment shows at `/super`, then cancel it.

## The first platform admin (production)

1. In Supabase → Authentication → Users, add the user (email and a strong password).
2. In the SQL editor:
   `insert into public.platform_admins (user_id) select id from auth.users where email = '…';`
3. Log in at `https://menumesh.in/login`; the first visit to `/super` asks to enrol an
   authenticator app.
