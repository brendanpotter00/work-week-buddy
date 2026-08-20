#!/usr/bin/env bash
# Creates a self-signed code-signing certificate with a STABLE designated
# requirement, so TCC grants survive rebuilds — docs/IMPL_LAYOUT.md §9.
#
# Why this exists at all: macOS binds an Input Monitoring / Accessibility grant
# to (bundle id + designated requirement + on-disk path). An ad-hoc signature
# ("identity: null" in electron-builder.yml) has no stable identity, so every
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
DRY_RUN=0

usage() {
  cat <<USAGE
usage: scripts/make-signing-cert.sh [--dir DIR] [--dry-run] [--show]

  --dir DIR    where to keep key.pem / cert.pem / wwb.p12 (default ~/.wwb-signing)
  --dry-run    print what would happen; create and import nothing
  --show       print the existing identity and its fingerprint, then exit
USAGE
}

SHOW_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:?--dir needs a path}"; shift 2 ;;
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
hdr()  { printf "\n\033[1m%s\033[0m\n" "$1"; }

# Every mutating command goes through this, so --dry-run cannot change the
# machine even by accident.
run() {
  if [ "$DRY_RUN" = "1" ]; then printf "  + %s\n" "$*"; return 0; fi
  "$@"
}

identity_present() {
  security find-identity -v -p codesigning 2>/dev/null | grep -q "$NAME"
}

print_identity() {
  security find-identity -v -p codesigning 2>/dev/null | grep "$NAME" || true
}

printf "\033[1mWork Week Buddy — signing certificate\033[0m\n"

if [ "$SHOW_ONLY" = "1" ]; then
  if identity_present; then
    ok "identity present"
    print_identity
    info "Compare this SHA-1 with the other Mac. They MUST match, or the two"
    info "machines have different designated requirements and grants will not"
    info "transfer between them."
    exit 0
  fi
  warn "no '$NAME' identity in the login keychain"
  exit 1
fi

# ── idempotency gate ────────────────────────────────────────────────────────
if identity_present; then
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
else
  info "no wwb.p12 yet — minting a new leaf certificate"
  if [ "$DRY_RUN" = "1" ]; then
    printf "  + write %s\n" "$DIR/openssl.cnf"
  else
    cat > "$DIR/openssl.cnf" <<'CNF'
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = WWB Local Signing
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF
  fi

  # 7300 days ≈ 20 years. An expired leaf means re-signing with a NEW leaf,
  # which means re-granting both permissions on both Macs.
  run openssl req -x509 -newkey rsa:2048 -nodes -days 7300 \
    -keyout "$DIR/key.pem" -out "$DIR/cert.pem" -config "$DIR/openssl.cnf"

  # -legacy is REQUIRED: OpenSSL 3 defaults to AES-256-CBC + PBKDF2 for PKCS#12,
  # which Security.framework cannot read. Without it `security import` fails with
  # a misleading "MAC verification failed" / "unable to read" error that looks
  # like a wrong password rather than a wrong algorithm.
  run openssl pkcs12 -export -legacy -inkey "$DIR/key.pem" -in "$DIR/cert.pem" \
    -name "$NAME" -out "$DIR/wwb.p12" -passout pass:
  [ "$DRY_RUN" = "1" ] || ok "created $DIR/wwb.p12"
fi

hdr "2. Import into the login keychain"
# -T /usr/bin/codesign pre-authorises codesign so install.sh does not stop on a
# keychain prompt halfway through every build.
run security import "$DIR/wwb.p12" -k "$HOME/Library/Keychains/login.keychain-db" \
  -T /usr/bin/codesign -P ""

if [ "$DRY_RUN" = "1" ]; then
  hdr "dry run — nothing was created, imported, or trusted"
  exit 0
fi

if identity_present; then
  ok "imported"
  print_identity
else
  warn "import ran but '$NAME' is still not listed as a codesigning identity."
  warn "It is usually the trust setting below — do step 1 and re-check with --show."
fi

hdr "3. Two steps that cannot be scripted"
info "1. Open Keychain Access, find '$NAME', and set it to Always Trust."
info "   (security add-trusted-cert needs an admin prompt and a settings file;"
info "   doing it by hand once is less fragile than automating it badly.)"
info "2. Copy $DIR/wwb.p12 into 1Password and import THE SAME FILE on the"
info "   other Mac. Both Macs must share one leaf certificate, or their"
info "   designated requirements differ and the grants do not transfer."
printf "\n"
warn "Losing wwb.p12 means re-granting Input Monitoring and Accessibility on both machines."
