/**
 * The embedded Worker must be the Worker.
 *
 * `src/cloud/worker-bundle.generated.ts` is a copy of `worker/` that ships
 * inside the app and gets uploaded to Cloudflare. A copy of another directory's
 * source is a stale copy waiting to happen, and the failure is the worst kind
 * this project sees: green tests, a successful deploy, and last month's Worker
 * running in production with nothing anywhere saying so.
 *
 * Two independent checks, because either alone is not enough:
 *
 *   1. THE HASH. A digest over `worker/src/*.ts`, `worker/schema.sql` and
 *      `worker/wrangler.toml` is recorded in the generated file and recomputed
 *      here. Edit the Worker without regenerating and this fails.
 *
 *   2. THE BUNDLE ACTUALLY RUNS. The hash only proves the INPUT was current. So
 *      the embedded JavaScript is written to a temp module, imported, and
 *      driven with real requests against `worker/test/fake-d1.ts` — the same
 *      `node:sqlite` D1 double the Worker's own tests use, loading the same
 *      `schema.sql`. If the bundle is broken, unbundled, or missing a module,
 *      this is where it shows.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { FakeD1 } from "../../worker/test/fake-d1";
import type { Env } from "../../worker/src/types";
import {
  WORKER_BUNDLE,
  WORKER_COMPATIBILITY_DATE,
  WORKER_INPUTS_SHA256,
  WORKER_MAIN_MODULE,
  WORKER_NAME,
  WORKER_SCHEMA_SQL,
} from "../../src/cloud/worker-bundle.generated";

const REPO = resolve(__dirname, "../..");

interface Bundler {
  hashWorkerInputs: (dir?: string) => string;
  readWranglerFields: (path?: string) => { name: string; compatibilityDate: string };
  renderCurrent: () => Promise<string>;
}

let bundler: Bundler;
let scratch = "";

beforeAll(async () => {
  bundler = (await import(
    pathToFileURL(join(REPO, "tools", "bundle-worker.mjs")).href
  )) as unknown as Bundler;
  scratch = mkdtempSync(join(tmpdir(), "wwb-bundle-"));
});

afterAll(() => {
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
});

describe("the embedded bundle is current", () => {
  it("matches worker/ — regenerate with `npm run bundle:worker` if this fails", () => {
    expect(
      WORKER_INPUTS_SHA256,
      "worker/ has changed but src/cloud/worker-bundle.generated.ts has not.\n" +
        "The wizard would deploy the previous version of the Worker.\n" +
        "Fix: npm run bundle:worker",
    ).toBe(bundler.hashWorkerInputs());
  });

  it("is byte-for-byte what the generator produces right now", async () => {
    // Catches the other half: an edit to `tools/bundle-worker.mjs` itself, or a
    // hand-edited generated file whose recorded hash was left alone.
    const { readFileSync } = await import("node:fs");
    const onDisk = readFileSync(
      join(REPO, "src", "cloud", "worker-bundle.generated.ts"),
      "utf8",
    );
    expect(onDisk).toBe(await bundler.renderCurrent());
  });

  it("carries wrangler.toml's name and compatibility date, not a restated copy", () => {
    // Both deploy paths — this one and `scripts/bringup-cloud.sh` — have to pin
    // the same runtime, or the Worker behaves differently depending on which
    // one last ran.
    const fields = bundler.readWranglerFields();
    expect(WORKER_NAME).toBe(fields.name);
    expect(WORKER_COMPATIBILITY_DATE).toBe(fields.compatibilityDate);
  });

  it("embeds worker/schema.sql verbatim", async () => {
    const { readFileSync } = await import("node:fs");
    expect(WORKER_SCHEMA_SQL).toBe(
      readFileSync(join(REPO, "worker", "schema.sql"), "utf8"),
    );
    // The property that makes re-applying it free, restated as a test rather
    // than trusted: every statement is guarded. Comments are stripped BEFORE
    // splitting — `-- server-assigned; the ONLY pull watermark` contains a
    // semicolon, and splitting first cuts a statement in half.
    const statements = WORKER_SCHEMA_SQL.replace(/--[^\n]*/g, "")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    expect(statements.length).toBeGreaterThan(3);
    for (const s of statements) expect(s).toMatch(/IF NOT EXISTS/i);
  });
});

describe("the embedded bundle is a working Worker", () => {
  interface WorkerModule {
    default: { fetch(req: Request, env: Env): Promise<Response> };
  }
  let mod: WorkerModule;
  let env: Env;

  beforeAll(async () => {
    const file = join(scratch, "worker-bundle.mjs");
    writeFileSync(file, WORKER_BUNDLE, "utf8");
    mod = (await import(pathToFileURL(file).href)) as unknown as WorkerModule;
    env = {
      DB: new FakeD1(),
      TOKEN_PERSONAL: "not-a-real-token-personal",
      TOKEN_WORK: "not-a-real-token-work",
      MACHINE_ID_PERSONAL: "MACHINE-A",
      MACHINE_ID_WORK: "MACHINE-B",
    };
  });

  it("is one self-contained ES module with a fetch handler", () => {
    expect(typeof mod.default.fetch).toBe("function");
    // Nothing may remain for the Workers runtime to resolve: it has no module
    // loader, no npm, and no node builtins.
    expect(WORKER_BUNDLE).not.toMatch(/^\s*import\s.*\sfrom\s/m);
    expect(WORKER_BUNDLE).not.toMatch(/\brequire\(/);
    expect(WORKER_BUNDLE).toMatch(/export\s*\{[\s\S]*as default/);
  });

  it("is named by main_module, so the multipart part name can match", () => {
    expect(WORKER_MAIN_MODULE).toBe("index.js");
  });

  it("answers /health without a token", async () => {
    const res = await mod.default.fetch(new Request("https://w/health"), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("still refuses an unauthenticated read", async () => {
    const res = await mod.default.fetch(new Request("https://w/machines"), env);
    expect(res.status).toBe(401);
  });

  it("still stamps machine_id from the TOKEN, not the body", async () => {
    // The forgery guard, exercised through the bundle rather than the source.
    // A bundler that dropped `auth.ts` would pass every check above and fail
    // exactly here.
    const res = await mod.default.fetch(
      new Request("https://w/intervals", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.TOKEN_PERSONAL}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          rows: [
            {
              id: "01900000-0000-7000-8000-000000000001",
              machine_id: "MACHINE-B", // a lie
              started_at_ms: 1,
              ended_at_ms: 2,
              duration_s: 1,
              end_reason: "idle_timeout",
              tz: "UTC",
              local_date: "2026-08-20",
              app_version: "0.1.0",
              closed_local_ms: 2,
            },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const pull = await mod.default.fetch(
      new Request("https://w/intervals?since=0", {
        headers: { authorization: `Bearer ${env.TOKEN_PERSONAL}` },
      }),
      env,
    );
    const body = (await pull.json()) as { rows: Array<{ machine_id: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.machine_id).toBe("MACHINE-A");
  });

  it("still has no DELETE and no UPDATE", async () => {
    for (const method of ["DELETE", "PUT", "PATCH"]) {
      const res = await mod.default.fetch(
        new Request("https://w/intervals", {
          method,
          headers: { authorization: `Bearer ${env.TOKEN_PERSONAL}` },
        }),
        env,
      );
      expect(res.status, `${method} /intervals`).toBe(404);
    }
  });
});
