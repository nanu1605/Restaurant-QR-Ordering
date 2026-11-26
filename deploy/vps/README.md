# The shared server kit

Everything MenuMesh needs on the shared server, and nothing the server team owns. The server runs
their host scripts (`app-apply`, `app-compose`, `app-deploy`, `hostwatch`); this folder mirrors
`/srv/menumesh/` and holds the files those scripts check and run. Why each piece is the way it is:
`docs/DECISIONS.md` VPS-31 to VPS-157. Every step in detail: `docs/RUNBOOK.md`, "The shared server
(VPS)".

## What goes where

| In this folder                         | On the server                                        | Owner, mode | Put there by                                                           |
| -------------------------------------- | ---------------------------------------------------- | ----------- | ---------------------------------------------------------------------- |
| `compose.yml`                          | `/srv/menumesh/compose.yml`                          | root, 0644  | the owner: `sudo app-apply menumesh compose compose.yml`               |
| `env/project.env.example`              | `/srv/menumesh/.env`                                 | root, 0600  | the owner: `pnpm vps:secrets --out <dir>`, then `sudo install -m 0600` |
| `env/images.env.example`               | `/srv/menumesh/images.env`                           | root, 0644  | the owner once, as it is; then only `app-deploy`                       |
| `env/web.env.example`                  | `/srv/menumesh/env/web.env`                          | root, 0600  | the owner, from the same `pnpm vps:secrets --out <dir>`                |
| `env/web-staging.env.example`          | `/srv/menumesh/env/web-staging.env`                  | root, 0600  | the owner, from the same `pnpm vps:secrets --out <dir>`                |
| `config/db/`, `config/envoy/`          | `/srv/menumesh/config/db/`, `config/envoy/`          | root, 0644  | the server's admin (`sudo install -m 0644`)                            |
| `config/scheduler/`                    | `/srv/menumesh/config/scheduler/`                    | root, 0644  | the server's admin                                                     |
| (not in git) Supabase's CA certificate | `/srv/menumesh/config/migrate/supabase-ca.crt`       | root, 0644  | the owner downloads it, the admin installs it with `config/`           |
| `edge/menumesh.caddy`                  | `/srv/edge/config/sites/menumesh.caddy`              | root, 0644  | the owner: `sudo app-apply menumesh site menumesh.caddy`               |
| `edge/log-redact.caddy`                | `/srv/edge/config/log-redact.d/menumesh.caddy`       | root, 0644  | the admin: `sudo app-apply edge redact menumesh log-redact.caddy`      |
| `edge/edge.env.example`                | the `MENUMESH_*` lines of `/srv/edge/edge.env`       | root, 0600  | the server's admin: `sudo app-apply edge env ~/incoming/edge.env`      |
| `migrate/`, `backup/`                  | images in `ghcr.io/nanu1605/menumesh`, run by digest |             | CI builds them; `app-deploy` brings them                               |
| `tools/`                               | `~/incoming/` only, for a run by hand                | `ops`       | the owner copies a tool there for its run (The owner's tools, below)   |
| `local/`, `test/`                      | never installed                                      |             | checks on a development machine                                        |

The snippet every block of `edge/menumesh.caddy` imports with the edge's `site_common`,
`tls_menumesh`, is the server team's: their `snippets.caddy` holds it, with `client_auth` on. They
install that file at a commit they name, with the edge's `compose.yml` and its digest pin of Caddy,
and the admin checks the server's against their confirmation and their repository at that commit
(RUNBOOK, First install, step 11). This folder adds no snippet to it, as Caddy refuses a snippet
declared twice.

`app-apply` also creates `/srv/menumesh/backup-out` (root, 0755), where the host's settings
archive lands every night. `config/db/` holds, beside the init SQL, `pg_hba.conf` (the database
image's own file plus one `replication` line, for the backup's base) and `wal-spool.sh` (`db`'s
entry wrapper, which makes the WAL spool postgres's before the image's own entrypoint runs).
`/srv/menumesh` itself and `env/` are root's, 0750. Nothing under `/srv/menumesh` may be writable
by anyone but root, up to `/`: `app-apply` refuses a mounted file otherwise. Every file here is LF
only.

## Who does what

- **The server's admin** writes `/etc/apps/menumesh.conf` (the values are in the RUNBOOK) and
  installs the redact file right after it, puts in the Origin CA certificate for `menumesh.in` and
  `*.menumesh.in` with the owner's origin-pulls CA (`aop-ca.pem`), then checks the server team's
  latest confirmation, that the server holds their `snippets.caddy`, with its `tls_menumesh`, and
  their digest pin of Caddy at the commit they name, so that authenticated origin pulls are on
  before any MenuMesh container runs, adds the two `MENUMESH_STAGING_AUTH_*` lines to a merged copy
  of the edge's `edge.env`, which Caddy takes at a recreate of its own on a night the owner picks,
  after the server team's on the pinned image when their night is the same, adds the 20:20 UTC
  drop-in for `app-config-archive@menumesh.timer`, and installs `config/` (the contract leaves it
  to the admin), with the CA certificate the owner downloads. On this server the owner is also the
  admin.
- **The owner**, through the same `ops` account, makes `.env` and `env/*.env` with
  `pnpm vps:secrets --out <dir>` (a folder outside the repository), fills in each line under
  `# FILL IN`, checks them with `pnpm vps:secrets --check <dir>` and installs them with `images.env`;
  installs `compose.yml` and the site file through `app-apply`, starts the services with
  `app-compose`, and deploys production with `app-deploy`. Off the server, the owner makes the
  origin pulls' CA and client certificate and uploads the client pair at Cloudflare.
- **CI** builds the images once the repository variable `VPS_IMAGES` is `true`, and deploys staging
  through the tunnel once `VPS_DEPLOY_STAGING` is `true` as well, from the staging night (RUNBOOK,
  The server rehearsal and the cut-over). Nothing in CI runs before then.

## The owner's tools

`tools/` holds files the owner runs by hand, never installed: `first-admin.mjs` on the server,
copied to `~/incoming` for its run, and `first-admin-values.mjs` on the owner's own machine.
Nothing under `/srv/menumesh` mounts or names them, and `app-apply` never sees them. They hold no
secret; the keys the server's tool needs come from the container it runs in.

- **`tools/first-admin.mjs`** makes production's first platform admin, once, after production's
  first deploy and before production's records move to the server (RUNBOOK, The first platform
  admin (production)). The owner runs it through `ops`, inside the `web` container, with that
  container's own environment, the values file and then the script on stdin:

  ```sh
  cat ~/incoming/first-admin.values.mjs ~/incoming/first-admin.mjs | sudo app-compose menumesh exec -T web node --input-type=module -
  ```

  It refuses once the platform has any team member, joined or not (later members come from
  Settings → Team), makes the login without a password of its own and its invite, and prints a
  one-time link to `/login/join` once, valid for 7 days, which the owner opens after production's
  DNS points at the server. It exits 0 with the link, 2 when it refused and made nothing, and 1
  when it failed, saying what is left. The RUNBOOK shows the lines it prints, and how to get a new
  link when one expires unused. `tests/unit/vps-first-admin.test.ts` runs it against a stand-in
  app and gateway, and `pnpm vps:rehearse` in the rehearsal's web container, its link followed to
  the end.

