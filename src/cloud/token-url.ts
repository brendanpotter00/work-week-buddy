/**
 * Where the Cloudflare API token is made.
 *
 * Failure #1 of the four watched live: he went looking for "Create Token" while
 * on the Worker's page. API tokens are under the USER PROFILE — not inside an
 * account, a Worker, or a database — and naming that path in a paragraph did
 * not help someone who was already somewhere else.
 *
 * ── THE DEEP LINK IS AN ACCELERATOR, NEVER THE ONLY PATH ────────────────────
 * Cloudflare's dashboard accepts query parameters that open Create Custom Token
 * with the permission rows already populated. Two things follow, and the second
 * is why the visible checklist stays on screen regardless:
 *
 *   • It works and is now documented — `permissionGroupKeys` carrying a
 *     URI-encoded JSON array of `{key, type}`, plus `accountId=*`, `zoneId=all`
 *     and an optional `name`. It was undocumented convention for years.
 *   • Permission-group KEY STRINGS are not a stable API and Cloudflare has
 *     renamed them before. If a key ever stops matching, that row simply does
 *     not appear pre-ticked — silently. Nothing here can detect that.
 *
 * So the screen always renders all three permissions as a checklist the reader
 * can follow by hand, and this link only saves them the clicking. If the whole
 * mechanism ever disappears, `TOKEN_PAGE_URL` is still correct and the flow is
 * still complete.
 *
 * No imports, no side effects: pure string building, so a test can assert the
 * encoding without a browser.
 */

/** The plain profile page. Correct forever, with or without the parameters. */
export const TOKEN_PAGE_URL = "https://dash.cloudflare.com/profile/api-tokens";

/** The token name offered in the dashboard form. Cosmetic. */
export const TOKEN_NAME = "Work Week Buddy";

/**
 * The three permissions setup needs, in the order the screen lists them.
 *
 * `key` is the dashboard's permission-group key; `type` is `read` or `edit`.
 * `label` is how the dashboard's own token editor spells it — note it says
 * **Edit** where Cloudflare's API docs say *Write*; they are the same
 * permission, and saying so on screen prevents a real moment of doubt.
 *
 * All three are ACCOUNT scope. Account Settings · Read is genuinely optional:
 * without it setup simply asks for the account ID instead of listing accounts.
 */
export const TOKEN_PERMISSIONS = [
  {
    key: "workers_scripts",
    type: "edit",
    label: "Account · Workers Scripts · Edit",
    why: "deploys the Worker and its address",
    optional: false,
  },
  {
    key: "d1",
    type: "edit",
    label: "Account · D1 · Edit",
    why: "creates the database and applies the schema",
    optional: false,
  },
  {
    key: "account_settings",
    type: "read",
    label: "Account · Account Settings · Read",
    why: "optional — lets setup list your accounts instead of asking for the ID",
    optional: true,
  },
] as const;

export type TokenPermission = (typeof TOKEN_PERMISSIONS)[number];

/**
 * The token page with Create Custom Token pre-filled.
 *
 * Falls back to `TOKEN_PAGE_URL` if the URL cannot be built for any reason —
 * a link that opens the right page beats a link that throws.
 */
export function tokenCreateUrl(): string {
  try {
    const url = new URL(TOKEN_PAGE_URL);
    url.searchParams.set("name", TOKEN_NAME);
    url.searchParams.set(
      "permissionGroupKeys",
      JSON.stringify(TOKEN_PERMISSIONS.map((p) => ({ key: p.key, type: p.type }))),
    );
    // Documented as required for the user-token form. `*` is every account and
    // `all` is every zone: this is only what the FORM starts out showing, and
    // the reader still picks the account under Account Resources.
    url.searchParams.set("accountId", "*");
    url.searchParams.set("zoneId", "all");
    return url.toString();
  } catch {
    return TOKEN_PAGE_URL;
  }
}
