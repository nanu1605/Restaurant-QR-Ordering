# syntax=docker/dockerfile:1.27.1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# check=skip=SecretsUsedInArgOrEnv

# The MenuMesh web image: the Next.js standalone server. One image per environment, because the
# NEXT_PUBLIC_* values are inlined at build (docs/DECISIONS.md VPS-13 to VPS-19, VPS-21, VPS-22).
# The check skipped above flags ARG names that contain KEY; the ones below are public by design.
#
#   docker build --tag menumesh-web:<tag> --build-arg NEXT_PUBLIC_APP_URL=... (every ARG of the
#   build stage) [--secret id=sentry_auth_token,env=SENTRY_AUTH_TOKEN] .
#
# Locally: pnpm docker:build, docker:run and docker:check (docs/RUNBOOK.md, The web image).

# The BuildKit frontend on the first line reads this file, so it is pinned like the base images
# below (docs/DECISIONS.md VPS-14): 1.27.1 was pushed on 2026-09-30, and 1.28.0 (2026-10-07) passes
# the 14 days too. `# check=` and the heredocs need 1.8 or later. Bump it with the Node digest.

# Node 24 on Debian 13, pinned by digest, and at least 14 days old when pinned, which is the
# shared server's rule: 24.22.0 was pushed on 2026-10-21; 24.22.1 (2026-10-28) and 24.22.2
# (2026-11-05) pass it on 2026-11-11 and 2026-11-19. Bump the tag and the digest together
# (docs/DECISIONS.md VPS-14).
ARG NODE_IMAGE=node:24.22.0-trixie-slim@sha256:a6155384446670e9719bdc4fd0ebe4d4b29fb32a8d6aa523da3547a6cfbcf22c

# pnpm's own image, at the version package.json's packageManager pins (built 2026-09-10).
FROM ghcr.io/pnpm/pnpm:12.4.1@sha256:f37ab4b175b5b3bcd8f7334287f908959b09a849b73d5e13678d9fa70ffdb246 AS pnpm

# ---- deps: node_modules from the lockfile alone, so source edits keep this layer cached
FROM ${NODE_IMAGE} AS deps
COPY --from=pnpm /opt/pnpm /opt/pnpm
RUN ln -s /opt/pnpm/pnpm /usr/local/bin/pnpm
ENV CI=true
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# No locked package needs an install script: native code ships as prebuilt optional packages (the
# supabase CLI's binary, sharp's addon), and the two that have one, core-js and unrs-resolver, are
# denied in pnpm-workspace.yaml. --ignore-scripts is defence in depth, so a package that gains one
# later cannot run code in the build (docs/DECISIONS.md VPS-15).
# --pm-on-fail=error: a pnpm that is not the one packageManager names fails the build instead of
# downloading another (docs/DECISIONS.md VPS-14, VPS-15).
RUN --mount=type=cache,id=menumesh-pnpm,target=/var/cache/pnpm \
    pnpm install --frozen-lockfile --ignore-scripts --pm-on-fail=error --store-dir /var/cache/pnpm

# ---- build: next build with output standalone
FROM deps AS build
ENV NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1
# Before the ARGs, so staging and production builds of one commit share this layer. .dockerignore
# lets only the app's own files in.
COPY . .

# Public values, inlined into the server and the browser bundles (src/lib/env.ts reads each by
# name). They show in `docker history`: nothing secret goes here. The optional ones default to
# empty, so every public name is defined at build, and the server never reads one from the
# container's environment instead.
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_SENTRY_DSN=
ARG NEXT_PUBLIC_SENTRY_ENVIRONMENT=
ARG NEXT_PUBLIC_POSTHOG_KEY=
ARG NEXT_PUBLIC_POSTHOG_HOST=
# The commit (/api/health and /api/live report it) and the ID of this build, which tags its pages
# and server actions (next.config.ts deploymentId, docs/DECISIONS.md P10-11, VPS-7). One ID per
# build, not per commit: two builds of one commit have different action ids.
ARG NEXT_PUBLIC_BUILD_SHA
ARG DEPLOYMENT_ID
# Sentry's build step. Its auth token is a BuildKit secret (below), never an argument.
ARG SENTRY_ORG=
ARG SENTRY_PROJECT=
ARG SENTRY_RELEASE=

