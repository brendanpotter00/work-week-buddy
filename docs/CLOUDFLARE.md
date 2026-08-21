# Cloudflare — what is deployed, and how to work with it

The cloud half of Work Week Buddy: one D1 database, one Worker, two tokens.
Set up on 2026-08-20 against the account `brendanpotter00@gmail.com`.

**Setting this up from scratch is now a thing the app does** —
Settings → Cloud sync → *Set up cloud sync…*, no terminal required. Jump to
[Setting it all up from the app](#setting-it-all-up-from-the-app). The rest of
this page describes the cloud that setup produces and how to work with it.

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

---

# Setting it all up from the app

**This is the primary path.** Everything below `## What exists` describes a
cloud that already exists; this is how one comes into being, and it needs no
terminal, no `wrangler login` and no Node toolchain.

Menu-bar icon → **Settings…** → **Cloud sync** → **Set up cloud sync…**

It does exactly what `scripts/bringup-cloud.sh` does — adopt or create the `wwb`
database, apply `worker/schema.sql`, deploy the Worker, turn on the workers.dev
address, mint the two per-machine tokens, and store this Mac's half in the
Keychain — over the Cloudflare REST API instead of wrangler. It is safe to run
again: an existing database is adopted, and the other Mac's token is left alone
unless you explicitly ask to replace it.

The shell script still works and is still supported. See
[If the app cannot do it](#if-the-app-cannot-do-it).

## The one thing you have to do by hand: make an API token

1. Open **[dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)**
   (My Profile → API Tokens).
2. **Create Token** → scroll to the bottom → **Create Custom Token** → *Get started*.
3. Give it a name — `work-week-buddy setup` is fine.
4. Under **Permissions**, add these rows. All three are **Account** scope:

   | Scope | Permission | Level | Needed for |
   |---|---|---|---|
   | Account | **Workers Scripts** | **Edit** | uploading the Worker, and putting it on workers.dev |
   | Account | **D1** | **Edit** | creating the database and applying the schema |
   | Account | **Account Settings** | **Read** | *optional* — lets the app list your accounts instead of asking for the ID |

   The dashboard says **Edit** where the API docs say *Write*. They are the same
   permission.

5. Under **Account Resources**, choose **Include → the account you want this on**.
6. **Continue to summary** → **Create Token** → copy the token.
7. Paste it into the wizard. Nothing is created yet: the app runs a **read-only
   probe** first and shows you what is already on that account — an existing
   `wwb` database and how many intervals are in it, an existing Worker, whether
   the other Mac already has a token — before it offers to change anything.

**The token is used and thrown away.** It is never written to `settings.json`,
never encrypted into the Keychain beside the sync token, never logged, and never
returned over IPC. That is deliberate: unlike the Worker token, which can only
append rows to one table, this one can create and delete resources on a real
billable account, and holding it at rest is a much larger blast radius than the
convenience is worth. Re-running setup means pasting it again. You can delete it
in the Cloudflare dashboard the moment setup finishes.

`Account Settings: Read` is optional because Cloudflare documents `GET /accounts`
for API keys rather than for tokens. Without it the wizard cannot list your
accounts and asks for the **Account ID** instead — it is in the right-hand column
of any account's overview page in the dashboard.

## Which Mac is which — the app works it out

The Worker stamps `machine_id` from the token, so each token's machine id has to
be the `IOPlatformUUID` of the Mac carrying it. Getting it wrong is silent: both
Macs sync, both mirrors converge, every total is right, and every hour is filed
under the wrong laptop.

`scripts/bringup-cloud.sh` refuses to guess and makes you pass `--this`. The
wizard cannot refuse — not asking is the point — so it works it out instead, and
it tells you what it concluded and why.

**What makes that possible:** the wizard stores the machine ids as **`plain_text`
bindings** rather than as secrets. Cloudflare will not read a `secret_text` value
back, but it will read a `plain_text` one, and a machine id is not a secret —
`worker/wrangler.toml` already said as much. The Worker cannot tell the
difference (`env.MACHINE_ID_PERSONAL` is `env.MACHINE_ID_PERSONAL` either way),
and the app gains the one fact that settles the question: whether
`MACHINE_ID_PERSONAL` is *this* Mac's UUID or somebody else's.

So:

| What the app can see | What it concludes |
|---|---|
| `MACHINE_ID_PERSONAL` reads back as this Mac's UUID | this is the personal Mac |
| `MACHINE_ID_PERSONAL` reads back as a different UUID, work is free | this is the work Mac |
| Neither slot has a machine id | first Mac — takes `personal` |
| Both slots taken by other Macs | **asks** |

On a deployment the **shell script** made, the ids are secrets and unreadable.
There is still one sound inference: while `MACHINE_ID_WORK` is unset the Worker
stamps the literal word `work` for that slot, so any UUID in the database must
have come from the personal slot. If this Mac's UUID is on rows already, this
Mac is personal — certainly, not probably. If it is not, the app **asks** rather
than guesses. After one wizard run the ids are plain text and every later run on
either Mac is exact.

Tokens are always secrets and always will be.

## The other Mac's token

Shown **once**, at the end, with a copy button. Cloudflare cannot read a secret
back, so that is genuinely the only time it exists outside Cloudflare. Put it in
1Password, then paste it into the other Mac's Settings → Cloud sync.

Running the wizard again on this Mac does **not** mint a new one — it inherits
the existing token untouched, so a re-run cannot knock the other Mac offline.
If that token is lost, tick **Replace the other Mac's token too** on the
confirmation screen; that Mac then stops syncing until the new one is pasted in,
and its recorded hours wait in its local outbox in the meantime.

## Deploying the Worker without wrangler

The app ships the Worker's compiled source inside itself
(`src/cloud/worker-bundle.generated.ts`, produced by `npm run bundle:worker`) and
uploads it as a multipart script. Two details are load-bearing:

- **An upload replaces every binding**, and the per-machine tokens are bindings.
  The other Mac's token survives because the upload carries
  `{"type":"inherit","name":"TOKEN_WORK"}`.
- Every upload is sent with **`?bindings_inherit=strict`**. Cloudflare's own API
  schema says: *"Without this, unresolvable inherit bindings are silently
  dropped."* Silently dropping it is the other Mac offline behind a 200.

If you edit anything under `worker/`, run `npm run bundle:worker`.
`test/cloud/worker-bundle.test.ts` fails if you forget — it re-hashes
`worker/src/`, `worker/schema.sql` and `worker/wrangler.toml`, and it also
executes the embedded bundle against the `node:sqlite` D1 double to check the
thing actually runs.

## If the app cannot do it

`scripts/bringup-cloud.sh` is unchanged and still works. Use it when:

- you would rather not create an API token at all — the script uses
  `wrangler login`'s browser OAuth session instead;
- something about the account is unusual enough that the wizard stops;
- you are debugging, and want to see each wrangler command.

```bash
npx wrangler login
npm run bringup:cloud -- --this personal
```

The two paths interoperate. The script sets machine ids as secrets and the app
sets them as plain text; both are read the same way by the Worker, and neither
disturbs the other's tokens.

## One token per Mac — this matters

Bring-up mints two, bound to machine slots. **Swapping them does not error.** Both
Macs sync, both mirrors converge, every total is right — and the per-machine
breakdown attributes every hour to the wrong laptop, silently.

Related: `MACHINE_ID_WORK` is only set once setup has run *on* the work Mac,
because it needs that machine's `IOPlatformUUID`. Until then the Worker stamps
the literal word `work` instead of a UUID. Nothing breaks; only the per-machine
split is wrong. **That state is the current one** — and it is also what lets the
app work out that the personal Mac is the personal Mac, since a UUID in the
database while `MACHINE_ID_WORK` is unset can only have come from the personal
slot. Fix by running setup on the work Mac, or:

```bash
/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID
./scripts/bringup-cloud.sh --this personal --machine-id-work <UUID>
```

The app never mints a token for a slot it is not standing on, and never sets the
other Mac's machine id from this Mac — the same refusal-to-guess the script has,
for the same reason.

## Second Mac

In the app: **Settings… → Cloud sync → Set up cloud sync…**, paste an API token,
and it will detect that this is the work Mac and set only that slot. See
[Which Mac is which](#which-mac-is-which--the-app-works-it-out).

Or, with the shell script:

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