- **`tools/first-admin-values.mjs`** makes that values file on the owner's machine with Node 24:
  it asks for the email and the name, checks them as `first-admin.mjs` does, and writes two lines
  of plain ASCII, which `ssh` takes to `~/incoming/first-admin.values.mjs`. So neither value is on
  a command line on the server, where sudo's journal keeps one for up to 187 days, and the values
  file is shredded after the run, whether it succeeded or not.

## What the backup image does

`backup/` is one image with four jobs, all from the `backup` service or a one-off of it:

- **The night** (`backup.sh`, 20:30 UTC): the roles, each database, Storage, a manifest, the
  settings archive and a base backup of the whole cluster, each age-encrypted to the owner's key,
  then `seal-<id>.txt`, the list of parts with their sha256 and sizes, signed by
  `BACKUP_SIGNING_KEY`. Under `daily/` in the bucket, a month's copy under `monthly/`, ended by
  `copy-<id>.txt`, a signed record that the copy is whole, without which no copy counts as the
  month's; the night's line names the month's copy. A name of the copy already in `monthly/` when
  it goes up stops the night, as someone else's writing.
- **The WAL** (`wal-ship.sh`, every minute): `db` hands each finished WAL file to the `wal-spool`
  volume (`basic_archive`, at least once a minute); the shipper compresses, encrypts, signs and
  uploads it to `wal/<cluster>/…`, alerts when it can't, and pings `HEARTBEAT_WAL_URL` every 5
  minutes. `wal-health.sh`, the service's healthcheck, turns `backup` unhealthy when crond is not
  running, or once WAL stops going up (a file waiting over 20 minutes, nothing sent for 10, seen so
  for 10 more). `wal-spool` is shared with `db` alone. The scripts' work files, and the shipper's record
  while the spool takes no write, are in the service's 16m tmpfs at `/tmp`, inside its 320m, so a
  full disk still gets its alert.
