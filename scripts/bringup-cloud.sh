#!/usr/bin/env bash
# Everything after `npx wrangler login`, in one command.
#
#   create the D1 database (or adopt the one that is already there)
#     → apply worker/schema.sql
#     → deploy the Worker
#     → mint the two per-machine tokens
#     → print exactly what to paste into the app
#
# ── WHAT THIS SCRIPT WILL NOT DO ────────────────────────────────────────────
# It never runs `wrangler login`. That is a browser OAuth flow against a real
# account with a real billing relationship, and it is the one step that has to
# be a person deciding. Run it yourself first:
#
#     npx wrangler login
#
# Everything after that is here, and this script is safe to run again: an
# existing database is adopted rather than duplicated, the schema is
# CREATE TABLE IF NOT EXISTS throughout, and a secret that is already set is
# left alone unless you ask for it to be rotated.
#
# ── THE MACHINE-ID TRAP ─────────────────────────────────────────────────────
# The Worker stamps machine_id from the TOKEN, never from the request body —
# that is what stops a stolen token forging the other Mac's rows. So each
# token's machine id has to be the IOPlatformUUID of the Mac that will carry it.
# Get it wrong and nothing breaks: both Macs sync, both mirrors converge, every
# total is correct, and the per-machine breakdown attributes your work to the
# wrong laptop. Forever, and silently. This script reads THIS Mac's UUID from
# ioreg and refuses to guess the other one.
set -euo pipefail

cd "$(dirname "$0")/.."

DB_NAME="wwb"
WORKER_DIR="worker"
TEMPLATE="${WORKER_DIR}/wrangler.toml"
# Generated, gitignored, and the one the deploy actually uses: the template is
# tracked and must stay free of a real database id.
GENERATED="${WORKER_DIR}/wrangler.generated.toml"
SCHEMA="${WORKER_DIR}/schema.sql"

WRANGLER_CMD=""
THIS_SLOT=""
MID_PERSONAL=""
MID_WORK=""
WORKER_URL=""
ROTATE=""
DRY_RUN=0

