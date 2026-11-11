#!/bin/bash
# The shared server's own checks on MenuMesh's kit (docs/DECISIONS.md VPS-42), run by
# `pnpm vps:check` (scripts/vps-kit.mts) in a throwaway container of Dockerfile.kitcheck: Ubuntu
# 24.04 as root, no network, the server's Docker CLI 29.9.3 and Compose 5.7.0, deploy/vps at /kit
# (read-only), a directory shared with vps-kit.mts at /out, and a /proc/meminfo whose MemTotal is
# the 15,990 MiB the KVM 4 is expected to report (to be read on the server).
#
# It sources the vendored app-apply (test/vendor/jainav-infotech; SOURCE names the commit) as the
# server team's own tests/host/app-apply.sh does, with APP_APPLY_SOURCE_ONLY=1, so every rule here
# is the code root runs on the server, on a /srv/menumesh and an /etc/apps laid out as the server's.
# Stubbed, because they need what a container lacks:
#   journal, logger        no journald or syslog here
#   check_edge_networks    asks the Docker daemon about the edge networks: the server runs it
#   installed_steady       the other projects' steady memory limits, from their compose files at
#                          the vendored commit: Jainav 4,480 MiB, the edge 256 MiB
#   caddy_run              for the site file's JSON check only: it replays the `caddy adapt` that
#                          vps-kit.mts ran on the host with caddy_run's own flags, once it has
#                          compared the files with the ones adapted there
#
#   kit-check.sh prepare   a throwaway certificate in /out/certs, and /out/edge.env parsed as
#                          app-apply parses edge.env, for vps-kit.mts's Caddy runs
#   kit-check.sh check     the compose file, the contract's own rules and the edge files; then
#                          broken copies of each, which every rule must refuse
#
# Prints a line per check (ok / not ok) and a count; exits 1 if one failed.
set -uo pipefail

kit=/kit
out=/out
vendor=$kit/test/vendor/jainav-infotech
srv=/srv/menumesh
T=$(mktemp -d)
mkdir -p "$T/cases"

checks=0 failed=0
ok() {
  checks=$((checks + 1))
  printf 'ok - %s\n' "$1"
}
bad() { # bad <name> <what> [<output>]
  checks=$((checks + 1))
  failed=$((failed + 1))
  printf 'not ok - %s: %s\n' "$1" "$2"
  if [ -n "${3-}" ]; then printf '%s\n' "$3" | sed 's/^/    | /'; fi
}
expect_clean() { # expect_clean <name> <what the checks printed>
  if [ -z "$2" ]; then ok "$1"; else bad "$1" "refused, but should pass" "$2"; fi
}
expect_refused() { # expect_refused <name> <what the checks printed> <text it must hold>
  if [ -z "$2" ]; then
    bad "$1" "passed, but should be refused"
  elif [[ $2 == *"$3"* ]]; then
    ok "$1"
  else
    bad "$1" "refused, but not for: $3" "$2"
  fi
}
note() { printf '# %s\n' "$*"; }

# In a subshell: app-apply's functions as root has them, the stubs above, and a work directory in
# /run as app-apply's main makes it. The sourcing sets app-apply's PATH, LC_ALL=C and umask.
# shellcheck disable=SC2317,SC2329 # the stubs are called by app-apply's functions
setup_lib() {
  # shellcheck source=/dev/null
  APP_APPLY_SOURCE_ONLY=1 . "$vendor/app-apply"
  set +eu
  journal() { cat >/dev/null; }
  # say and die name their line after --; finish pipes its list in, which is read to the end.
  logger() {
    case " $* " in
    *' -- '*) ;;
    *) cat >/dev/null ;;
    esac
  }
  # shellcheck disable=SC2034 # read by create_edge_networks in app-apply
  check_edge_networks() {
    edge_all=()
    edge_present=()
  }
  installed_steady() {
    case $1 in
    jainav) echo 4480 ;;
    edge) echo 256 ;;
    *) return 1 ;;
    esac
  }
  lock_dir
  work=$(mktemp -d /run/app-apply.XXXXXX)
  : >"$work/problems"
  mkdir -p "$work/empty"
}

