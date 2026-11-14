#!/bin/sh
# MenuMesh's signatures (docs/DECISIONS.md VPS-43): helpers that the backup image's scripts source
# from /usr/local/share/menumesh/seal.sh (`. /usr/local/share/menumesh/seal.sh`); never run on its
# own. The backup signs what it writes with the Ed25519 key in BACKUP_SIGNING_KEY (base64 PKCS #8
# DER, the backup service's alone), and a restore checks each signature against
# BACKUP_SIGNING_PUBLIC_KEY (base64 SPKI DER): one key, or several separated by single spaces with
# the private key's own first, so that after a rotation the old key stays and the backups it
# signed still restore. The owner keeps the public key with the age key, where the bucket's token
# can't reach. age proves nothing about who encrypted a file: whoever holds the bucket's token and
# the age public key can encrypt one, but only the backup can sign one.
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
