# Cloudflare — what is deployed, and how to work with it

The cloud half of Work Week Buddy: one D1 database, one Worker, and a registry
of however many Macs you have enrolled. Set up against the account
`brendanpotter00@gmail.com`.

**Setting this up is a thing the app does** — the tray's *Set up cloud sync…*,
or Settings → Cloud sync, no terminal required. Jump to
[Setting it all up from the app](#setting-it-all-up-from-the-app). The rest of
this page describes the cloud that setup produces and how to work with it.

**No secrets in this file, and none in Cloudflare either.** Each Mac mints its
own bearer token, keeps the plaintext in its own Keychain via Electron
`safeStorage`, and sends Cloudflare only the SHA-256. A dump of the database
therefore hands over nothing that can be presented as a credential. If a token
is lost, run setup again on that Mac — there is nothing to hunt for.

---

## What exists

| Thing | Value |
|---|---|
| Worker URL | `https://wwb-sync.work-week-buddy.workers.dev` |
| A second address | optional — setup can also put the Worker on a domain you own. Both are live; each Mac uses the one it can reach |
| Worker name | `wwb-sync` |
| D1 database | `wwb` |
| Account | `brendanpotter00@gmail.com` |
| Machines | as many as you enrol — `machine_token` in D1, nothing hardcoded to two |
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

**If you set up a second address, check both** — that is the whole reason there
are two. A hostname that answers from one Mac and not from another is the
expected outcome on a filtered network, not a fault:

```bash
curl https://wwb-sync.work-week-buddy.workers.dev/health
curl https://<your-name>.<your-domain>/health
```

A brand-new custom domain has no documented issuance SLA for its certificate.
Setup waits about three minutes and then gives up WITHOUT failing — it falls
back to the address that answered and says the other may work later. **Settings
→ Cloud sync → Test both addresses** re-asks, and offers to switch in one click.

The app itself now names the reason rather than reporting `fetch failed`: a
hostname that does not resolve, a connection a proxy dropped, a certificate
signed by an authority it does not trust, and a certificate that is merely still
being issued are four different problems with four different fixes, and they
used to produce one identical string.

Authenticated check, without putting the token in your shell history:

```bash
read -rs WWB_TOKEN            # paste, press enter
curl -H "authorization: Bearer $WWB_TOKEN" \
  https://wwb-sync.work-week-buddy.workers.dev/machines
unset WWB_TOKEN
```

`200` with a JSON body is healthy. Three failures, three different problems,
and the app's **Test connection** button distinguishes all of them:

| Answer | Means |
|---|---|
| connection refused / TLS error | the URL is wrong, or the network is |
| `401` | this token is in no live registry row — wrong token, or revoked |
| `503 machine registry unavailable` | the Worker is running but the schema was never applied. Run setup again; it applies the schema and changes nothing else. |

## Turning sync on in the app

Normally you never do this by hand — setup mints this Mac's token and stores it
for you. The fields exist for two cases: a Keychain that refused to store the
token (setup shows it once, so it can be pasted back), and a URL that needs
correcting.

Menu-bar icon → **Settings…** (or ⌘,) → **Cloud sync** → *Enter them by hand*.

The URL is an ordinary setting in `settings.json`. The token is not: it goes
through `safeStorage` into the Keychain and never touches a file.

**The two credentials are not interchangeable.** This Mac's sync token is 44
characters ending in `=`. A Cloudflare API token is 40 characters with no
padding, is only used during setup, and is never stored. The app warns if one
is pasted where the other belongs.

---

# Setting it all up from the app

**This is the primary path.** Everything below `## What exists` describes a
cloud that already exists; this is how one comes into being, and it needs no
terminal, no `wrangler login` and no Node toolchain.

Menu-bar icon → **Set up cloud sync…** (it is on the tray menu whenever sync is
unconfigured), or **Settings…** → **Cloud sync** → **Set up cloud sync…**. It
opens its own window.

It adopts or creates the `wwb` database, applies `worker/schema.sql`, **enrols
this Mac**, deploys the Worker, turns on its addresses, proves they answer, and
stores this Mac's token in the Keychain — over the Cloudflare REST API, no
wrangler involved.

**Addresses, plural, and that is the interesting part.** The workers.dev address
is always turned on. On the review screen you can also put the Worker on a
domain that is already on the same Cloudflare account — `wwb.your-domain.com`,
say. Setup then turns on **both**, asks **both** from the Mac it is running on,
saves whichever one that Mac can actually reach (preferring your own domain) and
remembers the other one.

Why: some work networks block `*.workers.dev` because everybody's Workers share
it. A domain you own usually gets through. Nothing is traded away for that —
both hostnames reach the same script, the same database and the same machine
registry, and the Worker stamps machine identity from the credential rather than
from the host, so which address a request arrives on is invisible to
correctness. A Mac on one network can use one address while a Mac on another
uses the other, and nothing needs changing when that happens.

Cloudflare creates the DNS record and issues the certificate. Setup **refuses**
a hostname that already has a DNS record or already belongs to a different
Worker — it never overrides one — and any of that failing costs a sentence
rather than a setup: the workers.dev address is already on by then.

**One thing to know about a custom domain:** it routes through your ZONE and
workers.dev does not. Anything configured on that domain — Bot Fight Mode, WAF
rules, rate limiting, Cloudflare Access — now applies to sync traffic. If the
custom address starts answering `403` on a token that works elsewhere, that is
where to look, and the app says so by name rather than blaming the token.

It is safe to run again. An existing database is adopted, never duplicated; the
Worker is redeployed with the same single `DB` binding; and only **this Mac's**
older tokens are retired. No run has ever touched another Mac's credential.

For a terminal escape hatch, see [If the app cannot do it](#if-the-app-cannot-do-it).

## The one thing you have to do by hand: make an API token

1. Open **[dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)**
   (My Profile → API Tokens).
2. **Create Token** → scroll to the bottom → **Create Custom Token** → *Get started*.
3. Give it a name — `work-week-buddy setup` is fine.
4. Under **Permissions**, add these rows. **Two are required and two can be
   skipped**, and neither optional one costs you a feature:

   | Scope | Permission | Level | Needed for | Optional? |
   |---|---|---|---|---|
   | Account | **Workers Scripts** | **Edit** | uploading the Worker, **and both of its addresses** | no |
   | Account | **D1** | **Edit** | creating the database and applying the schema | no |
   | Account | **Account Settings** | **Read** | lets the app list your accounts instead of asking for the ID | **yes** |
   | **Zone** | **Zone** | **Read** | lets the app list the domains you own instead of asking you to type one | **yes** |

   The dashboard says **Edit** where the API docs say *Write*. They are the same
   permission.

   **Putting the Worker on your own domain needs NO new permission.** It is
   authorised by `Workers Scripts · Edit`, which is already required — Cloudflare
   creates the DNS record with its own privileges, so no `DNS` permission, and a
   custom domain is not a route, so no `Workers Routes` permission either. The
   `Zone · Read` row buys a domain picker instead of a text field and nothing
   else: without it the app sends the domain by name.

5. Under **Account Resources**, choose **Include → the account you want this on**.
   If you added the `Zone` row, also set **Zone Resources → Include → All zones**.
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

## Nothing asks which Mac this is

The Worker stamps `machine_id` from the credential, so each token has to belong
to exactly one machine. Getting that wrong used to be possible and was silent:
both Macs synced, both mirrors converged, every total was right, and every hour
was filed under the wrong laptop.

**It is no longer constructible.** Each install enrols *itself*: it mints a
token, hashes it, and writes the hash next to its own `IOPlatformUUID`. A
machine can only ever enrol its own id, and only from the machine itself. There
is no slot to choose, no token to carry, and no question for the wizard to ask.

If `ioreg` cannot be read at all, setup **refuses to enrol** and says why —
filing a year of hours under a blank name is worse than a setup that stopped.

## The machine registry

`machine_token` in D1. One row per (machine, token):

| Column | |
|---|---|
| `token_sha256` | lowercase hex SHA-256 of the bearer token. **Primary key.** |
| `machine_id` | `IOPlatformUUID` — stamped onto every row this token writes |
| `enrolled_at_ms` | when |
| `revoked_at_ms` | `NULL` = live |

Three properties worth stating:

- **Cloudflare never holds a token.** Only a digest. The plaintext exists in
  that Mac's Keychain and nowhere else.
- **No Worker route can write this table.** A `POST /enrol` would let any valid
  token mint itself a second identity; a `POST /revoke` would let a stolen one
  take every other Mac offline. Enrolment and revocation are D1 REST writes that
  need the Cloudflare API token — the credential that can already delete
  everything.
- **Rows are never deleted.** Revocation sets `revoked_at_ms`. Same rule as
  `work_interval`, for the same reason: who could write, and when, is history.

There is deliberately **no label column**. A machine's name lives on the
`machine` table, written by that machine's own heartbeat, and the wizard
`LEFT JOIN`s for it. A second copy of a name is a rename that can half-fail.

## Adding a second Mac

Install the app there and run the same setup. It finds this database and this
Worker and enrols itself. **There is nothing to copy across** — no token in
1Password, no swap to get wrong.

The one honest trade: the second Mac needs its own Cloudflare API-token paste
rather than a Worker token handed to it. That is roughly the same effort and
strictly safer — no long-lived secret in a password manager, and nothing that
can be shown once and lost.

The review screen lists the Macs already enrolled, so you can see what exists
rather than guess.

## Revoking a Mac

On the wizard's review screen, next to that machine. It takes effect on that
Mac's **next request**. Nothing it has already recorded is deleted — its hours
stay in the cloud and on that Mac, and anything it has not yet sent waits in its
outbox. To bring it back, run setup on that Mac again.

There is no Revoke for the Mac you are standing on: running setup again already
does that, and does it in the order that cannot leave this Mac offline (enrol
the new token, store it, *then* retire the old one).

## Deploying the Worker without wrangler

The app ships the Worker's compiled source inside itself
(`src/cloud/worker-bundle.generated.ts`, produced by `npm run bundle:worker`) and
uploads it as a multipart script. Two details are load-bearing:

- **An upload replaces every binding.** That used to be dangerous: per-machine
  tokens *were* bindings, so an upload that forgot one deleted it. Credentials
  now live in `machine_token`, so the Worker's only binding is `DB` and there is
  nothing an upload can silently destroy.
- Every upload is still sent with **`?bindings_inherit=strict`**. Cloudflare's
  own API schema says: *"Without this, unresolvable inherit bindings are
  silently dropped."* Nothing is inherited any more, but the flag costs nothing
  and is the guarantee any future binding will want.

If you edit anything under `worker/`, run `npm run bundle:worker`.
`test/cloud/worker-bundle.test.ts` fails if you forget — it re-hashes
`worker/src/`, `worker/schema.sql` and `worker/wrangler.toml`, and it also
executes the embedded bundle against the `node:sqlite` D1 double to check the
thing actually runs.

## If the app cannot do it

There is no longer a `bringup-cloud.sh`. It was deleted, and the reasoning
matters: it was the artefact that produced the two-slot model in the first place
(`--this personal|work`, `--rotate`, `MACHINE_ID_PERSONAL`), and keeping it
would mean implementing the enrolment protocol **twice** — insert-then-revoke
ordering, hex validation, "revoke only after the Keychain commit" — in two
languages, where drift means silent misattribution or a Mac offline.

What replaces it is a recipe rather than a maintained script. `wrangler` stays
in `devDependencies`, pinned, and `worker/wrangler.toml` remains the single
source of the Worker's `name` and `compatibility_date` for
`tools/bundle-worker.mjs` — but it is no longer on any automated path.

```bash
npx wrangler login
npx wrangler d1 create wwb                     # skip if it already exists

# Put the real database_id into a gitignored copy of the config
sed "s|^database_id = .*|database_id = \"$DB_ID\"|" worker/wrangler.toml \
  > worker/wrangler.generated.toml

npx wrangler d1 execute wwb --remote --file=worker/schema.sql \
  --config worker/wrangler.generated.toml
npx wrangler deploy --config worker/wrangler.generated.toml

# Mint a token for THIS Mac and enrol it. The token never touches the network;
# only its SHA-256 does.
TOKEN="$(openssl rand -base64 32)"
HASH="$(printf %s "$TOKEN" | shasum -a 256 | cut -d' ' -f1)"
UUID="$(/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice \
        | sed -n 's/.*"IOPlatformUUID" = "\([0-9A-Fa-f-]*\)".*/\1/p' | head -1)"
npx wrangler d1 execute wwb --remote --config worker/wrangler.generated.toml \
  --command "INSERT INTO machine_token (token_sha256, machine_id, enrolled_at_ms) \
             VALUES ('$HASH','$UUID',$(date +%s)000);"

echo "$TOKEN"   # paste into Settings → Cloud sync → Enter them by hand
```

Revocation is now genuinely a one-liner:

```bash
npx wrangler d1 execute wwb --remote --config worker/wrangler.generated.toml \
  --command "UPDATE machine_token SET revoked_at_ms = $(date +%s)000 \
             WHERE machine_id = '<UUID>' AND revoked_at_ms IS NULL;"
```

## If a token leaks

Revoke that machine — from the wizard, or with the `UPDATE` above. It stops
working on its next request. Then run setup on that Mac to enrol a fresh token.

Because Cloudflare only ever held a hash, a leak of the *database* is not a leak
of any credential.

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
