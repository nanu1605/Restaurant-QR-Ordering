# The shared server kit

Everything MenuMesh needs on the shared server, and nothing the server team owns. The server runs
their host scripts (`app-apply`, `app-compose`, `app-deploy`, `hostwatch`); this folder mirrors
`/srv/menumesh/` and holds the files those scripts check and run. Why each piece is the way it is:
`docs/DECISIONS.md` VPS-31 to VPS-42. Every step in detail: `docs/RUNBOOK.md`, "The shared server
(VPS)".

## What goes where

| In this folder                         | On the server                                        | Owner, mode | Put there by                                                    |
| -------------------------------------- | ---------------------------------------------------- | ----------- | --------------------------------------------------------------- |
| `compose.yml`                          | `/srv/menumesh/compose.yml`                          | root, 0644  | the owner: `sudo app-apply menumesh compose compose.yml`        |
| `env/project.env.example`              | `/srv/menumesh/.env`                                 | root, 0600  | the owner, filled in by hand (`sudo install -m 0600`)           |
| `env/images.env.example`               | `/srv/menumesh/images.env`                           | root, 0644  | the owner once, as it is; then only `app-deploy`                |
| `env/web.env.example`                  | `/srv/menumesh/env/web.env`                          | root, 0600  | the owner, filled in by hand                                    |
| `env/web-staging.env.example`          | `/srv/menumesh/env/web-staging.env`                  | root, 0600  | the owner, filled in by hand                                    |
| `config/db/`, `config/envoy/`          | `/srv/menumesh/config/db/`, `config/envoy/`          | root, 0644  | the owner (`sudo install -m 0644`)                              |
| `config/scheduler/`                    | `/srv/menumesh/config/scheduler/`                    | root, 0644  | the owner                                                       |
| (not in git) Supabase's CA certificate | `/srv/menumesh/config/migrate/supabase-ca.crt`       | root, 0644  | the owner: `config/migrate/README.md`                           |
| `edge/menumesh.caddy`                  | `/srv/edge/config/sites/menumesh.caddy`              | root, 0644  | the owner: `sudo app-apply menumesh site menumesh.caddy`        |
| `edge/log-redact.caddy`                | `/srv/edge/config/log-redact.d/menumesh.caddy`       | root, 0644  | `sudo app-apply edge redact menumesh log-redact.caddy`          |
| `edge/tls_menumesh.caddy`              | a snippet in `/srv/edge/config/snippets.caddy`       | root, 0644  | the server's admin: `sudo app-apply edge config snippets.caddy` |
| `edge/edge.env.example`                | the `MENUMESH_*` lines of `/srv/edge/edge.env`       | root, 0600  | the server's admin: `sudo app-apply edge env edge.env`          |
| `migrate/`, `backup/`                  | images in `ghcr.io/nanu1605/menumesh`, run by digest |             | CI builds them; `app-deploy` brings them                        |
| `local/`, `test/`                      | never installed                                      |             | checks on a development machine                                 |

`app-apply` also creates `/srv/menumesh/backup-out` (root, 0755), where the host's settings
archive lands every night. `/srv/menumesh` itself and `env/` are root's, 0750. Nothing under
`/srv/menumesh` may be writable by anyone but root, up to `/`: `app-apply` refuses a mounted file
otherwise. Every file here is LF only.

## Who does what

- **The server's admin** writes `/etc/apps/menumesh.conf` (the values are in the RUNBOOK), adds
  `tls_menumesh` to the edge's snippets with the Origin CA certificate for `menumesh.in` and
  `*.menumesh.in`, turns authenticated origin pulls on before any MenuMesh container runs, adds
  the two `MENUMESH_STAGING_AUTH_*` lines to the edge's `edge.env`, and adds the 20:20 UTC drop-in
  for `app-config-archive@menumesh.timer`.
- **The owner** fills in `.env`, `images.env` and `env/*.env`, copies `config/`, installs
  `compose.yml`, the site file and the redact file through `app-apply`, starts the services with
  `app-compose`, and deploys production with `app-deploy`.
- **CI**, once the repository variables `VPS_IMAGES` and `VPS_DEPLOY_STAGING` are `true`, builds
  the images and deploys staging through the tunnel. Nothing in CI runs before then.

## First install, in order

1. The admin's part above, then the files under `/srv/menumesh` with their owners and modes.
2. `sudo app-apply menumesh compose compose.yml`. It checks the file against the server's rules
   (and every mounted file on disk), creates the edge networks and pins the file's sha256.
3. `sudo app-compose menumesh up -d db`, then `auth rest realtime storage api-gw`. Auth and
   Storage create their own schemas at start, and the first migration needs them.
4. The backup image (`app-deploy menumesh backup ...`) and the first deploys, which run the
   migrations; then `sudo app-compose menumesh up -d scheduler scheduler-staging`.
5. The site file and the redact file, the leak test, and DNS last. Rehearse everything before the
   site file goes in.

## Changing a file later

- `compose.yml`: `app-apply` again. `app-deploy` refuses to deploy while the installed file
  differs from its pin, and a changed service starts only on `app-compose menumesh up -d <service>`.
- A file under `config/`: install it over the old one, then restart the services that mount it
  (`sudo app-compose menumesh restart <service>`). The init SQL runs only on an empty volume.
- The edge files: `app-apply` again; Caddy reloads without dropping connections.
