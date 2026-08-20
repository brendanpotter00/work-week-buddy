#!/usr/bin/env bash
# M0 — work-laptop go/no-go spike for Work Week Buddy.
#
# Answers two questions, and nothing else:
#   (a) Can a locally built, self-signed app be granted Input Monitoring and Accessibility?
#   (b) Can this machine reach Cloudflare Workers through the corporate network?
#
# Safe to run: no sudo required, nothing installed permanently, no data sent anywhere.
# Everything it builds lives in a temp dir and is removed at the end.

set -uo pipefail
PASS=0; FAIL=0; UNKNOWN=0; CORE_TESTED=0
ok()   { printf "  \033[32m✓ PASS\033[0m  %s\n" "$1"; PASS=$((PASS+1)); }
bad()  { printf "  \033[31m✗ FAIL\033[0m  %s\n" "$1"; FAIL=$((FAIL+1)); }
huh()  { printf "  \033[33m? UNKNOWN\033[0m  %s\n" "$1"; UNKNOWN=$((UNKNOWN+1)); }
info() { printf "         %s\n" "$1"; }
hdr()  { printf "\n\033[1m%s\033[0m\n" "$1"; }

CHECKS_ONLY=0
[ "${1:-}" = "--checks-only" ] && CHECKS_ONLY=1

WORK=$(mktemp -d /tmp/wwb-m0.XXXXXX)
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

printf "\033[1mWork Week Buddy — M0 spike\033[0m\n"
printf "%s · macOS %s · %s\n" "$(scutil --get ComputerName 2>/dev/null || hostname)" "$(sw_vers -productVersion)" "$(uname -m)"
[ "$CHECKS_ONLY" = "1" ] && printf "\033[33mchecks-only mode: sections 1-2 only, no permission prompts\033[0m\n"

# ─────────────────────────────────────────────────────────────── 1. management
hdr "1. Device management"
ENROLL=$(profiles status -type enrollment 2>/dev/null)
if grep -qi "MDM enrollment: *Yes" <<<"$ENROLL"; then
  info "This Mac IS managed by MDM. That is expected for a work laptop and is not"
  info "a failure by itself — what matters is whether a policy blocks the two"
  info "permissions below. Section 3 is the real test."
  MANAGED=1
else
  info "No MDM enrollment detected."
  MANAGED=0
fi
grep -E "Enrolled via DEP|MDM enrollment" <<<"$ENROLL" | sed 's/^/         /'

if profiles list -all >/dev/null 2>&1; then
  PPPC=$(profiles list -all 2>/dev/null | grep -ci "TCC\|PrivacyPreferences" || true)
  [ "${PPPC:-0}" -gt 0 ] \
    && huh "Privacy-policy payloads are present. They may or may not restrict us — section 3 decides." \
    || ok "No privacy-policy payloads found that would pre-empt a permission grant."
else
  huh "Can't read configuration profiles without admin rights. Section 3 still gives the real answer."
fi

# ─────────────────────────────────────────────────────────────── 2. network
hdr "2. Network to Cloudflare Workers"
# A workers.dev subdomain that does not exist still proves DNS + TLS + routing work:
# Cloudflare itself answers with an error page rather than the request being blocked.
CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 https://workers.cloudflare.com 2>/dev/null)
if [[ "$CODE" =~ ^(2|3|4)[0-9][0-9]$ ]]; then
  ok "Reached workers.cloudflare.com (HTTP $CODE)."
else
  bad "Could not reach workers.cloudflare.com (got '$CODE'). A proxy or filter is in the way."
fi
CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 https://api.cloudflare.com/client/v4 2>/dev/null)
[[ "$CODE" =~ ^(2|3|4)[0-9][0-9]$ ]] \
  && ok "Reached api.cloudflare.com (HTTP $CODE)." \
  || bad "Could not reach api.cloudflare.com (got '$CODE')."

