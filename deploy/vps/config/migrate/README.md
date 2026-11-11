# config/migrate

`compose.yml` mounts one file from here into `migrate-staging`:
`/srv/menumesh/config/migrate/supabase-ca.crt`, Supabase's root CA certificate. The staging
migrations connect to hosted staging's session pooler with `PGSSLMODE=verify-full`, and libpq
checks the pooler's certificate against this file.

The certificate is not in this repository: the owner supplies it.

1. Download it from the hosted staging project: Database settings, SSL configuration, "Download
   certificate" (Supabase calls the file `prod-ca-2021.crt`).
2. Check what it is: `openssl x509 -in prod-ca-2021.crt -noout -subject -issuer -enddate`.
3. Put it on the server before `sudo app-apply menumesh compose compose.yml`, which refuses the
   compose file while a mounted file is missing:
   `sudo install -o root -g root -m 0644 prod-ca-2021.crt /srv/menumesh/config/migrate/supabase-ca.crt`.

It is public, so it needs no secrecy, only the right file. It goes into the host's settings archive
with the rest of `config/`. The `.gitignore` here keeps a downloaded copy out of git.
