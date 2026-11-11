# Files from self-hosted Supabase

Some files under `deploy/vps/config/` come from the `supabase/supabase` repository, folder
`docker/`, at the tag `self-hosted/v0.8.4` (commit `189adda99d1b56da55fc5a6ee3f849354aaea92a`), the
one self-hosted release the server runs (docs/DECISIONS.md VPS-34). That repository is licensed
under the Apache License, Version 2.0; `LICENSE-supabase` here is a byte-for-byte copy of its
`LICENSE` file (sha256 `c29468abcd629e248c2f76848155c386b733872bcabcc4cf65ef1e7c61431042`). It has
no NOTICE file.

Each sha256 below is of the upstream file as tagged: the git blob, with LF line endings
(`git show self-hosted/v0.8.4:<path> | sha256sum`).

## Verbatim copies

Byte for byte, without a header, so their sha256 is the upstream one: `sha256sum db/*.sql` here
must print the hashes below. The Postgres image runs them once, on the first start of an empty
volume (`compose.yml` mounts them read-only). `webhooks.sql` stays although nothing uses database
webhooks: `roles.sql` sets the password of `supabase_functions_admin`, which only `webhooks.sql`
creates. Not taken: `_supabase.sql`, `logs.sql` and `pooler.sql`, which serve the analytics and
pooler services that don't run here.

| File here         | Upstream path                    | sha256 of the upstream file                                        |
| ----------------- | -------------------------------- | ------------------------------------------------------------------ |
| `db/realtime.sql` | `docker/volumes/db/realtime.sql` | `7e9e442e7fc4dae05544c07b67bede37a00d84644304dfce4d937134cb4c8f88` |
| `db/webhooks.sql` | `docker/volumes/db/webhooks.sql` | `05a61316b899374253891cbba66ce073d9273f33983c3f47961eda3aa26c2823` |
| `db/roles.sql`    | `docker/volumes/db/roles.sql`    | `3ad717b225daa38aa982da26750f35641eb404e1eb5e69a763c22236ab96c1b2` |
| `db/jwt.sql`      | `docker/volumes/db/jwt.sql`      | `c1d3f5c01e44646c2e533c5a1c111821cc49cb5a4c2534e08cddad61d8fb0339` |

## Changed copies

Each starts with a comment that names its source and says what changed, and every change inside
is marked `MenuMesh:` (docs/DECISIONS.md VPS-35). Anything not marked is upstream's text, so a
newer release can be taken by repeating the marked changes on its files.

| File here                 | Upstream path                                   | sha256 of the upstream file                                        |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| `envoy/envoy.yaml`        | `docker/volumes/api/envoy/envoy.yaml`           | `3697f23b0be9ec5b829f937c600eb9b878f1f778ab510b42ad5e4f14742447e9` |
| `envoy/cds.yaml`          | `docker/volumes/api/envoy/cds.yaml`             | `9f2df9e1355cbeda3ecca809bffca9ed439bb18a66b82ca07caf97e27c34c291` |
| `envoy/lds.template.yaml` | `docker/volumes/api/envoy/lds.template.yaml`    | `51496623f48fe6178634fdd71efa72ec88ee46692a963cf8ec137ff667d9c52a` |
| `envoy/start.sh`          | `docker/volumes/api/envoy/docker-entrypoint.sh` | `8a0c9503764de32ba39e0d81e73629457b13ec42ef19897e30e4918c996d0508` |
