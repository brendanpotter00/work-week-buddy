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
import type { AccessState, NativeStatus, SignalSource } from "../native";
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
 * One permission's state, preferring what TCC actually stores.
 *
 * The order is deliberate. `granted` is decided by the capability check, not by
 * `IOHIDCheckAccess`, because Accessibility needs BOTH kTCCServicePostEvent and
 * AXIsProcessTrusted and the HID call only knows about the first — a row can
 * say granted while `AXIsProcessTrusted` is false, and calling that "granted"
 * would re-introduce the silent failure this class exists to catch.
 *
 * `denied` then comes from TCC directly — that is the new part, and the part
 * that survives a relaunch. `promptConsumed` stays underneath it unconditionally
 * rather than only for "unknown": Accessibility is two facts, so
 * kTCCServicePostEvent can read "granted" while AXIsProcessTrusted is false and
 * the app still cannot post. In that shape the HID call is not evidence of
 * anything, and if we have already spent the prompt the honest answer is still
 * "denied" — offering to ask again would be the old lie in a new place.
 */
/**
 * What `PermissionTracker.request` actually did.
 *
 * `"already-granted"` and `"no-prompt-possible"` both mean "no dialog appeared",
 * and that is exactly why they must not share a value: the first wants the
 * caller to do nothing, the second wants it to send the user to System Settings.
 */
export type RequestOutcome = "prompted" | "already-granted" | "no-prompt-possible";

export function resolveState(
  capable: boolean,
  access: AccessState,
  promptConsumed: boolean,
): PermissionState {
  if (capable) return "granted";
  if (access === "denied") return "denied";
  if (promptConsumed) return "denied";
  return "undetermined";
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
    // "-", NOT "0x0". A process with no tap has not read a mask of zero, it has
    // read no mask at all, and `0x0` is byte-for-byte what a REFUSED Input
    // Monitoring grant looks like. This is AGENTS.md silent-failure #16, which
    // `tapHealth()` already learned; the permission snapshot is fed by the same
    // `NativeStatus` and was still answering the old way, so `--doctor` — which
    // never installs a tap — reported `relaunchRequired: true` and
    // `grantedMaskHex: 0x0` on a perfectly healthy Mac, and `npm run doctor`
    // exited 1 for it at the end of every install.
    const maskHex = status?.grantedMask ?? "-";
    // The mask is the authority; `keyboardBitsGranted` from the status is the
    // source's own reading of the same fact and agrees with it by construction.
    const keyboardBitsGranted = status === null ? false : status.keyboardBitsGranted;

    // "denied" is read off TCC, not inferred from what this process happens to
    // remember asking. `consumed` lives in memory only, so before this the app
    // forgot every denial the moment it relaunched and went back to reporting
    // "never prompted" — which drew a Grant button that could not work, because
    // macOS prompts once per (service, code identity) and never again.
    // `IOHIDCheckAccess` reports the stored row directly, so a denial survives
    // a relaunch exactly as it does in TCC.db. `consumed` stays as the fallback
    // for the case IOHIDCheckAccess cannot speak to ("unknown").
    const inputMonitoring: PermissionState = resolveState(
      p.listenEvent,
      p.listenEventAccess,
      this.consumed.inputMonitoring,
    );

    // Accessibility is two facts — posting events (kTCCServicePostEvent) and
    // AXIsProcessTrusted — and only the first has a three-state reading.
    const accessibility: PermissionState = resolveState(
      p.postEvent && p.axTrusted,
      p.postEventAccess,
      this.consumed.accessibility,
    );

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
      //
      // `status !== null` because a mask nobody read is not a mask without the
      // bits. Telling a healthy owner to relaunch is a small lie; telling him
      // so at the end of every install, in red, is how a doctor stops being
      // read at all.
      relaunchRequired: status !== null && inputMonitoring === "granted" && !keyboardBitsGranted,
      promptConsumed: { ...this.consumed },
      microphone: "not-required",
    };
  }

  /**
   * Preflight, THEN request. Never prompts twice — the OS would ignore it
   * anyway, and a consumed prompt is the reason "Open System Settings…" exists.
   *
   * Three outcomes, not two. A boolean here would fuse "nothing to do, it is
   * already granted" with "nothing CAN be done, send them to System Settings",
   * and those want opposite things from the caller.
   */
  request(source: SignalSource, which: PermissionKey): RequestOutcome {
    const before = source.permissions();
    if (which === "inputMonitoring") {
      if (before.listenEvent) return "already-granted";
    } else if (before.postEvent && before.axTrusted) {
      return "already-granted";
    }
    // A denied row is a dead end: TCC answers `CGRequest…Access` from the
    // stored row without drawing anything, so calling it would look like a
    // no-op and leave the user staring at a screen waiting for a dialog.
    const access =
      which === "inputMonitoring" ? before.listenEventAccess : before.postEventAccess;
    if (access === "denied") {
      this.consumed[which] = true;
      return "no-prompt-possible";
    }
    source.requestPermissions({ prompt: true });
    this.consumed[which] = true;
    return "prompted";
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
