# BRINGUP — from a fresh clone to two Macs syncing

Do the steps in order. Each one says what you should see and what it means if
you do not, because most of the ways this goes wrong do not produce an error —
they produce a plausible wrong answer.

Read [`AGENTS.md`](../AGENTS.md) first if you are going to change anything.

## The shape of it

| Part | Where | Roughly |
|---|---|---|
| A. Go/no-go | the **work** Mac | 5 min |
| B. Certificate | the **personal** Mac, once ever | 2 min |
| C. Install | each Mac | 10 min each |
| D. Cloud | either Mac, once | 10 min |
| E. Second Mac | the **work** Mac | 15 min |
| F. Turning sync on | each Mac | 2 min each |

Two things in here are one-way. Losing `wwb.p12` costs you every permission
grant on both Macs. Rotating a token that is already set takes that Mac offline
until you paste the new one. Both are called out where they happen.

---

## Part A — the question that decides whether any of this is worth doing

### 1. Run the M0 spike on the **work** Mac

```bash
git clone https://github.com/brendanpotter00/work-week-buddy.git
cd work-week-buddy
./spike/run-m0.sh --checks-only    # safe, no prompts
./spike/run-m0.sh                  # the real test
```

**You should see** `PASS` on Input Monitoring for a locally built, self-signed
app, and `PASS` on reaching `*.workers.dev`.

**If Input Monitoring fails**, device management is blocking self-signed apps
and keyboard tracking is impossible on the machine that generates most of your
hours. Stop. The product changes shape and nothing below is worth doing yet.

**If the network check fails**, keyboard tracking still works and the local
mirror is still the source of truth for every screen — you just cannot sync from
this Mac. Do Parts B, C and E and skip Part D.

---

## Part B — the signing certificate (personal Mac, once ever)

This is what makes your permission grants survive a rebuild. Skip it and every
`./scripts/install.sh` re-prompts for Input Monitoring and Accessibility,
because an ad-hoc signature's designated requirement is literally the cdhash of
that one build — so macOS genuinely sees a different app each time.

The whole part is two commands and **no GUI**. If you remember it as involving
Keychain Access and a password prompt, that was the old version; see step 5.

### 2. Node

```bash
nvm install && nvm use     # honours .nvmrc → 22.14.0
node -v
```

**You should see** `v22.14.0`. **Anything else, especially 22.1.0**: that
version breaks stdio ESM and hangs the vitest forks pool, and `install.sh`
refuses to build on it.

### 3. Install and prove the checkout

```bash
npm ci
npm run lint && npm run typecheck && npm test
npm run smoke
```

**You should see** three clean runs and 1000-odd passing tests, then `smoke: OK`
after two windows flash open and closed. The smoke run is the only thing here
that opens a real window and measures it; the unit tests mount into a jsdom that
has no window, no size and no URL.

**If `npm ci` fails on a lockfile mismatch**, `package-lock.json` is out of date
with `package.json` — regenerate with `npm install` and commit it.

### 4. Mint the certificate

```bash
./scripts/make-signing-cert.sh
```

**You should see** `created ~/.wwb-signing/wwb.p12`, then `1 identity imported.`,
then a section headed **3. Prove it can sign** that ends with `signed a test
binary with WWB Local Signing` and prints the SHA-1 and the designated
requirement.

There is **no trust step and no password prompt.** Keychain Access will list
this certificate as untrusted forever, and that is correct — see step 5.

**If it says `MAC verification failed during PKCS12 import (wrong password?)`**,
you are on an old copy of the script. The `.p12` used to be exported with an
empty password and macOS rejects those outright. Pull.

**If it says `unknown option '-legacy'`**, likewise: `/usr/bin/openssl` is
LibreSSL and does not take that flag. The current script branches on
`openssl version`.

### 5. Check it — and do NOT trust it

```bash
./scripts/make-signing-cert.sh --show
```

**You should see** `identity present and able to sign`, a SHA-1, and the
designated requirement it signed with. Write the SHA-1 down; step 15 compares
against it.

