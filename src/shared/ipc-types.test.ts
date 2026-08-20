/**
 * The wire contract, checked against the code that produces the values.
 *
 * `docs/IMPL_UI.md` §2.4 lists `sleep`, `lock`, `shutdown` and `paused` in
 * `EndReason`. The committed reducer emits none of them. A wire type that is
 * wider than what can actually appear teaches the renderer to branch on states
 * that never happen; a wire type that is NARROWER is worse — a real
 * `end_reason` would fall through every branch and render as blank.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import type { EndReason as CoreEndReason } from "../core/types";
import {
  DEFAULT_METRICS_POLICY,
  INVOKE_CHANNELS,
  PUSH_CHANNELS,
  type EndReason as WireEndReason,
  type HoldKind,
  type InvokeChannel,
  type LiveStatus,
  type PushChannel,
  type SignalKind,
} from "./ipc-types";

describe("EndReason stays in step with the reducer", () => {
  it("every reason the reducer can emit exists on the wire", () => {
    expectTypeOf<CoreEndReason>().toExtend<WireEndReason>();
    expectTypeOf<WireEndReason>().toExtend<CoreEndReason>();
  });

  it("names the values, so widening one is a visible diff", () => {
    const all: WireEndReason[] = [
      "idle_timeout",
      "camera_cap",
      "jiggler_toggle",
      "pause",
      "app_quit",
      "tap_lost",
      "crash_recovered",
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("heldOpenBy is narrower than SignalKind, on purpose", () => {
  it("cannot be 'input' — a person is not a hold", () => {
    // `runtime.heldBy()` answers camera, mic or null. An interval a person is
    // feeding is OPEN, never HELD, so there is no fourth answer and no `input`
    // branch for the UI to grow. Widening this back to `SignalKind` fails here
    // rather than silently reintroducing dead copy in the stopwatch.
    expectTypeOf<HoldKind>().toEqualTypeOf<"camera" | "mic">();
    expectTypeOf<HoldKind>().toExtend<SignalKind>();
    expectTypeOf<LiveStatus["heldOpenBy"]>().toEqualTypeOf<HoldKind | null>();
  });

  it("still lets lastSignalKind be input — that one really can be", () => {
    expectTypeOf<LiveStatus["lastSignalKind"]>().toEqualTypeOf<SignalKind | null>();
  });
});

describe("the channel allowlists", () => {
  it("have no duplicates and cover the contract exactly", () => {
    expect(new Set(INVOKE_CHANNELS).size).toBe(INVOKE_CHANNELS.length);
    expect(new Set(PUSH_CHANNELS).size).toBe(PUSH_CHANNELS.length);
    // `satisfies readonly InvokeChannel[]` proves every entry is a real
    // channel at compile time; this proves the list is not merely a subset.
    expectTypeOf<(typeof INVOKE_CHANNELS)[number]>().toEqualTypeOf<InvokeChannel>();
    expectTypeOf<(typeof PUSH_CHANNELS)[number]>().toEqualTypeOf<PushChannel>();
  });

  it("namespaces every channel, so a stray ipcMain.handle is obvious", () => {
    for (const c of [...INVOKE_CHANNELS, ...PUSH_CHANNELS]) {
      expect(c).toMatch(/^wwb:[a-z-]+:[a-zA-Z-]+$/);
    }
  });
});

describe("the default metrics policy", () => {
  it("does not count jiggler time — PRD D1 option (a)", () => {
    expect(DEFAULT_METRICS_POLICY.countJigglerTime).toBe(0);
    expect(DEFAULT_METRICS_POLICY.minIntervalS).toBe(90);
    expect(DEFAULT_METRICS_POLICY.graceS).toBe(0);
  });

  it("uses thresholds that keep a 1.9-hour day distinct from a day off", () => {
    const [t1, t2, t3] = DEFAULT_METRICS_POLICY.heatmapThresholdsH;
    expect(t1).toBeGreaterThan(0);
    expect(t2).toBeGreaterThan(t1);
    expect(t3).toBeGreaterThan(t2);
  });
});
