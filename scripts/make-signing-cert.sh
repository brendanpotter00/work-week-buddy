#!/usr/bin/env bash
# Creates a self-signed code-signing certificate with a STABLE designated
# requirement, so TCC grants survive rebuilds — docs/IMPL_LAYOUT.md §9.
#
# Why this exists at all: macOS binds an Input Monitoring / Accessibility grant
# to (bundle id + designated requirement + on-disk path). The bundle that comes
# out of `npm run package` carries only Electron's own ad-hoc, linker-signed
# signature (`identity: null` in electron-builder.yml means "skip signing", not
# "sign ad-hoc"), and an ad-hoc signature has no stable identity — so every
# rebuild looks like a different app and every rebuild re-prompts. One leaf
# certificate, reused forever, is what makes the grant stick.
#
# Run ONCE, on the first Mac. On the second Mac, import the SAME wwb.p12 —
# a second, locally generated certificate has a different public key and
# therefore a different designated requirement, and grants do not transfer.
#
# Safe to run twice: if the identity is already in the keychain it exits 0
# without touching anything, and if wwb.p12 already exists it re-imports that
# file rather than minting a new leaf.
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
  --show            print the existing identity and its fingerprint, then exit
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

identity_present() {
  security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "$NAME"
}

print_identity() {
  security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null | grep "$NAME" || true
}

printf "\033[1mWork Week Buddy — signing certificate\033[0m\n"
info "openssl: $OPENSSL ($OPENSSL_VERSION${LEGACY:+, using $LEGACY})"
info "keychain: $KEYCHAIN"

if [ "$SHOW_ONLY" = "1" ]; then
  if identity_present; then
    ok "identity present"
    print_identity
    info "Compare this SHA-1 with the other Mac. They MUST match, or the two"
    info "machines have different designated requirements and grants will not"
    info "transfer between them."
    exit 0
  fi
  warn "no '$NAME' identity in $KEYCHAIN"
  # Present-but-untrusted is a completely different problem from absent, and it
  # is the likely one. Say which.
  if security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "$NAME"; then
    bad "it IS in the keychain but is not trusted (CSSMERR_TP_NOT_TRUSTED)."
    info "Open Keychain Access, find '$NAME', and set it to Always Trust."
  fi
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
  hdr "dry run — nothing was created, imported, or trusted"
  exit 0
fi

hdr "3. Trust it — this is a REQUIRED step, not a tidy-up"
# Measured, not assumed. Straight after import the identity is in the keychain
# and unusable, and nothing in the failure says the word "trust":
#
#   security find-identity -v -p codesigning   →  0 valid identities found
#   security find-identity    -p codesigning   →  1) … "WWB Local Signing"
#                                                     (CSSMERR_TP_NOT_TRUSTED)
#   codesign --sign "WWB Local Signing" …      →  "no identity found"
#
# install.sh's precondition check is that first command, so the install refuses
# to start until this is done rather than dying three minutes in at codesign.
if identity_present; then
  ok "imported AND trusted"
  print_identity
else
  warn "imported, but not yet usable — it is not trusted."
  info "1. Open Keychain Access (⌘-space, 'Keychain Access')."
  info "2. Find '$NAME'. Double-click it, open Trust, and set"
  info "   'When using this certificate' to Always Trust. Close the window;"
  info "   macOS will ask for your login password."
  info "3. Re-check with: ./scripts/make-signing-cert.sh --show"
  info "   It must print '1 valid identities found' before install.sh will run."
fi

hdr "4. And copy the archive to the other Mac"
info "Put $DIR/wwb.p12 into 1Password and import THE SAME FILE on the"
info "other Mac. Both Macs must share one leaf certificate, or their designated"
info "requirements differ and the grants do not transfer."
printf "\n"
warn "Losing wwb.p12 means re-granting Input Monitoring and Accessibility on both machines."
