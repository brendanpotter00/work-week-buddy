import { describe, it, expect } from "vitest";
import { ROUTES, lookupRoute } from "../src/routes.js";
import { call, harness, TOKEN_PERSONAL } from "./harness.js";

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
        token: TOKEN_PERSONAL, // authenticated, so 404 means "no such route"
      });
      expect(res.status, `DELETE ${path}`).toBe(404);
    }
  });

  it("UPDATE-shaped methods are unreachable on every path", async () => {
    const { env } = harness();
    for (const method of ["PUT", "PATCH"]) {
      for (const path of PATHS) {
        const res = await call(env, { method, path, token: TOKEN_PERSONAL });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
  });

  it("a mutating request cannot change a row even when the id exists", async () => {
    const { env, db } = harness();
    await call(env, {
      method: "POST",
      path: "/intervals",
      token: TOKEN_PERSONAL,
      body: { rows: [{ ...row(), id: "keep-me" }] },
    });
    const before = db.query("SELECT * FROM work_interval");

    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await call(env, {
        method,
        path: "/intervals",
        token: TOKEN_PERSONAL,
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
          token: TOKEN_PERSONAL,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(env, {
          method: "GET",
          path: "/heartbeat",
          token: TOKEN_PERSONAL,
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

  it("returns 500 rather than an unhandled rejection when the database fails", async () => {
    const { env, db } = harness();
    db.close(); // every query now throws
    const res = await call(env, {
      method: "GET",
      path: "/fingerprint",
      token: TOKEN_PERSONAL,
    });
    expect(res.status).toBe(500);
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