- **The restores** (`restore.sh`: `restore-test`, `recover`): read a night only through its seal,
  every part held to its size and sha256 before it is decrypted. On a new server the night's
  settings archive is checked the same way before it is unpacked, on the owner's own machine:
  `pnpm vps:verify-night <id> <folder> --keys <file>` (`scripts/vps-verify-night.mts`, with the
  seal reader of `scripts/vps-seal.mts` that `pnpm vps:backup-test` holds to `seal.sh`) checks the
  downloaded seal and archive and prints the sha256 that `sha256sum` must print on the server.
- **Point in time** (`pitr.sh`: `pitr-test`, the monthly drill; `recover-pitr`, a recovery): the
  newest sealed base plus the signed WAL after it, replayed with the image's Postgres to a target
  within 14 days or to the latest, without the live cluster's `ALTER SYSTEM` settings. A recovery
  to the latest whose chain of WAL files is cut is refused before it writes, unless
  `PITR_ACCEPT_CUT` names the cut, and so is a base whose timeline a rewind left before the base
  ended. `wal-fetch.sh` is its `restore_command`; `seal.sh` is the shared seal and signature code.

The public signing key (`BACKUP_SIGNING_PUBLIC_KEY`, one or several, space-separated) is in every
service that reads the bucket; the private key is in `backup` alone, and in the owner's password
manager. `pnpm vps:secrets` makes the pair and prints the public half for the owner to keep beside
the age key, in a file of its own and never in the age key's file, and after each rotation the
whole list in its place; after a theft of the key, the list without it, the stolen key kept in a
file of its own apart. A one-off of the backup image checks that the two values in `.env` are keys
and a pair, naming the one to mend, as the RUNBOOK's disaster recovery and rotation run it.

## First install, in order

1. The admin's part above, `config/` included, then the owner's env files and `images.env` under
   `/srv/menumesh`, with their owners and modes.
2. `sudo app-apply menumesh compose compose.yml`. It checks the file against the server's rules
   (and every mounted file on disk), checks that the edge networks exist and are internal (it
   creates only a missing one), and pins the file's sha256.
3. Once the server team says origin pulls are on for every zone of the server,
   `sudo app-compose menumesh up -d db`, then `auth rest realtime storage api-gw`. Auth and Storage
   create their own schemas at start, and the first migration needs them.
4. The backup image (`app-deploy menumesh backup ...`) and the first deploys, which run the
   migrations; then `sudo app-compose menumesh up -d scheduler`, production's alone:
   `scheduler-staging` waits for the staging night, after Vercel staging's cron jobs are disabled.
   Then a restore test and a point-in-time drill, once a night has run and the WAL has shipped for
   an hour (`restore-test`, then `pitr-test`, each under its own profile; the RUNBOOK has the
   commands).
5. Rehearse everything before the site file goes in. Then, at the staging night, `web-staging`
   deployed by hand on the commit Vercel staging serves, the site file (the redact file is in since
   the conf), the origin test of authenticated origin pulls for MenuMesh's hosts, the leak test
   through a temporary record, staging's DNS, and `scheduler-staging` once Vercel staging's cron
   jobs are disabled; production's DNS comes on a night of its own, with its first admin from
   `tools/first-admin.mjs` (RUNBOOK, The server rehearsal and the cut-over).

## Changing a file later

- `compose.yml`: `app-apply` again. `app-deploy` refuses to deploy while the installed file
  differs from its pin, and a changed service starts only on `app-compose menumesh up -d <service>`.
- A file under `config/`: the admin installs it over the old one, then the services that mount it
  are restarted (`sudo app-compose menumesh restart <service>`). The init SQL runs only on an empty
  volume.
- An env file: install it again, then `sudo app-compose menumesh up -d <service>` for each service
  that reads it; a restart keeps the old values.
