import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: { alias: { "@": resolve("src") } },
  test: {
    globals: true,
    environment: "node",
    // The forks pool hangs on Node 22.1.0. The .nvmrc pin is the real fix;
    // this is belt-and-braces so a wrong-Node run fails rather than hangs.
    pool: "threads",
    // Generous, because two files are inherently slow rather than badly
    // written: test/guardrails.test.ts spawns ESLint seven times, and
    // typescript-eslint's first load is heavy. The default 5s is enough idle
    // and not enough on a loaded machine. Real unit tests finish in
    // milliseconds, so this only ever rescues the pathological case.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // .tsx is here for the dashboard's component tests. They opt into jsdom
    // per file with a `@vitest-environment jsdom` docblock rather than
    // switching the default: everything else in this repo is a node test and
    // paying for a DOM in all 500+ of them would be a real cost.
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}", "worker/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/core/**", "src/store/**", "src/sync/**", "worker/src/**"],
      // src/core/ is pure: no I/O, no network, no clock. There is no legitimate
      // reason for a gap in it, and a gap here is a gap in the only part of the
      // product that cannot be spot-checked by looking at the screen.
      thresholds: { "src/core/**": { statements: 100, branches: 95, functions: 100, lines: 100 } },
    },
  },
});
