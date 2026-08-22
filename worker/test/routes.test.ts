import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ROUTES, lookupRoute } from "../src/routes.js";
import { call, harness, TOKEN_A } from "./harness.js";

/**
 * docs/DATA_MODEL.md: rows are never deleted or updated; exclusion is a
 * query-time filter. The enforcement is the route surface — so it is tested,
 * not commented. These tests fail the moment a mutating handler is registered,
 * which is the only way that rule can survive ten years of edits.
 */

const PATHS = [
  "/health",
  "/intervals",
  "/heartbeat",
  "/machines",
  "/fingerprint",
  "/",
  "/intervals/abc",
] as const;

describe("the route table is the enforcement", () => {
  it("registers exactly six routes and no mutating method", () => {
    // `GET /machines` is a READ. It joined this list when device naming needed
    // a way for one Mac to learn the other's label, and it changes nothing
    // about the rule this file guards: the only writer is still `POST`, and a
    // machine label is still only ever set by the machine it names, through its
    // own heartbeat and its own token.
    expect(Object.keys(ROUTES).sort()).toEqual([
      "GET /fingerprint",
      "GET /health",
      "GET /intervals",
      "GET /machines",
      "POST /heartbeat",
      "POST /intervals",
    ]);
    for (const key of Object.keys(ROUTES)) {
      expect(key).toMatch(/^(GET|POST) \//);
    }
  });

  it("DELETE is unreachable on every path — 404, never a handler that declines", async () => {
    const { env } = harness();
    for (const path of PATHS) {
      const res = await call(env, {
        method: "DELETE",
        path,
        token: TOKEN_A, // authenticated, so 404 means "no such route"
      });
      expect(res.status, `DELETE ${path}`).toBe(404);
    }
  });

  it("UPDATE-shaped methods are unreachable on every path", async () => {
    const { env } = harness();
    for (const method of ["PUT", "PATCH"]) {
      for (const path of PATHS) {
        const res = await call(env, { method, path, token: TOKEN_A });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
  });

  it("a mutating request cannot change a row even when the id exists", async () => {
    const { env, db } = harness();
    await call(env, {
      method: "POST",
      path: "/intervals",
      token: TOKEN_A,
      body: { rows: [{ ...row(), id: "keep-me" }] },
    });
    const before = db.query("SELECT * FROM work_interval");

    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await call(env, {
        method,
        path: "/intervals",
        token: TOKEN_A,
        body: { rows: [{ ...row(), id: "keep-me", duration_s: 99_999 }] },
      });
      expect(res.status, method).toBe(404);
    }
    expect(db.query("SELECT * FROM work_interval")).toEqual(before);
  });

  it("the same path with a different method does not fall through to another handler", async () => {
    const { env } = harness();
    // POST /fingerprint and GET /heartbeat are not registered. If dispatch ever
    // keyed on path alone, one of these would answer 200.
    expect(
      (
        await call(env, {
          method: "POST",
          path: "/fingerprint",
          token: TOKEN_A,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(env, {
          method: "GET",
          path: "/heartbeat",
          token: TOKEN_A,
        })
      ).status,
    ).toBe(404);
  });

  it("an inherited Object property name cannot resolve to a handler", () => {
    // `ROUTES[key]` with a bare index would hand back Object.prototype.toString
    // for `GET /` + "toString". Object.hasOwn is what stops that.
    expect(lookupRoute("GET", "/health")).toBeDefined();
    expect(lookupRoute("toString", "")).toBeUndefined();
    expect(lookupRoute("constructor", "")).toBeUndefined();
    expect(lookupRoute("GET", "/nope")).toBeUndefined();
  });

  it("returns 500 rather than an unhandled rejection when a HANDLER's query fails", async () => {
    // The registry is intact, so the token authenticates; the table the handler
    // reads is gone. That is a genuine 500 and must not be dressed up as
    // anything else.
    const { env, db } = harness();
    db.raw.exec("DROP TABLE work_interval");
    const res = await call(env, {
      method: "GET",
      path: "/fingerprint",
      token: TOKEN_A,
    });
    expect(res.status).toBe(500);
  });

  it("returns 503, not 500, when the registry itself cannot be read", async () => {
    // A dead database fails at authentication, before any handler is reached.
    // 503 says "this deployment was never finished", which is the useful
    // diagnostic; a 500 would say nothing and a 401 would say the wrong thing.
    const { env, db } = harness();
    db.close(); // every query now throws
    const res = await call(env, {
      method: "GET",
      path: "/fingerprint",
      token: TOKEN_A,
    });
    expect(res.status).toBe(503);
  });
});

describe("no route can touch the machine registry", () => {
  /**
   * The registry is readable by `authenticate` and by nothing else. A route
   * that wrote it would let a stolen bearer token mint itself a second identity
   * or take another Mac offline — the blast radius this design exists to keep
   * at "append rows as myself". Enrolment and revocation are D1 REST writes
   * made with the Cloudflare API token, which can already destroy everything.
   *
   * Asserted over the source text, in the style of the tap-callback guard: a
   * behavioural test can only prove the routes that exist today do not do it.
   */
  it("no handler's SQL mentions machine_token", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/routes.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toContain("machine_token");
  });

  it("only auth.ts reads the registry, and it only SELECTs", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/auth.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toContain("FROM machine_token");
    // No write verb anywhere in the Worker's half of the registry contract.
    for (const verb of ["INSERT INTO machine_token", "UPDATE machine_token", "DELETE FROM machine_token"]) {
      expect(src, verb).not.toContain(verb);
    }
  });
});

function row(): Record<string, unknown> {
  return {
    id: "x",
    started_at_ms: 1,
    ended_at_ms: 2,
    duration_s: 1,
    end_reason: "idle_timeout",
    tz: "UTC",
    local_date: "2025-10-09",
    app_version: "0.1.0",
    closed_local_ms: 2,
  };
}
