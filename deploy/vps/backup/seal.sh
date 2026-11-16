#!/bin/sh
# MenuMesh's signatures (docs/DECISIONS.md VPS-43): helpers that the backup image's scripts source
# from /usr/local/share/menumesh/seal.sh (`. /usr/local/share/menumesh/seal.sh`); never run on its
# own. The backup signs what it writes with the Ed25519 key in BACKUP_SIGNING_KEY (base64 PKCS #8
# DER, the backup service's alone), and a restore checks each signature against
# BACKUP_SIGNING_PUBLIC_KEY (base64 SPKI DER): one key, or several separated by single spaces with
# the private key's own first, so that after a rotation the old key stays and the backups it
# signed still restore. The owner keeps that list beside the age key, in a file of its own (age
# reads the file of its key as keys and comments alone), where the bucket's token can't reach. age
# proves nothing about who encrypted a file: whoever holds the bucket's token and the age public
# key can encrypt one, but only the backup can sign one.
#
#   seal_sign <file>                 the signature of the file's bytes, base64url without padding
#                                    (86 characters), on stdout
#   seal_verify <file> <signature>   true when the signature is one of the file's bytes by any of
#                                    the public keys
#   seal_verify_first <file> <signature>
#                                    the same, with the first public key alone
#   seal_self_check                  signs a probe and checks it with the first public key: true
#                                    when the private key is the pair of what restores check
#   seal_b64url                      stdin as base64url without padding, on one line
#   seal_open <file> <night>         true when the file is that night's seal as backup.sh writes
#                                    one, signed by any of the public keys (below)
#   seal_part <name>                 "<sha256> <bytes>" of a part that seal lists, or nothing
#
# The private key reaches openssl as PEM text on file descriptor 3, from a here-document, which
# BusyBox ash hands over in a pipe: never in an argument or a file. Sourcing this file also takes
# the key out of the environment the sourcing script's children get (it stays a variable of that
# shell), so no other program it runs sees it. Ed25519 signs a message whole, so each message and
# signature is a file in a folder of its own under /tmp, removed at once; none holds a secret. A
# signature has one spelling: it is 64 bytes, and only the canonical base64url of them is taken.
# Ed25519's signatures are deterministic: the same bytes get the same signature every time. A
# failure prints one line naming what failed, never a value.

if [ -n "${BACKUP_SIGNING_KEY+set}" ]; then
  seal_key=$BACKUP_SIGNING_KEY
  unset BACKUP_SIGNING_KEY
  BACKUP_SIGNING_KEY=$seal_key
  unset seal_key
fi

# No set given to tr starts with "-", which it would take for an option.
seal_b64url() {
  base64 -w 0 | tr '/+' '_-' | tr -d '=\n'
  echo
}

# Whether BACKUP_SIGNING_KEY has the shape of an Ed25519 private key's PKCS #8 DER in base64: its
# fixed first 21 characters, then 43 more.
seal_private_key_ok() {
  case ${BACKUP_SIGNING_KEY-} in
    *[!A-Za-z0-9+/]*) return 1 ;;
    MC4CAQAwBQYDK2VwBCIEI*) [ "${#BACKUP_SIGNING_KEY}" -eq 64 ] ;;
    *) return 1 ;;
  esac
}

# Whether BACKUP_SIGNING_PUBLIC_KEY is one or more Ed25519 public keys' SPKI DER in base64 (each
# 60 characters, the first 16 fixed), separated by single spaces.
seal_public_keys_ok() {
  case ${BACKUP_SIGNING_PUBLIC_KEY-} in
    '' | ' '* | *' ' | *'  '* | *[!A-Za-z0-9+/=\ ]*) return 1 ;;
  esac
  seal_ifs=$IFS
  IFS=' '
  for seal_one in $BACKUP_SIGNING_PUBLIC_KEY; do
    case $seal_one in
      MCowBQYDK2VwAyEA*=) [ "${#seal_one}" -eq 60 ] || { IFS=$seal_ifs; return 1; } ;;
      *) IFS=$seal_ifs; return 1 ;;
    esac
  done
  IFS=$seal_ifs
}

