/**
 * How `--selftest` reports itself.
 *
 * The gate's output is part of the gate. `install.sh` prints this and then
 * either stops the install or does not, and the owner's failing run had to be
 * diagnosed by hand-parsing a 4 kB line of JSON to find out which of
 * twenty-five checks had gone red. A gate whose output has to be decoded before
 * it can be acted on is a gate that gets bypassed.
 *
 * The three states have to stay visually distinct — in particular `?` must not
 * read as `ok`, because the whole point of the third state is that it did not
 * prove anything.
 */
import { describe, it, expect } from "vitest";
import {
  formatSelfTestReport,
  INCONCLUSIVE_MARKER,
} from "../../src/native/selftest-cli";
import type { SelfTestCheck, SelfTestReport } from "../../src/native/types";

const report = (checks: readonly SelfTestCheck[]): SelfTestReport => ({
  ok: checks.every((c) => c.ok),
  checks,
});

const OK: SelfTestCheck = { name: "posted event was kCGEventNull", ok: true, detail: "0" };
const FAILED: SelfTestCheck = {
  name: "cursor did not move",
  ok: false,
  detail: "100,200 → 105,200 · the jiggle moved it",
};
const UNMEASURED: SelfTestCheck = {
  name: "cursor did not move",
  ok: true,
  inconclusive: true,
  detail: "could not measure: foreign pointer input in all 4 attempts",
};

describe("the rendered report", () => {
  it("marks a pass, a failure and an unmeasurable check differently", () => {
    const out = formatSelfTestReport(report([OK, FAILED, UNMEASURED]));

    expect(out).toContain("  ok   posted event was kCGEventNull · 0");
    expect(out).toContain("  FAIL cursor did not move · 100,200 → 105,200");
    expect(out).toContain("  ?    cursor did not move · could not measure");
  });

  it("never renders an inconclusive check as ok, even though ok is true", () => {
    // `ok: true` on an inconclusive check answers one question only — "does
    // this stop the install?". It is not a verdict, and it must not print like
    // one.
    const lines = formatSelfTestReport(report([UNMEASURED])).split("\n");
    const line = lines.find((l) => l.includes("cursor did not move"));
    expect(line?.startsWith("  ?")).toBe(true);
    expect(line?.startsWith("  ok")).toBe(false);
  });

  it("summarises with the marker install.sh greps for", () => {
    // The contract between this file and scripts/install.sh. There is no JSON
    // parser in POSIX sh, so the marker is the interface.
    const out = formatSelfTestReport(report([OK, UNMEASURED]));
    expect(out).toContain(`self-test: 2 checks · 1 ok · 1 ${INCONCLUSIVE_MARKER}`);
    expect(INCONCLUSIVE_MARKER).toBe("COULD NOT BE MEASURED");
  });

  it("says nothing about unmeasured checks when there are none", () => {
    // A clean green run must read as clean and green, or the warning stops
    // meaning anything.
    const out = formatSelfTestReport(report([OK, OK]));
    expect(out).toContain("self-test: 2 checks · 2 ok");
    expect(out).not.toContain(INCONCLUSIVE_MARKER);
    expect(out).not.toContain("FAILED");
  });

  it("counts a failure and an unmeasured check separately", () => {
    const out = formatSelfTestReport(report([OK, OK, FAILED, UNMEASURED]));
    expect(out).toContain(`self-test: 4 checks · 2 ok · 1 FAILED · 1 ${INCONCLUSIVE_MARKER}`);
  });

  it("omits the separator when a check has no detail", () => {
    const out = formatSelfTestReport(report([{ name: "CGEventTapIsEnabled", ok: true, detail: "" }]));
    expect(out).toContain("  ok   CGEventTapIsEnabled\n");
  });
});

describe("the marker install.sh depends on", () => {
  it("appears in scripts/install.sh, spelled the same way", async () => {
    // Two files, one string. If either side is renamed on its own, a run that
    // could not measure something reports a clean pass and nobody finds out.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../scripts/install.sh", import.meta.url), "utf8");
    expect(src).toContain(INCONCLUSIVE_MARKER);
  });
});