**Keychain Access shows this certificate as untrusted. Leave it that way.**
Earlier versions of this document told you to set it to *Always Trust*, said the
step was required, and made `install.sh` refuse to run without it. That was
wrong, and it was the most confusing thing in the whole bring-up — the
certificate is hard to even find in Keychain Access, and the failure message
never says the word "trust".

Trust governs **chain validation**: Gatekeeper, `spctl`, and the `-v` flag of
`security find-identity`. None of them are involved here.

* `codesign` signs happily with an untrusted leaf — measured, both by SHA-1 and
  by common name.
* The requirement it produces is
  `identifier "com.bpotter.workweekbuddy" and certificate leaf = H"<sha1>"`.
  It pins the certificate by hash and names **no anchor**, so no chain is ever
  built and trust is never consulted.
* `SecCodeCheckValidity` against that requirement — the exact call `tccd` makes
  on a client process — returns `errSecSuccess` for a live, rebuilt, untrusted-
  cert-signed process.
* Gatekeeper never engages either: a locally built bundle carries no
  `com.apple.quarantine` attribute. `spctl` "rejects" the ad-hoc bundle that has
  been running fine all along, which is the proof that `spctl` is not the thing
  deciding anything here.

What actually depended on trust was this repo's own precondition check.
`security find-identity -v` hides any identity whose chain does not validate, so
a perfectly usable certificate was reported as `0 valid identities found`. The
check no longer uses `-v`; it resolves the identity and then signs a throwaway
binary with it.

**If you see `is in the keychain but codesign cannot sign with it`**, that is a
missing private key, not a trust problem. Delete the certificate in Keychain
Access and re-run step 4.

### 6. Back up `wwb.p12` **now**

```bash
open ~/.wwb-signing
```

Put `wwb.p12` in 1Password. The passphrase is `work-week-buddy` and is not a
secret — `scripts/make-signing-cert.sh` explains at length why.

**This is the one-way step.** Both Macs must import *this exact file*. A second,
locally generated certificate has a different public key, therefore a different
designated requirement, therefore no shared grants. Losing it means re-granting
Input Monitoring and Accessibility on both machines.

---

## Part C — install (personal Mac)

### 7. Install

```bash
./scripts/install.sh
```

It does `npm ci` → `npm run package` → `codesign` → stop the LaunchAgent →
replace `/Applications/Work Week Buddy.app` → **self-test (hard gate)** →
doctor (advisory) → launch-at-login. It is safe to re-run, and re-running it is
also the upgrade path.

**You should see** every section tick through to `7. Launch at login`, and a
`designated requirement:` line printed after the install. Write that line down —
it is what TCC remembers, and it is the thing to compare between the two Macs
when a grant mysteriously fails to transfer.

**If it stops at `0. Preconditions`**, go back to step 5.

**If it stops at `5. Self-test (hard gate)`**, do not work around it. The app
could not prove it can tell its own synthetic jiggle from human input. Left
running, the jiggler would be counted as work and your week would inflate with
fake time, silently. Run the command it prints to see which check failed.

**If macOS asks "Terminal wants to control Work Week Buddy"**, say yes. That is
the clean-quit Apple event for the copy that is already running; without it the
outgoing process is killed instead and its open interval is closed by crash
recovery rather than as `app_quit`.

### 8. First launch, and the two prompts

```bash
open "/Applications/Work Week Buddy.app"
```

**You should see** a menu-bar icon and **no Dock icon**. Onboarding asks for
**Input Monitoring** and **Accessibility**. Both need a human, once each.

**Once each is the literal truth.** macOS raises each prompt exactly once per
permission per code identity. Dismiss one, or click Deny, and the row is written
as denied and **no prompt ever appears again** — the app cannot summon one, and
the button that appears to offer it would do nothing. The app knows this
(`IOHIDCheckAccess` reports denied, not merely "not granted"), hides the button,
and tells you to tick the box yourself. To get the prompt back instead, see
*Starting the grants over* below.

**If there is no menu-bar icon**, check `~/Library/Logs/WorkWeekBuddy/`.

