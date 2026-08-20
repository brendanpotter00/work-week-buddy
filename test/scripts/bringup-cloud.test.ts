/**
 * `scripts/bringup-cloud.sh` — everything after `npx wrangler login`.
 *
 * Driven against `test/scripts/fake-wrangler.sh`, which answers the five
 * commands bring-up issues in the shapes wrangler 4 actually returns and
 * records every invocation. That is the only honest way to test this file: the
 * real one creates billable resources on a real account, and re-running it
 * wrongly would take a Mac offline with no error anywhere.
 *
 * The properties that matter are all about the SECOND run:
 *   * the database is adopted, not recreated
 *   * a secret that is already set is left alone — Cloudflare cannot read a
 *     secret back, so a silent reset of TOKEN_WORK would strand the work Mac
 *     until someone noticed the row count had stopped moving
 *   * the schema re-applies, because every statement in it is IF NOT EXISTS
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(REPO, "scripts", "bringup-cloud.sh");
const FAKE = join(REPO, "test", "scripts", "fake-wrangler.sh");
const GENERATED = join(REPO, "worker", "wrangler.generated.toml");

let scratch = "";

interface Run {
  code: number;
  out: string;
  /** Every `wrangler …` command line, in order. */
  calls: string[];
}

function bringup(args: readonly string[], env: NodeJS.ProcessEnv = {}): Run {
  const log = join(scratch, "calls.log");
  // Per RUN, not per test: the interesting assertions are about what the SECOND
  // run does, and an accumulating log would let the first run's `secret put`
  // masquerade as the second's.
  rmSync(log, { force: true });
  const r = spawnSync("bash", [SCRIPT, "--wrangler", FAKE, ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      FAKE_WRANGLER_STATE: join(scratch, "state"),
      FAKE_WRANGLER_LOG: log,
      PATH: `${dirname(process.execPath)}:${process.env["PATH"] ?? ""}`,
    },
  });
  const calls = existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean)
    : [];
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, calls };
}

/** What the fake recorded as having been piped into `wrangler secret put`. */
function storedSecret(name: string): string | null {
  const p = join(scratch, "state", `secret.${name}`);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "wwb-bringup-"));
  rmSync(GENERATED, { force: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  // The generated config names a live database. It is gitignored, but a test
  // that leaves one behind would have the next `wrangler deploy` from this
  // checkout point at a fake id.
  rmSync(GENERATED, { force: true });
});

