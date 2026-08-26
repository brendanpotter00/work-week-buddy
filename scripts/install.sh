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
#   * The self-test is a HARD GATE, over two separate promises: that the app can
#     tell its own synthetic jiggle from human input (fail that and hours inflate
#     with fake time without anything looking wrong), and that the jiggle moves
#     nothing on screen. The failure message names the check rather than assuming
#     which one broke.
#   * It runs one line after an install the owner just typed, so it runs WHILE
#     SOMEBODY IS USING THE MAC. A check that cannot get a verdict under those
#     conditions reports COULD NOT BE MEASURED and does not stop the install: a
#     gate that fails during normal use is a gate its owner learns to bypass.
#   * The LaunchAgent goes last, so a failed install never leaves a broken app
#     wired to launch at every login.
#
# Safe to run twice: every step is either idempotent (npm ci, ditto over a
# removed destination) or explicitly torn down first (launchctl bootout).
#
# ── The overrides at the bottom of `usage` exist for ONE reason ──────────────
# so that test/scripts/install-flow.test.ts can drive this entire file into
# $TMPDIR — real ditto, real replace, real self-test gate, real plist — without
# a certificate, without /Applications, and without launchd. Nothing about the
# real install is optional; the defaults ARE the real install, and any run that
# changes a destination says so in red before it does anything.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$PWD"

# Frozen — see above. Must match scripts/launch-agent.sh and the app.
DEFAULT_APP_DEST="/Applications/Work Week Buddy.app"

IDENTITY="WWB Local Signing"
# Resolved from the keychain in the precondition block; codesign_sign prefers it
# over the common name so two certificates sharing a CN cannot be confused.
IDENTITY_HASH=""
DEFAULT_KEYCHAIN="${HOME}/Library/Keychains/login.keychain-db"
KEYCHAIN="$DEFAULT_KEYCHAIN"
APP_DEST="$DEFAULT_APP_DEST"
APP_SRC_OVERRIDE=""
PLIST_DIR=""
LOG_DIR=""

DRY_RUN=0
SKIP_LAUNCH_AGENT=0
SKIP_DOCTOR=0
DO_SIGN=1
DO_LAUNCHCTL=1

usage() {
  cat <<USAGE
usage: scripts/install.sh [--dry-run] [--skip-launch-agent] [--skip-doctor]

  --dry-run             print every step in order; build and change nothing
  --skip-launch-agent   do not install launch-at-login (the app still installs)
  --skip-doctor         skip the post-install diagnostic

Overrides. These exist so the flow can be tested into a scratch directory; a
real install needs none of them and should be given none of them.

  --dest PATH           install here instead of "$DEFAULT_APP_DEST"
  --app-src PATH        use this .app instead of running npm ci && npm run package
  --identity NAME       codesigning identity (default "$IDENTITY")
  --keychain PATH       keychain to look the identity up in
  --no-sign             do not codesign at all
  --no-launchctl        write the plist but never call launchctl
  --plist-dir DIR       LaunchAgents directory
  --log-dir DIR         where the agent's stdout/stderr go
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --skip-launch-agent) SKIP_LAUNCH_AGENT=1; shift ;;
    --skip-doctor) SKIP_DOCTOR=1; shift ;;
    --dest) APP_DEST="${2:?--dest needs a path}"; shift 2 ;;
    --app-src) APP_SRC_OVERRIDE="${2:?--app-src needs a path}"; shift 2 ;;
    --identity) IDENTITY="${2:?--identity needs a value}"; shift 2 ;;
    --keychain) KEYCHAIN="${2:?--keychain needs a path}"; shift 2 ;;
    --no-sign) DO_SIGN=0; shift ;;
    --no-launchctl) DO_LAUNCHCTL=0; shift ;;
    --plist-dir) PLIST_DIR="${2:?--plist-dir needs a path}"; shift 2 ;;
    --log-dir) LOG_DIR="${2:?--log-dir needs a path}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

APP_BIN="${APP_DEST}/Contents/MacOS/Work Week Buddy"

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

# The three functions below all build their arguments with `set --` rather than
# an array, because macOS ships bash 3.2, where expanding an empty array under
# `set -u` is itself an "unbound variable" error — and the flags genuinely can
# contain spaces ("/Applications/Work Week Buddy.app").
#
# `--keychain` is passed ONLY when it has been overridden. On the default login
# keychain the flag is redundant, because codesign already searches it. (It is
# NOT a licence to point codesign anywhere: --keychain says which keychain to
# PREFER, not where codesign may look, so a keychain outside the search list
# stays invisible and signing fails with "no identity found". That error is what
# this repo spent a release misreading as a trust problem.)
#
# Resolves the leaf's SHA-1. Deliberately NOT `find-identity -v` — see the
# precondition block below, and scripts/make-signing-cert.sh's header for the
# measurements. Signing by hash rather than by common name also removes the
# ambiguity of two certificates sharing a CN, which is exactly what happens
# after someone re-mints instead of importing the shared wwb.p12.
# Prints EVERY match, one per line — `break`, not `exit`. Two certificates CAN
# share this common name: it is what happens when someone runs
# make-signing-cert.sh on the second Mac without putting wwb.p12 in place first.
# Taking whichever `security` happens to list first would sign with a coin flip
# and silently drop every grant on one of the two machines.
identity_hash() {
  security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null \
    | awk -v want="$IDENTITY" '
        index($0, want) == 0 { next }
        { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9A-Fa-f]{40}$/) { print $i; break } }
      '
}