**Do not run it from `release/`.** A TCC grant binds to bundle id + designated
requirement + **on-disk path**. A bundle run from anywhere but
`/Applications/Work Week Buddy.app` has no permissions and tracks nothing —
without an error.

### 9. Confirm

```bash
npm run doctor
npm run launch-agent status
```

**You should see** green on both permissions, a live tap, a passing self-test —
and **`Last cloud write: not configured`**. That last one is correct at this
point and is a *state*, not a failure: there is no Worker yet, tracking runs at
full speed, and the rows are safe in the local mirror.

**If Input Monitoring says granted but the mask is empty**, that is trap #2 in
`AGENTS.md` and the app catches it deliberately. Toggle the app off and on in
System Settings → Privacy & Security → Input Monitoring, then relaunch.

If toggling does not fix it, the grant is recorded against a **different build**.
Check what the app is signed with:

```bash
codesign -dvvv "/Applications/Work Week Buddy.app" 2>&1 | grep -E 'Authority|Signature'
```

`Authority=WWB Local Signing` is right. `Signature=adhoc` means the bundle was
never re-signed, its designated requirement is the cdhash of one build, and the
stored grant belongs to a build that no longer exists. System Settings will
still show the checkbox ticked, because that row is keyed on the bundle id — but
the running app fails the stored requirement and is handed an empty event mask.
Re-run `./scripts/install.sh`, then start the grants over.

### Starting the grants over

Needed when a permission was denied, or when a grant was recorded against an
ad-hoc build. **Order matters** — the requirement is written at grant time from
whatever the app is signed with then, so signing has to come first:

```bash
./scripts/install.sh                                    # 1. sign with the real leaf
tccutil reset ListenEvent    com.bpotter.workweekbuddy  # 2. drop the stale rows
tccutil reset Accessibility  com.bpotter.workweekbuddy
tccutil reset PostEvent      com.bpotter.workweekbuddy
open "/Applications/Work Week Buddy.app"                # 3. grant once more
```

**Three resets, not two.** `tccutil reset X` is a literal string prefix — it
resets `kTCCServiceX` and validates nothing, so a typo is accepted and silently
matches no rows. This app's *Accessibility* is two services:
`kTCCServiceAccessibility` (`AXIsProcessTrusted`) and `kTCCServicePostEvent`
(`CGEventPost`, the jiggler). Reset only the first and a denied `PostEvent` row
survives, along with the dead end. `tccutil reset All com.bpotter.workweekbuddy`
does all three if you would rather not remember which.

`tccutil` needs no password, and it removes the row rather than denying it —
which is what makes the prompt available again. It resolves the bundle id
through LaunchServices, so the app has to be installed for it to work. Do this
**after** step 1, never before: reset first and you re-grant against the old
identity and are back where you started on the next rebuild.

Done in that order it is the last time: every later `install.sh` produces the
same designated requirement, so the grant survives.

---

## Part D — the cloud (once, from either Mac)

### 10. Log in to Cloudflare — you, in a browser

```bash
npx wrangler login
```

**This is the only step no script will do for you.** It authorises a real
account that can be billed. Nothing automated gets to make that call.

**You should see** a browser tab, an "Allow" button, and `Successfully logged
in.`

**If you get `command not found: wrangler`**, you are running it without `npx`.
Wrangler is a devDependency of this repo, not a global install.

### 11. Everything else, in one command

```bash
npm run bringup:cloud -- --this personal
```

Substitute `--this work` if you are doing this from the work Mac. It creates the
D1 database, applies `worker/schema.sql`, deploys the Worker, mints the two
per-machine tokens, sets this Mac's machine id, and prints what to paste.

**You should see**, in order: `logged in` → `created wwb (…)` → `schema applied`
→ a `https://…workers.dev` URL → four secrets set → `GET /health → {"ok":true,…}`
→ the two tokens.

**Put both tokens in 1Password immediately.** They are printed exactly once.
Cloudflare cannot read a secret back out, so a token you lose is a token you
have to rotate, and rotating takes that Mac offline until you paste the new one.

