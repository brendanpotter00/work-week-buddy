#!/usr/bin/env bash
# Creates a self-signed code-signing certificate with a STABLE designated
# requirement, so TCC grants survive rebuilds — docs/IMPL_LAYOUT.md §9.
#
# Why this exists at all: macOS binds an Input Monitoring / Accessibility grant
# to (bundle id + designated requirement + on-disk path). The bundle that comes
# out of `npm run package` carries only Electron's own ad-hoc, linker-signed
# signature (`identity: null` in electron-builder.yml means "skip signing", not
# "sign ad-hoc"), and an ad-hoc signature's designated requirement is literally
# the cdhash of that one build — so every rebuild looks like a different app and
# every rebuild re-prompts. One leaf certificate, reused forever, is what makes
# the grant stick.
#
# Run ONCE, on the first Mac. On the second Mac, import the SAME wwb.p12 —
# a second, locally generated certificate has a different public key and
# therefore a different designated requirement, and grants do not transfer.
#
# Safe to run twice: if the identity is already in the keychain it exits 0
# without touching anything, and if wwb.p12 already exists it re-imports that
# file rather than minting a new leaf.
#
# ── There is NO "Always Trust" step, and there never needed to be. ──────────
# This script used to end by telling you to open Keychain Access and set the
# certificate to Always Trust, and install.sh refused to run until you had.
# That was wrong, and it was the single most confusing thing in the whole
# bring-up. Measured on macOS 26, with the leaf explicitly UNTRUSTED
# (`security find-identity -p codesigning` annotating it CSSMERR_TP_NOT_TRUSTED):
#
#   codesign --force --sign <sha1> app     →  succeeds
#   codesign --force --sign "<CN>"  app    →  succeeds
#   codesign -d -r- app                    →  designated =>
#                                               identifier "…" and
#                                               certificate leaf = H"<sha1>"
#   codesign --verify -R <that req> app'   →  explicit requirement satisfied
#                                             (on a REBUILT app with a new cdhash)
#   SecCodeCheckValidity(live pid, req)    →  errSecSuccess
#
# That last line is the one that matters: it is the exact call tccd makes
# against a client process, and it passes. Trust settings govern CHAIN
# VALIDATION — Gatekeeper, `spctl`, `find-identity -v`. The designated
# requirement above pins the leaf by hash and names no anchor, so no chain is
# ever built and trust is never consulted. Gatekeeper is not in the picture
# either: a locally built bundle carries no com.apple.quarantine attribute, so
# it is never assessed (`spctl` "rejects" the ad-hoc bundle that runs fine
# today, which is the proof).
#
# What DID depend on trust was this repo's own precondition check:
# `security find-identity -v` filters out anything whose chain does not
# validate, so a perfectly usable identity was reported as "0 valid identities
# found" and install.sh stopped. The check is now "sign something and read the
# requirement back", which tests the operation we actually care about instead of
# a proxy for it.
set -euo pipefail

NAME="WWB Local Signing"
DIR="${HOME}/.wwb-signing"
KEYCHAIN="${HOME}/Library/Keychains/login.keychain-db"
OPENSSL=""

# ── Why this passphrase is in a public repo, in plaintext. ──────────────────
# It is NOT a secret and there is no version of it that could be one.
#
#   * `security import -P ""` FAILS. A .p12 exported with `-passout pass:` is
#     rejected by Security.framework with "MAC verification failed during PKCS12
#     import (wrong password?)" — with and without -legacy, and with any
#     -macalg. The error names the password and means the empty one. So the
#     export password has to be non-empty, and something has to know it.
#   * What the .p12 protects is a self-signed leaf that signs local builds on
#     two Macs. It confers nothing anywhere else — no Apple account, no
#     distribution, no trust that anyone but its owner grants by hand.
#   * The file itself is the secret, and it travels through 1Password. A
#     passphrase the second Mac has to be told out of band would only mean one
#     more thing to lose, for no property gained.
#
# Override with --p12-pass if you are importing an archive made with a
# different one.
P12_PASS="work-week-buddy"

DRY_RUN=0
SHOW_ONLY=0
DO_IMPORT=1
PRINT_HASH=0

