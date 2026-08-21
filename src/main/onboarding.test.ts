/**
 * Permission onboarding, with no permission granted and no window open.
 *
 * The failure this file exists to prevent is the quiet one: a tap that reports
 * itself enabled while the keyboard bits have been stripped out of its granted
 * mask. Nothing throws, nothing logs, and every number in the product runs a
 * little low, forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSignalSource } from "../native";
import type { NativeStatus, Permissions } from "../native";
import {
  PermissionTracker,
  privacyPaneUrl,
  shouldShowOnboarding,
  startPermissionPoll,
} from "./onboarding";
import type { PermissionSnapshot } from "../shared/ipc-types";

const T0 = 1_700_000_000_000;

function sourceWith(perms: Partial<Permissions> = {}): FakeSignalSource {
  const s = new FakeSignalSource();
  s.perms = {
    listenEvent: true,
    postEvent: true,
    axTrusted: true,
    listenEventAccess: "granted",
    postEventAccess: "granted",
    ...perms,
  };
  return s;
}

async function statusOf(s: FakeSignalSource): Promise<NativeStatus> {
  return s.start(() => {});
}

describe("PermissionTracker.read", () => {
  it("believes the MASK, not the preflight", async () => {
    const source = sourceWith();
    const status = await statusOf(source);
    const t = new PermissionTracker();
    expect(t.read(source, status).keyboardBitsGranted).toBe(true);

    // Input Monitoring revoked while the app runs: the tap lives, the keyboard
    // bits are gone, and `CGPreflightListenEventAccess()` still says granted.
    source.stripKeyboardBits();
    const after = t.read(source, source.probe());
    expect(after.inputMonitoring).toBe("granted");
    expect(after.keyboardBitsGranted).toBe(false);
    // Granted-but-no-bits is exactly the "quit and reopen" case.
    expect(after.relaunchRequired).toBe(true);
  });

  it("reads the flagsChanged bit out of the mask — modifier-only presses", async () => {
    const source = sourceWith();
    const granted = new PermissionTracker().read(source, await statusOf(source));
    expect(granted.flagsChangedBitGranted).toBe(true);
    expect(granted.grantedMaskHex).toBe("0xfc01cfe");

    source.stripKeyboardBits();
    const stripped = new PermissionTracker().read(source, source.probe());
    expect(stripped.flagsChangedBitGranted).toBe(false);
  });

  it("is 'undetermined' before a prompt and 'denied' after one was consumed", async () => {
    // "unknown" is the honest reading for a service with no TCC row yet:
    // IOHIDCheckAccess reports neither granted nor denied, so this process's
    // own memory of having burnt the prompt is all there is to go on.
    const source = sourceWith({
      postEvent: false,
      axTrusted: false,
      postEventAccess: "unknown",
    });
    const status = await statusOf(source);
    const t = new PermissionTracker();

    expect(t.read(source, status).accessibility).toBe("undetermined");
    expect(t.read(source, status).promptConsumed.accessibility).toBe(false);

    t.request(source, "accessibility");
    const after = t.read(source, status);
    expect(after.accessibility).toBe("denied");
    expect(after.promptConsumed.accessibility).toBe(true);
  });

  it("reads 'denied' straight from TCC, without this process having asked", async () => {
    // The bug this exists for. `promptConsumed` lives in memory, so every
    // relaunch used to forget the denial and report "never prompted" — which
    // drew a Grant button for a prompt macOS will never show again. A denied
    // row outlives the process, and IOHIDCheckAccess reports it directly.
    const source = sourceWith({
      postEvent: false,
      axTrusted: false,
      postEventAccess: "denied",
    });
    const status = await statusOf(source);
    const t = new PermissionTracker();

    const snap = t.read(source, status);
    expect(snap.accessibility).toBe("denied");
    // Nothing in THIS process asked, and the state is still denied.
    expect(snap.promptConsumed.accessibility).toBe(false);
  });

  it("does not spend a prompt on a denied row, and says a prompt is not coming", async () => {
    // TCC answers CGRequestPostEventAccess from the stored row without drawing
    // anything, so requesting would look like a no-op and leave the user
    // waiting for a dialog. Report that no prompt is possible instead.
    const source = sourceWith({
      postEvent: false,
      axTrusted: false,
      postEventAccess: "denied",
    });
    let requests = 0;
    source.requestPermissions = () => {
      requests++;
      return source.perms;
    };
    const t = new PermissionTracker();

    expect(t.request(source, "accessibility")).toBe("no-prompt-possible");
    expect(requests).toBe(0);
  });

  it("still raises a real prompt when the row is merely absent", async () => {
    const source = sourceWith({
      postEvent: false,
      axTrusted: false,
      postEventAccess: "unknown",
    });
    let requests = 0;
    source.requestPermissions = () => {
      requests++;
      return source.perms;
    };
    const t = new PermissionTracker();

    expect(t.request(source, "accessibility")).toBe("prompted");
    expect(requests).toBe(1);
  });

  it("stays 'denied' after a spent prompt even when the TCC row reads granted", async () => {
    // kTCCServicePostEvent can be granted while AXIsProcessTrusted is false, so
    // the HID reading is not evidence either way here. Having already spent the
    // prompt is, and it outranks a row that cannot settle the question.
    const source = sourceWith({
      postEvent: true,
      axTrusted: false,
      postEventAccess: "granted",
    });
    const status = await statusOf(source);
    const t = new PermissionTracker();
    t.markConsumed("accessibility");

    expect(t.read(source, status).accessibility).toBe("denied");
  });

  it("prefers the capability check over the TCC row for 'granted'", async () => {
    // Accessibility is TWO facts and IOHIDCheckAccess only knows one of them.
    // A kTCCServicePostEvent row can read granted while AXIsProcessTrusted is
    // false; calling that "granted" would re-introduce the silent failure the
    // whole permission story exists to catch.
    const source = sourceWith({
      postEvent: true,
      axTrusted: false,
      postEventAccess: "granted",
    });
    const status = await statusOf(source);
    const t = new PermissionTracker();

    expect(t.read(source, status).accessibility).not.toBe("granted");
  });

  it("has no mask to believe before the tap exists, and says so", () => {
    const t = new PermissionTracker();
    const snap = t.read(sourceWith(), null);
    expect(snap.keyboardBitsGranted).toBe(false);
    expect(snap.grantedMaskHex).toBe("0x0");
  });

  it("never requests a permission that is already granted", () => {
    const source = sourceWith();
    let requests = 0;
    source.requestPermissions = () => {
      requests++;
      return source.perms;
    };
    const t = new PermissionTracker();
    t.request(source, "inputMonitoring");
    t.request(source, "accessibility");
    // The prompt is one-shot for the lifetime of the app identity. Burning it
    // on a permission we already hold is how a user ends up with no path left
    // but System Settings.
    expect(requests).toBe(0);
  });

  it("the microphone must never prompt — 'prompted' is a defect, not a state", async () => {
    const source = sourceWith();
    expect(new PermissionTracker().read(source, await statusOf(source)).microphone).toBe(
      "not-required",
    );
  });
});

describe("shouldShowOnboarding", () => {
  const base: PermissionSnapshot = {
    checkedAtMs: T0,
    inputMonitoring: "granted",
    accessibility: "granted",
    keyboardBitsGranted: true,
    flagsChangedBitGranted: true,
    grantedMaskHex: "0xfc01cfe",
    relaunchRequired: false,
    promptConsumed: { inputMonitoring: true, accessibility: true },
    microphone: "not-required",
  };

  it("opens no window on a normal launch", () => {
    expect(shouldShowOnboarding(base, true)).toBe(false);
    expect(shouldShowOnboarding(base, false)).toBe(false);
  });

  it("opens on a first launch after a clean install", () => {
    expect(shouldShowOnboarding({ ...base, accessibility: "undetermined" }, false)).toBe(true);
  });

  it("dismissing onboarding is not consent to bad data", () => {
    // "Done" was pressed, but typing is still invisible. The window comes back.
    expect(shouldShowOnboarding({ ...base, keyboardBitsGranted: false }, true)).toBe(true);
    expect(shouldShowOnboarding({ ...base, relaunchRequired: true }, true)).toBe(true);
    // A missing Accessibility grant, however, is respected once dismissed:
    // the jiggler is optional and tracking is unaffected.
    expect(shouldShowOnboarding({ ...base, accessibility: "denied" }, true)).toBe(false);
  });
});

describe("the 1 Hz permission poll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  function snap(over: Partial<PermissionSnapshot> = {}): PermissionSnapshot {
    return {
      checkedAtMs: Date.now(),
      inputMonitoring: "undetermined",
      accessibility: "undetermined",
      keyboardBitsGranted: false,
      flagsChangedBitGranted: false,
      grantedMaskHex: "0x0",
      relaunchRequired: false,
      promptConsumed: { inputMonitoring: false, accessibility: false },
      microphone: "not-required",
      ...over,
    };
  }

  it("fires only on a real change — a moving checkedAtMs is not one", () => {
    let current = snap();
    const seen: PermissionSnapshot[] = [];
    startPermissionPoll({
      isWindowOpen: () => true,
      read: () => ({ ...current, checkedAtMs: Date.now() }),
      onChange: (s) => seen.push(s),
    });

    vi.advanceTimersByTime(5000);
    expect(seen).toHaveLength(0);

    current = snap({ keyboardBitsGranted: true, inputMonitoring: "granted" });
    vi.advanceTimersByTime(1000);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.keyboardBitsGranted).toBe(true);

    vi.advanceTimersByTime(5000);
    expect(seen).toHaveLength(1);
  });

  it("UI-T14: stops when the onboarding window closes", () => {
    let open = true;
    let reads = 0;
    const poll = startPermissionPoll({
      isWindowOpen: () => open,
      read: () => {
        reads++;
        return snap();
      },
      onChange: () => {},
    });
    vi.advanceTimersByTime(3000);
    const before = reads;
    open = false;
    vi.advanceTimersByTime(1000);
    expect(poll.running).toBe(false);
    vi.advanceTimersByTime(30_000);
    expect(reads).toBe(before);
  });

  it("UI-T14: stops after 45 s regardless", () => {
    const poll = startPermissionPoll({
      isWindowOpen: () => true,
      read: () => snap(),
      onChange: () => {},
    });
    vi.advanceTimersByTime(44_000);
    expect(poll.running).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(poll.running).toBe(false);
  });
});

describe("the Privacy deep links", () => {
  it("points at the two panes, and they are different rows", () => {
    expect(privacyPaneUrl("inputMonitoring")).toContain("Privacy_ListenEvent");
    expect(privacyPaneUrl("accessibility")).toContain("Privacy_Accessibility");
    expect(privacyPaneUrl("inputMonitoring")).not.toBe(privacyPaneUrl("accessibility"));
  });
});
