#!/usr/bin/env bash
# The LaunchAgent — launch at login, and restart after a crash.
#
# ONE autostart mechanism, ever (docs/IMPL_UI.md §1.7). Never also call
# app.setLoginItemSettings(): that registers a second, independent launch path;
# both fire at login, the second loses the single-instance lock and exits, and
# the doctor panel then disagrees with reality. This plist is the only authority.
#
# The plist is GENERATED rather than committed as a static file because two of
# its values are absolute paths that only exist at install time ($HOME for the
# log files, and the frozen /Applications bundle path). A committed plist with a
# literal `~` in it is silently wrong: launchd does not expand tildes.
#
#   ./scripts/launch-agent.sh render      print the plist to stdout
#   ./scripts/launch-agent.sh install     write it, then bootstrap it
#   ./scripts/launch-agent.sh stop        bootout, keeping the plist on disk
#   ./scripts/launch-agent.sh uninstall   bootout, then remove it
#   ./scripts/launch-agent.sh status      what is on disk and what is loaded
#
# Safe to run twice: install boots the agent out before bootstrapping it, and
# uninstall tolerates an agent that is already gone.
set -euo pipefail

LABEL="com.bpotter.workweekbuddy"
# Frozen. TCC grants bind to bundle id + designated requirement + on-disk path,
# so this must be the same string here, in install.sh, and in the app.
APP_PATH="/Applications/Work Week Buddy.app"
EXEC="${APP_PATH}/Contents/MacOS/Work Week Buddy"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST="${PLIST_DIR}/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs/WorkWeekBuddy"

DRY_RUN=0
FORCE=0
CMD=""

usage() {
  cat <<USAGE
usage: scripts/launch-agent.sh <render|install|stop|uninstall|status> [--dry-run] [--force]

  render      print the generated plist to stdout (touches nothing)
  install     write ~/Library/LaunchAgents/${LABEL}.plist and bootstrap it
  stop        bootout the agent, leaving the plist in place
  uninstall   bootout and remove it
  status      report what is installed and whether it is loaded

  --force     install even when the app is not at ${APP_PATH}
  --dry-run   print what would happen; change nothing
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    render|install|stop|uninstall|status) CMD="$1"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$CMD" ]; then usage >&2; exit 2; fi

ok()   { printf "  \033[32m✓\033[0m  %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m  %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m  %s\n" "$1"; }
info() { printf "     %s\n" "$1"; }

run() {
  if [ "$DRY_RUN" = "1" ]; then printf "  + %s\n" "$*"; return 0; fi
  "$@"
}

# launchd wants a real uid, and `gui/<uid>` is the only domain that has a
# WindowServer connection. CGEventSource* calls hang without one, which is why
# NON_GOALS #6 bans a LaunchDaemon.
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"

# A path containing & or < would produce invalid XML. Cheap to escape, and the
# failure it prevents (plutil rejecting the file at install time) is opaque.
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

render_plist() {
  local exec_x log_x
  exec_x="$(xml_escape "$EXEC")"
  log_x="$(xml_escape "$LOG_DIR")"
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${exec_x}</string>
    <string>--hidden</string>
  </array>
  <key>RunAtLoad</key><true/>
  <!-- Restart on a crash, but NOT after a clean quit. Without SuccessfulExit
       false, quitting from the tray menu relaunches the app immediately and
       the menu item looks broken. -->
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <!-- GUI session only. -->
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${log_x}/agent.out.log</string>
  <key>StandardErrorPath</key><string>${log_x}/agent.err.log</string>
</dict>
</plist>
PLIST
}

case "$CMD" in
  render)
    render_plist
    ;;

  install)
    if [ ! -d "$APP_PATH" ] && [ "$FORCE" != "1" ]; then
      bad "no app at $APP_PATH"
      info "Run ./scripts/install.sh first, or pass --force to write the plist anyway."
      exit 1
    fi

    run mkdir -p "$LOG_DIR" "$PLIST_DIR"

    if [ "$DRY_RUN" = "1" ]; then
      printf "  + write %s\n" "$PLIST"
    else
      # Write via a temp file in the same directory: a half-written plist that
      # launchd reads at the wrong moment is a login that silently does nothing.
      tmp="$(mktemp "${PLIST_DIR}/.${LABEL}.XXXXXX")"
      render_plist > "$tmp"
      plutil -lint "$tmp" >/dev/null
      mv "$tmp" "$PLIST"
      ok "wrote $PLIST"
    fi

    # bootout first: bootstrap fails outright on an already-loaded label, and on
    # a re-install the loaded copy is the OLD plist. Failure here is normal (it
    # means nothing was loaded), so it must not trip `set -e`.
    run launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
    run launchctl bootstrap "$DOMAIN" "$PLIST"
    [ "$DRY_RUN" = "1" ] || ok "bootstrapped ${DOMAIN}/${LABEL}"
    ;;

  stop)
    # Used by install.sh before it replaces the bundle: KeepAlive would
    # otherwise relaunch the app from a half-copied /Applications bundle the
    # instant the old process dies.
    run launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
    [ "$DRY_RUN" = "1" ] || ok "booted out ${DOMAIN}/${LABEL} (if it was loaded)"
    ;;

  uninstall)
    run launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
    run rm -f "$PLIST"
    [ "$DRY_RUN" = "1" ] || ok "removed $PLIST"
    ;;

  status)
    if [ -f "$PLIST" ]; then ok "plist present: $PLIST"; else warn "plist absent: $PLIST"; fi
    if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
      ok "loaded in ${DOMAIN}"
    else
      warn "not loaded in ${DOMAIN}"
    fi
    # A missing app is the only hard failure: the plist can legitimately be
    # absent (launch-at-login is optional), but a plist pointing at nothing is
    # a login that silently does nothing. Exit non-zero rather than print a red
    # cross and claim success.
    if [ -d "$APP_PATH" ]; then
      ok "app present: $APP_PATH"
    else
      bad "app missing: $APP_PATH"
      exit 1
    fi
    ;;
esac