describe("bringup-cloud.sh", () => {
  it("refuses to guess which Mac it is on", () => {
    // The machine id is stamped from the token, so a wrong slot mis-attributes
    // every row from that Mac — for ever, and without an error anywhere.
    const missing = bringup([]);
    expect(missing.code).toBe(2);
    expect(missing.out).toContain("--this is required");

    const wrong = bringup(["--this", "laptop"]);
    expect(wrong.code).toBe(1);
    expect(wrong.out).toContain("must be 'personal' or 'work'");
  });

  it("stops at the login it is not allowed to perform", () => {
    const r = bringup(["--this", "personal"], { FAKE_WRANGLER_LOGGED_IN: "0" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("npx wrangler login");
    // It asked, and then it stopped. It did not create anything.
    expect(r.calls).toEqual(["whoami"]);
  });

  it("creates, applies, deploys and sets — in that order", () => {
    // BOTH machine ids explicitly, so the call sequence is the same everywhere.
    // Left to `ioreg` this asserts four `secret put`s on macOS and three on the
    // Linux half of CI, where there is no ioreg and this Mac's slot goes unset.
    const r = bringup([
      "--this", "personal",
      "--machine-id-personal", "PERSONAL-UUID",
      "--machine-id-work", "WORK-UUID",
    ]);
    expect(r.code, r.out).toBe(0);

    const seq = r.calls.map((c) => c.split(" ").slice(0, 2).join(" "));
    expect(seq).toEqual([
      "whoami",
      "d1 list",     // is it already there?
      "d1 create",
      "d1 list",     // …and what id did it get
      "d1 execute",  // schema BEFORE the deploy
      "deploy --config",
      "secret list", // which secrets exist BEFORE setting any
      "secret put",
      "secret put",
      "secret put",
      "secret put",
    ]);
    // The schema comes from the file the Worker's own tests load, not from a
    // paraphrase of docs/DATA_MODEL.md.
    expect(r.calls.find((c) => c.startsWith("d1 execute"))).toContain(
      "--file=worker/schema.sql",
    );
    expect(r.calls.find((c) => c.startsWith("d1 execute"))).toContain("--remote");
  });

  it("writes the real database id into a generated config, never the tracked one", () => {
    const r = bringup(["--this", "personal"]);
    expect(r.code, r.out).toBe(0);

    expect(readFileSync(GENERATED, "utf8")).toContain(
      'database_id = "11111111-2222-3333-4444-555555555555"',
    );
    // The repo is public. The tracked template keeps its placeholder.
    expect(readFileSync(join(REPO, "worker", "wrangler.toml"), "utf8")).toContain(
      "REPLACE_AFTER_wrangler_d1_create",
    );
    // …and every wrangler call that needs a binding used the generated one.
    for (const call of r.calls.filter((c) => /^(d1 execute|deploy|secret)/.test(c))) {
      expect(call).toContain("--config worker/wrangler.generated.toml");
    }
  });

  it("prints the two tokens it actually uploaded", () => {
    const r = bringup(["--this", "personal"]);
    expect(r.code, r.out).toBe(0);

    const personal = storedSecret("TOKEN_PERSONAL");
    const work = storedSecret("TOKEN_WORK");
    expect(personal).toBeTruthy();
    expect(work).toBeTruthy();
    expect(personal).not.toBe(work);
    // Not "a token was generated" — THE token, the one now in Cloudflare.
    expect(r.out).toContain(personal as string);
    expect(r.out).toContain(work as string);
    expect(r.out).toContain("ONLY time these tokens are printed");
  });

  it("stamps this Mac's IOPlatformUUID onto this Mac's slot", () => {
    const r = bringup([
      "--this", "work",
      "--machine-id-personal", "PERSONAL-UUID",
    ]);
    expect(r.code, r.out).toBe(0);
    expect(storedSecret("MACHINE_ID_PERSONAL")).toBe("PERSONAL-UUID");

    const mine = spawnSync(
      "bash",
      [
        "-c",
        "/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice | " +
          "sed -n 's/.*\"IOPlatformUUID\" = \"\\([0-9A-Fa-f-]*\\)\".*/\\1/p' | head -1",
      ],
      { encoding: "utf8" },
    ).stdout.trim();
    if (mine) expect(storedSecret("MACHINE_ID_WORK")).toBe(mine);
  });

  it("says what a missing machine id costs, since nothing else will", () => {
    const r = bringup(["--this", "personal"]);
    expect(r.code, r.out).toBe(0);
    expect(storedSecret("MACHINE_ID_WORK")).toBeNull();
    expect(r.out).toContain("MACHINE_ID_WORK not set");
    // The failure mode, stated: it is not an error, it is a wrong answer.
    expect(r.out).toContain("stamps the slot name");
    expect(r.out).toContain("per-machine breakdown is wrong");
  });

  it("is safe to run again: adopts the database, leaves the secrets alone", () => {
    const first = bringup(["--this", "personal", "--machine-id-work", "WORK-UUID"]);
    expect(first.code, first.out).toBe(0);
    const token = storedSecret("TOKEN_PERSONAL");

    const second = bringup(["--this", "personal", "--machine-id-work", "WORK-UUID"]);
    expect(second.code, second.out).toBe(0);
    expect(second.out).toContain("adopting the existing 'wwb'");
    expect(second.calls.some((c) => c.startsWith("d1 create"))).toBe(false);
    expect(second.calls.some((c) => c.startsWith("secret put"))).toBe(false);
    expect(second.out).toContain("TOKEN_PERSONAL already set — left alone");
    expect(storedSecret("TOKEN_PERSONAL")).toBe(token);

    // The schema still re-applies. Every statement in it is IF NOT EXISTS, and
    // skipping it would mean a schema change never reaching a database that
    // already exists.
    expect(second.calls.some((c) => c.startsWith("d1 execute"))).toBe(true);
  });

  it("rotates exactly the slot it was asked to", () => {
    expect(bringup(["--this", "personal", "--machine-id-work", "W"]).code).toBe(0);
    const before = {
      personal: storedSecret("TOKEN_PERSONAL"),
      work: storedSecret("TOKEN_WORK"),
    };

    const r = bringup([
      "--this", "personal",
      "--machine-id-work", "W",
      "--rotate", "work",
    ]);
    expect(r.code, r.out).toBe(0);
    expect(storedSecret("TOKEN_PERSONAL")).toBe(before.personal);
    expect(storedSecret("TOKEN_WORK")).not.toBe(before.work);
    // The new work token is printed; the personal one cannot be, and the script
    // has to say why rather than print nothing.
    expect(r.out).toContain(storedSecret("TOKEN_WORK") as string);
    expect(r.out).toContain("Cloudflare cannot read a secret back");
  });

  it("rejects a --rotate target that does not exist", () => {
    const r = bringup(["--this", "personal", "--rotate", "everything"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("--rotate must be one of");
  });

  it("mints nothing and prints no token in --dry-run", () => {
    const r = bringup(["--this", "personal", "--dry-run"]);
    expect(r.code, r.out).toBe(0);
    // A token printed by a run that did not upload it looks exactly like a real
    // one and produces 401s that read as a broken Worker.
    expect(r.out).toContain("no tokens were minted");
    expect(r.out).not.toMatch(/[A-Za-z0-9+/]{40,}=/);
    expect(existsSync(GENERATED)).toBe(false);
    // Two reads and a third — `secret list` still runs, because "TOKEN_WORK is
    // already set" is exactly what a dry run is being asked. Nothing that
    // creates, deploys or sets is reached.
    expect(r.calls).toEqual(["whoami", "d1 list --json", "secret list --format json --config worker/wrangler.generated.toml"]);
  });
});
