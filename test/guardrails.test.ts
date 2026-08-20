import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";

/**
 * Three of the thirteen traps in AGENTS.md are prevented by lint rules.
 * A lint rule nobody proved is a comment, so these tests lint deliberate
 * violations and assert each one is actually rejected.
 */

async function lint(code: string, filePath: string): Promise<string> {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [res] = await eslint.lintText(code, { filePath, warnIgnored: false });
  return (res?.messages ?? []).map((m) => m.message).join("\n");
}

describe("guardrails actually fire", () => {
  it("rejects an electron import from src/core/", async () => {
    const out = await lint(
      `import { app } from "electron";\nexport const x = app;\n`,
      "src/core/__fixture__.ts",
    );
    expect(out).toMatch(/must stay pure/);
  });

  it("rejects an impure-layer import from src/core/", async () => {
    const out = await lint(
      `import { openDb } from "@/store/db";\nexport const x = openDb;\n`,
      "src/core/__fixture__.ts",
    );
    expect(out).toMatch(/may not depend on any impure layer/);
  });

  it("rejects Date.now() in src/core/ — time is a parameter", async () => {
    const out = await lint(`export const t = () => Date.now();\n`, "src/core/__fixture__.ts");
    expect(out).toMatch(/nowMs as a parameter/);
  });

  it("rejects powerMonitor.getSystemIdleTime anywhere", async () => {
    // AGENTS.md #7: polluted by our own jiggler, so a tracker built on it
    // reports 24-hour workdays, silently.
    const out = await lint(
      `import { powerMonitor } from "electron";\nexport const t = () => powerMonitor.getSystemIdleTime();\n`,
      "src/main/__fixture__.ts",
    );
    expect(out).toMatch(/Polluted by CGEventPost/);
  });

  it("rejects CGEventSourceSecondsSinceLastEventType anywhere", async () => {
    const out = await lint(
      `declare function CGEventSourceSecondsSinceLastEventType(a: number, b: number): number;\n` +
        `export const t = () => CGEventSourceSecondsSinceLastEventType(1, 0);\n`,
      "src/native/__fixture__.ts",
    );
    expect(out).toMatch(/Reset by our own jiggler/);
  });

  it("rejects the renderer importing the store", async () => {
    const out = await lint(
      `import { openDb } from "@/store/db";\nexport const x = openDb;\n`,
      "src/renderer/__fixture__.ts",
    );
    expect(out).toMatch(/talks over IPC only/);
  });

  it("allows an ordinary pure module in src/core/", async () => {
    const out = await lint(
      `export function add(a: number, b: number): number { return a + b; }\n`,
      "src/core/__fixture__.ts",
    );
    expect(out).toBe("");
  });
});
