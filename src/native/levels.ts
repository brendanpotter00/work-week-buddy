/**
 * The camera/mic edge synthesiser. Pure, and shared by MacSignalSource and
 * FakeSignalSource so both obey the same rule with the same code.
 *
 * The OS reports a LEVEL ("a camera is in use right now"); the reducer wants
 * EDGES. Converting one to the other is where a phantom five minutes gets in,
 * so it is written once, here, and property-tested.
 *
 *   on  edge → the probe instant.       Later than the truth by up to one probe
 *                                       interval. Starting late under-counts,
 *                                       which is the safe direction.
 *   off edge → the LAST PROBE AT WHICH THE LEVEL WAS STILL ON — never the
 *              instant we noticed it had gone. Closing at the detection instant
 *              would donate up to a full probe interval to every meeting: the
 *              same bug as closing an interval at the timeout instant, wearing
 *              a different hat. AGENTS.md, the rule that outranks everything.
 */
import type { RawSignal, SignalKind } from "./types";

export interface LevelState {
  readonly on: boolean;
  readonly lastOnMs: number | null;
}

export const LEVEL_OFF: LevelState = { on: false, lastOnMs: null };

export function levelEdge(
  prev: LevelState,
  nowOn: boolean,
  nowMs: number,
  onKind: SignalKind,
  offKind: SignalKind,
): { next: LevelState; signal: RawSignal | null } {
  if (nowOn) {
    const next = { on: true, lastOnMs: nowMs };
    return prev.on ? { next, signal: null } : { next, signal: { kind: onKind, atMs: nowMs } };
  }
  if (!prev.on) return { next: prev, signal: null };
  return {
    next: LEVEL_OFF,
    // ← last seen ON, never nowMs.
    signal: { kind: offKind, atMs: prev.lastOnMs ?? nowMs },
  };
}