identity_count() {
  h="$(identity_hash)"
  if [ -z "$h" ]; then printf '0\n'; else printf '%s\n' "$h" | wc -l | tr -d ' '; fi
}

# Sets IDENTITY_HASH, or explains and returns non-zero. Ambiguity is a hard stop,
# never a guess.
resolve_identity() {
  n="$(identity_count)"
  if [ "$n" -gt 1 ]; then
    bad "$n certificates in $KEYCHAIN are called '$IDENTITY'."
    identity_hash | sed 's/^/       /'
    info "Signing would pick one arbitrarily, and only one of them matches the"
    info "grants on your other Mac. Delete the wrong one in Keychain Access — it"
    info "is the one whose SHA-1 the other Mac's --show does NOT print."
    return 1
  fi
  IDENTITY_HASH="$(identity_hash)"
  [ -n "$IDENTITY_HASH" ]
}

# The precondition that means something: sign a throwaway Mach-O and confirm the
# designated requirement that comes back pins this exact certificate. A copy of
# /usr/bin/true stands in because it is a real Mach-O present on every Mac.
signing_probe_ok() {
  hash="$1"
  probe_dir="$(mktemp -d)"
  # shellcheck disable=SC2064 -- expand probe_dir NOW; it is about to go away.
  trap "rm -rf '$probe_dir'" RETURN
  cp /usr/bin/true "$probe_dir/probe" 2>/dev/null || return 1
  set -- --force --timestamp=none --sign "$hash"
  if [ "$KEYCHAIN" != "$DEFAULT_KEYCHAIN" ]; then set -- "$@" --keychain "$KEYCHAIN"; fi
  codesign "$@" "$probe_dir/probe" >/dev/null 2>&1 || return 1
  codesign -d -r- "$probe_dir/probe" 2>/dev/null \
    | grep -qi "certificate leaf = H\"$hash\""
}

codesign_sign() {
  app="$1"
  set -- --force --deep --timestamp=none
  if [ "$KEYCHAIN" != "$DEFAULT_KEYCHAIN" ]; then set -- "$@" --keychain "$KEYCHAIN"; fi
  run codesign "$@" --sign "${IDENTITY_HASH:-$IDENTITY}" "$app"
}

launch_agent() {
  set -- "$1"
  if [ "$APP_DEST" != "$DEFAULT_APP_DEST" ]; then set -- "$@" --app-path "$APP_DEST"; fi
  if [ -n "$PLIST_DIR" ]; then set -- "$@" --plist-dir "$PLIST_DIR"; fi
  if [ -n "$LOG_DIR" ]; then set -- "$@" --log-dir "$LOG_DIR"; fi
  if [ "$DO_LAUNCHCTL" != "1" ]; then set -- "$@" --no-launchctl; fi
  run bash scripts/launch-agent.sh "$@"
}

printf "\033[1mWork Week Buddy — install\033[0m\n"
info "repo: $REPO"
[ "$DRY_RUN" = "1" ] && warn "dry run: nothing will be built, signed, copied, or loaded"

# A run that is not going to /Applications is not an install, and must never be
# mistaken for one afterwards. Say so before anything happens.
if [ "$APP_DEST" != "$DEFAULT_APP_DEST" ]; then
  bad "NOT A REAL INSTALL: destination overridden to $APP_DEST"
  info "A TCC grant binds to the on-disk path, so an app anywhere but"
  info "$DEFAULT_APP_DEST has no permissions and tracks nothing."
fi

# ── 0. preconditions ────────────────────────────────────────────────────────
hdr "0. Preconditions"

[ "$(uname -s)" = "Darwin" ] || die "macOS only."

if [ "$DO_SIGN" != "1" ]; then
  warn "--no-sign: the bundle will keep Electron's ad-hoc signature"
  info "Grants do not survive a rebuild without a stable designated requirement."
elif [ "$DRY_RUN" = "1" ]; then
  # Resolve the hash even here. It is a read-only keychain lookup, and without it
  # the dry run prints `--sign WWB Local Signing` while the real run signs by
  # SHA-1 — a dry run that describes a different command than the one it is
  # previewing is worse than no dry run.
  if resolve_identity; then
    info "would sign with '$IDENTITY' ($IDENTITY_HASH)"
  else
    info "would require the '$IDENTITY' codesigning identity (none usable yet)"
  fi
