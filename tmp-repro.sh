#!/usr/bin/env bash
# Throwaway. Ad-hoc sign and launch via LaunchServices — the owner's exact path.
set -u
cd "$(dirname "$0")"
APP="$PWD/release/mac-arm64/Work Week Buddy.app"
codesign --force --deep --timestamp=none -s - "$APP" >/dev/null 2>&1
PROFILE="$(mktemp -d /tmp/wwb-verify-XXXXXX)"
echo "profile=$PROFILE"
open -n "$APP" --args --user-data-dir="$PROFILE"
sleep 25
echo "=== wwb.log ==="
cat "$PROFILE/wwb.log" 2>/dev/null || echo "(no log)"
echo "=== windows on screen ==="
python3 - <<'PY'
import Quartz
wl = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionAll, Quartz.kCGNullWindowID)
n = 0
for w in wl:
    o = str(w.get('kCGWindowOwnerName', ''))
    if 'Work Week' in o:
        b = w.get('kCGWindowBounds')
        print(f"  {int(b['Width'])}x{int(b['Height'])} pid={w.get('kCGWindowOwnerPID')}")
        n += 1
    elif 'SecurityAgent' in o and w.get('kCGWindowLayer') == 1000:
        print(f"  (SecurityAgent prompt on screen, layer 1000)")
print("  NO WINDOWS" if n == 0 else "")
PY
pkill -f "$APP/Contents/MacOS" 2>/dev/null
echo done