# Next.js inlines NEXT_PUBLIC_* from any .env file it finds, and copies .env and .env.production
# into the standalone output. .dockerignore keeps them out; this fails the build if that ever
# stops being true.
RUN <<'EOF'
set -eu
found="$(find . -path ./node_modules -prune -o \( -name '.env' -o -name '.env.*' \) -print)"
if [ -n "$found" ]; then
  echo 'error: env files reached the build (check .dockerignore):' >&2
  echo "$found" >&2
  exit 1
fi
EOF

# Fail early and clearly where Next.js would inline undefined or the app would fail later.
RUN <<'EOF'
set -eu
for name in NEXT_PUBLIC_APP_URL NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY NEXT_PUBLIC_BUILD_SHA DEPLOYMENT_ID; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "error: build argument $name is required" >&2
    exit 1
  fi
done
for name in NEXT_PUBLIC_APP_URL NEXT_PUBLIC_SUPABASE_URL; do
  eval "value=\${$name}"
  case "$value" in
    http://*|https://*) ;;
    *) echo "error: $name must start with http:// or https://" >&2; exit 1 ;;
  esac
done
case "$NEXT_PUBLIC_APP_URL" in
  */) echo 'error: NEXT_PUBLIC_APP_URL must not end with a slash' >&2; exit 1 ;;
esac
case "$DEPLOYMENT_ID" in
  *[!A-Za-z0-9_-]*) echo 'error: DEPLOYMENT_ID may only hold letters, digits, dashes and underscores' >&2; exit 1 ;;
esac
if [ -n "${NEXT_PUBLIC_SENTRY_DSN:-}" ] && [ -z "${NEXT_PUBLIC_SENTRY_ENVIRONMENT:-}" ]; then
  echo 'error: NEXT_PUBLIC_SENTRY_ENVIRONMENT is required when NEXT_PUBLIC_SENTRY_DSN is set' >&2
  exit 1
fi
EOF

# `pnpm build` is `next build`; calling it directly keeps pnpm's verify-deps-before-run from
# running an install (with scripts) again in this stage. The Sentry token is mounted for this step
# only; without it (local builds) source maps are neither made nor uploaded (next.config.ts). The
# context has no .git, so the release is the commit the build says it is.
#
# No cache mount on .next/cache here, and NEXT_SERVER_ACTIONS_ENCRYPTION_KEY stays unset: Next.js
# keeps the key that salts the server action ids in .next/cache/.rscinfo for 14 days, and a key
# set by hand is used as it is. Both would keep the ids the same from build to build. They must
# change with every build, so a page from an older build gets a clean refusal and refreshes
# instead of running a newer action with its old arguments (docs/DECISIONS.md VPS-10).
RUN --mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN \
    SENTRY_RELEASE="${SENTRY_RELEASE:-$NEXT_PUBLIC_BUILD_SHA}" \
    node_modules/.bin/next build

# The standalone server must exist (NEXT_OUTPUT was honoured). No source map ships: Sentry deletes
# the ones it uploaded, and this covers builds without a token.
RUN <<'EOF'
set -eu
test -f .next/standalone/server.js
find .next -name '*.map' -delete
if [ -n "$(find .next/standalone -maxdepth 1 -name '.env*')" ]; then
  echo 'error: an env file reached the standalone output' >&2
  exit 1
fi
EOF

# ---- runtime: only what node server.js needs
FROM ${NODE_IMAGE} AS runtime
ARG NEXT_PUBLIC_BUILD_SHA
ARG DEPLOYMENT_ID
LABEL org.opencontainers.image.title=menumesh-web \
      org.opencontainers.image.description='MenuMesh web app: Next.js standalone server' \
      org.opencontainers.image.source=https://github.com/nanu1605/Restaurant-QR-Ordering \
      org.opencontainers.image.revision=${NEXT_PUBLIC_BUILD_SHA} \
      io.menumesh.deployment-id=${DEPLOYMENT_ID}

# HOSTNAME: Docker sets it to the container ID, and the standalone server binds to it and builds
# request.url from it, so the loopback health check and the proxy need 0.0.0.0. Whatever depends
# on the host the visitor asked for reads X-Forwarded-Host, else Host (docs/DECISIONS.md VPS-2).
# KEEP_ALIVE_TIMEOUT (ms) must outlast the proxy's idle upstream connections: Caddy keeps them 2
# minutes, and a shorter timeout makes Caddy reuse connections Node has already closed
# (docs/DECISIONS.md VPS-16). The memory limit and --max-old-space-size are the deploy's to set
# (docs/DECISIONS.md VPS-24).
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    KEEP_ALIVE_TIMEOUT=130000 \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# Root-owned, so read-only to the app. It writes in two places only, both owned by node so that a
# fresh named volume mounted there starts writable: .next/cache (resized images) and
# .next/static, which the start-up script below keeps (VPS-21).
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/public ./public
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build /app/.next/static /opt/menumesh/static
RUN mkdir -p .next/cache && chown node:node .next/cache