else
  # NOT `find-identity -v`. -v means "the chain validates", which for a
  # self-signed leaf it never will unless someone marks it Always Trust in
  # Keychain Access by hand. That flag is the entire reason this repo used to
  # demand a GUI trust step: the identity was perfectly able to sign, and the
  # precondition check said "0 valid identities found" anyway. codesign does not
  # consult trust — measured, see scripts/make-signing-cert.sh's header — so the
  # gate is now "resolve the identity, then actually sign something with it".
  if ! resolve_identity; then
    # resolve_identity has already explained a DUPLICATE. Only the "none at all"
    # case still needs saying.
    if [ "$(identity_count)" = "0" ]; then
      bad "no '$IDENTITY' codesigning identity in $KEYCHAIN."
      info "Run ./scripts/make-signing-cert.sh first (once per Mac, importing the"
      info "SAME wwb.p12 on both — a second, freshly minted certificate has a"
      info "different designated requirement and your grants will not transfer)."
    fi
    exit 1
  fi
  if signing_probe_ok "$IDENTITY_HASH"; then
    ok "signing identity usable: $IDENTITY ($IDENTITY_HASH)"
    info "Keychain Access will show it untrusted. That is expected and fine:"
    info "trust governs chain validation, and the designated requirement below"
    info "pins the leaf by hash without naming an anchor."
  else
    bad "'$IDENTITY' is in $KEYCHAIN but codesign cannot sign with it."
    info "This is NOT a trust problem — trust is not required and never was."
    info "Either $KEYCHAIN is outside the keychain search list (check with"
    info "'security list-keychains -d user'), or the .p12 was imported without"
    info "its private key."
    info "Diagnose with: ./scripts/make-signing-cert.sh --show"
    exit 1
  fi
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
if [ -n "$APP_SRC_OVERRIDE" ]; then
  hdr "2. Build and package (skipped — --app-src)"
  [ -d "$APP_SRC_OVERRIDE" ] || die "no bundle at $APP_SRC_OVERRIDE"
  APP_SRC="$APP_SRC_OVERRIDE"
  ok "using $APP_SRC"
else
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
fi

# ── 3. sign ─────────────────────────────────────────────────────────────────
if [ "$DO_SIGN" != "1" ]; then
  hdr "3. Codesign (skipped — --no-sign)"
else
  hdr "3. Codesign"
  # --deep because an Electron bundle carries frameworks and helper apps that must
  # all carry the same signature. Measured on this exact bundle: --deep walks the
  # five helper .apps, Electron Framework, Squirrel, Mantle, ReactiveObjC and
  # chrome_crashpad_handler, and --verify --strict --deep then passes.
  # --timestamp=none because a self-signed leaf gains nothing from Apple's
  # timestamp authority, and contacting it makes an offline or firewalled install
  # hang for minutes before failing.
  codesign_sign "$APP_SRC"
  run codesign --verify --strict --deep "$APP_SRC"
  [ "$DRY_RUN" = "1" ] || ok "signed and verified"
fi

# ── 4. install to the frozen path ───────────────────────────────────────────
hdr "4. Install to $APP_DEST"

# KeepAlive relaunches the app the moment the old process dies, which during a
# replace means launching a half-copied bundle. Boot the agent out first.
launch_agent stop

# Quit any hand-launched copy: replacing the bundle underneath a running process
# leaves it holding deleted inodes and writing to a database it no longer owns.
#
# Guarded by pgrep, and NOT because it is tidier: `osascript -e 'quit app "X"'`
# LAUNCHES an app that is not running, purely so it can quit it. Unguarded, a
# reinstall would start the outgoing build for a second and a fresh install
# would start whatever else answers to the name.
quit_running_copy() {
  if [ "$APP_DEST" != "$DEFAULT_APP_DEST" ]; then
    info "not the frozen path; leaving any running app alone"
    return 0
  fi
  if ! pgrep -f "$APP_BIN" >/dev/null 2>&1; then
    info "no running copy"
    return 0
  fi
  # A clean quit runs before-quit, which closes the open interval with
  # end_reason 'app_quit'. SIGTERM would leave it to crash recovery instead, so
  # ask nicely first and only then insist. The first Apple event may raise the
  # one-time "Terminal wants to control Work Week Buddy" prompt.
  osascript -e 'quit app "Work Week Buddy"' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "$APP_BIN" >/dev/null 2>&1 || break
    sleep 0.5
  done
  pkill -f "$APP_BIN" >/dev/null 2>&1 || true
  ok "stopped the running copy"
}
if [ "$DRY_RUN" = "1" ]; then
  printf "  + osascript -e 'quit app \"Work Week Buddy\"'\n"
