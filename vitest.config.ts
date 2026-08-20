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
    include: ["src/**/*.test.ts", "test/**/*.test.ts", "worker/**/*.test.ts"],
  },
});
