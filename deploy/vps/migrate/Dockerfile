# syntax=docker/dockerfile:1.27.1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e

# MenuMesh's migrate image (docs/DECISIONS.md VPS-39): supabase/migrations and the psql runner that
# applies them, run by app-deploy as the migrate or migrate-staging one-off of deploy/vps/compose.yml
# before it switches a web image. CI builds it from the repository's root as
# ghcr.io/nanu1605/menumesh:migrate-<sha>, labelled org.opencontainers.image.version with that tag,
# which app-deploy checks. Dockerfile.dockerignore, beside this file, lets the build see the
# migrations and this folder only, so no seed ever reaches the image:
#
#   docker build --file deploy/vps/migrate/Dockerfile --tag menumesh-migrate:<tag> \
#     --label org.opencontainers.image.version=<tag> --build-arg REVISION=<sha> .
#
# The frontend is pinned as in the web image's Dockerfile. psql 17, the server's major, from
# Postgres's own Alpine image, pinned by digest and at least 14 days old, the shared server's rule:
# 17.10 on Alpine 3.24 was pushed on 2026-07-08; 17.11 (pushed 2026-11-06) passes the rule on
# 2026-11-20. Bump the tag and the digest together, here and in the backup image.
FROM postgres:17.10-alpine3.24@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193

ARG REVISION=
LABEL org.opencontainers.image.title=menumesh-migrate \
      org.opencontainers.image.description='MenuMesh database migrations and their psql runner' \
      org.opencontainers.image.source=https://github.com/nanu1605/Restaurant-QR-Ordering \
      org.opencontainers.image.revision=${REVISION}

COPY supabase/migrations/ /migrations/
COPY --chmod=755 deploy/vps/migrate/migrate.sh /usr/local/bin/menumesh-migrate

# A client only: no server, no root.
USER postgres
ENTRYPOINT ["/usr/local/bin/menumesh-migrate"]