else
  quit_running_copy
fi

# rm then ditto, never `cp -R` over an existing bundle: cp merges directories,
# so a stale file from the previous build survives into the new app. ditto is
# the Apple-sanctioned bundle copy and preserves the signature's xattrs.
run rm -rf "$APP_DEST"
run mkdir -p "$(dirname "$APP_DEST")"
run ditto "$APP_SRC" "$APP_DEST"
if [ "$DO_SIGN" = "1" ]; then run codesign --verify --strict --deep "$APP_DEST"; fi
[ "$DRY_RUN" = "1" ] || ok "installed at $APP_DEST"

# ── HIDE THE BUILD OUTPUT FROM SPOTLIGHT AND LAUNCHPAD ──────────────────────
# LaunchServices registers every .app bundle it finds anywhere on disk, so the
# copy we just built in release/ shows up beside the installed one under the
# same name and the same icon. That is not cosmetic. A TCC grant binds to the
# bundle's ON-DISK PATH, so launching the release/ copy from Spotlight gives an
# app with no Input Monitoring and no Accessibility: it opens, looks entirely
# normal, and records nothing. Silently, which is the only way this app can
# fail badly.
#
# Unregister rather than delete: release/ is the build output and other scripts
# (tools/smoke-packaged.sh) expect it to still be there. Unregistering only
# removes it from the launcher's index, and re-running this script re-hides the
# copy the next build creates.
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
unregister_stray() {
  [ -e "$1" ] || return 0
  "$LSREGISTER" -u "$1" 2>/dev/null || true
}
if [ "$DRY_RUN" = "1" ]; then
  printf "  + lsregister -u \"%s\"\n" "$APP_SRC"
elif [ -x "$LSREGISTER" ] && [ "$APP_DEST" = "$DEFAULT_APP_DEST" ]; then
  unregister_stray "$APP_SRC"
  ok "hid the build copy from Spotlight (only $APP_DEST is launchable)"
fi

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
#
# THIS RUNS WHILE SOMEBODY IS AT THE KEYBOARD. It is one line after an install
# the owner just typed, so "the Mac is idle" is the one assumption no check here
# may make. The checks that need an undisturbed machine report COULD NOT BE
# MEASURED rather than failing — see src/native/cursor-stillness.ts. Nothing
# below asks the owner to keep his hands off the mouse: an instruction he has to
# obey is a gate that fails when he forgets.
#
# The transcript is captured as well as shown, so the pass path can tell a clean
# green run from one that could not measure something.
if [ "$DRY_RUN" = "1" ]; then
  printf "  + \"%s\" --selftest\n" "$APP_BIN"
  info "a non-zero exit here aborts the install"
else
  SELFTEST_LOG="$(mktemp -t wwb-selftest)"
  # shellcheck disable=SC2064 -- expand SELFTEST_LOG now, not at trap time.
  trap "rm -f '$SELFTEST_LOG'" EXIT
  # `2>&1 |` and not a redirect to the file alone: the owner watches this step,
  # and a gate that prints nothing for eight seconds and then aborts is a gate
  # nobody trusts. pipefail (set at the top) is what keeps the app's exit status
  # rather than tee's.
  if "$APP_BIN" --selftest 2>&1 | tee "$SELFTEST_LOG"; then
    if grep -q "COULD NOT BE MEASURED" "$SELFTEST_LOG"; then
      # Deliberately not the words "self-test passed": nothing failed, but
      # something was not proven, and those are different facts.
      warn "no check failed, but one COULD NOT BE MEASURED (marked ? above)."
      info "That is neither a pass nor a failure. It happens when the Mac was in"
      info "use while the check ran — most likely you were moving the mouse."
      info "The install continues. For a verdict, re-run the self-test with your"
      info "hands off the trackpad:"
      info "  \"$APP_BIN\" --selftest"
    else
      ok "self-test passed"
    fi
  else
    # NOT "the app could not tell its own jiggle from human input" — that names
    # one of the two promises this gate covers, and it is the wrong one about
    # half the time. Say which check failed instead of guessing why.
    bad "SELF-TEST FAILED — stopping before launch-at-login is installed."
    info "Read the FAIL line above; it names the check. Two promises are gated:"
    info "  · DISCRIMINATION (round-trip, userData, srcPid, kCGEventNull) — if"
    info "    one of those failed, the jiggler counts as work and your hours"
    info "    inflate with fake time, silently."
    info "  · UNOBTRUSIVENESS ('cursor did not move') — the jiggler is dragging"
    info "    your pointer."
    exit 1
  fi
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
  launch_agent install
fi

hdr "Done"
info "Open it from /Applications the first time and complete onboarding: the"
info "two permission prompts can only be answered by a human, once each."
info "Then re-run: npm run doctor"