seal_sign() {
  if ! seal_private_key_ok; then
    echo 'seal: BACKUP_SIGNING_KEY is not an Ed25519 private key (base64 PKCS #8 DER)' >&2
    return 1
  fi
  [ -f "${1-}" ] || { echo "seal: no file ${1-} to sign" >&2; return 1; }
  seal_sign_dir=$(mktemp -d /tmp/seal.XXXXXX) || return 1
  if openssl pkeyutl -sign -rawin -inkey /dev/fd/3 -in "$1" -out "$seal_sign_dir/signature" 3<<EOF; then
-----BEGIN PRIVATE KEY-----
$BACKUP_SIGNING_KEY
-----END PRIVATE KEY-----
EOF
    if [ "$(($(wc -c <"$seal_sign_dir/signature")))" -eq 64 ]; then
      seal_b64url <"$seal_sign_dir/signature"
      rm -rf "$seal_sign_dir"
      return 0
    fi
  fi
  rm -rf "$seal_sign_dir"
  echo "seal: openssl could not sign ${1##*/}" >&2
  return 1
}

# seal_check <signature> <file> <first | all>: the signature's 64 bytes into a file, then openssl
# with each key, or the first alone, until one verifies.
seal_check() {
  case ${1-} in *[!A-Za-z0-9_-]* | '') return 1 ;; esac
  [ "${#1}" -eq 86 ] && [ -f "${2-}" ] && seal_public_keys_ok || return 1
  seal_check_dir=$(mktemp -d /tmp/seal.XXXXXX) || return 1
  seal_found=1
  if printf '%s==\n' "$1" | tr '_-' '/+' | base64 -d >"$seal_check_dir/signature" 2>/dev/null &&
    [ "$(($(wc -c <"$seal_check_dir/signature")))" -eq 64 ] &&
    [ "$(seal_b64url <"$seal_check_dir/signature")" = "$1" ]; then
    seal_ifs=$IFS
    IFS=' '
    for seal_one in $BACKUP_SIGNING_PUBLIC_KEY; do
      if openssl pkeyutl -verify -rawin -pubin -inkey /dev/fd/3 -in "$2" \
        -sigfile "$seal_check_dir/signature" >/dev/null 2>&1 3<<EOF; then
-----BEGIN PUBLIC KEY-----
$seal_one
-----END PUBLIC KEY-----
EOF
        seal_found=0
        break
      fi
      [ "$3" = all ] || break
    done
    IFS=$seal_ifs
  fi
  rm -rf "$seal_check_dir"
  return "$seal_found"
}

seal_verify() {
  seal_check "${2-}" "${1-}" all
}

seal_verify_first() {
  seal_check "${2-}" "${1-}" first
}

seal_self_check() {
  seal_probe_dir=$(mktemp -d /tmp/seal.XXXXXX) || return 1
  printf 'menumesh seal probe %s\n' "$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')" \
    >"$seal_probe_dir/probe"
  if seal_probe=$(seal_sign "$seal_probe_dir/probe") &&
    seal_verify_first "$seal_probe_dir/probe" "$seal_probe"; then
    rm -rf "$seal_probe_dir"
    return 0
  fi
  rm -rf "$seal_probe_dir"
  return 1
}

# A night's seal (docs/DECISIONS.md VPS-43), seal-<night>.txt, the last object backup.sh uploads
# for a night, in plain text: the night, where its base backup starts, and the sha256 and size of
# each part as it went up, then the signature of every line above it, each line ending in a
# newline:
#
#   menumesh seal 1 <night>
#   base <end time, UTC> <start walfile> <system identifier>      or "base none"
#   part <sha256> <bytes> <name>                                  one line a part
#   signature <base64url Ed25519 signature of the lines above>
#
# The base line gives a time no earlier than the end of the night's base backup
# (2026-11-14T20:33:07Z), the WAL file the base starts in, from which a point-in-time recovery
# replays the cluster's WAL, and the cluster's system identifier, unsigned, as wal-ship.sh names
# its folder; "base none" when the night's base backup failed, and then no base part is listed.
# Each part is one of the night's names, ending in its id. No seal is longer than seal_max bytes,
# which a reader fetches one byte past, so a longer object shows as one.
seal_max=16384

