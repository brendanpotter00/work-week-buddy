/**
 * The Cloudflare token deep link.
 *
 * The URL is built in MAIN and opened with `shell.openExternal` — the renderer
 * asks for "the token page" and does not get to say where that is. So the
 * encoding cannot be asserted through the UI, and it is asserted here instead.
 *
 * ── WHAT THIS CAN AND CANNOT PROVE ─────────────────────────────────────────
 * It proves the URL we emit has the shape Cloudflare documents for the
 * user-token template form. It CANNOT prove the dashboard still honours the
 * permission-group keys — those are not a versioned API and Cloudflare has
 * renamed them before, and a renamed key fails SILENTLY by simply not
 * pre-ticking that row.
 *
 * That is exactly why the wizard renders all three permissions as a visible
 * checklist regardless, and why `tokenCreateUrl()` degrades to the plain
 * profile URL rather than throwing. The link is an accelerator; the checklist
 * is the instruction.
 */
import { describe, it, expect } from "vitest";

import { TOKEN_PAGE_URL, TOKEN_PERMISSIONS, tokenCreateUrl } from "../../src/cloud/token-url";

describe("tokenCreateUrl", () => {
  it("points at the user profile, which is where API tokens actually live", () => {
    // Onboarding failure #1 was looking for "Create Token" on a Worker's page.
    const url = new URL(tokenCreateUrl());
    expect(url.origin).toBe("https://dash.cloudflare.com");
    expect(url.pathname).toBe("/profile/api-tokens");
    expect(TOKEN_PAGE_URL).toBe("https://dash.cloudflare.com/profile/api-tokens");
  });

  it("carries every permission key as a URI-encoded JSON array", () => {
    const url = new URL(tokenCreateUrl());
    const raw = url.searchParams.get("permissionGroupKeys");
    expect(raw).not.toBeNull();

    const parsed = JSON.parse(raw ?? "[]") as Array<{ key: string; type: string }>;
    expect(parsed).toEqual([
      { key: "workers_scripts", type: "edit" },
      { key: "d1", type: "edit" },
      { key: "account_settings", type: "read" },
      // The one new row, and it is optional. Attaching a custom domain needs no
      // new permission at all — this only buys a domain picker.
      { key: "zone", type: "read" },
    ]);
  });

  it("sends the account and zone scopes the documented form requires", () => {
    const url = new URL(tokenCreateUrl());
    expect(url.searchParams.get("accountId")).toBe("*");
    expect(url.searchParams.get("zoneId")).toBe("all");
    expect(url.searchParams.get("name")).toBe("Work Week Buddy");
  });

  it("is properly encoded — the JSON must not leak raw braces into the query", () => {
    const emitted = tokenCreateUrl();
    expect(emitted).toContain("permissionGroupKeys=");
    expect(emitted).not.toContain('{"key"');
    // And it round-trips: whatever we emit parses back to the same three rows.
    expect(new URL(emitted).searchParams.get("permissionGroupKeys")).toContain("workers_scripts");
  });

  it("lists the same permissions the wizard renders as a checklist", () => {
    // The deep link and the visible checklist come from ONE list, so a key that
    // is added or renamed cannot appear in the URL and not on screen.
    expect(TOKEN_PERMISSIONS.map((p) => p.key)).toEqual([
      "workers_scripts",
      "d1",
      "account_settings",
      "zone",
    ]);
    for (const p of TOKEN_PERMISSIONS) {
      // The dashboard's own spelling, which the screen shows verbatim. It says
      // "Edit" where Cloudflare's API docs say "Write"; the screen says so too.
      // Every label still names its level — it just is not "Account" for all of
      // them any more, and the Zone row is added in the OTHER half of the form.
      expect(p.label.startsWith(`${p.level} · `)).toBe(true);
      expect(p.why).not.toBe("");
    }
    // Two are optional, and neither of them costs a feature: without them setup
    // asks for the account ID, and asks you to type the domain.
    expect(TOKEN_PERMISSIONS.filter((p) => p.optional).map((p) => p.key)).toEqual([
      "account_settings",
      "zone",
    ]);
    // Everything REQUIRED is still an account row. That matters: it is the
    // whole reason the new one can be skipped.
    expect(TOKEN_PERMISSIONS.filter((p) => !p.optional).every((p) => p.level === "Account")).toBe(
      true,
    );
  });

  it("does not ask for DNS, or for Workers Routes", () => {
    // Neither is needed and both would be a real cost. Cloudflare writes the
    // custom domain's DNS record with its own privileges, and Workers Routes
    // governs route patterns — a different feature entirely. Nothing may quietly
    // add either while "making the domain work".
    const keys = TOKEN_PERMISSIONS.map((p) => p.key);
    expect(keys).not.toContain("dns");
    expect(keys).not.toContain("workers_routes");
  });

  it("is a plain string built from nothing — no imports, no I/O, no clock", () => {
    // Called during a render to decide whether to show the "already ticked"
    // sentence, so it has to be free and deterministic.
    expect(tokenCreateUrl()).toBe(tokenCreateUrl());
  });
});
