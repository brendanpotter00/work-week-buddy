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
        detail: `${String(keyOrMouse)} — a human at the keyboard is expected here, not a problem`,
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

/** The marker `scripts/install.sh` greps for. Changing it changes that too. */
export const INCONCLUSIVE_MARKER = "COULD NOT BE MEASURED";

/**
 * The report, as something a person can read.
 *
 * It exists because `install.sh` gates on this and then leaves a 4 kB line of
 * JSON on the terminal. The owner's failing run was diagnosed by hand-parsing
 * that blob; a gate whose output has to be decoded before it can be acted on is
 * a gate that gets bypassed instead. Three states, three prefixes, one summary:
 *
 *     ok    posted event was kCGEventNull · 0
 *     FAIL  cursor did not move · 100,200 → 105,200 · the jiggle moved it …
 *     ?     cursor did not move · could not measure: …
 */
export function formatSelfTestReport(report: SelfTestReport): string {
  const lines = report.checks.map((c) => {
    const tag = !c.ok ? "FAIL" : c.inconclusive === true ? "?   " : "ok  ";
    return `  ${tag} ${c.name}${c.detail === "" ? "" : ` · ${c.detail}`}`;
  });
  const failed = report.checks.filter((c) => !c.ok).length;
  const unmeasured = report.checks.filter((c) => c.ok && c.inconclusive === true).length;
  const parts = [
    `${String(report.checks.length)} checks`,
    `${String(report.checks.length - failed - unmeasured)} ok`,
  ];
  if (failed > 0) parts.push(`${String(failed)} FAILED`);
  // Named in full so the install script can find it without parsing JSON, and
  // so the owner reading the transcript sees the distinction rather than a tick.
  if (unmeasured > 0) parts.push(`${String(unmeasured)} ${INCONCLUSIVE_MARKER}`);
  return [...lines, `  self-test: ${parts.join(" · ")}`].join("\n");
}

/**
 * Runs the self-test, prints the report as one JSON object on stdout, and the
 * readable rendering on stderr.
 *
 * The split is deliberate: stdout stays exactly one machine-readable object, so
 * anything that ever wants to parse this keeps working, while the thing a human
 * runs at 11pm because their tracker stopped prints something they can act on.
 */
export async function runSelfTestCli(): Promise<number> {
  const { report, exitCode } = await runNativeSelfTest();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.stderr.write(`${formatSelfTestReport(report)}\n`);
  return exitCode;
}