# The server as app-apply finds it: the confs in /etc/apps (root, 0644), the vendored edge.conf and
# jainav.conf and MenuMesh's own, and /srv/menumesh as the owner fills it (deploy/vps/README.md):
# root's, 0750, the env files 0600, the rest 0644, and the CA certificate the owner downloads.
install_server() {
  install -d -m 0755 /etc/apps
  install -m 0644 "$vendor/edge.conf" /etc/apps/edge.conf
  install -m 0644 "$vendor/jainav.conf" /etc/apps/jainav.conf
  install -m 0644 "$kit/test/menumesh.conf" /etc/apps/menumesh.conf
  install -d -m 0750 "$srv" "$srv/env"
  cp -R "$kit/config" "$srv/config"
  printf 'a stand-in for the CA certificate the owner downloads\n' >"$srv/config/migrate/supabase-ca.crt"
  chown -R root:root "$srv/config"
  find "$srv/config" -type d -exec chmod 0755 {} +
  find "$srv/config" -type f -exec chmod 0644 {} +
  install -m 0600 "$kit/env/web.env.example" "$srv/env/web.env"
  install -m 0600 "$kit/env/web-staging.env.example" "$srv/env/web-staging.env"
  install -m 0644 "$kit/env/images.env.example" "$srv/images.env"
}

# .env with a dummy value for every ${NAME} the compose file names, as tests/host/app-apply.sh
# makes it; images.env (later, so it wins) is the template as the owner copies it once.
dummy_env() { # dummy_env <compose file>
  { grep -oE '[$][{][A-Z_0-9]+' "$1" || true; } | sed -e 's/^..//' -e 's/$/=dummy/' | sort -u >"$srv/.env"
  chmod 0600 "$srv/.env"
}

# --- the compose file ---

