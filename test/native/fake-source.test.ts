import { describe, it, expect } from "vitest";
import { FakeSignalSource } from "@/native/fake-source";
import type { RawSignal } from "@/native/types";

/**
 * The SignalSource contract, exercised through the fake.
 *
 * Every one of these assertions is about behaviour the real Mac source must also
 * have — and the two share levels.ts, so the edge rules are literally the same
 * code. What cannot be shared (koffi, a tap, a TCC grant) is proven by
 * `--selftest` on a real machine instead, because a test that only passes when
 * this terminal happens to hold Accessibility proves nothing about the app.
 */

function collect(): { sink: (s: RawSignal) => void; signals: RawSignal[] } {
  const signals: RawSignal[] = [];
  return { sink: (s) => signals.push(s), signals };
}

describe("FakeSignalSource — lifecycle", () => {
  it("reports the tap installed and enabled once started", async () => {
    const src = new FakeSignalSource(() => 1_000);
    const { sink } = collect();
    const status = await src.start(sink);
    expect(status.tapInstalled).toBe(true);
    expect(status.tapEnabled).toBe(true);
    expect(status.probedAtMs).toBe(1_000);
  });

  it("is safe to stop before start, and to stop twice", () => {
    const src = new FakeSignalSource(() => 0);
    expect(() => {
      src.stop();
      src.stop();
    }).not.toThrow();
    expect(src.probe().tapInstalled).toBe(false);
  });

  it("reads the clock only through the function it was given", async () => {
    let t = 5_000;
    const src = new FakeSignalSource(() => t);
    await src.start(() => {});
    t = 9_000;
    expect(src.probe().probedAtMs).toBe(9_000);
  });

  it("produces a status that survives JSON — no BigInt ever crosses the boundary", async () => {
    const src = new FakeSignalSource(() => 1_000);
    const status = await src.start(() => {});
    // A mask that crossed IPC as a BigInt would throw in a log line, far from
    // here and long after the fact. It is a hex string on purpose.
    expect(typeof status.grantedMask).toBe("string");
    expect(() => JSON.stringify(status)).not.toThrow();
  });
});

describe("FakeSignalSource — the jiggler must never look like a human", () => {
  it("records a jiggle but emits no signal for it", async () => {
    const src = new FakeSignalSource(() => 42_000);
    const { sink, signals } = collect();
    await src.start(sink);

    expect(src.jiggle()).toBe(true);
    expect(src.jiggle()).toBe(true);

    // AGENTS.md trap #4. If our own synthetic input reached the reducer, the
    // idle countdown would never expire and every day would be 24 hours long,
    // with no error anywhere.
    expect(signals).toEqual([]);
    expect(src.jiggles).toEqual([42_000, 42_000]);
    expect(src.probe().counters.realEvents).toBe(0);
    expect(src.probe().counters.ourEvents).toBe(2);
  });

  it("returns false and posts nothing when Accessibility is not granted", async () => {
    const src = new FakeSignalSource(() => 1_000);
    const { sink, signals } = collect();
    await src.start(sink);
    src.perms = {
      listenEvent: true,
      postEvent: false,
      axTrusted: false,
      listenEventAccess: "granted",
      postEventAccess: "unknown",
    };

    // CGEventPost fails SILENTLY without the grant: no error, no exception,
    // cursor delta 0. The caller gets a boolean it has to act on instead.
    expect(src.jiggle()).toBe(false);
    expect(src.jiggles).toEqual([]);
    expect(signals).toEqual([]);
  });
});

describe("FakeSignalSource — keep awake is not work", () => {
  it("emits no signal when keep-awake is toggled on or off", async () => {
    const src = new FakeSignalSource(() => 1_000);
    const { sink, signals } = collect();
    await src.start(sink);

    src.setKeepAwake(true);
    expect(src.keepAwake).toBe(true);
    src.setKeepAwake(false);
    expect(src.keepAwake).toBe(false);

    expect(signals).toEqual([]);
  });

  it("releases keep-awake on stop, the way the kernel does on process death", async () => {
    const src = new FakeSignalSource(() => 1_000);
    await src.start(() => {});
    src.setKeepAwake(true);
    src.stop();
    expect(src.keepAwake).toBe(false);
  });
});