usage() {
  cat <<USAGE
usage: scripts/make-signing-cert.sh [options]

  --dir DIR         where to keep key.pem / cert.pem / wwb.p12 (default ~/.wwb-signing)
  --name NAME       common name of the leaf (default "WWB Local Signing")
  --keychain PATH   keychain to import into (default the login keychain)
  --openssl PATH    openssl to use (default: resolved from PATH, see below)
  --p12-pass PASS   PKCS#12 passphrase (default "work-week-buddy"; must be non-empty)
  --no-import       create the key material only; do not touch any keychain
  --dry-run         print what would happen; create and import nothing
  --show            print the existing identity, its fingerprint, and proof that
                    it can sign; exit non-zero if it cannot
  --print-hash      print just the SHA-1 of the identity and exit (for scripts)
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:?--dir needs a path}"; shift 2 ;;
    --name) NAME="${2:?--name needs a value}"; shift 2 ;;
    --keychain) KEYCHAIN="${2:?--keychain needs a path}"; shift 2 ;;
    --openssl) OPENSSL="${2:?--openssl needs a path}"; shift 2 ;;
    # `${2?…}` not `${2:?…}`: an EMPTY value must reach the check below, which
    # explains why it cannot be empty, rather than dying on a bash message.
    --p12-pass) P12_PASS="${2?--p12-pass needs a value}"; shift 2 ;;
    --no-import) DO_IMPORT=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --show) SHOW_ONLY=1; shift ;;
    --print-hash) PRINT_HASH=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) printf 'unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
    # Positional dir, kept because docs/IMPL_LAYOUT.md §9 documents `$1`.
    *) DIR="$1"; shift ;;
  esac
done

ok()   { printf "  \033[32m✓\033[0m  %s\n" "$1"; }
info() { printf "     %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m  %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m  %s\n" "$1"; }
hdr()  { printf "\n\033[1m%s\033[0m\n" "$1"; }
die()  { bad "$1"; exit 1; }

# Every mutating command goes through this, so --dry-run cannot change the
# machine even by accident.
run() {
  if [ "$DRY_RUN" = "1" ]; then printf "  + %s\n" "$*"; return 0; fi
  "$@"
}

[ -n "$P12_PASS" ] || die "--p12-pass may not be empty: security import rejects an empty-password .p12."

# ── which openssl, and does it want -legacy ─────────────────────────────────
# OpenSSL 3 defaults to AES-256-CBC + PBKDF2 for PKCS#12, which
# Security.framework cannot read, so it needs -legacy. macOS's own
# /usr/bin/openssl is LibreSSL, already emits legacy algorithms, and REJECTS the
# flag ("unknown option '-legacy'") — so hard-coding it breaks the script on any
# Mac without Homebrew's openssl ahead of it on PATH. Branch on the version
# string rather than guessing from the path.
resolve_openssl() {
  if [ -n "$OPENSSL" ]; then
    command -v "$OPENSSL" >/dev/null 2>&1 || die "no openssl at $OPENSSL"
    return
  fi
  OPENSSL="$(command -v openssl || true)"
  [ -n "$OPENSSL" ] || OPENSSL=/usr/bin/openssl
  [ -x "$OPENSSL" ] || die "no openssl on PATH and none at /usr/bin/openssl"
}
resolve_openssl

OPENSSL_VERSION="$("$OPENSSL" version 2>/dev/null || echo unknown)"
# A plain string, not an array: macOS ships bash 3.2, where expanding an empty
# array under `set -u` is itself an "unbound variable" error.
LEGACY=""
case "$OPENSSL_VERSION" in
  "OpenSSL 3."*|"OpenSSL 4."*) LEGACY="-legacy" ;;
esac

# ── finding the identity ────────────────────────────────────────────────────
# NOT `find-identity -v`. The -v flag means "valid", and valid means "the chain
# validates" — which a self-signed leaf's never will unless someone marks it
# Always Trust by hand. codesign does not care (see the header), so neither does
# this. `find-identity` without -v lists every certificate that has a matching
# PRIVATE KEY in the keychain, which is the actual definition of an identity and
# the only thing signing needs.
identity_hash() {
  security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null \
    | awk -v want="$NAME" '
        index($0, want) == 0 { next }
        { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9A-Fa-f]{40}$/) { print $i; exit } }
      '
}

identity_present() {
  [ -n "$(identity_hash)" ]
}

print_identity() {
  security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep "$NAME" || true
}