# seal_open <file> <night>: true when the file is the seal of that night as backup.sh writes one,
# signed by any of BACKUP_SIGNING_PUBLIC_KEY's keys: only printable ASCII and newlines, only the
# lines above, each in its one spelling, no part twice. Then seal_base holds the base line's fields
# ("none", or "<end time> <start walfile> <system identifier>") and seal_parts the parts, one
# "<sha256> <bytes> <name>" a line. Else both are empty and seal_problem says, in a few words that
# hold no text of the file, what is wrong with it. The night's id must be checked whole by the
# caller: it is matched as given.
# shellcheck disable=SC2034 # seal_base and seal_problem: read by the scripts that source this file
seal_open() {
  seal_base=
  seal_parts=
  seal_problem=
  if [ ! -f "${1-}" ]; then
    seal_problem='is not there'
    return 1
  fi
  seal_size=$(($(wc -c <"$1")))
  if [ "$seal_size" -eq 0 ]; then
    seal_problem='is empty'
    return 1
  fi
  if [ "$seal_size" -gt "$seal_max" ]; then
    seal_problem="is longer than a seal's $seal_max bytes"
    return 1
  fi
  # A byte that is no printable ASCII or newline (a NUL among them, which awk would not see), or a
  # last line without its newline.
  if [ "$(LC_ALL=C tr -d '\n -~' <"$1" | wc -c)" -ne 0 ] ||
    [ "$(tail -c 1 "$1" | od -An -tx1 | tr -d ' \n')" != 0a ]; then
    seal_problem='holds a byte that is not printable ASCII, or does not end in a newline'
    return 1
  fi
  seal_read=$(LC_ALL=C awk -v night="${2-}" '
    # Whether a name is one of the night'"'"'s parts: a database'"'"'s dump is <db>-<night>.dump.age,
    # with <db> a plain name, as the manifest gives it.
    function part(name, suffix, db) {
      if (name == "globals-" night ".sql.age" || name == "storage-" night ".tar.age" ||
        name == "manifest-" night ".txt.age" || name == "config-" night ".tar.age" ||
        name == "base-" night ".tar.zst.age") return 1
      suffix = "-" night ".dump.age"
      if (length(name) <= length(suffix) || substr(name, length(name) - length(suffix) + 1) != suffix) return 0
      db = substr(name, 1, length(name) - length(suffix))
      return db ~ /^[a-z_][a-z0-9_]*$/ && length(db) < 64 && db !~ /^template[01]$/
    }
    { line[NR] = $0 }
    END {
      if (NR < 4) { print "problem has fewer lines than a seal"; exit }
      if (line[1] != "menumesh seal 1 " night) { print "problem does not begin with the line \"menumesh seal 1 " night "\""; exit }
      n = split(line[2], f, " ")
      if (line[2] == "base none") base = "none"
      else if (n == 4 && line[2] == "base " f[2] " " f[3] " " f[4] &&
        f[2] ~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/ &&
        f[3] ~ /^[0-9A-F]{24}$/ && f[4] ~ /^[1-9][0-9]{0,19}$/) base = f[2] " " f[3] " " f[4]
      else { print "problem has no base line as a backup writes one"; exit }
      for (i = 3; i < NR; i++) {
        n = split(line[i], f, " ")
        if (n != 4 || line[i] != "part " f[2] " " f[3] " " f[4] || f[2] !~ /^[0-9a-f]{64}$/ ||
          f[3] !~ /^[1-9][0-9]{0,14}$/ || !part(f[4])) { print "problem has a line " i " that is not a part as a backup lists one"; exit }
        if (seen[f[4]]++) { print "problem lists a part twice"; exit }
        if (f[4] == "base-" night ".tar.zst.age") based = 1
        parts = parts f[2] " " f[3] " " f[4] "\n"
      }
      if ((base == "none") == based) { print "problem has a base line that its parts do not match"; exit }
      n = split(line[NR], f, " ")
      if (n != 2 || line[NR] != "signature " f[2] || f[2] !~ /^[A-Za-z0-9_-]{86}$/) { print "problem does not end in a signature line"; exit }
      printf "base %s\n%ssignature %s\n", base, parts, f[2]
    }' "$1") || seal_read='problem could not be read'
  case $seal_read in
    'base '*) ;;
    'problem '*)
      seal_problem=${seal_read#problem }
      return 1
      ;;
    *)
      seal_problem='could not be read'
      return 1
      ;;
  esac
  # The signature, of every byte before its line.
  seal_open_dir=$(mktemp -d /tmp/seal.XXXXXX) || { seal_problem='could not be checked'; return 1; }
  if sed '$d' "$1" >"$seal_open_dir/body" &&
    seal_verify "$seal_open_dir/body" "$(printf '%s\n' "$seal_read" | sed -n 's/^signature //p')"; then
    rm -rf "$seal_open_dir"
    seal_base=$(printf '%s\n' "$seal_read" | sed -n '1s/^base //p')
    seal_parts=$(printf '%s\n' "$seal_read" | sed '1d;$d')
    return 0
  fi
  rm -rf "$seal_open_dir"
  seal_problem="is signed by none of BACKUP_SIGNING_PUBLIC_KEY's keys"
  return 1
}

# seal_part <name>: "<sha256> <bytes>" of a part the seal seal_open read lists; nothing when it
# lists no part of that name.
seal_part() {
  printf '%s\n' "$seal_parts" | awk -v name="${1-}" '$3 == name { print $1 " " $2 }'
}
