#!/bin/sh
# Envoy's entrypoint for MenuMesh's gateway, from self-hosted Supabase v0.8.4 (supabase/supabase,
# docker/volumes/api/envoy/docker-entrypoint.sh, Apache-2.0; see deploy/vps/config/SOURCES.md).
# Changed, each marked "MenuMesh:" below (docs/DECISIONS.md VPS-35): no Studio basic auth to hash;
# the keys reach sed in a script file instead of its arguments; the listeners go to the tmpfs at
# /run/envoy, as Envoy runs as uid 101 with a read-only root. compose.yml requires all six keys:
# without them the sb_ keys get 401.
set -e

echo "Generating Envoy configuration..."

# Process the lds.yaml template with environment variables using sed
# Using | as delimiter since JWT tokens contain /
# MenuMesh: printf, a shell builtin, writes the substitutions to a file that only Envoy's user can
# read, so no process ever has a key in its arguments, where the host's process list shows them.
umask 077
# shellcheck disable=SC2016 # the ${...} in the formats are the template's placeholders
{
  printf 's|${ANON_KEY}|%s|g\n' "${ANON_KEY}"
  printf 's|${ANON_KEY_ASYMMETRIC}|%s|g\n' "${ANON_KEY_ASYMMETRIC}"
  printf 's|${SERVICE_ROLE_KEY}|%s|g\n' "${SERVICE_ROLE_KEY}"
  printf 's|${SERVICE_ROLE_KEY_ASYMMETRIC}|%s|g\n' "${SERVICE_ROLE_KEY_ASYMMETRIC}"
  printf 's|${SUPABASE_PUBLISHABLE_KEY}|%s|g\n' "${SUPABASE_PUBLISHABLE_KEY}"
  printf 's|${SUPABASE_SECRET_KEY}|%s|g\n' "${SUPABASE_SECRET_KEY}"
} >/run/envoy/keys.sed
sed -f /run/envoy/keys.sed /etc/envoy/lds.template.yaml >/run/envoy/lds.yaml
rm -f /run/envoy/keys.sed

if [ -n "$SUPABASE_SECRET_KEY" ] && \
   [ -n "$SUPABASE_PUBLISHABLE_KEY" ] && \
   [ -n "$SERVICE_ROLE_KEY_ASYMMETRIC" ] && \
   [ -n "$ANON_KEY_ASYMMETRIC" ]; then
  echo "Envoy sb_ key translation enabled"
else
  echo "Envoy running in legacy API key mode (sb_ keys disabled)"
fi

echo "Envoy configuration generated successfully"
echo "Starting Envoy..."

# Start Envoy
exec envoy -c /etc/envoy/envoy.yaml "$@"
