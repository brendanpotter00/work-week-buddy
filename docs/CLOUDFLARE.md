# Cloudflare — what is deployed, and how to work with it

The cloud half of Work Week Buddy: one D1 database, one Worker, two tokens.
Set up on 2026-08-20 against the account `brendanpotter00@gmail.com`.

**No secrets in this file.** The two bearer tokens were printed once by
`npm run bringup:cloud` and cannot be read back from Cloudflare. They live in
1Password and, on each Mac, in the macOS Keychain via Electron `safeStorage`.
If they are lost, rotate rather than hunt for them — see below.

---

## What exists

| Thing | Value |
|---|---|
| Worker URL | `https://wwb-sync.work-week-buddy.workers.dev` |
| Worker name | `wwb-sync` |
| D1 database | `wwb` |
| Account | `brendanpotter00@gmail.com` |
| Cost | $0 — free plan, ~10 row-writes/day against a 100,000/day cap |

The real database id lives in `worker/wrangler.generated.toml`, which is
**gitignored**. The tracked `worker/wrangler.toml` is a template.

## The four routes

All require `Authorization: Bearer <token>` except `/health`.

| Route | Does |
|---|---|
| `GET /health` | liveness, unauthenticated |
| `POST /intervals` | insert closed intervals, returns which ids are now present |
| `GET /intervals?since=&limit=` | pull, paged by `seq` |
| `POST /heartbeat` | machine liveness and label |
| `GET /machines` | machine names, so each Mac can show the other's |

There is **no DELETE and no UPDATE**, and no arbitrary SQL. That is enforced by
the route surface, not by a comment: a leaked token cannot destroy history.

## Verifying it works

```bash
curl https://wwb-sync.work-week-buddy.workers.dev/health
# {"ok":true,"ms":...}
```

If that fails right after first deploy, it is almost certainly the workers.dev
certificate still being issued — DNS resolves before TLS is ready. It took about
two minutes on first setup. `curl` on macOS ships an old LibreSSL that reports
this as `sslv3 alert handshake failure`, which reads like a real error and is not.

Authenticated check, without putting the token in your shell history:

```bash
read -rs WWB_TOKEN            # paste, press enter
curl -H "authorization: Bearer $WWB_TOKEN" \
  https://wwb-sync.work-week-buddy.workers.dev/machines
unset WWB_TOKEN
```

`200` with a JSON body is healthy. `401` means the token is wrong — which is a
different problem from an unreachable URL, and the app's **Test connection**
button distinguishes them for exactly that reason.

## Turning sync on in the app

Menu-bar icon → **Settings…** (or ⌘,) → **Cloud sync**. Paste the Worker URL and
**that Mac's** token, press **Test connection**, then **Save**. No relaunch.

The URL is an ordinary setting in `settings.json`. The token is not: it goes
through `safeStorage` into the Keychain and never touches a file.

## One token per Mac — this matters

Bring-up mints two, bound to machine slots. **Swapping them does not error.** Both
Macs sync, both mirrors converge, every total is right — and the per-machine
breakdown attributes every hour to the wrong laptop, silently.

Related: `MACHINE_ID_WORK` is only set once bring-up has run *on* the work Mac,
because it needs that machine's `IOPlatformUUID`. Until then the Worker stamps
the literal word `work` instead of a UUID. Nothing breaks; only the per-machine
split is wrong. Fix by running bring-up there, or:

```bash
/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID
./scripts/bringup-cloud.sh --this personal --machine-id-work <UUID>
```

## Second Mac

```bash
npx wrangler login                        # its own browser session
npm run bringup:cloud -- --this work
```

Expect `adopting the existing 'wwb'` and `TOKEN_* already set — left alone`.

- **"created a database"** → it is pointed at a different Cloudflare account.
  Check `npx wrangler whoami` on both.
- **"offers to print a token"** → a secret was missing and has been replaced.
  The other Mac now needs the new one.

## Rotating a token

```bash
npm run bringup:cloud -- --this personal --rotate work
```

That Mac stops syncing until the new token is pasted into its Settings. Its
queued intervals are not lost — they sit in the local outbox and flush when it
can authenticate again.

## If the cloud disappears entirely

Every Mac holds a **complete** local mirror; the cloud is a reconciliation
target, never the source of truth. To rebuild it from a Mac:

```sql
UPDATE work_interval SET synced_at_ms = NULL;
```

then let the flush loop run. Note this re-stamps the *other* Mac's rows with the
rebuilding Mac's id — the same forgery guard that stops a stolen token faking
hours. To preserve attribution, rebuild from both Macs with each restricted to
its own `machine_id`.

## Where the rest lives

`docs/BRINGUP.md` is the full fresh-clone-to-syncing checklist, including the
parts that are not Cloudflare. `docs/DATA_MODEL.md` has the schema and the sync
protocol.
