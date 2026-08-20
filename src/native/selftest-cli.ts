/**
 * `--selftest` — the only place the real koffi layer is exercised.
 *
 * Nothing in native.ts can be honestly unit-tested: creating the tap needs Input
 * Monitoring, posting a jiggle needs Accessibility, and TCC grants cannot be
 * scripted. A test that passed only because the terminal running it happened to
 * hold Accessibility would be worse than no test — it would report green on a
 * machine where the app is silently dead. So the real layer is proven HERE, by a
 * human, on the machine that will run the app:
 *
 *     npm run selftest
 *     # or, against the installed bundle, which is the grant that actually matters:
 *     "/Applications/Work Week Buddy.app/Contents/MacOS/Work Week Buddy" --selftest
 *
 * Dev and prod are different TCC subjects. A green run in dev says nothing about
 * the packaged app, which is why install.sh runs this against the installed
 * bundle as a hard gate.
 *
 * Exit code 0 = every check passed. Anything else = do not ship this build.
 */
import type { RawSignal, SelfTestCheck, SelfTestReport } from "./types";

export interface SelfTestCliResult {
  readonly report: SelfTestReport;
  readonly exitCode: number;
}

/**
 * Install the real tap, run the self-test through it, tear it down.
 * A failure to even start is itself a reported check rather than a stack trace:
 * "no Input Monitoring" is the single most likely outcome on a fresh machine and
 * it should read as a failed gate, not as a crash.
 */
export async function runNativeSelfTest(): Promise<SelfTestCliResult> {
  const { MacSignalSource } = await import("./mac-source");
  const source = new MacSignalSource();
  const signals: RawSignal[] = [];

  let checks: SelfTestCheck[];
  try {
    await source.start((s) => {
      signals.push(s);
    });
    const report = await source.selfTest();
    const keyOrMouse = signals.filter((s) => s.kind === "key" || s.kind === "mouse").length;
    checks = [
      ...report.checks,
      // Informational, not a gate: a human running this may well move the mouse
      // while it runs, and mouseMoved is in the mask. The gate for "our own
      // jiggle never became a signal" is the round-trip check above — the tap
      // classified it as ours, which is the branch that returns before any
      // signal is emitted.
      {
        name: "real signals observed during the run (informational)",
        ok: true,
        detail: String(keyOrMouse),
      },
    ];
  } catch (err) {
    checks = [
      {
        name: "tap installed",
        ok: false,
        detail: String(err),
      },
    ];
  } finally {
    source.stop();
  }

  const report: SelfTestReport = { ok: checks.every((c) => c.ok), checks };
  return { report, exitCode: report.ok ? 0 : 1 };
}

/** Runs the self-test and prints the report as one JSON object on stdout. */
export async function runSelfTestCli(): Promise<number> {
  const { report, exitCode } = await runNativeSelfTest();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return exitCode;
}