# ── the proof ───────────────────────────────────────────────────────────────
# The honest question is never "is this certificate trusted" — it is "can
# codesign sign with it, and does the signature carry the stable requirement
# TCC will remember". So ask exactly that: sign a throwaway Mach-O and read the
# designated requirement back out. A copy of /usr/bin/true is used because it is
# a real Mach-O that exists on every Mac; codesign happily re-signs a copy.
#
# Echoes the requirement on success so both Macs can be compared: it is the
# string TCC stores, and if the two differ the grants cannot transfer.
proves_it_can_sign() {
  hash="$1"
  probe_dir="$(mktemp -d)"
  # shellcheck disable=SC2064 -- expand probe_dir NOW; it is about to go away.
  trap "rm -rf '$probe_dir'" RETURN
  cp /usr/bin/true "$probe_dir/probe" 2>/dev/null || return 1
  set -- --force --timestamp=none --sign "$hash"
  if [ "$KEYCHAIN" != "${HOME}/Library/Keychains/login.keychain-db" ]; then
    set -- "$@" --keychain "$KEYCHAIN"
  fi
  codesign "$@" "$probe_dir/probe" >/dev/null 2>&1 || return 1
  PROVEN_REQUIREMENT="$(codesign -d -r- "$probe_dir/probe" 2>/dev/null \
    | sed -n 's/^designated => //p')"
  case "$PROVEN_REQUIREMENT" in
    *"certificate leaf = H\"$(printf '%s' "$hash" | tr '[:upper:]' '[:lower:]')\""*) return 0 ;;
    *) return 1 ;;
  esac
}
PROVEN_REQUIREMENT=""

# ── --print-hash: one line, for install.sh ──────────────────────────────────
if [ "$PRINT_HASH" = "1" ]; then
  h="$(identity_hash)"
  [ -n "$h" ] || exit 1
  printf '%s\n' "$h"
  exit 0
fi

printf "\033[1mWork Week Buddy — signing certificate\033[0m\n"
info "openssl: $OPENSSL ($OPENSSL_VERSION${LEGACY:+, using $LEGACY})"
info "keychain: $KEYCHAIN"

# ── --show: say ONE true thing ──────────────────────────────────────────────
# This used to print "no 'WWB Local Signing' identity" and then, on the very
# next line, "it IS in the keychain but is not trusted" — two contradictory
# claims, neither of which was the thing the reader needed. There are exactly
# three states and each gets one answer.
if [ "$SHOW_ONLY" = "1" ]; then
  HASH="$(identity_hash)"
  if [ -z "$HASH" ]; then
    bad "no '$NAME' identity in $KEYCHAIN."
    info "Run ./scripts/make-signing-cert.sh to create and import one."
    info "On the SECOND Mac, put the first Mac's ~/.wwb-signing/wwb.p12 in place"
    info "first — a freshly minted leaf has a different designated requirement"
    info "and its grants do not transfer."
    exit 1
  fi
  if proves_it_can_sign "$HASH"; then
    ok "identity present and able to sign: $NAME"
    info "SHA-1: $HASH"
    printf "\n"
    info "COMPARE THAT SHA-1 WITH THE OTHER MAC. It is the half of the app's"
    info "designated requirement that identifies the signer, so if the two"
    info "differ the machines have different identities and grants do not"
    info "transfer. The other half is the app's bundle id, which never varies."
    printf "\n"
    info "Proof it signs (a throwaway binary, hence the 'probe' identifier):"
    info "  $PROVEN_REQUIREMENT"
    printf "\n"
    info "Untrusted in Keychain Access is FINE and expected. Trust governs chain"
    info "validation (Gatekeeper, 'find-identity -v'); the requirement above"
    info "pins the leaf by hash and names no anchor, so no chain is ever built."
    exit 0
  fi
  bad "'$NAME' is in $KEYCHAIN but codesign cannot sign with it."
  print_identity
  info "This is NOT a trust problem — trust is not required and never was."
  info "There are exactly two causes, and Always Trust fixes neither:"
  info "  1. $KEYCHAIN is not in the keychain search list, so codesign cannot"
  info "     see it at all. --keychain says which keychain to PREFER, not where"
  info "     codesign may look. Check: security list-keychains -d user"
  info "  2. the .p12 was imported without its private key. Delete the"
  info "     certificate in Keychain Access and re-run this script."
  exit 1
fi

# ── idempotency gate ────────────────────────────────────────────────────────
if [ "$DO_IMPORT" = "1" ] && identity_present; then
  ok "Already present: $NAME"
  print_identity
  info "Nothing to do. To start over, delete the identity in Keychain Access first."
  exit 0