- The edge files: `menumesh.caddy` and `log-redact.caddy` through `app-apply` again, which reloads
  Caddy without dropping connections. `edge.env`'s lines go in only through the RUNBOOK's merged
  copy (First install, step 11, and Rotation's staging password), then Caddy is recreated between
  01:00 and 07:00 IST, which drops every connection on the shared edge, with nothing of the edge in
  between: until that recreate, `app-apply` refuses every other change to the edge, the server
  team's own among them.

## Checking it here first

None of the checks needs the server. `pnpm test` pins what each file must keep
(`tests/unit/vps-kit.test.ts`, `tests/unit/vps-verify-night.test.ts` for `pnpm vps:verify-night`,
`tests/unit/vps-first-admin.test.ts` for `tools/first-admin.mjs`, `tests/unit/vps-probe.test.ts`
for `pnpm vps:probe`, and `tests/unit/vps-runbook.test.ts` for the RUNBOOK's steps that no script
runs). `pnpm vps:check` runs the server's own `app-apply` checks on this folder, as root in a
throwaway container, with `test/menumesh.conf` as `/etc/apps/menumesh.conf`, then the contract's
extra rules, Caddy's and Envoy's own validation and shellcheck. `pnpm vps:edge` puts the server's
Caddy tree with `menumesh.caddy` in front of stub apps and tests how it answers, with
authenticated origin pulls on: every request presents a throwaway client certificate, made as the
owner makes theirs, and a connection without one, or with one from another CA, fails in the
handshake. Both need only Docker. Run them before every install, after copying the server team's
files again if those changed. Once records point at the server, `pnpm vps:probe staging` or
`production` checks, from the owner's machine, what Cloudflare and the edge answer (RUNBOOK, The
server rehearsal and the cut-over).

`pnpm vps:rehearse` runs the whole stack on Docker Desktop as project `menumesh-rehearsal`, the way
the install and `app-deploy` would: `compose.yml` in a mirror of `/srv/menumesh` (`.vps-rehearsal/`,
gitignored, with the throwaway values of `pnpm vps:secrets --rehearsal`) and
`local/compose.rehearsal.yml` on top. That override is never installed (`app-apply` would refuse its
name and its ports): it publishes the app and the gateway on 127.0.0.1 only (3300 and 8300), gives
Postgres smaller buffers, keeps the staging services off, adds a local S3 for the backup and sends
every third-party host the code could call to a sinkhole. It also runs `tools/first-admin.mjs` in
the web container as the owner would, the seed's platform admin set aside, and follows its link
through the join page to a sign-in with the new password. `pnpm vps:backup-test` runs the WAL
shipper, its outage and its failure paths (a full disk among them), then the nightly backup into
that S3 with each night sealed, named by its id, its stamp and 8 random hex characters (a night with
a stale settings archive, then the month's copy in `monthly/`, past objects named like its parts
too and a whole-looking copy with its record, both another key's, refused at its seal, and with its
signed record, a copy without one or with one someone else put in copied again, names of the copy
and of its record put in `monthly/` while the night runs, each stopping that night, five copies cut
short before their records, which hide no recorded one, and a night whose id someone else wrote a
name of first, stopped before its first upload), the monthly restore test, the disaster recovery's
check of a downloaded night with `pnpm vps:verify-night` (and its refusal of settings archives of
someone else's), a rotation and a theft of the signing key with the night by hand and the signing
pair's check, with signing values that are not keys named by it, by the night and by the shipper,
planted nights and names the restore must refuse or not read (each night is read from the one folder
its age gives: `daily/` under 29 days, `monthly/` past that), and then the disaster recovery of a
month's copy two months old, from `monthly/`, after one without `RESTORE_STAMP` is refused: the
rehearsal's own database and Storage volumes are made new and filled from the backup, and the stack
starts on them. Last, the point-in-time drill to a point and to the latest against rows written and
a table dropped, over a base holding an `ALTER SYSTEM` setting too, restores that refuse a night
another key sealed, a recovery to the latest refused at a cut and taken to it with
`PITR_ACCEPT_CUT`, a recovery to a point cut short while a newer night exists, from which the latest
refuses `PITR_ACCEPT_CUT` and goes through without it, a recovery to a point into new `db-data` and
`wal-spool` with the stack started on it, a gap on the new timeline that an abandoned one's file
must not fill, and a rewind that leaves two nights behind it, one whose base it ran inside: the
drill and a recovery to the latest refuse each in turn, each seal kept aside, until the night before
recovers across the fork, a point on the stretch the rewind abandoned reaching from it only the
rewind's point, and with the seals back before a night of the new timeline they refuse again.
`pnpm vps:down` removes the project (its images too with `--images`), and nothing else.

## Where the borrowed files come from

`config/SOURCES.md` lists the files taken from self-hosted Supabase (Apache-2.0), with their
upstream paths and hashes. `test/vendor/jainav-infotech/SOURCE` does the same for the server
team's files that the local checks run.
