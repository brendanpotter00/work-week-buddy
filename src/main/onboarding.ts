/**
 * Permission onboarding — `docs/IMPL_UI.md` §4.
 *
 * Two permissions, two panes, one window. They are INDEPENDENT TCC rows:
 * having one does not imply the other (`docs/MACOS.md` §6).
 *
 * | Pane | TCC service | If denied |
 * |---|---|---|
 * | Input Monitoring | `kTCCServiceListenEvent` | **keyboard silently untracked** — hours run low forever |
 * | Accessibility    | `kTCCServicePostEvent`   | the jiggler is disabled. Tracking is unaffected. |
 *
 * Nothing here imports `electron`, so the whole permission story is testable in
 * a plain Node process with no grant and no window: the caller supplies the
 * `SignalSource` and does the opening.
 */
import type { NativeStatus, SignalSource } from "../native";
import type {
  PermissionKey,
  PermissionSnapshot,
  PermissionState,
} from "../shared/ipc-types";

/** keyDown | keyUp. The two bits that decide whether typing is visible at all. */
export const KEY_BITS = (1 << 10) | (1 << 11);
/** flagsChanged — modifier-only presses. AGENTS.md trap #3. */
export const FLAGS_CHANGED_BIT = 1 << 12;

const PANE_URL: Record<PermissionKey, string> = {
  inputMonitoring:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
  accessibility:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};

/**
 * The deep link for a Privacy pane. A pure function, so the caller — which
 * already holds `electron`'s `shell` — does the opening and this module stays
 * importable from a test.
 */
export function privacyPaneUrl(which: PermissionKey): string {
  return PANE_URL[which];
}

function hasBits(hex: string, bits: number): boolean {
  try {
    return (BigInt(hex) & BigInt(bits)) === BigInt(bits);
  } catch {
    return false;
  }
}

/**
 * Reads the two TCC states and, crucially, the GRANTED MASK.
 *
 * `docs/MACOS.md` §6: which TCC bucket governs the keyboard bits is genuinely
 * disputed, so neither preflight is trusted — the mask is read back off the
 * live tap and believed. A tap that reports `enabled` with the keyboard bits
 * stripped is the silent failure this whole class exists to catch: hours come
 * out slightly low, forever, with no error anywhere.
 */
export class PermissionTracker {
  /** The system prompt is ONE SHOT for the lifetime of the app identity. */
  private consumed: Record<PermissionKey, boolean> = {
    inputMonitoring: false,
    accessibility: false,
  };

  read(source: SignalSource, status: NativeStatus | null): PermissionSnapshot {
    const p = source.permissions();
    const maskHex = status?.grantedMask ?? "0x0";
    // The mask is the authority; `keyboardBitsGranted` from the status is the
    // source's own reading of the same fact and agrees with it by construction.
    const keyboardBitsGranted = status === null ? false : status.keyboardBitsGranted;

    const inputMonitoring: PermissionState = p.listenEvent
      ? "granted"
      : this.consumed.inputMonitoring
        ? "denied"
        : "undetermined";

    const accessibility: PermissionState =
      p.postEvent && p.axTrusted
        ? "granted"
        : this.consumed.accessibility
          ? "denied"
          : "undetermined";

    return {
      checkedAtMs: Date.now(),
      inputMonitoring,
      accessibility,
      keyboardBitsGranted,
      flagsChangedBitGranted: hasBits(maskHex, FLAGS_CHANGED_BIT),
      grantedMaskHex: maskHex,
      // A fresh Input Monitoring grant does not retroactively add the keyboard
      // bits to a tap that already exists. The DECIDER IS THE MASK, not the
      // grant: granted-but-no-bits is exactly the "quit and reopen" case.
      relaunchRequired: inputMonitoring === "granted" && !keyboardBitsGranted,
      promptConsumed: { ...this.consumed },
      microphone: "not-required",
    };
  }

  /**
   * Preflight, THEN request. Never prompts twice — the OS would ignore it
   * anyway, and a consumed prompt is the reason "Open System Settings…" exists.
   */
  request(source: SignalSource, which: PermissionKey): void {
    const before = source.permissions();
    if (which === "inputMonitoring") {
      if (before.listenEvent) return;
    } else if (before.postEvent && before.axTrusted) {
      return;
    }
    source.requestPermissions({ prompt: true });
    this.consumed[which] = true;
  }

  /** Test seam: replay a prior session's one-shot state. */
  markConsumed(which: PermissionKey): void {
    this.consumed[which] = true;
  }
}

/**
 * First launch after a clean install shows onboarding; a normal launch shows no
 * window at all.
 *
 * "Done" (which sets `onboardingDismissed`) does NOT buy silence about a
 * missing keyboard grant: dismissing onboarding is not consent to bad data, so
 * a missing mask re-opens the window regardless.
 */
export function shouldShowOnboarding(
  perms: PermissionSnapshot,
  onboardingDismissed: boolean,
): boolean {
  if (!perms.keyboardBitsGranted) return true;
  if (perms.relaunchRequired) return true;
  if (onboardingDismissed) return false;
  return perms.accessibility !== "granted";
}

export interface PermissionPollOptions {
  /** Alive only while the onboarding window exists. */
  readonly isWindowOpen: () => boolean;
  readonly read: () => PermissionSnapshot;
  readonly onChange: (snapshot: PermissionSnapshot) => void;
  readonly now?: () => number;
  readonly setRepeating?: (fn: () => void, ms: number) => NodeJS.Timeout;
  readonly clearRepeating?: (t: NodeJS.Timeout) => void;
  /** Hard stop. Default 45 s. */
  readonly maxMs?: number;
  readonly everyMs?: number;
}

export interface PermissionPoll {
  stop(): void;
  readonly running: boolean;
}

/**
 * The 1 Hz TCC read, alive only while an onboarding window exists, with a hard
 * 45-second stop.
 *
 * TWO reasons it lives in MAIN and not in the renderer:
 *
 *  - the onboarding window spends its entire life BEHIND System Settings, and a
 *    hidden renderer's timers collapse — measured 153 of 400 ticks with a clean
 *    60-second gap. AGENTS.md trap #10.
 *  - main is where the push comes from anyway.
 *
 * This is NOT a NON_GOALS #1 violation. That rule bans polling for INPUT. This
 * is a TCC read, scoped to an open window, with a hard stop, and it posts
 * nothing. Do not delete it as a rules violation.
 */
export function startPermissionPoll(o: PermissionPollOptions): PermissionPoll {
  const now = o.now ?? Date.now;
  const setRepeating = o.setRepeating ?? setInterval;
  const clearRepeating = o.clearRepeating ?? clearInterval;
  const deadline = now() + (o.maxMs ?? 45_000);
  let last = stable(o.read());
  let timer: NodeJS.Timeout | null = null;

  const stop = (): void => {
    if (timer !== null) {
      clearRepeating(timer);
      timer = null;
    }
  };

  timer = setRepeating(() => {
    if (!o.isWindowOpen() || now() > deadline) {
      stop();
      return;
    }
    const snap = o.read();
    const json = stable(snap);
    if (json !== last) {
      last = json;
      o.onChange(snap);
    }
  }, o.everyMs ?? 1000);

  return {
    stop,
    get running() {
      return timer !== null;
    },
  };
}

/** `checkedAtMs` moves every tick and is not a change. */
function stable(s: PermissionSnapshot): string {
  return JSON.stringify({ ...s, checkedAtMs: 0 });
}
