/**
 * Camera and mic — levels into edges.
 *
 * The OS reports *state* ("a camera is in use"), not events. The reducer wants
 * edges. This converts, and it is where the mic scoping from PRD §3.5 lives.
 *
 * PURE, like everything else in src/core/: `atMs` arrives as data.
 */

import { NO_SIGNAL, type Ms, type Signal } from "./types";

export interface LevelInput {
  readonly cameraInUse: boolean;
  readonly micInUse: boolean;
  readonly meetingAppRunning: boolean;
  readonly atMs: Ms;
}

export interface LevelState {
  readonly camera: boolean;
  readonly micMeeting: boolean;
  /** When the mic first went up. The 60-second floor is measured from here. */
  readonly micRisingAtMs: Ms;
}

export const initialLevels: LevelState = {
  camera: false,
  micMeeting: false,
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

  // THE CONJUNCTION. Mic alone is never a signal — dictation tools hold the
  // microphone more or less continuously and are not meetings. The OS tells us
  // the mic is captured but not by whom, so a running meeting app is the
  // available proxy. PRD §3.5.
  const micRisingAtMs = input.micInUse
    ? prev.micRisingAtMs === NO_SIGNAL
      ? input.atMs
      : prev.micRisingAtMs
    : NO_SIGNAL;

  const heldLongEnough =
    input.micInUse && micRisingAtMs !== NO_SIGNAL && input.atMs - micRisingAtMs >= micMinCaptureMs;

  // A two-second Siri invocation or a dictation blip never opens an interval.
  const micMeeting = heldLongEnough && input.meetingAppRunning;

  if (micMeeting !== prev.micMeeting) {
    signals.push(
      micMeeting
        ? { kind: "micMeetingOn", atMs: input.atMs }
        : { kind: "micMeetingOff", atMs: input.atMs },
    );
  }

  return { next: { camera: input.cameraInUse, micMeeting, micRisingAtMs }, signals };
}
