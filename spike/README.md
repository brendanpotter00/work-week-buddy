# M0 spike

A single script that answers whether Work Week Buddy can run on a given Mac.

```bash
./run-m0.sh --checks-only   # management + network only, no permission prompts
./run-m0.sh                 # full test, including the two permission grants
```

**Safe on a work laptop:** no sudo, nothing installed permanently, no data leaves the machine. It builds a probe app in a temp directory, requests the permissions, records what was actually granted, then clears its own permission entries and deletes itself.

## What it checks

1. **Device management** — whether an MDM profile is present, and whether privacy-policy payloads exist that might pre-empt a grant. Informational: section 3 is the real test.
2. **Network** — whether Cloudflare Workers and API are reachable through whatever proxy or filter is in the way.
3. **Permissions** — the decisive one. Builds a self-signed app, asks for Input Monitoring and Accessibility, then creates a listen-only event tap and checks the mask that was *actually granted*. A tap can come back non-nil with the keyboard bits silently stripped, which is exactly the failure this is looking for.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | GO |
| 1 | NO-GO — something the product depends on is blocked |
| 2 | Inconclusive — the permission test did not run |
