import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => import("../../test/fakes/electron"));

import { APP_ORIGIN, CSP, resolveAppPath } from "./protocol";

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
