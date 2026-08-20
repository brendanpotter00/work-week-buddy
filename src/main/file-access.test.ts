import { describe, expect, it, vi } from "vitest";

import {
  ACCESS_TIMEOUT_MS,
  awaitDirectoryAccess,
  createDirectoryAccessGate,
} from "./file-access";

/**
 * THE REGRESSION TEST FOR THE FREEZE.
 *
 * The packaged app shipped with no windows at all and nothing on stderr,
 * because `readdirSync` on the iCloud backup directory blocked the Electron
 * main thread waiting on a macOS consent prompt. The whole event loop went with
 * it: no window, no `second-instance`, no log line.
 *
 * A test cannot make a real `open(2)` block, so it does the thing that matters
 * instead — it holds the ASYNC probe pending and asserts that the caller is
 * still running. A gate that waited synchronously could not pass this file at
 * all; it would never reach the assertion.
 */
const NEVER = new Promise<never>(() => {
  /* the dialog nobody answered */
});

describe("the directory access gate", () => {
  it("resolves 'allowed' once the probe comes back", async () => {
    expect(await awaitDirectoryAccess("/backups", { probe: async () => ["a"] })).toBe("allowed");
  });

  it("treats a missing directory as allowed — it is a first run, not a refusal", async () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    expect(await awaitDirectoryAccess("/backups", { probe: () => Promise.reject(enoent) })).toBe(
      "allowed",
    );
  });

  it("resolves 'denied' when macOS says no, so the caller fails fast instead of hanging", async () => {
    const eperm = Object.assign(new Error("EPERM"), { code: "EPERM" });
    expect(await awaitDirectoryAccess("/backups", { probe: () => Promise.reject(eperm) })).toBe(
      "denied",
    );
  });

  it("gives up rather than waiting forever on a prompt nobody answers", async () => {
    vi.useFakeTimers();
    try {
      const answer = awaitDirectoryAccess("/backups", { probe: () => NEVER, timeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await answer).toBe("undecided");
    } finally {
      vi.useRealTimers();
    }
  });

  it("DOES NOT BLOCK ITS CALLER while the prompt is unanswered — this is the bug", async () => {
    // The freeze was a SYNCHRONOUS call waiting on this same decision. If the
    // gate ever became synchronous again, the loop below would never run and
    // this test would time out instead of failing with a message.
    vi.useFakeTimers();
    try {
      let ticks = 0;
      const answer = awaitDirectoryAccess("/backups", { probe: () => NEVER, timeoutMs: 5_000 });
      const beat = setInterval(() => {
        ticks += 1;
      }, 250);
      await vi.advanceTimersByTimeAsync(5_000);
      clearInterval(beat);
      expect(await answer).toBe("undecided");
      // 20 beats in 5 s. The event loop kept running the whole time.
      expect(ticks).toBeGreaterThan(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults to a timeout a human can actually meet", () => {
    // An LSUIElement app cannot bring the consent dialog to the front, so the
    // owner has to go and find it. Too short and the export is skipped on every
    // launch of a machine that would have said yes.
    expect(ACCESS_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });
});

describe("the memoised gate", () => {
  it("asks macOS exactly once, however many cycles ask it", async () => {
    const probe = vi.fn(async () => ["a"]);
    const gate = createDirectoryAccessGate("/backups", { probe });
    expect(await gate()).toBe("allowed");
    expect(await gate()).toBe("allowed");
    expect(await gate()).toBe("allowed");
    // Two dialogs stacked on each other is worse than one nobody answered.
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting on the SAME prompt after a timeout, rather than re-asking", async () => {
    vi.useFakeTimers();
    try {
      let release: (v: string[]) => void = () => undefined;
      const probe = vi.fn(() => new Promise<string[]>((r) => (release = r)));
      const gate = createDirectoryAccessGate("/backups", { probe, timeoutMs: 1_000 });

      const first = gate();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await first).toBe("undecided");

      // The owner finds the dialog and clicks Allow. The next cycle — a wake,
      // or the next launch's — gets the real answer off the same probe.
      release(["a"]);
      const second = gate();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await second).toBe("allowed");
      expect(probe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
