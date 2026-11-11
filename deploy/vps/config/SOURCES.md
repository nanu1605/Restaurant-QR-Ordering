# Files from self-hosted Supabase

Some files under `deploy/vps/config/` come from the `supabase/supabase` repository, folder
`docker/`, at the tag `self-hosted/v0.8.4` (commit `189adda99d1b56da55fc5a6ee3f849354aaea92a`), the
one self-hosted release the server runs (docs/DECISIONS.md VPS-34). That repository is licensed
under the Apache License, Version 2.0; `LICENSE-supabase` here is a byte-for-byte copy of its
`LICENSE` file (sha256 `c29468abcd629e248c2f76848155c386b733872bcabcc4cf65ef1e7c61431042`). It has
no NOTICE file.

Each sha256 below is of the upstream file as tagged: the git blob, with LF line endings
(`git show self-hosted/v0.8.4:<path> | sha256sum`).

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
