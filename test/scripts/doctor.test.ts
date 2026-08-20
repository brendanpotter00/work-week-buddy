/**
 * `scripts/doctor.ts` — task 7.1.
 *
 * Every state below comes from an INJECTED `DoctorReport`. Nothing here reads a
 * permission, opens the database, starts an event tap, or looks for an
 * installed bundle, which is what makes "doctor goes red when X is broken"
 * provable at all — on a developer Mac with everything working, and on the
 * Linux CI runner where none of it exists.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_PATH,
  evaluate,
  exitCodeFor,
  extractJson,
  parseArgs,
  render,
  renderLine,
  type Invariant,
  type Level,
} from "../../scripts/doctor";
import { GREEN, NOW, report } from "./doctor-report";

const DAY = 86_400_000;
const HOUR = 3_600_000;

function levels(invariants: readonly Invariant[]): Record<string, Level> {
  const out: Record<string, Level> = {};
  for (const i of invariants) out[i.id] = i.level;
  return out;
}

function level(patch: Parameters<typeof report>[0], id: string): Level {
  const found = evaluate(report(patch), NOW).find((i) => i.id === id);
  if (found === undefined) throw new Error(`no invariant '${id}'`);
  return found.level;
}

function detail(patch: Parameters<typeof report>[0], id: string): string {
  const found = evaluate(report(patch), NOW).find((i) => i.id === id);
  if (found === undefined) throw new Error(`no invariant '${id}'`);
  return found.detail;
}

describe("evaluate — the nine invariants", () => {
  it("reports one line per invariant, in a stable order", () => {
    expect(evaluate(GREEN, NOW).map((i) => i.id)).toEqual([
      "input-monitoring",
      "accessibility",
      "tap",
      "granted-mask",
      "selftest",
      "sync",
      "fingerprint",
      "backup",
      "rows",
    ]);
  });

  it("is green on a healthy machine", () => {
    const inv = evaluate(GREEN, NOW);
    expect(inv.every((i) => i.level === "ok")).toBe(true);
    expect(exitCodeFor(inv)).toBe(0);
  });

  it("is pure: the same report and clock always give the same verdict", () => {
    expect(evaluate(GREEN, NOW)).toEqual(evaluate(GREEN, NOW));
  });
});

describe("permissions", () => {
  it("goes red when Input Monitoring is denied", () => {
    expect(level({ permissions: { inputMonitoring: "denied" } }, "input-monitoring")).toBe("fail");
  });

  it("goes red when Input Monitoring was never prompted", () => {
    // Not "warn": until it is granted, every keystroke is invisible and the
    // hours look plausible anyway. That is the failure this app exists to avoid.
    expect(level({ permissions: { inputMonitoring: "undetermined" } }, "input-monitoring")).toBe(
      "fail",
    );
  });

  it("only warns when the preflight cannot be read", () => {
    expect(level({ permissions: { inputMonitoring: "unknown" } }, "input-monitoring")).toBe("warn");
  });

  it("only WARNS when Accessibility is missing — tracking is unaffected", () => {
    // Accessibility is the jiggler's permission. Failing the whole doctor on it
    // would make the jiggler feel mandatory; it is off by default.
    const inv = evaluate(report({ permissions: { accessibility: "denied" } }), NOW);
    expect(levels(inv)["accessibility"]).toBe("warn");
    expect(exitCodeFor(inv)).toBe(0);
  });
});

describe("event tap", () => {
  it("goes red when the tap was never created", () => {
    expect(level({ tap: { created: false } }, "tap")).toBe("fail");
  });

  it("goes red when macOS disabled the tap", () => {
    expect(level({ tap: { enabled: false, disabledByTimeoutCount: 3 } }, "tap")).toBe("fail");
  });

  it("warns when the tap is alive but intervals were closed as tap_lost", () => {
    expect(level({ tap: { tapLostRows: 2 } }, "tap")).toBe("warn");
  });
});

describe("granted mask", () => {
  it("goes red when the keyboard bits are missing", () => {
    const patch = { permissions: { keyboardBitsGranted: false } };
    expect(level(patch, "granted-mask")).toBe("fail");
    expect(detail(patch, "granted-mask")).toContain("keyDown/keyUp");
  });

  it("warns when only the flagsChanged bit is missing", () => {
    expect(level({ permissions: { flagsChangedBitGranted: false } }, "granted-mask")).toBe("warn");
  });

  it("goes red when a grant landed but the live tap still lacks the bits", () => {
    const patch = { permissions: { relaunchRequired: true } };
    expect(level(patch, "granted-mask")).toBe("fail");
    expect(detail(patch, "granted-mask")).toMatch(/RELAUNCH/);
  });

  it("prints the mask itself, so it can be compared with docs/MACOS.md", () => {
    expect(detail({}, "granted-mask")).toContain("0x2000000000ca");
  });
});

describe("self-test", () => {
  it("warns when it has never run", () => {
    expect(level({ selfTest: null }, "selftest")).toBe("warn");
  });

  it("goes red when it failed, and names the check that failed", () => {
    const patch = {
      selfTest: {
        ranAtMs: NOW - HOUR,
        passed: false,
        appVersion: "0.1.0",
        checks: [
          { id: "jiggle-tagged", passed: false, detail: "userData was 0" },
          { id: "tap-alive", passed: true, detail: "" },
        ],
      },
    };
    expect(level(patch, "selftest")).toBe("fail");
    expect(detail(patch, "selftest")).toContain("jiggle-tagged");
    expect(detail(patch, "selftest")).not.toContain("tap-alive");
  });

  it("warns when the last pass is older than the build is likely to be", () => {
    expect(
      level(
        { selfTest: { ranAtMs: NOW - 31 * DAY, passed: true, appVersion: "0.1.0", checks: [] } },
        "selftest",
      ),
    ).toBe("warn");
  });

  it("prints the date of the last result", () => {
    expect(detail({}, "selftest")).toMatch(/passed \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(3d ago\)/);
  });
});

describe("sync", () => {
  it("goes red after 72 h of cloud silence — DATA_MODEL backup layer 4", () => {
    expect(level({ sync: { silentForMs: 73 * HOUR } }, "sync")).toBe("fail");
  });

  it("stays green at 71 h", () => {
    expect(level({ sync: { silentForMs: 71 * HOUR } }, "sync")).toBe("ok");
  });

  it("derives the silence from the last cloud write when the app did not", () => {
    expect(
      level(
        { sync: { silentForMs: null, lastCloudWriteMs: NOW - 80 * HOUR, lastFlushOkMs: null } },
        "sync",
      ),
    ).toBe("fail");
  });

  it("warns, not fails, when nothing has ever synced", () => {
    expect(
      level(
        { sync: { lastCloudWriteMs: null, lastFlushOkMs: null, silentForMs: null, pendingRows: 12 } },
        "sync",
      ),
    ).toBe("warn");
  });

  it("warns when the last flush errored but the cloud is not yet silent", () => {
    const patch = { sync: { lastFlushError: "503 from the Worker" } };
    expect(level(patch, "sync")).toBe("warn");
    expect(detail(patch, "sync")).toContain("503 from the Worker");
  });
});

describe("fingerprint", () => {
  it("goes red on a mismatch, and prints both counts", () => {
    const patch = { fingerprint: { matched: false, localCount: 1_204, cloudCount: 1_190 } };
    expect(level(patch, "fingerprint")).toBe("fail");
    expect(detail(patch, "fingerprint")).toContain("1,204");
    expect(detail(patch, "fingerprint")).toContain("1,190");
  });

  it("warns when it has never been checked", () => {
    expect(level({ fingerprint: { matched: null, checkedAtMs: null } }, "fingerprint")).toBe("warn");
  });
});

describe("backup age", () => {
  it("is green two days after a weekly export", () => {
    expect(level({}, "backup")).toBe("ok");
  });

  it("warns once a week has been missed", () => {
    expect(level({ backup: { lastAtMs: NOW - 9 * DAY, ageDays: 9 } }, "backup")).toBe("warn");
  });

  it("goes red once the weekly export has clearly stopped", () => {
    expect(level({ backup: { lastAtMs: NOW - 16 * DAY, ageDays: 16 } }, "backup")).toBe("fail");
  });

  it("warns when no backup has ever been taken", () => {
    expect(level({ backup: { lastAtMs: null, ageDays: null } }, "backup")).toBe("warn");
  });
});

describe("local rows", () => {
  it("prints the row count", () => {
    expect(detail({}, "rows")).toContain("1,204 intervals");
  });

  it("goes red when the integrity check failed", () => {
    expect(level({ db: { integrityOk: false } }, "rows")).toBe("fail");
  });

  it("warns on an empty database rather than failing a fresh install", () => {
    expect(level({ db: { rows: 0 } }, "rows")).toBe("warn");
  });
});

describe("exit code", () => {
  it("is 0 when every invariant holds", () => {
    expect(exitCodeFor(evaluate(GREEN, NOW))).toBe(0);
  });

  it("is 0 when there are warnings but no failures", () => {
    const inv = evaluate(
      report({
        selfTest: null,
        fingerprint: { matched: null, checkedAtMs: null },
        backup: { lastAtMs: null, ageDays: null },
        permissions: { accessibility: "denied" },
      }),
      NOW,
    );
    expect(inv.filter((i) => i.level === "warn").length).toBeGreaterThan(0);
    expect(inv.some((i) => i.level === "fail")).toBe(false);
    expect(exitCodeFor(inv)).toBe(0);
  });

  it("is non-zero when ANY single invariant is red", () => {
    const reds: Parameters<typeof report>[0][] = [
      { permissions: { inputMonitoring: "denied" } },
      { tap: { created: false } },
      { permissions: { keyboardBitsGranted: false } },
      { selfTest: { ranAtMs: NOW, passed: false, appVersion: "0.1.0", checks: [] } },
      { sync: { silentForMs: 100 * HOUR } },
      { fingerprint: { matched: false } },
      { backup: { lastAtMs: NOW - 30 * DAY, ageDays: 30 } },
      { db: { integrityOk: false } },
    ];
    for (const patch of reds) {
      expect(exitCodeFor(evaluate(report(patch), NOW))).toBe(1);
    }
  });
});

describe("rendering", () => {
  it("marks green, amber and red differently", () => {
    const line = (l: Level): string =>
      renderLine({ id: "x", label: "X", level: l, detail: "d" }, false);
    expect(line("ok")).toContain("[ ok ]");
    expect(line("warn")).toContain("[warn]");
    expect(line("fail")).toContain("[FAIL]");
  });

  it("emits no ANSI escapes when colour is off, and colours when it is on", () => {
    const plain = renderLine({ id: "x", label: "X", level: "fail", detail: "d" }, false);
    const colour = renderLine({ id: "x", label: "X", level: "fail", detail: "d" }, true);
    expect(plain).not.toContain("\u001b");
    expect(colour).toContain("\u001b[31m");
    expect(colour).toContain("\u001b[0m");
  });

  it("prints one line per invariant plus a summary", () => {
    const out = render(GREEN, evaluate(GREEN, NOW), { color: false, nowMs: NOW });
    expect(out.match(/\[ ok \]/g)?.length).toBe(9);
    expect(out).toContain("9 ok · 0 warning(s) · 0 failed");
  });

  it("counts the reds in the summary", () => {
    const r = report({ tap: { created: false }, permissions: { accessibility: "denied" } });
    const out = render(r, evaluate(r, NOW), { color: false, nowMs: NOW });
    expect(out).toContain("7 ok · 1 warning(s) · 1 failed");
    expect(out).toMatch(/\[FAIL\] Event tap/);
  });

  it("says so when the app's own allGreen disagrees with every invariant holding", () => {
    const r = report({ allGreen: false });
    const out = render(r, evaluate(r, NOW), { color: false, nowMs: NOW });
    expect(out).toContain("allGreen=false");
  });

  it("flags a report that came from something other than the installed bundle", () => {
    // AGENTS.md: the dev build is a different app to TCC, so its permissions
    // are a different app's permissions. Everything else would look merely odd.
    const r = report({ app: { execPath: "/Users/x/dev/wwb/node_modules/electron/dist/Electron" } });
    const out = render(r, evaluate(r, NOW), { color: false, nowMs: NOW });
    expect(out).toContain("NOT the installed bundle");
    expect(render(GREEN, evaluate(GREEN, NOW), { color: false, nowMs: NOW })).not.toContain(
      "NOT the installed bundle",
    );
  });
});

describe("collection plumbing", () => {
  it("finds the report inside noisy Electron stdout", () => {
    const noisy = `[12345:0819/120000] some chromium warning\n${JSON.stringify(GREEN)}\n(node) warning\n`;
    expect(extractJson(noisy).machine.machineId).toBe("m-1");
  });

  it("throws rather than guessing when there is no JSON at all", () => {
    expect(() => extractJson("dyld: library not loaded\n")).toThrow(/no JSON object/);
  });

  it("defaults to the frozen /Applications path", () => {
    expect(APP_PATH).toBe("/Applications/Work Week Buddy.app");
    expect(parseArgs([], false).bin).toBe(`${APP_PATH}/Contents/MacOS/Work Week Buddy`);
  });

  it("takes an injected report, a different bundle, and a colour override", () => {
    expect(parseArgs(["--report", "/tmp/r.json"], false).reportPath).toBe("/tmp/r.json");
    expect(parseArgs(["--app", "/Volumes/T/W.app"], false).bin).toBe(
      "/Volumes/T/W.app/Contents/MacOS/Work Week Buddy",
    );
    expect(parseArgs([], true).color).toBe(true);
    expect(parseArgs(["--no-color"], true).color).toBe(false);
    expect(() => parseArgs(["--wat"], false)).toThrow(/unknown argument/);
  });
});

describe("the script as a process", () => {
  // The exit code is the contract install.sh and any future watchdog gate on,
  // so it is proved by running the real file, not by calling exitCodeFor().
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/doctor.ts");
  const dir = mkdtempSync(join(tmpdir(), "wwb-doctor-"));

  function runDoctor(reportJson: unknown, name: string): { code: number; out: string } {
    const path = join(dir, `${name}.json`);
    writeFileSync(path, JSON.stringify(reportJson), "utf8");
    try {
      const out = execFileSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--disable-warning=ExperimentalWarning",
          script,
          "--report",
          path,
          "--no-color",
        ],
        { encoding: "utf8" },
      );
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  it("exits 0 and prints every invariant green", () => {
    const { code, out } = runDoctor(GREEN, "green");
    expect(code).toBe(0);
    expect(out).toContain("[ ok ] Input Monitoring");
    expect(out).toContain("[ ok ] Event tap");
    expect(out).toContain("0 failed");
  });

  it("exits 1 when one invariant is red", () => {
    const { code, out } = runDoctor(report({ tap: { enabled: false } }), "red");
    expect(code).toBe(1);
    expect(out).toContain("[FAIL] Event tap");
  });

  it("exits 0 with warnings only — a fresh install must not look broken", () => {
    const fresh = report({
      selfTest: null,
      sync: { lastCloudWriteMs: null, lastFlushOkMs: null, silentForMs: null },
      fingerprint: { matched: null, checkedAtMs: null },
      backup: { lastAtMs: null, ageDays: null },
      db: { rows: 0 },
    });
    const { code, out } = runDoctor(fresh, "fresh");
    expect(code).toBe(0);
    expect(out).toContain("[warn] Self-test");
    expect(out).toContain("0 failed");
  });

  it("--json changes the output, not the verdict", () => {
    const path = join(dir, "json-red.json");
    writeFileSync(path, JSON.stringify(report({ db: { integrityOk: false }, allGreen: true })), "utf8");
    let code = 0;
    let out = "";
    try {
      out = execFileSync(
        process.execPath,
        ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", script, "--report", path, "--json"],
        { encoding: "utf8" },
      );
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      code = e.status ?? -1;
      out = e.stdout ?? "";
    }
    // The app claimed allGreen; our own threshold says the database is corrupt.
    expect(code).toBe(1);
    expect(JSON.parse(out).db.integrityOk).toBe(false);
  });

  it("exits 2, not 0, when no report can be obtained", () => {
    let code = -1;
    try {
      execFileSync(
        process.execPath,
        ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", script, "--report", join(dir, "nope.json")],
        { encoding: "utf8", stdio: "pipe" },
      );
      code = 0;
    } catch (err) {
      code = (err as { status?: number }).status ?? -1;
    }
    expect(code).toBe(2);
  });
});
