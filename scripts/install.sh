#!/usr/bin/env bash
# Build, sign, install, and gate Work Week Buddy — docs/IMPL_LAYOUT.md §9.
#
# The order below is load-bearing:
#
#   node pin → npm ci → package → codesign → stop the running copy →
#   /Applications → SELF-TEST (hard gate) → doctor (advisory) → LaunchAgent
#
#   * The bundle always lands at exactly /Applications/Work Week Buddy.app.
#     A TCC grant binds to (bundle id + designated requirement + on-disk path),
#     so a bundle run from ~/Downloads or from release/ has no permissions and
#     tracks nothing — silently.
#   * The self-test is a HARD GATE. If it fails, the app cannot tell its own
#     synthetic jiggle from human input, and hours inflate with fake time
#     without anything looking wrong.
#   * The LaunchAgent goes last, so a failed install never leaves a broken app
#     wired to launch at every login.
#
# Safe to run twice: every step is either idempotent (npm ci, ditto over a
# removed destination) or explicitly torn down first (launchctl bootout).
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$PWD"

IDENTITY="WWB Local Signing"
# Frozen — see above. Must match scripts/launch-agent.sh and the app.
APP_DEST="/Applications/Work Week Buddy.app"
APP_BIN="${APP_DEST}/Contents/MacOS/Work Week Buddy"

DRY_RUN=0
SKIP_LAUNCH_AGENT=0
SKIP_DOCTOR=0

usage() {
  cat <<USAGE
usage: scripts/install.sh [--dry-run] [--skip-launch-agent] [--skip-doctor]

  --dry-run             print every step in order; build and change nothing
  --skip-launch-agent   do not install launch-at-login (the app still installs)
  --skip-doctor         skip the post-install diagnostic
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --skip-launch-agent) SKIP_LAUNCH_AGENT=1; shift ;;
    --skip-doctor) SKIP_DOCTOR=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

ok()   { printf "  \033[32m✓\033[0m  %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m  %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m  %s\n" "$1"; }
info() { printf "     %s\n" "$1"; }
hdr()  { printf "\n\033[1m%s\033[0m\n" "$1"; }
die()  { bad "$1"; exit 1; }

# Every command that changes the machine goes through this. --dry-run then
# cannot install, sign, copy, or load anything even if a later edit is careless.
run() {
  if [ "$DRY_RUN" = "1" ]; then printf "  + %s\n" "$*"; return 0; fi
  "$@"
}

printf "\033[1mWork Week Buddy — install\033[0m\n"
info "repo: $REPO"
[ "$DRY_RUN" = "1" ] && warn "dry run: nothing will be built, signed, copied, or loaded"

# ── 0. preconditions ────────────────────────────────────────────────────────
hdr "0. Preconditions"

[ "$(uname -s)" = "Darwin" ] || die "macOS only."

if [ "$DRY_RUN" = "1" ]; then
  info "would require the '$IDENTITY' codesigning identity"
elif security find-identity -v -p codesigning 2>/dev/null | grep -q "$IDENTITY"; then
  ok "signing identity present: $IDENTITY"
else
  bad "no '$IDENTITY' codesigning identity in the login keychain."
  info "Run ./scripts/make-signing-cert.sh first (once per Mac, importing the"
  info "SAME wwb.p12 on both — a second, freshly minted certificate has a"
  info "different designated requirement and your grants will not transfer)."
  exit 1
fi

# ── 1. node ─────────────────────────────────────────────────────────────────
hdr "1. Node"

WANT="$(tr -d '[:space:]' < .nvmrc)"
# nvm.sh trips over `set -u` on some shells, and `nvm use` returns non-zero for
# reasons that are not fatal here, so relax both just for the source.
if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  set +eu
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  nvm use >/dev/null 2>&1   # honours .nvmrc
  set -eu
fi

HAVE="$(node -v 2>/dev/null || echo none)"
if [ "$HAVE" != "v${WANT}" ]; then
  bad "node ${HAVE} is active; this repo pins v${WANT} (.nvmrc)."
  info "The default 22.1.0 on this host breaks stdio ESM and hangs the vitest"
  info "forks pool. Run: nvm install ${WANT} && nvm use"
  exit 1
fi
ok "node $HAVE"

# ── 2. build ────────────────────────────────────────────────────────────────
hdr "2. Build and package"
run npm ci
run npm run package

# electron-builder writes release/mac-arm64/ on Apple silicon and release/mac/
# on Intel. Resolve it rather than assuming.
if [ "$DRY_RUN" = "1" ]; then
  APP_SRC="release/mac-arm64/Work Week Buddy.app"
  info "would use $APP_SRC"
