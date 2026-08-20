/**
 * The only import site for the rest of the app. Nothing outside src/native/
 * imports native.ts, mac-source.ts or koffi.
 */
import type { SignalSource } from "./types";

export * from "./types";
export { levelEdge, LEVEL_OFF, type LevelState } from "./levels";
export { FakeSignalSource } from "./fake-source";

/**
 * The one door out of "a packaged build is never faked" — `src/main/smoke.ts`.
 *
 * It exists because refusing altogether is what left the packaged app
 * unverified: the app that shipped with no windows was never launched by a
 * test, because no test could launch it. Set on the command line of a smoke
 * run and nowhere else.
 */
export const PACKAGED_FAKE_ENV = "WWB_ALLOW_FAKE_IN_PACKAGED";

export interface SourceOptions {
  /** Pass app.isPackaged. A packaged build can never be faked, whatever the env says. */
  readonly isPackaged: boolean;
  /**
   * True only for `--smoke` (`readCliMode`). A smoke run has already replaced
   * `userData` with a throwaway profile and refuses to open anything else, so
   * it cannot reach the owner's data whatever else goes wrong.
   */
  readonly isSmokeRun?: boolean;
}

/**
 * The fake/real decision, split out so it can be asserted without importing
 * native.ts — which loads koffi and seven system frameworks at module scope.
 *
 * A packaged build ALWAYS gets the real source. Shipping a build that quietly
 * measures nothing because an environment variable leaked into the app bundle
 * is precisely the silent failure this project is built to avoid.
 *
 * THE ONE EXCEPTION, and why it is safe. A packaged build will take the fake
 * only when THREE independent things are true at once: the process was started
 * with `--smoke` (which mints a throwaway `userData` before `whenReady()` and
 * refuses to run against anything else), `WWB_FAKE_NATIVE=1`, and a second
 * variable whose only purpose is to be absent. Nothing a user launches from
 * /Applications carries any of them, let alone all three — and the alternative,
 * a packaged build no test can start, is how a windowless app reached the
 * owner in the first place.
 */
export function shouldUseFake(
  opts: SourceOptions,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const wantsFake = env.WWB_FAKE_NATIVE === "1" || env.NODE_ENV === "test";
  if (!wantsFake) return false;
  if (!opts.isPackaged) return true;
  return opts.isSmokeRun === true && env[PACKAGED_FAKE_ENV] === "1";
}

export async function createSignalSource(opts: SourceOptions): Promise<SignalSource> {
  if (shouldUseFake(opts)) {
    const { FakeSignalSource } = await import("./fake-source");
    console.warn(
      `[native] FAKE signal source — no real input is being measured` +
        (opts.isPackaged ? " (PACKAGED SMOKE RUN)" : ""),
    );
    return new FakeSignalSource();
  }
  // Dynamic: importing native.ts on a non-Mac throws at module scope, by design.
  const { MacSignalSource } = await import("./mac-source");
  return new MacSignalSource();
}
