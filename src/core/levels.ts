/**
 * Camera and mic — levels into edges.
 *
 * The OS reports *state* ("a camera is in use"), not events. The reducer wants
 * edges. This converts, and it is where the mic floor from PRD §3.5 lives.
 *
 * PURE, like everything else in src/core/: `atMs` arrives as data.
 */

import { NO_SIGNAL, type Ms, type Signal } from "./types";

export interface LevelInput {
  readonly cameraInUse: boolean;
  readonly micInUse: boolean;
  readonly atMs: Ms;
}

export interface LevelState {
  readonly camera: boolean;
  readonly micActive: boolean;
  /** When the mic first went up. The 60-second floor is measured from here. */
  readonly micRisingAtMs: Ms;
}

export const initialLevels: LevelState = {
  camera: false,
  micActive: false,
  micRisingAtMs: NO_SIGNAL,
};

export function levelsToSignals(
  prev: LevelState,
  input: LevelInput,
  micMinCaptureMs: number,
): { next: LevelState; signals: Signal[] } {
  const signals: Signal[] = [];

  if (input.cameraInUse !== prev.camera) {
    signals.push(
      input.cameraInUse
        ? { kind: "cameraOn", atMs: input.atMs }
        : { kind: "cameraOff", atMs: input.atMs },
    );
  }

  // THE MIC IS A WORK SIGNAL ON ITS OWN. PRD §3.5.
  //
  // This used to be conjoined with "a meeting application is running", so that
  // dictation would not read as a call. That distinction is gone on purpose:
  // whoever holds the microphone — Zoom, Slack, Wispr Flow, macOS dictation, a
  // screen recording — the owner is at the machine and working. App identity
  // was a proxy for a question that turned out not to matter, and it cost two
  // user-editable lists to maintain.
  //
  // What survives is the floor, and only the floor. It is invisible and
  // unconfigurable, which is why it survives while the lists did not.
  const micRisingAtMs = input.micInUse
    ? prev.micRisingAtMs === NO_SIGNAL
      ? input.atMs
      : prev.micRisingAtMs
    : NO_SIGNAL;

  // A two-second Siri invocation or a dictation blip never opens an interval.
  const micActive =
    input.micInUse && micRisingAtMs !== NO_SIGNAL && input.atMs - micRisingAtMs >= micMinCaptureMs;

  if (micActive !== prev.micActive) {
    signals.push(
      micActive ? { kind: "micOn", atMs: input.atMs } : { kind: "micOff", atMs: input.atMs },
    );
  }

  return { next: { camera: input.cameraInUse, micActive, micRisingAtMs }, signals };
}