else
  APP_SRC=""
  for candidate in release/mac-arm64 release/mac release/mac-universal; do
    if [ -d "${candidate}/Work Week Buddy.app" ]; then
      APP_SRC="${candidate}/Work Week Buddy.app"
      break
    fi
  done
  [ -n "$APP_SRC" ] || die "no built app under release/. Did 'npm run package' succeed?"
  ok "built $APP_SRC"
fi

# ── 3. sign ─────────────────────────────────────────────────────────────────
hdr "3. Codesign"
# --deep because an Electron bundle carries frameworks and helper apps that must
# all carry the same signature.
# --timestamp=none because a self-signed leaf gains nothing from Apple's
# timestamp authority, and contacting it makes an offline or firewalled install
# hang for minutes before failing.
run codesign --force --deep --timestamp=none --sign "$IDENTITY" "$APP_SRC"
run codesign --verify --strict --deep "$APP_SRC"
[ "$DRY_RUN" = "1" ] || ok "signed and verified"

# ── 4. install to the frozen path ───────────────────────────────────────────
hdr "4. Install to $APP_DEST"

# KeepAlive relaunches the app the moment the old process dies, which during a
# replace means launching a half-copied bundle. Boot the agent out first.
run bash scripts/launch-agent.sh stop

# Quit any hand-launched copy: replacing the bundle underneath a running process
# leaves it holding deleted inodes and writing to a database it no longer owns.
if [ "$DRY_RUN" = "1" ]; then
  printf "  + osascript -e 'quit app \"Work Week Buddy\"'\n"
else
  osascript -e 'quit app "Work Week Buddy"' >/dev/null 2>&1 || true
  pkill -f "$APP_BIN" >/dev/null 2>&1 || true
fi

# rm then ditto, never `cp -R` over an existing bundle: cp merges directories,
# so a stale file from the previous build survives into the new app. ditto is
# the Apple-sanctioned bundle copy and preserves the signature's xattrs.
run rm -rf "$APP_DEST"
run ditto "$APP_SRC" "$APP_DEST"
run codesign --verify --strict --deep "$APP_DEST"
[ "$DRY_RUN" = "1" ] || ok "installed at $APP_DEST"

# The designated requirement IS the identity that TCC remembers. Print it so the
# two Macs can be compared when a grant mysteriously fails to transfer.
if [ "$DRY_RUN" = "1" ]; then
  printf "  + codesign -d -r- \"%s\"\n" "$APP_DEST"
else
  # `|| true`: under pipefail a failed codesign read would abort the install
  # here, one line after the install actually succeeded.
  DR="$(codesign -d -r- "$APP_DEST" 2>/dev/null | sed -n 's/^designated => //p' || true)"
  [ -n "$DR" ] && info "designated requirement: $DR"
fi

# ── 5. the hard gate ────────────────────────────────────────────────────────
hdr "5. Self-test (hard gate)"
if [ "$DRY_RUN" = "1" ]; then
  printf "  + \"%s\" --selftest\n" "$APP_BIN"
  info "a non-zero exit here aborts the install"
elif "$APP_BIN" --selftest; then
  ok "self-test passed"
else
  bad "SELF-TEST FAILED — stopping before launch-at-login is installed."
  info "The app could not prove it can tell its own synthetic jiggle from human"
  info "input. Left running, the jiggler would be counted as work and your hours"
  info "would inflate with fake time, silently."
  info "Run \"$APP_BIN\" --selftest by hand to see which check failed."
  exit 1
fi

# ── 6. doctor (advisory) ────────────────────────────────────────────────────
if [ "$SKIP_DOCTOR" = "1" ]; then
  hdr "6. Doctor (skipped)"
else
  hdr "6. Doctor"
  # Deliberately NOT a gate. On a first install the permissions have not been
  # granted yet — onboarding does that on first launch — so doctor is red by
  # construction here. Aborting on it would mean launch-at-login is never
  # installed on precisely the run that needs it.
  if [ "$DRY_RUN" = "1" ]; then
    printf "  + npm run doctor\n"
  elif npm run --silent doctor; then
    ok "all invariants green"
  else
    warn "doctor reported problems (see above). This does not block the install."
    info "Re-run 'npm run doctor' after granting permissions on first launch."
  fi
fi

# ── 7. launch at login ──────────────────────────────────────────────────────
if [ "$SKIP_LAUNCH_AGENT" = "1" ]; then
  hdr "7. Launch at login (skipped)"
  warn "the agent was booted out in step 4 and has not been re-loaded"
else
  hdr "7. Launch at login"
  run bash scripts/launch-agent.sh install
fi

hdr "Done"
info "Open it from /Applications the first time and complete onboarding: the"
info "two permission prompts can only be answered by a human, once each."
info "Then re-run: npm run doctor"