# Pages from earlier builds ask for their own scripts and styles. The deploy mounts a named volume
# on /app/.next/static, and each start adds this build's files from the copy kept above, which no
# volume hides, then drops files that no build has added again for 14 days (docs/DECISIONS.md
# VPS-21). Without a volume it only refreshes the image's own folder. When the files cannot be
# added (a volume that uid 1000 cannot write, or a full disk, which leaves cut-short files) it
# starts only if the folder already holds every one of them unchanged: the volume hides the
# image's own copy, so a server without this build's scripts would turn healthy and answer 404 to
# every page. The server then replaces this script, so node is the process Docker sends SIGTERM to.
COPY --chmod=755 <<'EOF' /usr/local/bin/menumesh-web-start
#!/bin/sh
set -u
archive=/app/.next/static
if cp -Rf /opt/menumesh/static/. "$archive"/; then
  find "$archive" -type f -mmin +20160 -delete
  find "$archive" -mindepth 1 -type d -empty -delete
else
  missing="$(cd /opt/menumesh/static && find . -type f | while IFS= read -r file; do cmp -s "$file" "$archive/$file" || echo "$file"; done)"
  if [ -n "$missing" ]; then
    echo "error: $(echo "$missing" | wc -l) of this build's static files are missing or cut short in $archive and could not be added: the volume must be writable by uid 1000 and the disk not full" >&2
    exit 1
  fi
  echo "warning: $archive could not be updated, but it already holds this build's static files" >&2
fi
exec "$@"
EOF

# Next.js stops on SIGTERM by closing the server first, and Node's server.close() drops the idle
# keep-alive connections only once. One that is busy at that moment idles for KEEP_ALIVE_TIMEOUT
# after its answer, and Caddy keeps its pooled connections as long, so a stop that found one busy
# always ran out the grace period and ended in Docker's kill (docs/DECISIONS.md VPS-16, VPS-22).
# Once the server is closing, this ends every connection with its answer and drops the ones that
# fall idle. CMD loads it rather than NODE_OPTIONS, which the deploy sets.
COPY --chmod=644 <<'EOF' /usr/local/lib/menumesh-drain.cjs
const http = require('node:http');
const close = http.Server.prototype.close;
http.Server.prototype.close = function (...args) {
  // Every answer from now on ends its connection.
  this.prependListener('request', (_req, res) => {
    res.shouldKeepAlive = false;
  });
  // The connections that are busy now fall idle later: close them as they do.
  const timer = setInterval(() => this.closeIdleConnections(), 250).unref();
  this.once('close', () => clearInterval(timer));
  return close.apply(this, args);
};
EOF

USER node

# Proves that sharp's addon and its libvips load for the user the app runs as, so a broken image
# never ships: Next.js's file tracing has dropped libvips before (lovell/sharp#4567, docs/DECISIONS.md
# VPS-18).
RUN node <<'EOF'
const { createRequire } = require('node:module');
const sharp = createRequire(require.resolve('next/package.json'))('sharp');
sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } })
  .webp()
  .toBuffer()
  .then(
    (out) => process.exit(out.length > 0 ? 0 : 1),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
EOF

EXPOSE 3000
# The deploy turns a new container on only when Docker calls it healthy (it waits up to 120 s), so
# this asks /api/health, which reaches the database: healthy means Next.js, PostgREST and the
# database all answer. When the database goes away the container turns unhealthy and, once it is
# back, healthy again; nothing restarts it for that (docs/DECISIONS.md VPS-17). /api/live is the
# one without the database. A probe runs every 2 s during the 60 s start period, with failures not
# counted, then every 30 s; the probe gives up after 4 s.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/api/health`, { signal: AbortSignal.timeout(4000) }).then((res) => process.exit(res.ok ? 0 : 1), () => process.exit(1))"]
# Next.js handles SIGTERM itself: it stops accepting, lets requests and after() work finish, and
# exits 143. Deploys stop the container with a 25 s grace period, and what still runs then is
# killed (docs/DECISIONS.md VPS-22). The preload above lets that stop finish.
ENTRYPOINT ["/usr/local/bin/menumesh-web-start"]
CMD ["node", "--require", "/usr/local/lib/menumesh-drain.cjs", "server.js"]
