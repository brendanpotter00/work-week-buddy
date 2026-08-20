/**
 * The only import site for the rest of the app. Nothing outside src/native/
 * imports native.ts, mac-source.ts or koffi.
 */
import type { SignalSource } from "./types";

export * from "./types";
export { levelEdge, LEVEL_OFF, type LevelState } from "./levels";
export { FakeSignalSource } from "./fake-source";

export interface SourceOptions {
  /** Pass app.isPackaged. A packaged build can never be faked, whatever the env says. */
  readonly isPackaged: boolean;
}

/**
 * The fake/real decision, split out so it can be asserted without importing
 * native.ts — which loads koffi and seven system frameworks at module scope.
 *
 * A packaged build ALWAYS gets the real source. Shipping a build that quietly
 * measures nothing because an environment variable leaked into the app bundle
 * is precisely the silent failure this project is built to avoid.
 */
export function shouldUseFake(
  opts: SourceOptions,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const wantsFake = env.WWB_FAKE_NATIVE === "1" || env.NODE_ENV === "test";
  return wantsFake && !opts.isPackaged;
}

export async function createSignalSource(opts: SourceOptions): Promise<SignalSource> {
  if (shouldUseFake(opts)) {
    const { FakeSignalSource } = await import("./fake-source");
    console.warn("[native] FAKE signal source — no real input is being measured");
    return new FakeSignalSource();
  }
  // Dynamic: importing native.ts on a non-Mac throws at module scope, by design.
  const { MacSignalSource } = await import("./mac-source");
  return new MacSignalSource();
}
