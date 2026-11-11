#!/bin/sh
# The backup's alert and heartbeat (docs/DECISIONS.md VPS-40), for backup.sh and restore.sh:
#
#   notify.sh alert <text>   sends <text> to TELEGRAM_CHAT_ID from the bot of TELEGRAM_BOT_TOKEN
#   notify.sh beat           pings HEARTBEAT_URL
#
# The token and the URL come from the environment and reach curl on its stdin (--config -), never
# in its arguments, so the host's process list never shows them. An empty value sends nothing. A
# failed send prints one line naming only what failed, and the exit stays 0: the caller's own
# failure is what matters, and a heartbeat monitor notices a missing ping by itself.
set -eu

# A value as a double-quoted string of curl's config file.
quoted() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/[\\"]/\\&/g')"
}

# Reads the request from stdin and prints the HTTP status; curl's own messages could name the URL.
send() {
  curl --config - --silent --output /dev/null --write-out '%{http_code}' "$@"
}

# One line for a send that got no 2xx: curl's exit code, or the HTTP status.
report() {
  case $2 in
    2??) ;;
    *) printf 'notify: %s failed (%s)\n' "$1" "$3" >&2 ;;
  esac
}

case ${1-} in
  alert)
    text=${2-}
    [ -n "$text" ] || { echo 'usage: notify.sh alert <text>' >&2; exit 2; }
    [ -n "${TELEGRAM_BOT_TOKEN-}" ] && [ -n "${TELEGRAM_CHAT_ID-}" ] || exit 0
    rc=0
    code=$({
      printf 'url = %s\n' "$(quoted "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage")"
      printf 'data-urlencode = %s\n' "$(quoted "chat_id=${TELEGRAM_CHAT_ID}")"
      printf 'data-urlencode = %s\n' "$(quoted "text=${text}")"
    } | send --max-time 20 --retry 2) || rc=$?
    report 'the Telegram alert' "$code" "$([ "$rc" -eq 0 ] && echo "HTTP $code" || echo "curl exit $rc")"
    ;;
  beat)
    [ -n "${HEARTBEAT_URL-}" ] || exit 0
    rc=0
    code=$(printf 'url = %s\n' "$(quoted "$HEARTBEAT_URL")" | send --max-time 10 --retry 3) || rc=$?
    report 'the heartbeat ping' "$code" "$([ "$rc" -eq 0 ] && echo "HTTP $code" || echo "curl exit $rc")"
    ;;
  *)
    echo 'usage: notify.sh alert <text> | notify.sh beat' >&2
    exit 2
    ;;
esac
exit 0
