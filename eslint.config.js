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
    ],
  },
);
