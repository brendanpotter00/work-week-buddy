#!/usr/bin/env bash
# THE SMOKE RUN AGAINST THE THING WE ACTUALLY SHIP.
#
# `npm run smoke` runs `electron .` from a shell. That is not the app: it is the
# same JavaScript in a different process, launched a different way, with a
# different TCC identity. The difference cost a release. The packaged app booted,
# put its icon in the menu bar, opened its database, and then had NO WINDOWS AT
# ALL and nothing on stderr, because its main thread was blocked in a
# synchronous `readdirSync` waiting on a macOS consent prompt that a
# terminal-launched process never sees (src/main/file-access.ts).
#
# So this runner launches the real .app THE WAY THE OWNER LAUNCHES IT:
#
#   open -n   → LaunchServices, which is what Finder and the LaunchAgent use,
#               and the only launch that has the app's own TCC identity.
#               A terminal launch inherits the terminal's grants and cannot
#               reproduce this class of bug at all.
#
# LaunchServices hands us a detached process and no exit code, so the run writes
# its verdict to $WWB_SMOKE_DIR/result.json and we wait for the file. NO FILE IS
# THE FAILURE WE CARE ABOUT: an app frozen on boot never writes one, and the
# boot log printed below ends on the exact step that hung.
#
# SAFETY. Both of the owner's real stores are kept out of it:
#   * --user-data-dir is a fresh mktemp; the app never opens the real profile
#     at ~/Library/Application Support/Work Week Buddy. `runSmoke()` refuses to
#     start unless the path it was handed carries the wwb-smoke- prefix.
#   * the run DOES call `sync.runCycle("launch")` — it has to, that is the call
#     that froze — but with the backup directory pointed inside the throwaway
#     profile (src/main/smoke.ts). Nothing reaches iCloud Drive or ~/Documents.
#
# --prove-it PROVES THIS RUNNER CAN SEE A FROZEN MAIN THREAD.
#
# A gate nobody has watched fail is a gate nobody should trust, and this one
# cannot manufacture the real trigger: reproducing a TCC prompt means touching
# the owner's iCloud Drive or ~/Documents, which is precisely what a test must
# never do. So --prove-it reproduces the MECHANISM instead, deterministically
# and inside the throwaway profile: it puts a FIFO where `weeklyBackup()` writes
# its ndjson temp file, and `open(2)` on a FIFO with no reader blocks forever.
# Same class, same thread, same result — a boot that never finishes and a
# process that never writes result.json. With --prove-it the run is expected to
# FAIL, and the runner exits 0 only if it did.
#
# Usage:  bash tools/smoke-packaged.sh [--no-build] [--prove-it]
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$PWD"

BUILD=1
PROVE=0
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --prove-it) PROVE=1 ;;
    *) printf 'unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