**If it stops at `0. Cloudflare account`**, go back to step 10.

**If `GET /health` fails from the work Mac**, its proxy is blocking
`workers.dev`. The Worker is fine; that Mac cannot reach it. `/health` is
unauthenticated precisely so you can test this before any token is involved.

**Re-running this is safe.** An existing database is adopted rather than
recreated, every statement in the schema is `CREATE TABLE IF NOT EXISTS`, and a
secret that is already set is left alone.

### 12. The machine-id caveat — read this one twice

The Worker stamps `machine_id` **from the token**, never from the request body.
That is what stops a stolen work token forging personal rows. The consequence is
that **each token's machine id must be that Mac's `IOPlatformUUID`**.

Get it wrong and *nothing fails*. Both Macs sync. Both mirrors converge. Every
weekly total is correct. And the per-machine breakdown attributes your work to
the wrong laptop — for ever, and with no error anywhere, because the app stamps
the real UUID on the row it writes locally and the Worker stamps something else
on the copy it stores.

Step 11 read this Mac's UUID from `ioreg` and set it. The **other** Mac's is
still unset until you run step 19. Until then the Worker stamps the literal
string `personal` or `work` in place of a UUID.

To check, on each Mac:

```bash
/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID
```

and set the other one without waiting:

```bash
npm run bringup:cloud -- --this personal --machine-id-work <THAT-MACS-UUID>
```

---

## Part E — the second Mac (work)

### 13. Clone, Node, install

```bash
git clone https://github.com/brendanpotter00/work-week-buddy.git
cd work-week-buddy
nvm install && nvm use
npm ci
```

### 14. Import **the same** certificate

Copy `wwb.p12` out of 1Password to `~/.wwb-signing/wwb.p12`, then:

```bash
mkdir -p ~/.wwb-signing     # then put the file there
./scripts/make-signing-cert.sh
```

**You should see** `reusing existing ~/.wwb-signing/wwb.p12 (same leaf ⇒ same
designated requirement)`.

**If you see `no wwb.p12 yet — minting a new leaf certificate`, stop and delete
what it just made.** It did not find the file, and a second certificate is the
most expensive mistake available here: the two Macs get different designated
requirements and their grants never transfer.

### 15. Check it

```bash
./scripts/make-signing-cert.sh --show
```

**The SHA-1 must match the personal Mac's**, byte for byte. If it does not, the
two Macs are running different certificates — go back to step 14.

Nothing to trust here either. Untrusted in Keychain Access is the expected and
correct state on both machines; step 5 says why.

### 16. Install

```bash
./scripts/install.sh
```

Same as step 7.

### 17. Grants

Same as step 8. These are per-Mac and cannot be copied; the certificate is what
makes them survive *rebuilds*, not what makes them transfer between machines.

### 18. Confirm

```bash
npm run doctor
```

### 19. Tell the cloud who this Mac is

```bash
npx wrangler login          # this Mac has its own browser session
npm run bringup:cloud -- --this work
```

**You should see** `adopting the existing 'wwb'`, `TOKEN_PERSONAL already set —
left alone`, `TOKEN_WORK already set — left alone`, and `MACHINE_ID_WORK set
(<this Mac's UUID>)`.

**If it says it created a database**, it is pointed at a different Cloudflare
account. Check `npx wrangler whoami` on both Macs.

**If it offers to print a token**, one of the secrets was missing and has just
been replaced — the other Mac now needs the new one.

---

## Part F — turning sync on

### 20. Where the two halves live

| | Stored in | Why |
|---|---|---|
| Worker URL | `settings.json` under Application Support | a URL is not a credential |
| Per-machine token | Electron `safeStorage` → the macOS Keychain (`sync-token.bin`) | it is |

Both go in through one IPC call, `wwb:sync:setConfig`, and take effect without a
relaunch. The token is write-only: the renderer can ask whether one exists and
can never read it back.

### 21. Paste both halves into Settings

Open the settings window. There are three routes and they all land in the same
place:

- the **menu-bar icon → Settings…** — the one to use, because the app is
  usually all tray and no window
