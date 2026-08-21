import js from "@eslint/js";
import ts from "typescript-eslint";
import globals from "globals";

// ESLint flat config merges `rules` with later-wins PER RULE NAME, not per
// entry. So any block that redefines no-restricted-properties replaces every
// earlier entry for the files it matches. Share the list rather than repeat it.
const POLLUTED_APIS = [
  { object: "powerMonitor", property: "getSystemIdleTime",
    message: "Polluted by CGEventPost. Use lastRealSignalMs." },
  { object: "powerMonitor", property: "getSystemIdleState",
    message: "Polluted by CGEventPost. Use lastRealSignalMs." },
];

const NO_CLOCK = {
  object: "Date", property: "now",
  message: "src/core/ takes nowMs as a parameter. Never read the clock.",
};

export default ts.config(
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    languageOptions: {
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
      globals: { ...globals.node },
    },
  },

  // ── The polluted-API rule. AGENTS.md #7. These are reset by our own jiggler,
  //    so a tracker built on them reports 24-hour workdays, silently.
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    rules: {
      "no-restricted-properties": ["error", ...POLLUTED_APIS],
      "no-restricted-syntax": ["error", {
        selector: "CallExpression[callee.name='CGEventSourceSecondsSinceLastEventType']",
        message: "Reset by our own jiggler at every tap location. Use the per-event-type counters or lastRealSignalMs.",
      }],
    },
  },

  // ── Purity. src/core/ is a pure reducer over timestamps-as-data, which is
  //    why its tests run on Linux in CI and why a 15-minute test is arithmetic
  //    rather than a 15-minute wait.
  {
    files: ["src/core/**/*.ts"],
    ignores: ["src/core/**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "electron", message: "src/core/ must stay pure. Pass what you need in as a parameter." },
          { name: "koffi", message: "src/core/ must stay pure." },
        ],
        patterns: [
          { group: ["node:*"], message: "src/core/ must stay pure — no node builtins." },
          { group: ["../native/*", "../store/*", "../main/*", "@/native/*", "@/store/*", "@/main/*"],
            message: "src/core/ may not depend on any impure layer." },
        ],
      }],
      // Time is a parameter, never ambient. A reducer that reads the clock
      // cannot be tested for the sleep/wake cases, which is where the bugs are.
      // POLLUTED_APIS is repeated here because this block matches src/core/
      // and would otherwise replace the general block's entries entirely.
      "no-restricted-properties": ["error", NO_CLOCK, ...POLLUTED_APIS],
    },
  },

  // ── src/cloud/ talks to Cloudflare and to nothing else in this app.
  //    It is layered like src/sync/: no electron, no keychain, no database, so
  //    the whole bring-up runs in plain Node against a fake Cloudflare and the
  //    tests never need a real account. src/main/cloud-setup.ts owns the three
  //    impure parts — this Mac's UUID, the randomness, and safeStorage.
  {
    files: ["src/cloud/**/*.ts"],
    ignores: ["src/cloud/**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "electron", message: "src/cloud/ must stay testable in plain Node. Pass what you need in as a parameter." },
          { name: "koffi", message: "src/cloud/ has no native dependency." },
        ],
        patterns: [
          { group: ["../main/*", "../store/*", "../native/*", "@/main/*", "@/store/*", "@/native/*"],
            message: "src/cloud/ may not depend on the app's impure layers." },
        ],
      }],
      // A logger in here is a logger that eventually prints a Cloudflare API
      // token. Failures are thrown as values and the caller decides — see
      // src/cloud/errors.ts.
      "no-console": "error",
    },
  },

  // ── The renderer may not reach the machine.
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{ name: "electron", message: "The renderer talks over IPC. See src/shared/ipc-types.ts." }],
        patterns: [
          { group: ["node:*"], message: "The renderer has no node access." },
          { group: ["@/store/*", "@/native/*", "@/main/*", "@/core/*"],
            message: "The renderer talks over IPC only." },
        ],
      }],
    },
  },

  // ── The FOUC killer is a CLASSIC browser script served from public/, not a
  //    module and not TypeScript (docs/IMPL_UI.md §5.5). It needs browser
  //    globals and script scope, which nothing else in the repo does.
  {
    files: ["src/renderer/public/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.browser },
    },
  },

  {
    ignores: [
      "dist/**", "out/**", "release/**", "coverage/**", "node_modules/**",
      "design/**", "docs/**", "spike/**",
      // Parallel agents get git worktrees under .claude/worktrees/, each a full
      // checkout with its own build output. Without this, `npm run lint`
      // silently lints four extra copies of the repo and reports ~1700 errors
      // that have nothing to do with your change. CI never sees it, which is
      // what makes it confusing rather than merely noisy.
      ".claude/**",
      "src/renderer/components/ui/**",
      // Verbatim vendor copies. design/README.md: "Copy verbatim. Do not
      // rewrite." theme-provider carries a file-level disable for
      // react-refresh/only-export-components, a plugin this config does not
      // load — and ESLint errors on a disable comment naming an unknown rule.
      // Linting a file we are forbidden to edit can only produce a standoff.
      "src/renderer/lib/theme-provider.tsx",
    ],
  },
);