# The contract's rules that app-apply leaves to each app (docs/DECISIONS.md VPS-24, VPS-33), on
# the JSON app-apply had Compose print: every service sets cpu_shares and a non-zero
# oom_score_adj itself (Compose leaves 0 out); no logging keys (journald is the daemon's default);
# a healthcheck on every long-running service but the webs, whose image has its own; no swap for
# db, api-gw and backup; 6,560 MiB of steady limits exactly; on the edge networks only web,
# api-gw and web-staging, each with its one alias; staging's services on staging's networks only.
# shellcheck disable=SC2016 # jq's own $ variables
CONTRACT_JQ='def steady: ((.value.profiles // []) | length) == 0;
  (services | .key as $s | .value
    | (if has("cpu_shares") then empty else "service \($s): cpu_shares is not set" end),
      (if ((.oom_score_adj // 0) | tonum) == 0 then "service \($s): oom_score_adj is not set (Compose leaves out 0)" else empty end),
      (if has("logging") then "service \($s): sets logging; the daemon'"'"'s journald default applies" else empty end)),
  (services | select(steady) | select(.key | IN("web", "web-staging") | not)
    | select((.value.healthcheck // null) == null or (.value.healthcheck.disable // false))
    | "service \(.key) runs all the time without a healthcheck"),
  (services | select(.key | IN("db", "api-gw", "backup")) | .key as $s | .value
    | select((.memswap_limit | tobytes) != (.mem_limit | tobytes))
    | "service \($s): memswap_limit must equal mem_limit"),
  ([services | select(steady) | (.value.mem_limit | tobytes) // 0] | add / 1048576 | floor
    | if . == 6560 then empty else "the steady mem_limit total is \(.) MiB, not the contract'"'"'s 6,560" end),
  (. as $root | [($root.networks // {}) | to_entries[] | select((.value // {}) | external) | .key] as $edge
    | [services | .key as $s | (.value | nets) | to_entries[] | select(.key | IN($edge[]))
        | "\($s) \(.key) \(((.value // {}).aliases // []) | join(","))"] | sort
    | if . == ["api-gw edge-menumesh menumesh-gw", "web edge-menumesh menumesh-web", "web-staging edge-menumesh-staging menumesh-web-staging"]
      then empty else "the edge networks carry \(join("; ")), not web, api-gw and web-staging with their aliases" end),
  (services | .key as $s | (.value | nets | keys) as $n
    | if ($s | test("staging"))
      then ($n - ["staging", "edge-menumesh-staging"] | .[] | "service \($s) is on \(.), one of production'"'"'s networks")
      else ($n | map(select(IN("staging", "edge-menumesh-staging"))) | .[] | "service \($s) is on \(.), one of staging'"'"'s networks") end)'

# What `app-apply menumesh compose <file>` refuses (its own cmd_compose, every check in its order,
# then the install into /srv/menumesh and the sha256 pin), then what the contract's rules refuse;
# nothing when both pass. app-apply's own lines go to $T/install.log.
compose_case() { # compose_case <compose file>
  (
    setup_lib
    dummy_env "$1"
    if ! (cmd_compose menumesh "$1") >"$T/install.log" 2>&1; then
      cat "$T/install.log"
      exit 0
    fi
    # What cmd_compose set in its own subshell, for jqc in app-apply.
    # shellcheck disable=SC2034
    project=menumesh
    load_conf menumesh
    # shellcheck disable=SC2034
    allowed_edge=$EDGE_NETWORKS
    : >"$work/problems"
    rule "$CONTRACT_JQ"
    cat "$work/problems"
  )
}

# Where a case's copy goes: its name, letters and digits only.
case_path() { printf '%s/cases/%s' "$T" "$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '-')"; }

# A copy of compose.yml with one line of a service (or of the file, for -) replaced by new text,
# which may hold \n; an empty one removes the line. Fails when the line is no longer there.
case_file() { # case_file <name> <service|-> <line> <new text>
  local f
  f=$(case_path "$1").yml
  awk -v svc="  $2:" -v any="$([ "$2" = - ] && echo 1)" -v old="$3" -v new="$4" '
    /^[^ #]/ { insvc = 0 }
    /^  [^ #-]/ { insvc = ($0 == svc) }
    (any || insvc) && !done && $0 == old { done = 1; if (new != "") print new; next }
    { print }
    END { if (!done) exit 3 }' "$kit/compose.yml" >"$f" || return 1
  printf '%s' "$f"
}
# The same, without the line and the lines indented under it.
case_drop() { # case_drop <name> <service> <line>
  local f
  f=$(case_path "$1").yml
  awk -v svc="  $2:" -v old="$3" '
    /^[^ #]/ { insvc = 0 }
    /^  [^ #-]/ { insvc = ($0 == svc) }
    skip { match($0, /^ */); if (RLENGTH > depth && $0 !~ /^[ \t]*$/) next; skip = 0 }
    insvc && !done && $0 == old { done = 1; skip = 1; match($0, /^ */); depth = RLENGTH; next }
    { print }
    END { if (!done) exit 3 }' "$kit/compose.yml" >"$f" || return 1
  printf '%s' "$f"
}
# compose_bite <name> <text the refusal holds> <case_file or case_drop arguments...>
compose_bite() {
  local name=$1 want=$2 f
  shift 2
  if [ $# -eq 3 ]; then f=$(case_file "$name" "$@"); else f=$(case_drop "$name" "$@"); fi ||
    {
      bad "compose refuses $name" "the line to change is not in compose.yml any more"
      return
    }
  expect_refused "compose refuses $name" "$(compose_case "$f")" "$want"
}

check_compose() {
  local output
  output=$(compose_case "$kit/compose.yml")
  expect_clean 'compose.yml passes app-apply menumesh compose (every check, the install and the pin) and the contract' "$output"
  if [ -n "$output" ]; then
    # Each broken copy starts from compose.yml, and app-apply stops at its first refusal: they
    # would all show compose.yml's own problem.
    note 'the broken copies of compose.yml are skipped until it passes'
    return
  fi
  note "app-apply: $(grep -m1 '^steady memory limits' "$T/install.log")"
  note "app-apply: $(grep -m1 '^installed ' "$T/install.log")"

  # app-apply's own rules, each on a copy with one mistake.
  compose_bite 'another project name' 'the project name must be menumesh' - 'name: menumesh' 'name: jainav'
  compose_bite 'another top-level key' 'top-level keys are name, services, networks, volumes and x-*' \
    - 'services:' 'configs:\n  kit: {}\nservices:'
  compose_bite 'extends' 'include and extends are not allowed' \
    web '    <<: *steady' '    <<: *steady\n    extends:\n      service: web-staging'
  compose_bite 'a published port' 'service web: ports is not allowed' \
    web '    <<: *steady' "    <<: *steady\n    ports: ['127.0.0.1:3000:3000']"
  compose_bite 'privileged' 'service db: privileged is not allowed' \
    db '    <<: *steady' '    <<: *steady\n    privileged: true'
  compose_bite 'a missing limit' 'service scheduler: pids_limit must be set' scheduler '    pids_limit: 64' ''
  compose_bite 'swap beyond 256m' 'service web: memswap_limit must be from mem_limit to mem_limit + 256m' \
    web '    memswap_limit: 1792m' '    memswap_limit: 2048m'
  # shellcheck disable=SC2016 # ${...} is compose text under test, not for this shell to expand
  compose_bite 'a ${VAR} in volumes' 'service db: volumes takes a value from the env files' \
    db '      - ./config/db/jwt.sql:/docker-entrypoint-initdb.d/init-scripts/99-jwt.sql:ro' \
    '      - ./config/db/${KIT_INIT_SQL}:/docker-entrypoint-initdb.d/init-scripts/99-jwt.sql:ro'
  compose_bite 'a writable bind' 'must be read-only' \
    api-gw '      - ./config/envoy/start.sh:/opt/menumesh/envoy-start.sh:ro' \
    '      - ./config/envoy/start.sh:/opt/menumesh/envoy-start.sh'
  compose_bite 'a bind outside /srv/menumesh' 'bind /etc/passwd is outside /srv/menumesh/' \
    backup '      - storage-data:/storage:ro' '      - storage-data:/storage:ro\n      - /etc/passwd:/etc/host-passwd:ro'
  compose_bite 'the Docker socket' 'the Docker socket is never mounted' \
    backup '      - storage-data:/storage:ro' '      - storage-data:/storage:ro\n      - /var/run/docker.sock:/var/run/docker.sock:ro'
  compose_bite 'another capability' 'service backup: cap_add SYS_ADMIN is not allowed' \
    backup '    cap_add: [SETUID, SETGID]' '    cap_add: [SETUID, SETGID, SYS_ADMIN]'
  compose_bite 'a tmpfs without a size' 'tmpfs /tmp has no size' web "    tmpfs: ['/tmp:size=64m']" "    tmpfs: ['/tmp']"
  compose_bite 'a long-running service without restart' 'service scheduler has no profile, so it needs restart: unless-stopped' \
    scheduler '    <<: *steady' '    <<: *hardened'
  compose_bite 'an alias not in UPSTREAMS' 'alias menumesh-www on edge-menumesh is not in UPSTREAMS' \
    web '        aliases: [menumesh-web]' '        aliases: [menumesh-www]'
  compose_bite 'the database on an edge network' 'service db is on edge-menumesh without an alias from UPSTREAMS' \
    db '    networks: [data]' '    networks: [data, edge-menumesh]'
  compose_bite 'an external volume' 'volume db-data is external' - '  db-data: {}' '  db-data:\n    external: true'
  compose_bite 'IPv6 on a network' 'network staging enables IPv6' - '  staging: {}' '  staging:\n    enable_ipv6: true'
  # One more long-running service of 4 GiB: with Jainav's and the edge's limits and the host's
  # 1,536 MiB, more than MemTotal.
  compose_bite 'limits over MemTotal' 'are not below MemTotal (15990 MiB)' - 'services:' \
    "services:\n  kit-hog:\n    <<: *steady\n    image: kit/hog:1\n    networks: [data]\n    healthcheck:\n      test: ['CMD', 'true']\n    mem_limit: 4096m\n    memswap_limit: 4096m\n    cpus: 0.5\n    cpu_shares: 128\n    pids_limit: 64\n    oom_score_adj: 900"
  # The contract's rules, where app-apply lets the copy pass.
  compose_bite 'a cpu_shares left out' 'service backup: cpu_shares is not set' backup '    cpu_shares: 128' ''
  compose_bite 'an oom_score_adj left out' 'service web: oom_score_adj is not set' web '    oom_score_adj: -300' ''
  compose_bite 'swap for the database' 'service db: memswap_limit must equal mem_limit' \
    db '    memswap_limit: 1920m' '    memswap_limit: 2048m'
  compose_bite 'a long-running service without a healthcheck' 'service auth runs all the time without a healthcheck' \
    auth '    healthcheck:'
  compose_bite 'a logging key' 'service rest: sets logging' \
    rest '    networks: [data]' '    networks: [data]\n    logging:\n      driver: journald'
  compose_bite 'a steady total off 6,560 MiB' 'the steady mem_limit total is 6592 MiB' \
    web '    mem_limit: 1536m' '    mem_limit: 1568m'
  compose_bite 'staging on a production network' 'service scheduler-staging is on default, one of production' \
    scheduler-staging '    networks: [staging]' '    networks: [staging, default]'
  # Both aliases are in UPSTREAMS, so app-apply lets it pass; the gateway would answer for the app.
  compose_bite 'a second alias on an edge network' 'the edge networks carry api-gw edge-menumesh menumesh-gw,menumesh-web' \
    api-gw '        aliases: [menumesh-gw]' '        aliases: [menumesh-gw, menumesh-web]'
}

# --- the edge files ---

# What app-apply's text check of an edge file refuses: edge_env_parse (app-apply edge env),
# site_text_check with the keys of edge.env.example (app-apply menumesh site, check 1) or
# check_redact_text (app-apply edge redact). The conf gives ZONE, UPSTREAMS and ENV_PREFIX.
edge_case() { # edge_case env|site|redact <file>
  (
    setup_lib
    load_conf menumesh
    case $1 in
    env) edge_env_parse "$2" "$work/edge" ;;
    site)
      edge_env_parse "$kit/edge/edge.env.example" "$work/edge"
      : >"$work/problems"
      site_text_check menumesh "$2" "$work/edge.keys"
      ;;
    redact) check_redact_text "$2" ;;
    esac
    cat "$work/problems"
  )
}

# What the site file's JSON check (app-apply menumesh site, check 2) refuses in Caddy's adapted
# config. caddy_run replays the host's adapt (/out/adapt), once the three files app-apply put
# together for it are the ones the host adapted; <json> is what it hands back.
# shellcheck disable=SC2317,SC2329 # caddy_run is called by site_json_check
site_json_case() { # site_json_case <adapted json>
  (
    setup_lib
    load_conf menumesh
    replay=$1
    caddy_run() {
      local f
      [ "$4" = adapt ] || {
        echo "kit-check: no recorded caddy $4" >&2
        return 1
      }
      for f in Caddyfile snippets.caddy sites/menumesh.caddy; do
        cmp -s "$1/$f" "$out/adapt/$f" || {
          echo "kit-check: the host adapted another $f" >&2
          return 1
        }
      done
      cat "$out/adapt/adapt.err" >&2
      cat "$replay"
      return "$(cat "$out/adapt/status")"
    }
    site_json_check menumesh "$kit/edge/menumesh.caddy" "$out/adapt/snippets.caddy" "$out/edge.docker"
    cat "$work/problems"
  )
}

# A copy of an edge file with one line replaced (or, with an empty old line, one line added at
# the end); fails when the line is no longer there.
edge_copy() { # edge_copy <name> <file> <line> <new text>
  local f
  f=$(case_path "$1")
  awk -v old="$3" -v new="$4" '
    old != "" && !done && $0 == old { done = 1; if (new != "") print new; next }
    { print }
    END { if (old == "") { print new; done = 1 } if (!done) exit 3 }' "$2" >"$f" || return 1
  printf '%s' "$f"
}
edge_bite() { # edge_bite <name> <env|site|redact> <file> <text the refusal holds> <line> <new text>
  local f
  f=$(edge_copy "$1" "$3" "$5" "$6") || {
    bad "$1" "the line to change is not in ${3##*/} any more"
    return
  }
  expect_refused "$1" "$(edge_case "$2" "$f")" "$4"
}

check_edge() {
  local site=$kit/edge/menumesh.caddy redact=$kit/edge/log-redact.caddy env=$kit/edge/edge.env.example
  expect_clean 'edge.env.example passes app-apply edge env (edge_env_parse)' "$(edge_case env "$env")"
  expect_clean 'menumesh.caddy passes app-apply menumesh site, check 1 (the text)' "$(edge_case site "$site")"
  if [ -s "$out/adapt/adapted.json" ] && [ -s "$out/adapt/status" ]; then
    expect_clean 'menumesh.caddy passes app-apply menumesh site, check 2 (Caddy'"'"'s adapted JSON)' \
      "$(site_json_case "$out/adapt/adapted.json")"
    # shellcheck disable=SC2016 # jq's own syntax
    if jq '.apps.http.servers[].routes[0].match[0].host += ["kit-check.example"]' "$out/adapt/adapted.json" >"$T/outside.json" 2>/dev/null; then
      expect_refused 'check 2 refuses a host outside menumesh.in' "$(site_json_case "$T/outside.json")" 'host kit-check.example is outside menumesh.in'
    else
      bad 'check 2 refuses a host outside menumesh.in' 'could not add a host to the adapted JSON'
    fi
    if jq '.apps.http.servers[].routes[0].handle += [{"handler": "file_server"}]' "$out/adapt/adapted.json" >"$T/handler.json" 2>/dev/null; then
      expect_refused 'check 2 refuses a handler off its list' "$(site_json_case "$T/handler.json")" 'handler file_server is not allowed'
    else
      bad 'check 2 refuses a handler off its list' 'could not add a handler to the adapted JSON'
    fi
  else
    bad 'menumesh.caddy passes app-apply menumesh site, check 2 (Caddy'"'"'s adapted JSON)' 'no adapt from the host in /out/adapt'
  fi
  expect_clean 'log-redact.caddy passes app-apply edge redact (check_redact_text)' "$(edge_case redact "$redact")"

  # Each on a copy with one mistake. The lines go through awk -v, which reads \t and \n.
  edge_bite 'site check 1 refuses an expression matcher' site "$site" 'matcher expression is not allowed' \
    '\t@upgrade header Upgrade *' "\t@upgrade header Upgrade *\n\t@legacy expression {path('/old')}"
  edge_bite 'site check 1 refuses a block without import tls_menumesh' site "$site" \
    'a site block starts with import site_common, then import tls_menumesh' '\timport tls_menumesh' ''
  edge_bite 'site check 1 refuses an upstream not in UPSTREAMS' site "$site" 'upstream menumesh-admin:3000 is not in UPSTREAMS' \
    '\treverse_proxy menumesh-web:3000 {' '\treverse_proxy menumesh-admin:3000 {'
  # shellcheck disable=SC2016 # {$NAME} is a Caddy placeholder under test
  edge_bite 'site check 1 refuses another app'"'"'s placeholder' site "$site" '{$JAINAV_STAGING_AUTH_HASH} is not this app'"'"'s' \
    '\t\t{$MENUMESH_STAGING_AUTH_USER} {$MENUMESH_STAGING_AUTH_HASH}' '\t\t{$MENUMESH_STAGING_AUTH_USER} {$JAINAV_STAGING_AUTH_HASH}'
  edge_bite 'site check 1 refuses a client-IP header set by the site' site "$site" 'Caddy alone sets the client-IP headers' \
    '\treverse_proxy menumesh-web-staging:3000 {' '\trequest_header X-Forwarded-For 1.2.3.4\n\treverse_proxy menumesh-web-staging:3000 {'
  edge_bite 'edge redact refuses a quoted pattern' redact "$redact" 'quotes and backquotes are not allowed' \
    'request>uri regexp ^/t/[A-Za-z0-9]+ /t/_' 'request>uri regexp "^/t/[A-Za-z0-9]+" /t/_'
  edge_bite 'edge redact refuses another directive' redact "$redact" 'a line is: request>uri regexp <pattern> <replacement>' \
    '' 'request>headers delete'
  edge_bite 'edge env refuses a name of no app' env "$env" 'starts with no app ENV_PREFIX' '' 'CADDY_ADMIN=0.0.0.0:2019'
  # shellcheck disable=SC2016 # the $ signs are a bcrypt hash's
  edge_bite 'edge env refuses an unquoted hash' env "$env" 'must be plain, or in single quotes' \
    "MENUMESH_STAGING_AUTH_HASH='\$2a\$14\$replace-me'" 'MENUMESH_STAGING_AUTH_HASH=$2a$14$replace-me'
}

# --- prepare: what the host's Caddy runs need ---

prepare() {
  local dir=$out/certs/menumesh
  mkdir -p "$dir"
  # A throwaway pair for the zone's names; the server's is Cloudflare's Origin CA certificate.
  if openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 \
    -subj '/CN=menumesh.in' -addext 'subjectAltName=DNS:menumesh.in,DNS:*.menumesh.in' \
    -keyout "$dir/origin-key.pem" -out "$dir/origin.pem" 2>"$T/openssl.err"; then
    # Caddy runs as root without DAC_OVERRIDE, as on the server, so the throwaway key must be
    # readable by all (tests/host/app-apply.sh does the same).
    chmod 0644 "$dir/origin-key.pem" "$dir/origin.pem"
    ok 'a throwaway certificate for menumesh.in and *.menumesh.in'
  else
    bad 'a throwaway certificate for menumesh.in and *.menumesh.in' 'openssl failed' "$(cat "$T/openssl.err")"
  fi
  # edge.env as app-apply hands it to docker run --env-file (edge_env_parse): the host's Caddy
  # runs read /out/edge.docker.
  expect_clean 'the throwaway edge.env passes edge_env_parse' "$(
    setup_lib
    edge_env_parse "$out/edge.env" "$out/edge"
    cat "$work/problems"
  )"
  # Root made these in a folder of the host's user, who removes it afterwards: on a Linux host
  # the files must be that user's (Docker Desktop's mounts take no owner).
  chown -R "$(stat -c %u:%g "$out")" "$out/certs" "$out/edge.docker" "$out/edge.keys" 2>/dev/null || true
}

install_server
case ${1-} in
prepare) prepare ;;
check)
  note "app-apply $(sed -n 's/^# Commit: *\([0-9a-f]\{7\}\).*/\1/p' "$vendor/SOURCE"), Docker $(docker version --format '{{.Client.Version}}' 2>/dev/null), $(docker compose version), $(jq --version), $(awk -W version 2>&1 | head -n 1)"
  check_compose
  check_edge
  ;;
*)
  echo 'usage: kit-check.sh prepare|check' >&2
  exit 2
  ;;
esac
printf '%s checks, %s failed\n' "$checks" "$failed"
[ "$failed" -eq 0 ]