- the **gear** at the top right of the dashboard
- **⌘,** while any window is focused

In **Cloud sync**:

1. Paste the **Worker URL** from step 20. A URL that is not a URL is rejected
   next to the field, before anything is written.
2. Paste **this Mac's token** — the one for *this* laptop. Step 20 printed one
   per Mac; swapping them files every hour under the other machine, and that
   mistake is invisible afterwards.
3. Press **Test connection** *before* Save. It calls the Worker's
   unauthenticated `/health` and then one authenticated read, so you get one of
   three answers rather than silence:
   - *reached the Worker and the token was accepted* — go ahead and Save.
   - *reachable but rejected this token* — the URL is right and the token is
     wrong. Usually the two tokens are the wrong way round.
   - *could not reach …* — the URL is wrong, the Worker is not deployed, or, on
     the work Mac, the proxy is blocking `workers.dev`. That is exactly why
     `/health` needs no token.
4. **Save.** It applies without a relaunch, and the badge at the top right of
   the card goes from *Not set up* to *Syncing*.

The token is write-only across the boundary: after Save the field is blank and
the pane can only ever learn that *a* token exists. There is nothing to read it
back with.

Do **not** hand-edit `sync-token.bin`. It is a `safeStorage` blob keyed to this
Mac's Keychain; an unreadable one is treated as absent, so the only effect would
be to look configured and silently not be.

### 22. What you should see

```bash
npm run doctor
```

`Last cloud write` goes from `not configured` to a timestamp, `pending` drops to
0, and the fingerprint line matches. `flush()` runs on interval close, on wake
and at launch; `pull()` runs after every successful flush.

---

## When something is wrong later

| Symptom | First thing to check |
|---|---|
| Permissions re-prompt after every rebuild | Are both Macs on the same `wwb.p12`? `./scripts/make-signing-cert.sh --show` on each; the SHA-1s must match. Then check the app is actually signed with it: `codesign -dvvv "/Applications/Work Week Buddy.app"` must say `Authority=WWB Local Signing`, **not** `Signature=adhoc`. |
| System Settings says granted, the app disagrees | The stored grant is against a *different* build. `codesign -d -r- "/Applications/Work Week Buddy.app"` — if it prints `cdhash H"…"` the app is ad-hoc signed and every rebuild broke the grant. Re-run `./scripts/install.sh`, then `tccutil reset ListenEvent com.bpotter.workweekbuddy` and grant it once more. From then on it sticks. |
| A permission prompt never appears | The row is **denied** (`auth_value = 0`), and macOS asks exactly once per permission per code identity. Nothing the app can do brings the prompt back. Either tick the box in System Settings › Privacy & Security, or `tccutil reset All com.bpotter.workweekbuddy` to make the prompts available again. `npm run doctor` names this explicitly, with the per-service commands. |
| Hours look too high | `"/Applications/Work Week Buddy.app/Contents/MacOS/Work Week Buddy" --selftest`. A failed jiggle discriminator is the one way this happens silently. |
| Nothing at login | `npm run launch-agent status`. A plist pointing at a missing app is a login that does nothing. |
| Sync silent | `npm run doctor`. Over 72 h silent is a hard red, not a warning. |
| Right totals, wrong machine | Step 12. The machine ids are swapped or unset. |
| A token leaked | `npm run bringup:cloud -- --this <this mac> --rotate work` (or `personal`). That Mac is offline until you paste the new token. |

## Reference

| | |
|---|---|
| Install path | `/Applications/Work Week Buddy.app` — frozen; TCC binds to it |
| Certificate | `~/.wwb-signing/wwb.p12`, CN `WWB Local Signing`, 20 years |
| LaunchAgent | `~/Library/LaunchAgents/com.bpotter.workweekbuddy.plist` |
| Logs | `~/Library/Logs/WorkWeekBuddy/` |
| App data | `~/Library/Application Support/Work Week Buddy/` |
| Generated wrangler config | `worker/wrangler.generated.toml` — gitignored, carries the real database id |
