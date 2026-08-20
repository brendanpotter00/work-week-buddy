---
name: m0-spike
description: Run the M0 go/no-go spike for Work Week Buddy on this Mac — checks whether a self-signed app can be granted Input Monitoring and Accessibility, and whether Cloudflare Workers is reachable. Use on a work or managed laptop before any implementation starts.
---

# M0 spike

The one question that has to be answered before any code is written: **can this Mac actually run Work Week Buddy?**

If device management blocks Input Monitoring for self-signed apps, keyboard tracking is impossible here — and on a work laptop that is the machine generating most of the hours. Nothing in the spec can determine this. Only trying it can.

## Run it

```bash
./spike/run-m0.sh --checks-only    # safe: management + network only, no prompts
./spike/run-m0.sh                  # the real test: also asks for the two permissions
```

Takes 2–3 minutes. No sudo. Nothing is installed permanently — it builds a tiny probe app in a temp directory, asks macOS for the permissions, records what it actually got, then removes its own permission entries and deletes itself.

## What to do with the result

**GO** — proceed to M1 in `docs/ROADMAP.md`.

**NO-GO** — report which line failed. The two failures mean different things:

| Failure | Consequence |
|---|---|
| Input Monitoring refused | Keyboard tracking impossible on this Mac. Mouse and camera still work, but the weekly number will run low. The product changes shape — raise it before building. |
| Network to Cloudflare blocked | The database vendor changes, not the product. Everything else in the spec holds. |
| Accessibility refused | Only the mouse jiggler is lost. Tracking is unaffected. Not a blocker. |

**INCONCLUSIVE** — the permission test did not run. Install Xcode Command Line Tools (`xcode-select --install`) and run it again. Sections 1 and 2 passing is not an answer.

## Reporting back

Paste the whole output. The verdict line alone is not enough — which check failed determines what changes.