describe("FakeSignalSource — camera and mic edges come out of probe()", () => {
  it("emits camera_on at the probe instant and camera_off at the last on-probe", async () => {
    let t = 1_000;
    const src = new FakeSignalSource(() => t);
    const { sink, signals } = collect();
    await src.start(sink);

    src.cameraOn = true;
    t = 301_000;
    src.probe();
    t = 601_000;
    src.probe(); // still on: nothing emitted
    src.cameraOn = false;
    t = 901_000;
    src.probe();

    expect(signals).toEqual([
      { kind: "camera_on", atMs: 301_000 },
      // NOT 901_000. The camera could have stopped at any point in the window;
      // the last time we saw it running is the only defensible answer, and it
      // is the one that cannot invent minutes.
      { kind: "camera_off", atMs: 601_000 },
    ]);
  });

  it("emits mic_on and mic_off with the same rule", async () => {
    let t = 0;
    const src = new FakeSignalSource(() => t);
    const { sink, signals } = collect();
    await src.start(sink);

    src.micOn = true;
    t = 60_000;
    src.probe();
    src.micOn = false;
    t = 360_000;
    src.probe();

    expect(signals).toEqual([
      { kind: "mic_on", atMs: 60_000 },
      { kind: "mic_off", atMs: 60_000 },
    ]);
  });

  it("reports the raw camera and mic levels in the status", async () => {
    const src = new FakeSignalSource(() => 1_000);
    await src.start(() => {});
    src.cameraOn = true;
    src.micOn = true;
    const status = src.probe();
    expect(status.cameraInUse).toBe(true);
    expect(status.micInUse).toBe(true);
  });
});

describe("FakeSignalSource — the failures a real Mac inflicts", () => {
  it("a killed tap reads as disabled and emits nothing", async () => {
    const src = new FakeSignalSource(() => 1_000);
    const { sink, signals } = collect();
    await src.start(sink);

    src.killTap();

    // This is the shape of the real failure: the app looks fine and measures
    // nothing. Only the status says so.
    expect(src.probe().tapEnabled).toBe(false);
    expect(signals).toEqual([]);
  });

  it("restart() rebuilds the tap and counts the restart", async () => {
    const src = new FakeSignalSource(() => 1_000);
    await src.start(() => {});
    src.killTap();
    const status = src.restart();
    expect(status.tapEnabled).toBe(true);
    expect(src.restarts).toBe(1);
  });

  it("stripped keyboard bits are visible in the granted mask, not inferred from the tap", async () => {
    const src = new FakeSignalSource(() => 1_000);
    await src.start(() => {});
    const KEYBOARD_BITS = 0x1c00;

    expect(Number.parseInt(src.probe().grantedMask, 16) & KEYBOARD_BITS).toBe(KEYBOARD_BITS);

    // Input Monitoring revoked: CGEventTapCreate still returns non-NULL, the tap
    // still reports enabled, and the keyboard bits are simply gone. Hours come
    // out slightly low, forever, with nothing logged. AGENTS.md traps #2 and #3.
    src.stripKeyboardBits();
    const degraded = src.probe();
    expect(degraded.tapEnabled).toBe(true);
    expect(degraded.keyboardBitsGranted).toBe(false);
    expect(Number.parseInt(degraded.grantedMask, 16) & KEYBOARD_BITS).toBe(0);
  });
});

describe("FakeSignalSource — the test driver", () => {
  it("emits key and mouse signals at the timestamps it was given", async () => {
    const src = new FakeSignalSource(() => 999_999_999);
    const { sink, signals } = collect();
    await src.start(sink);

    src.key(1_000, 3);
    src.mouse(2_000);

    expect(signals).toEqual([
      { kind: "key", atMs: 1_000, count: 3 },
      { kind: "mouse", atMs: 2_000, count: 1 },
    ]);
  });

  it("tracks lastRealSignalMs from the signals themselves, never from the clock", async () => {
    // The clock is hours ahead of the signals on purpose: if lastRealSignalMs
    // ever came from now(), an interval would end in the future and the whole
    // measurement would be fiction.
    const src = new FakeSignalSource(() => 9_000_000);
    await src.start(() => {});
    src.key(1_000);
    src.mouse(2_500);
    src.key(2_000); // out of order: the max wins, not the last one seen

    const counters = src.probe().counters;
    expect(counters.lastRealSignalMs).toBe(2_500);
    expect(counters.realEvents).toBe(3);
  });

  it("plays a scripted day in one call", async () => {
    const src = new FakeSignalSource(() => 0);
    const { sink, signals } = collect();
    await src.start(sink);
    src.script([
      [1_000, "key"],
      [2_000, "mouse"],
      [3_000, "key"],
    ]);
    expect(signals.map((s) => s.atMs)).toEqual([1_000, 2_000, 3_000]);
    expect(signals.map((s) => s.kind)).toEqual(["key", "mouse", "key"]);
  });

  it("reports zero number-contract violations — the fake cannot have any", async () => {
    const src = new FakeSignalSource(() => 0);
    await src.start(() => {});
    expect(src.probe().counters.numberContractViolations).toBe(0);
  });
});