fi

hdr "1. Key material"
run mkdir -p "$DIR"
if [ "$DRY_RUN" != "1" ]; then chmod 700 "$DIR"; fi

if [ -f "$DIR/wwb.p12" ]; then
  # The identity is missing from the keychain but the archive is here: this is
  # the second Mac, or a re-imaged first Mac. Re-import the SAME leaf. Minting
  # a fresh one here is the single most expensive mistake in this script — it
  # silently invalidates every existing grant on the other machine.
  ok "reusing existing $DIR/wwb.p12 (same leaf ⇒ same designated requirement)"
  # Read it back before handing it to `security`, which reports every failure as
  # the same "MAC verification failed" line whatever the real cause is.
  if [ "$DRY_RUN" != "1" ]; then
    # shellcheck disable=SC2086 -- $LEGACY is one flag or nothing at all.
    "$OPENSSL" pkcs12 -in "$DIR/wwb.p12" $LEGACY -nokeys -passin "pass:${P12_PASS}" \
      >/dev/null 2>&1 || die "cannot open $DIR/wwb.p12 with the configured passphrase — pass --p12-pass."
  fi
else
  info "no wwb.p12 yet — minting a new leaf certificate"
  if [ "$DRY_RUN" = "1" ]; then
    printf "  + write %s\n" "$DIR/openssl.cnf"
  else
    cat > "$DIR/openssl.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = ${NAME}
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF
  fi

  # 7300 days ≈ 20 years. An expired leaf means re-signing with a NEW leaf,
  # which means re-granting both permissions on both Macs.
  run "$OPENSSL" req -x509 -newkey rsa:2048 -nodes -days 7300 \
    -keyout "$DIR/key.pem" -out "$DIR/cert.pem" -config "$DIR/openssl.cnf"

  # shellcheck disable=SC2086 -- $LEGACY is one flag or nothing at all.
  run "$OPENSSL" pkcs12 -export $LEGACY -inkey "$DIR/key.pem" -in "$DIR/cert.pem" \
    -name "$NAME" -out "$DIR/wwb.p12" -passout "pass:${P12_PASS}"
  [ "$DRY_RUN" = "1" ] || ok "created $DIR/wwb.p12"
fi

if [ "$DO_IMPORT" != "1" ]; then
  hdr "Key material only (--no-import)"
  info "Nothing was imported into any keychain."
  exit 0
fi

hdr "2. Import into the keychain"
# -T /usr/bin/codesign pre-authorises codesign so install.sh does not stop on a
# keychain prompt halfway through every build.
run security import "$DIR/wwb.p12" -k "$KEYCHAIN" -T /usr/bin/codesign -P "$P12_PASS"

if [ "$DRY_RUN" = "1" ]; then
  hdr "dry run — nothing was created or imported"
  exit 0
fi

hdr "3. Prove it can sign"
# Not "trust it". Signing a throwaway binary and reading the requirement back is
# the whole acceptance test, and it is what install.sh gates on too.
HASH="$(identity_hash)"
if [ -z "$HASH" ]; then
  die "import reported success but no '$NAME' identity is in $KEYCHAIN."
fi
if proves_it_can_sign "$HASH"; then
  ok "signed a test binary with $NAME"
  info "SHA-1: $HASH"
  info "requirement: $PROVEN_REQUIREMENT"
  printf "\n"
  info "That requirement names the certificate and the bundle id, and nothing"
  info "about the build — so it is identical for every future rebuild, which is"
  info "exactly why the grants stick. Keychain Access will show this certificate"
  info "as untrusted; that is expected and changes nothing here."
else
  bad "imported, but codesign cannot sign with it."
  print_identity
  info "Not a trust problem. Either $KEYCHAIN is outside the keychain search"
  info "list (check: security list-keychains -d user), or the private key did"
  info "not come across — for that, delete the certificate in Keychain Access"
  info "and run this script again."
  exit 1
fi

hdr "4. And copy the archive to the other Mac"
info "Put $DIR/wwb.p12 into 1Password and import THE SAME FILE on the"
info "other Mac. Both Macs must share one leaf certificate, or their designated"
info "requirements differ and the grants do not transfer."
printf "\n"
warn "Losing wwb.p12 means re-granting Input Monitoring and Accessibility on both machines."