if command -v dig >/dev/null 2>&1 && dig +short +time=5 workers.dev @1.1.1.1 2>/dev/null | grep -q .; then
  ok "DNS resolves workers.dev."
else
  huh "Could not resolve workers.dev via 1.1.1.1 — DNS may be forced through a corporate resolver. Not fatal on its own."
fi

PROXY=$(scutil --proxy 2>/dev/null | grep -cE "HTTPSEnable *: *1|ProxyAutoConfigEnable *: *1" || true)
[ "${PROXY:-0}" -gt 0 ] \
  && huh "An HTTP(S) proxy or PAC file is configured. Requests above still succeeded, so it allows Cloudflare." \
  || ok "No system proxy configured."

# ─────────────────────────────────────────────────────────────── 3. permissions
hdr "3. Can a self-signed app get the two permissions?"
info "This is the question the whole project depends on."

if [ "$CHECKS_ONLY" = "1" ]; then
  huh "Skipped (--checks-only). Re-run without the flag to test the permissions."
elif ! xcrun --find swiftc >/dev/null 2>&1; then
  huh "Xcode Command Line Tools not installed, so the probe app can't be built here."
  info "Install them with:  xcode-select --install"
  info "…then re-run this script. Sections 1 and 2 above are still valid."
else
  APP="$WORK/WWBProbe.app"
  mkdir -p "$APP/Contents/MacOS"
  cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>WWBProbe</string>
  <key>CFBundleIdentifier</key><string>com.bpotter.wwbprobe</string>
  <key>CFBundleExecutable</key><string>WWBProbe</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST

  cat > "$WORK/probe.swift" <<'SWIFT'
import Foundation
import CoreGraphics
import ApplicationServices

// Ask for both permissions, then report what we actually got.
// Requesting is the only way to find out whether policy forbids it.
let listenPre = CGPreflightListenEventAccess()
let postPre   = CGPreflightPostEventAccess()
if !listenPre { _ = CGRequestListenEventAccess() }
if !postPre   { _ = CGRequestPostEventAccess() }
let axOpts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
let axTrusted = AXIsProcessTrustedWithOptions(axOpts)

// Give the user time to click through both System Settings panes.
let deadline = Date().addingTimeInterval(120)
var listen = CGPreflightListenEventAccess()
var post   = CGPreflightPostEventAccess()
var ax     = axTrusted
while Date() < deadline && !(listen && (post || ax)) {
    Thread.sleep(forTimeInterval: 2)
    listen = CGPreflightListenEventAccess()
    post   = CGPreflightPostEventAccess()
    ax     = AXIsProcessTrusted()
}

// The decisive check: create a listen-only tap and inspect the mask we were
// actually granted. A tap can come back non-nil with the keyboard bits stripped.
let mask: CGEventMask =
    (1 << CGEventType.keyDown.rawValue) |
    (1 << CGEventType.keyUp.rawValue) |
    (1 << CGEventType.flagsChanged.rawValue) |
    (1 << CGEventType.leftMouseDown.rawValue)
let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                            options: .listenOnly, eventsOfInterest: mask,
                            callback: { _, _, e, _ in Unmanaged.passUnretained(e) },
                            userInfo: nil)
let tapMade = tap != nil
var keyboardGranted = false
if let t = tap {
    keyboardGranted = CGEvent.tapIsEnabled(tap: t)
    CGEvent.tapEnable(tap: t, enable: false)
}

