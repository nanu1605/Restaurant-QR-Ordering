#!/bin/sh
# Entrypoint of MenuMesh's schedulers (docs/DECISIONS.md VPS-38). Compose passes the web
# container's address, the cron bearer and the heartbeat URLs in the environment. This writes them
# to /run/menumesh/cron.env, a 0600 file on a tmpfs that only root can enter, where cron-call reads
# them whether or not crond hands its environment to the jobs. printf is a shell builtin, so no
# value is ever in a process's arguments. Then BusyBox crond runs in the foreground: -l 9 keeps its
# line for every job start out of the journal, and -L sends its errors to stderr (a container has
# no syslog).
set -eu
umask 077
run=/run/menumesh

# A value goes into cron.env in single quotes and into curl's config in double quotes, so none may
# hold a quote, a backslash or a line break.
line() { # line <name> <value>
  case $2 in
  *"'"* | *'"'* | *\\* | *'
'*)
    echo "start: $1 may not hold a quote, a backslash or a line break" >&2
    exit 1
    ;;
  *) ;;
  esac
  printf "%s='%s'\n" "$1" "$2"
}

if [ -z "${CRON_BASE_URL:-}" ] || [ -z "${CRON_SECRET:-}" ]; then
  echo "start: CRON_BASE_URL and CRON_SECRET must be set" >&2
  exit 1
fi
{
  line CRON_BASE_URL "$CRON_BASE_URL"
  line CRON_SECRET "$CRON_SECRET"
  line HEARTBEAT_DAILY_URL "${HEARTBEAT_DAILY_URL:-}"
  line HEARTBEAT_DIGEST_URL "${HEARTBEAT_DIGEST_URL:-}"
  line HEARTBEAT_JOBS_URL "${HEARTBEAT_JOBS_URL:-}"
} >"$run/cron.env.new"
mv -f "$run/cron.env.new" "$run/cron.env"

exec crond -f -c /etc/crontabs -L /dev/stderr -l 9
