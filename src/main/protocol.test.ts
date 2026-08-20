import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => import("../../test/fakes/electron"));

import { net, protocol, resetElectronMock } from "../../test/fakes/electron";
import { APP_ORIGIN, CSP, registerAppProtocol, resolveAppPath } from "./protocol";
import { resetLogSinkForTests } from "./log";

const ROOT = "/app/out/renderer";

describe("the app:// path resolver", () => {
  it("serves index.html for the bare origin", () => {
    expect(resolveAppPath(ROOT, `${APP_ORIGIN}/`)).toEqual({
      kind: "file",
      path: `${ROOT}/index.html`,
    });
  });

  it("M09: never resolves outside the renderer root", () => {
    // `new URL()` collapses plain `..` segments on its own, so these land back
    // inside the root and 404 on the way out. Asserting the INVARIANT (the
    // resolved path is under root) rather than the status code is what keeps
    // this test honest if that normalisation ever changes.
    for (const url of [
      `${APP_ORIGIN}/../../etc/passwd`,
      `${APP_ORIGIN}/assets/../../../etc/passwd`,
      `${APP_ORIGIN}/%2e%2e/%2e%2e/etc/passwd`,
    ]) {
      const r = resolveAppPath(ROOT, url);
      if (r.kind === "file") expect(r.path.startsWith(`${ROOT}/`)).toBe(true);
      else expect(r.status).toBe(403);
    }
  });

  it("M09: refuses an ENCODED-SLASH traversal, which URL parsing does not collapse", () => {
    // `..%2f..%2f` survives `new URL()` intact and only becomes `../../` after
    // decoding — which is precisely why the guard resolves FIRST and then
    // proves the result is still under root. Pattern-matching the raw URL for
    // ".." is the version of this check that gets bypassed.
    expect(resolveAppPath(ROOT, `${APP_ORIGIN}/..%2f..%2fetc/passwd`)).toEqual({
      kind: "error",
      status: 403,
      body: "forbidden",
    });
  });

  it("refuses a different host on our own scheme", () => {
    expect(resolveAppPath(ROOT, "app://evil/index.html").kind).toBe("error");
  });

  it("M10: the CSP keeps script-src 'self' and allows inline styles", () => {
    // 'unsafe-inline' on style-src is required, not laziness: Recharts writes
    // inline style attributes and @floating-ui positions with inline transforms.
    expect(CSP).toContain("style-src 'self' 'unsafe-inline'");
    // The FOUC killer is a real file, so scripts stay locked down.
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).toContain("default-src 'none'");
    expect(CSP).toContain("object-src 'none'");
    expect(CSP).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});

/**
 * A HANDLER THAT THROWS IS A WINDOW THAT NEVER OPENS AND NEVER SAYS WHY.
 *
 * `protocol.handle` swallows a rejected handler: the renderer gets a bare
 * network error, `ready-to-show` never fires because nothing painted, the
 * window stays hidden, and main logs nothing at all. That is a windowless app
 * with an empty stderr, which this project has now shipped once.
 *
 * Against a REAL directory, because `existsSync` is the guard being tested and
 * an ESM namespace cannot be spied on.
 */
describe("the app:// handler when something goes wrong", () => {
  const dirs: string[] = [];
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wwb-proto-"));
    dirs.push(root);
    writeFileSync(join(root, "index.html"), "<!doctype html><title>hi</title>");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetElectronMock();
    resetLogSinkForTests();
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function handle(url: string): Promise<Response> {
    registerAppProtocol(root);
    const fn = protocol.handlers.get("app") as (r: { url: string }) => Promise<Response>;
    return fn({ url });
  }

  it("answers 500 and LOGS, instead of rejecting, when the read blows up", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m: unknown) => {
      errors.push(String(m));
    });
    vi.spyOn(net, "fetch").mockRejectedValue(new Error("net::ERR_FILE_NOT_FOUND"));

    const res = await handle(`${APP_ORIGIN}/index.html`);

    // Not a rejection. A rejection here is invisible from both sides.
    expect(res.status).toBe(500);
    expect(errors.join("\n")).toMatch(/app:\/\/ FAILED/);
  });

  it("keeps the traversal guard and stamps the CSP on a real file", async () => {
    expect((await handle(`${APP_ORIGIN}/..%2f..%2fetc/passwd`)).status).toBe(403);
    expect((await handle(`${APP_ORIGIN}/nope.js`)).status).toBe(404);

    const ok = await handle(`${APP_ORIGIN}/index.html`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Security-Policy")).toBe(CSP);
    expect(ok.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