ok()   { printf "  \033[32m✓\033[0m  %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m  %s\n" "$1"; }
info() { printf "     %s\n" "$1"; }
die()  { bad "$1"; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "macOS only — the packaged smoke run needs a real .app."

# ── 1. build ────────────────────────────────────────────────────────────────
if [ "$BUILD" = "1" ]; then
  printf "\033[1mPackaging\033[0m\n"
  npm run package
fi

APP=""
for candidate in release/mac-arm64 release/mac release/mac-universal; do
  if [ -d "${REPO}/${candidate}/Work Week Buddy.app" ]; then
    APP="${REPO}/${candidate}/Work Week Buddy.app"
    break
  fi
done
[ -n "$APP" ] || die "no packaged app under release/. Run 'npm run package' first."
ok "app: $APP"

# ── 2. a profile that is not the owner's ────────────────────────────────────
# The prefix is not decoration: src/main/smoke-report.ts exports it and
# runSmoke() refuses to open a database in a directory without it.
PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/wwb-smoke-packaged-XXXXXX")"
OUT="${WWB_SMOKE_DIR:-${PROFILE}/out}"
mkdir -p "$OUT"
RESULT="${OUT}/result.json"
LOG="${PROFILE}/wwb.log"
info "profile: $PROFILE"
info "output:  $OUT"

cleanup() {
  # Never leave a detached app behind, however this exits.
  pkill -f "${APP}/Contents/MacOS/Work Week Buddy" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ── 3. launch it the way the owner does ─────────────────────────────────────
# WWB_ALLOW_FAKE_IN_PACKAGED is the one door in src/native/index.ts that lets a
# packaged build take the fake signal source, and it only opens alongside
# --smoke and WWB_FAKE_NATIVE=1. Without it this run would need real Input
# Monitoring and Accessibility grants and could not run unattended.
export WWB_FAKE_NATIVE=1
export WWB_ALLOW_FAKE_IN_PACKAGED=1
export WWB_SMOKE_DIR="$OUT"

if [ "$PROVE" = "1" ]; then
  # `weeklyBackup()` writes <dir>/wwb-<ISO week>.ndjson.gz.tmp with
  # writeFileSync. A FIFO there turns that into an open(2) that never returns —
  # on the main thread, inside runCycle("launch"), exactly where the real freeze
  # lived. Everything here is inside the throwaway profile.
  WEEK="$(python3 -c '
import datetime
y, w, _ = datetime.date.today().isocalendar()
print(f"{y:04d}-W{w:02d}")')"
  mkdir -p "${PROFILE}/backups"
  mkfifo "${PROFILE}/backups/wwb-${WEEK}.ndjson.gz.tmp"
  info "--prove-it: FIFO trap set at backups/wwb-${WEEK}.ndjson.gz.tmp"
  info "--prove-it: this run is EXPECTED TO FAIL; exit 0 means the gate works"
fi

printf "\033[1mLaunching through LaunchServices\033[0m\n"
open -n "$APP" --args --smoke --user-data-dir="$PROFILE"

# ── 4. wait for the verdict ─────────────────────────────────────────────────
# Longer than runSmokeCli's own 120s bomb, so a run that fails its assertions
# gets to say so rather than being reported as a hang.
DEADLINE=$((SECONDS + 180))
[ "$PROVE" = "1" ] && DEADLINE=$((SECONDS + 60))
while [ ! -f "$RESULT" ]; do
  if [ "$SECONDS" -ge "$DEADLINE" ]; then
    if [ "$PROVE" = "1" ]; then
      ok "--prove-it: the runner caught a frozen main thread (no $RESULT)"
      printf "\n\033[1mBoot log\033[0m — it ends at the step that hung:\n"
      [ -f "$LOG" ] && sed 's/^/    /' "$LOG"
      exit 0
    fi
    bad "the packaged app never produced $RESULT."
    info "It did not finish, which for this app means it did not run: a frozen"
    info "main thread opens no window, fires no second-instance and logs nothing."
    printf "\n\033[1mBoot log (%s)\033[0m — it ends at the step that hung:\n" "$LOG"
    if [ -f "$LOG" ]; then sed 's/^/    /' "$LOG"; else info "(no log file — it did not reach app.whenReady)"; fi
    printf "\n\033[1mSample of the main thread\033[0m\n"
    PID="$(pgrep -f "${APP}/Contents/MacOS/Work Week Buddy" | head -1 || true)"
    if [ -n "$PID" ]; then
      sample "$PID" 2 -f "${OUT}/sample.txt" >/dev/null 2>&1 || true
      sed -n '/Call graph/,/^ *[0-9]* Thread/p' "${OUT}/sample.txt" 2>/dev/null | tail -30 | sed 's/^/    /'
      info "full sample: ${OUT}/sample.txt"
    else
      info "(process already gone)"
    fi
    exit 1
  fi
  sleep 1
done

# ── 5. report ───────────────────────────────────────────────────────────────
CODE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["exitCode"])' "$RESULT")"
NOTE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["note"])' "$RESULT")"

printf "\n\033[1mPackaged smoke\033[0m\n"
if [ -f "${OUT}/smoke-report.json" ]; then
  python3 - "${OUT}/smoke-report.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
print(f"     packaged={r['packaged']}  worst main-thread stall={r['maxStallMs']}ms")
for p in r["probes"]:
    print(f"     {p['window']:<10} {p['scenario']:<9} view={str(p['view']):<11}"
          f" window={p['bounds']['width']}x{p['bounds']['height']}"
          f" content={p['scrollWidth']}x{p['scrollHeight']}")
for f in r.get("failures", []):
    print(f"     FAIL: {f}")
PY
fi

if [ "$PROVE" = "1" ]; then
  bad "--prove-it: the run FINISHED (exit $CODE) with the main thread trapped."
  info "This runner cannot see a frozen boot, which makes it worthless. Fix it."
  exit 1
fi

if [ "$CODE" = "0" ]; then
  ok "packaged smoke: OK"
  exit 0
fi
bad "packaged smoke FAILED (exit $CODE): $NOTE"
[ -f "$LOG" ] && { printf "\n\033[1mBoot log\033[0m\n"; sed 's/^/    /' "$LOG"; }
exit "$CODE"