let out: [String: Any] = [
  "input_monitoring": listen, "post_event": post,
  "accessibility": ax, "tap_created": tapMade, "tap_enabled": keyboardGranted
]
let data = try! JSONSerialization.data(withJSONObject: out)
try! data.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
SWIFT

  if ! xcrun swiftc -O "$WORK/probe.swift" -o "$APP/Contents/MacOS/WWBProbe" 2>"$WORK/build.log"; then
    bad "Probe failed to compile."
    sed 's/^/         /' "$WORK/build.log" | head -8
  else
    # Self-signed identity if one exists, otherwise ad-hoc. Either proves the policy question.
    IDENT=$(security find-identity -v -p codesigning 2>/dev/null | grep -i "WWT Local Signing\|WWB Local Signing" | head -1 | awk '{print $2}')
    if [ -n "${IDENT:-}" ]; then
      codesign --force --sign "$IDENT" "$APP" >/dev/null 2>&1 && info "Signed with your local certificate."
    else
      codesign --force --sign - "$APP" >/dev/null 2>&1 && info "Ad-hoc signed (no local certificate found — fine for this test)."
    fi

    RESULT="$WORK/result.json"
    printf "\n"
    info "Launching the probe. macOS will ask for TWO permissions."
    info "Approve both in System Settings → Privacy & Security:"
    info "   • Input Monitoring"
    info "   • Accessibility"
    info "If a permission is greyed out, locked, or the app cannot be added at all,"
    info "that IS the finding — leave it and let this time out."
    printf "\n"
    "$APP/Contents/MacOS/WWBProbe" "$RESULT" 2>/dev/null &
    PROBE_PID=$!
    SECS=0
    while kill -0 "$PROBE_PID" 2>/dev/null && [ $SECS -lt 130 ]; do sleep 2; SECS=$((SECS+2)); printf "\r         waiting for you… %ss" "$SECS"; done
    printf "\r%*s\r" 40 ""
    wait "$PROBE_PID" 2>/dev/null

    if [ -f "$RESULT" ]; then
      R=$(cat "$RESULT")
      val() { python3 -c "import json,sys;print(json.loads(sys.argv[1]).get(sys.argv[2]))" "$R" "$1" 2>/dev/null; }
      [ "$(val input_monitoring)" = "True" ] && ok "Input Monitoring GRANTED to a self-signed app." \
                                             || bad "Input Monitoring NOT granted. Keyboard tracking is impossible on this Mac."
      { [ "$(val accessibility)" = "True" ] || [ "$(val post_event)" = "True" ]; } \
        && ok "Accessibility GRANTED (the jiggler would work)." \
        || huh "Accessibility not granted. Tracking still works; only the jiggler is lost."
      [ "$(val tap_enabled)" = "True" ] && ok "A listen-only event tap was created AND enabled." \
                                        || bad "Event tap could not be enabled. This is the core mechanism."
      CORE_TESTED=1
    else
      bad "Probe produced no result (timed out or was blocked from running)."
    fi
    # Leave no trace in the permission list.
    tccutil reset ListenEvent com.bpotter.wwbprobe >/dev/null 2>&1
    tccutil reset Accessibility com.bpotter.wwbprobe >/dev/null 2>&1
    tccutil reset PostEvent com.bpotter.wwbprobe >/dev/null 2>&1
    info "Cleaned up the probe's permission entries."
  fi
fi

# ─────────────────────────────────────────────────────────────── verdict
hdr "Verdict"
printf "  %s passed · %s failed · %s unknown\n\n" "$PASS" "$FAIL" "$UNKNOWN"
if [ "$FAIL" -eq 0 ] && [ "$CORE_TESTED" -eq 1 ]; then
  printf "  \033[32mGO.\033[0m Work Week Buddy can run on this Mac. Proceed to M1.\n\n"
  exit 0
elif [ "$FAIL" -eq 0 ]; then
  printf "  \033[33mINCONCLUSIVE.\033[0m Sections 1-2 look fine, but the permission test never ran,\n"
  printf "  and that is the only part that actually decides this. Re-run without --checks-only\n"
  printf "  (install Xcode CLT first if it asked you to).\n\n"
  exit 2
else
  printf "  \033[31mNO-GO as specified.\033[0m Report the failed lines above.\n"
  printf "  If Input Monitoring is the blocker, keyboard tracking is impossible here and\n"
  printf "  the product changes shape — mouse and camera alone still work, but the number\n"
  printf "  will run low. If the network is the blocker, the database vendor changes.\n\n"
  exit 1
fi