usage() {
  cat <<USAGE
usage: scripts/bringup-cloud.sh --this <personal|work> [options]

  --this SLOT              which Mac you are running this on. Required — its
                           IOPlatformUUID becomes that slot's machine id.

  --machine-id-personal ID  set a slot's machine id explicitly instead of
  --machine-id-work ID      reading it from this Mac.
  --rotate WHAT            mint a new value for an ALREADY-SET secret:
                           personal | work | tokens | machine-ids | all
  --worker-url URL         skip URL detection and use this one
  --db NAME                D1 database name (default "$DB_NAME")
  --wrangler CMD           run this instead of "npx wrangler" (tests)
  --dry-run                print every command; change nothing

You must have run \`npx wrangler login\` first. This script will not do it.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --this) THIS_SLOT="${2:?--this needs personal or work}"; shift 2 ;;
    --machine-id-personal) MID_PERSONAL="${2:?needs a UUID}"; shift 2 ;;
    --machine-id-work) MID_WORK="${2:?needs a UUID}"; shift 2 ;;
    --rotate) ROTATE="${2:?--rotate needs a value}"; shift 2 ;;
    --worker-url) WORKER_URL="${2:?--worker-url needs a URL}"; shift 2 ;;
    --db) DB_NAME="${2:?--db needs a name}"; shift 2 ;;
    --wrangler) WRANGLER_CMD="${2:?--wrangler needs a command}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

ok()   { printf "  \033[32m✓\033[0m  %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m  %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m  %s\n" "$1"; }
info() { printf "     %s\n" "$1"; }
hdr()  { printf "\n\033[1m%s\033[0m\n" "$1"; }
die()  { bad "$1"; exit 1; }

case "$THIS_SLOT" in
  personal|work) ;;
  "") bad "--this is required."; info "Which Mac is this: personal or work?"; exit 2 ;;
  *) die "--this must be 'personal' or 'work', not '$THIS_SLOT'." ;;
esac

case "$ROTATE" in
  ""|personal|work|tokens|machine-ids|all) ;;
  *) die "--rotate must be one of: personal work tokens machine-ids all" ;;
esac

# `npx wrangler` by default, so a fresh clone needs no global install; a single
# executable when a test hands us a fake one.
wr() {
  if [ -n "$WRANGLER_CMD" ]; then "$WRANGLER_CMD" "$@"; else npx wrangler "$@"; fi
}

# Mutating wrangler calls go through this, so --dry-run cannot create a database,
# deploy a Worker, or set a secret on a real account.
wr_run() {
  if [ "$DRY_RUN" = "1" ]; then printf "  + wrangler %s\n" "$*"; return 0; fi
  wr "$@"
}

# JSON is parsed by a JSON parser. wrangler's output is stable enough to grep
# right up until the day it is not, and the failure would be a bring-up that
# adopts the wrong database.
pick_uuid() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let rows = [];
      try { rows = JSON.parse(s); } catch { rows = []; }
      if (!Array.isArray(rows)) rows = rows.result ?? [];
      const hit = rows.find((r) => r && r.name === process.argv[1]);
      process.stdout.write(String(hit?.uuid ?? hit?.database_id ?? ""));
    });
  ' "$1"
}

secret_names() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let rows = [];
      try { rows = JSON.parse(s); } catch { rows = []; }
      if (!Array.isArray(rows)) rows = rows.result ?? [];
      process.stdout.write(rows.map((r) => r && r.name).filter(Boolean).join("\n"));
    });
  '
}

printf "\033[1mWork Week Buddy — cloud bring-up\033[0m\n"
info "database: $DB_NAME"
info "this Mac: $THIS_SLOT"
if [ "$DRY_RUN" = "1" ]; then warn "dry run: nothing will be created, deployed, or set"; fi

# ── 0. are you logged in ────────────────────────────────────────────────────
hdr "0. Cloudflare account"
WHOAMI="$(wr whoami 2>&1 || true)"
case "$WHOAMI" in
  *"You are logged in with"*)
    ok "logged in"
    ;;
  *)
    bad "not logged in to Cloudflare."
    info "Run this yourself, in a browser, and then re-run this script:"
    info ""
    info "    npx wrangler login"
    info ""
    info "It is deliberately not scripted: it authorises a real account that can"
    info "be billed, and that is a decision, not a step."
    exit 1
    ;;
esac

# ── 1. the database ─────────────────────────────────────────────────────────
hdr "1. D1 database"
DB_ID="$(wr d1 list --json 2>/dev/null | pick_uuid "$DB_NAME" || true)"

if [ -n "$DB_ID" ]; then
  ok "adopting the existing '$DB_NAME' ($DB_ID)"
  info "Not recreated. Re-running this script must never cost you a database."
elif [ "$DRY_RUN" = "1" ]; then
  wr_run d1 create "$DB_NAME"
  DB_ID="00000000-0000-0000-0000-000000000000"
  info "would then re-read the id from d1 list"
else
  info "no '$DB_NAME' yet — creating it"
  wr d1 create "$DB_NAME" >/dev/null
  DB_ID="$(wr d1 list --json 2>/dev/null | pick_uuid "$DB_NAME" || true)"
  [ -n "$DB_ID" ] || die "created '$DB_NAME' but cannot find its id in 'wrangler d1 list --json'."
  ok "created $DB_NAME ($DB_ID)"
fi

# ── 2. the config wrangler will actually use ────────────────────────────────
hdr "2. Config"
# The tracked wrangler.toml carries a placeholder id on purpose: this repo is
# public and the tracked files stay free of anything account-shaped. The real id
# goes into a generated, gitignored sibling, in the same directory so that
# `main = "src/index.ts"` still resolves.
if [ "$DRY_RUN" = "1" ]; then
  printf "  + write %s with database_id = %s\n" "$GENERATED" "$DB_ID"
else
  sed "s|^database_id = .*|database_id = \"${DB_ID}\"|" "$TEMPLATE" > "$GENERATED"
  grep -q "$DB_ID" "$GENERATED" || die "failed to write the database id into $GENERATED"
  ok "wrote $GENERATED"
fi
info "Every wrangler command below passes --config $GENERATED."

# ── 3. schema ───────────────────────────────────────────────────────────────
hdr "3. Schema"
# worker/schema.sql is docs/DATA_MODEL.md's cloud half verbatim, and is the same
# file worker/test/fake-d1.ts loads — so the tests run against the schema that
# is actually deployed rather than a paraphrase of it. Every statement in it is
# IF NOT EXISTS, which is what makes this step safe to repeat.
wr_run d1 execute "$DB_NAME" --remote --yes --file="$SCHEMA" --config "$GENERATED"
if [ "$DRY_RUN" != "1" ]; then ok "schema applied (CREATE TABLE IF NOT EXISTS throughout)"; fi

# ── 4. deploy ───────────────────────────────────────────────────────────────
hdr "4. Deploy the Worker"
if [ "$DRY_RUN" = "1" ]; then
  wr_run deploy --config "$GENERATED"
  DEPLOY_OUT=""
else
  DEPLOY_OUT="$(wr deploy --config "$GENERATED" 2>&1)"
  printf '%s\n' "$DEPLOY_OUT"
fi

if [ -z "$WORKER_URL" ]; then
  WORKER_URL="$(printf '%s' "$DEPLOY_OUT" \
    | grep -o 'https://[A-Za-z0-9._-]*\.workers\.dev' | head -1 || true)"
fi

if [ -n "$WORKER_URL" ]; then
  ok "worker URL: $WORKER_URL"
elif [ "$DRY_RUN" != "1" ]; then
  warn "could not find the workers.dev URL in the deploy output."
  info "It is the https://…workers.dev line above. Re-run with --worker-url to"
  info "have this script finish the rest of the bring-up with it."
fi

# ── 5. secrets ──────────────────────────────────────────────────────────────
hdr "5. Tokens and machine ids"

EXISTING="$(wr secret list --format json --config "$GENERATED" 2>/dev/null | secret_names || true)"

has_secret() {
  printf '%s\n' "$EXISTING" | grep -qx "$1"
}

should_rotate() {
  case "$1:$ROTATE" in
    *:all) return 0 ;;
    TOKEN_PERSONAL:tokens|TOKEN_WORK:tokens) return 0 ;;
    TOKEN_PERSONAL:personal|MACHINE_ID_PERSONAL:personal) return 0 ;;
    TOKEN_WORK:work|MACHINE_ID_WORK:work) return 0 ;;
    MACHINE_ID_PERSONAL:machine-ids|MACHINE_ID_WORK:machine-ids) return 0 ;;
    *) return 1 ;;
  esac
}

# Set only when absent or explicitly rotated. A secret cannot be read back out
# of Cloudflare, so a re-run that silently reset TOKEN_WORK would take the other
# Mac offline with no error anywhere until someone noticed the row count had
# stopped moving.
put_secret() {
  local name="$1" value="$2" note="$3"
  if has_secret "$name" && ! should_rotate "$name"; then
    ok "$name already set — left alone"
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    printf "  + printf '…' | wrangler secret put %s --config %s\n" "$name" "$GENERATED"
    return 0
  fi
  printf '%s' "$value" | wr secret put "$name" --config "$GENERATED" >/dev/null
  ok "$name set${note:+ ($note)}"
}

# 32 random bytes, base64. The token never touches the filesystem: it is piped
# straight into `wrangler secret put` and printed once, here, for you to paste.
mint_token() { openssl rand -base64 32; }

TOKEN_PERSONAL=""
TOKEN_WORK=""
# Nothing is minted in a dry run. A token printed by a run that did not upload
# it is worse than no token: it looks exactly like the real thing, and pasting
# it into the app produces 401s that read as a broken Worker.
if [ "$DRY_RUN" != "1" ]; then
  if ! has_secret TOKEN_PERSONAL || should_rotate TOKEN_PERSONAL; then
    TOKEN_PERSONAL="$(mint_token)"
  fi
  if ! has_secret TOKEN_WORK || should_rotate TOKEN_WORK; then
    TOKEN_WORK="$(mint_token)"
  fi
fi
put_secret TOKEN_PERSONAL "$TOKEN_PERSONAL" ""
put_secret TOKEN_WORK "$TOKEN_WORK" ""

# This Mac's IOPlatformUUID. ioreg needs no permission and no FFI, and it is the
# same value src/main/machine-id.ts reads, which is the point: the id the app
# stamps locally and the id the Worker stamps in the cloud have to be one value.
this_machine_id() {
  /usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null \
    | sed -n 's/.*"IOPlatformUUID" = "\([0-9A-Fa-f-]*\)".*/\1/p' | head -1
}

THIS_ID="$(this_machine_id || true)"
if [ "$THIS_SLOT" = "personal" ] && [ -z "$MID_PERSONAL" ]; then MID_PERSONAL="$THIS_ID"; fi
if [ "$THIS_SLOT" = "work" ] && [ -z "$MID_WORK" ]; then MID_WORK="$THIS_ID"; fi

if [ -n "$MID_PERSONAL" ]; then
  put_secret MACHINE_ID_PERSONAL "$MID_PERSONAL" "$MID_PERSONAL"
else
  warn "MACHINE_ID_PERSONAL not set — no IOPlatformUUID for the personal Mac."
fi
if [ -n "$MID_WORK" ]; then
  put_secret MACHINE_ID_WORK "$MID_WORK" "$MID_WORK"
else
  warn "MACHINE_ID_WORK not set — no IOPlatformUUID for the work Mac."
fi

if [ -z "$MID_PERSONAL" ] || [ -z "$MID_WORK" ]; then
  info ""
  info "Until BOTH are set, the Worker stamps the slot name ('personal' /"
  info "'work') instead of a UUID. Nothing errors: both Macs sync, both mirrors"
  info "converge, every total is right — and the per-machine breakdown is wrong,"
  info "because the app stamps the real UUID locally and the cloud stamps a word."
  info "Run this on the other Mac, or pass its UUID:"
  info ""
  info "    /usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID"
  info "    ./scripts/bringup-cloud.sh --this $THIS_SLOT --machine-id-work <UUID>"
fi

# ── 6. does it answer ───────────────────────────────────────────────────────
hdr "6. Check"
if [ -n "$WORKER_URL" ] && [ "$DRY_RUN" != "1" ]; then
  # /health is the one unauthenticated route, and it exists for exactly this:
  # proving reachability from the work Mac's network before any token is in play.
  HEALTH="$(curl -fsS --max-time 15 "${WORKER_URL}/health" 2>&1 || true)"
  case "$HEALTH" in
    *'"ok":true'*) ok "GET /health → $HEALTH" ;;
    *) warn "GET /health did not answer as expected: $HEALTH"
       info "If this is the work Mac, its proxy may be blocking workers.dev." ;;
  esac
else
  info "skipped (no URL yet)"
fi

# ── 7. what to paste ────────────────────────────────────────────────────────
hdr "7. Paste this into the app"
if [ "$DRY_RUN" = "1" ]; then
  info "dry run — no tokens were minted, so there is nothing to paste."
  exit 0
fi
printf "\n"
printf "  Worker URL   %s\n" "${WORKER_URL:-<the https://…workers.dev line above>}"
printf "\n"
if [ -n "$TOKEN_PERSONAL" ]; then
  printf "  personal Mac token:\n    %s\n\n" "$TOKEN_PERSONAL"
else
  info "personal Mac token: unchanged, and Cloudflare cannot read a secret back."
  info "  To replace it: ./scripts/bringup-cloud.sh --this $THIS_SLOT --rotate personal"
  printf "\n"
fi
if [ -n "$TOKEN_WORK" ]; then
  printf "  work Mac token:\n    %s\n\n" "$TOKEN_WORK"
else
  info "work Mac token: unchanged, and Cloudflare cannot read a secret back."
  info "  To replace it: ./scripts/bringup-cloud.sh --this $THIS_SLOT --rotate work"
  printf "\n"
fi
warn "This is the ONLY time these tokens are printed. Put them in 1Password now."
info "Each Mac gets ONE of them — the one whose machine id is that Mac's"
info "IOPlatformUUID. Swapping them attributes every row to the other laptop."
printf "\n"
info "The URL is an ordinary setting (settings.json). The token is not: it goes"
info "through Electron safeStorage into the Keychain and never touches a file."
info "See docs/BRINGUP.md step 9 for where they go."
