#!/usr/bin/env bash
# A stand-in for `npx wrangler`, so scripts/bringup-cloud.sh can be executed
# end to end without a Cloudflare account.
#
# It is NOT a mock of wrangler's behaviour in general. It answers the five
# commands bring-up actually issues, in the shapes wrangler 4 actually returns
# them — `d1 list --json` is an array of {uuid,name}, `secret list --format
# json` is an array of {name,type} — and it appends every invocation to
# $FAKE_WRANGLER_LOG so the test can assert what was run and in what order.
#
# State lives in $FAKE_WRANGLER_STATE:
#   dbs        one "<uuid> <name>" per line
#   secrets    one name per line
#   secret.<NAME>  the value that was piped in, so a test can prove the token
#                  that was printed is the token that was set.
#
# Knobs:
#   FAKE_WRANGLER_LOGGED_IN=0   whoami reports logged out
set -euo pipefail

STATE="${FAKE_WRANGLER_STATE:?fake-wrangler needs FAKE_WRANGLER_STATE}"
mkdir -p "$STATE"
: > "$STATE/.touch"

if [ -n "${FAKE_WRANGLER_LOG:-}" ]; then
  printf '%s\n' "$*" >> "$FAKE_WRANGLER_LOG"
fi

case "$1${2:-}" in
  whoami)
    if [ "${FAKE_WRANGLER_LOGGED_IN:-1}" = "1" ]; then
      printf 'Getting User settings...\nYou are logged in with an OAuth Token, associated with the email fake@example.com.\n'
      exit 0
    fi
    printf 'You are not authenticated. Please run `wrangler login`.\n'
    exit 1
    ;;
esac

case "${1:-} ${2:-}" in
  "d1 list")
    printf '['
    first=1
    if [ -f "$STATE/dbs" ]; then
      while read -r uuid name; do
        [ -n "$uuid" ] || continue
        [ "$first" = 1 ] || printf ','
        printf '{"uuid":"%s","name":"%s","version":"production"}' "$uuid" "$name"
        first=0
      done < "$STATE/dbs"
    fi
    printf ']\n'
    ;;

  "d1 create")
    name="$3"
    if [ -f "$STATE/dbs" ] && grep -q " ${name}$" "$STATE/dbs"; then
      printf 'A database with that name already exists.\n' >&2
      exit 1
    fi
    printf '11111111-2222-3333-4444-555555555555 %s\n' "$name" >> "$STATE/dbs"
    printf 'Created your new D1 database.\n'
    ;;

  "d1 execute")
    printf 'Executed against %s\n' "$3"
    ;;

  "secret list")
    printf '['
    first=1
    if [ -f "$STATE/secrets" ]; then
      while read -r n; do
        [ -n "$n" ] || continue
        [ "$first" = 1 ] || printf ','
        printf '{"name":"%s","type":"secret_text"}' "$n"
        first=0
      done < "$STATE/secrets"
    fi
    printf ']\n'
    ;;

  "secret put")
    name="$3"
    cat > "$STATE/secret.$name"
    grep -qx "$name" "$STATE/secrets" 2>/dev/null || printf '%s\n' "$name" >> "$STATE/secrets"
    printf 'Uploaded secret %s\n' "$name"
    ;;

  "deploy "*|"deploy")
    printf 'Total Upload: 12.34 KiB / gzip: 4.56 KiB\n'
    printf 'Deployed wwb-sync triggers (0.51 sec)\n'
    printf '  https://wwb-sync.fake-account.workers.dev\n'
    printf 'Current Version ID: 00000000-0000-0000-0000-000000000000\n'
    ;;

  *)
    printf 'fake-wrangler: unhandled command: %s\n' "$*" >&2
    exit 64
    ;;
esac
