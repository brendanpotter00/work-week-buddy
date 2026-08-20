import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { levelEdge, LEVEL_OFF, type LevelState } from "@/native/levels";
import type { RawSignal } from "@/native/types";

/**
 * The close rule, applied to levels.
 *
 * The camera and the mic are sampled by the 5-minute watchdog, so "it went off"
 * is only ever noticed up to a whole probe interval late. Stamping the off edge
 * at the moment of NOTICING would donate up to five phantom minutes to every
 * meeting — the same bug as ending an interval at the timeout instant, wearing a
 * different hat. AGENTS.md, the rule that outranks everything.
 */
describe("levelEdge", () => {
  it("stamps the on edge at the probe instant", () => {
    const { next, signal } = levelEdge(LEVEL_OFF, true, 1_000, "camera_on", "camera_off");
    expect(signal).toEqual({ kind: "camera_on", atMs: 1_000 });
    expect(next).toEqual({ on: true, lastOnMs: 1_000 });
  });

  it("emits nothing while a level stays on, but tracks the last on-probe", () => {
    const first = levelEdge(LEVEL_OFF, true, 1_000, "mic_on", "mic_off");
    const second = levelEdge(first.next, true, 301_000, "mic_on", "mic_off");
    expect(second.signal).toBeNull();
    expect(second.next).toEqual({ on: true, lastOnMs: 301_000 });
  });

  it("stamps the off edge at the last probe the level was still on, never at the probe that noticed", () => {
    const on = levelEdge(LEVEL_OFF, true, 1_000, "camera_on", "camera_off");
    const stillOn = levelEdge(on.next, true, 301_000, "camera_on", "camera_off");
    // Five minutes later the camera is gone. It could have gone at any point in
    // that window; the only defensible answer is the last time we SAW it on.
    const off = levelEdge(stillOn.next, false, 601_000, "camera_on", "camera_off");
    expect(off.signal).toEqual({ kind: "camera_off", atMs: 301_000 });
    expect(off.signal?.atMs).not.toBe(601_000);
    expect(off.next).toEqual(LEVEL_OFF);
  });

  it("emits nothing while a level stays off", () => {
    const { next, signal } = levelEdge(LEVEL_OFF, false, 5_000, "mic_on", "mic_off");
    expect(signal).toBeNull();
    expect(next).toBe(LEVEL_OFF);
  });

  it("carries no event count — levels are not events", () => {
    const { signal } = levelEdge(LEVEL_OFF, true, 1_000, "camera_on", "camera_off");
    expect(signal && "count" in signal).toBe(false);
  });

  /**
   * The property that must hold for any sequence of probes at any spacing:
   * an off edge is never stamped later than the last observed on-probe, and
   * therefore never later than the probe that detected it.
   */
  it("never stamps an off edge after the last probe at which the level was on", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ gapMs: fc.integer({ min: 1, max: 900_000 }), on: fc.boolean() }), {
          minLength: 1,
          maxLength: 60,
        }),
        (probes) => {
          let state: LevelState = LEVEL_OFF;
          let at = 1_700_000_000_000;
          let lastSeenOnAt: number | null = null;
          const emitted: Array<{ signal: RawSignal; detectedAt: number }> = [];

          for (const p of probes) {
            at += p.gapMs;
            const { next, signal } = levelEdge(state, p.on, at, "camera_on", "camera_off");
            if (signal) emitted.push({ signal, detectedAt: at });
            if (signal?.kind === "camera_off") {
              // The off edge must land exactly on the last probe we saw it on.
              expect(signal.atMs).toBe(lastSeenOnAt);
            }
            if (p.on) lastSeenOnAt = at;
            state = next;
          }

          for (const e of emitted) {
            expect(e.signal.atMs).toBeLessThanOrEqual(e.detectedAt);
          }
          // Edges alternate, and the first one is always an on.
          const kinds = emitted.map((e) => e.signal.kind);
          kinds.forEach((k, i) => {
            expect(k).toBe(i % 2 === 0 ? "camera_on" : "camera_off");
          });
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });
});
