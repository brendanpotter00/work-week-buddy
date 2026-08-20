/**
 * The three states, as arithmetic.
 *
 * `src/main/sync-seam.ts` states the rule this file enforces: "not configured"
 * is neither healthy nor failing, and painting it as either is the defect. It
 * gets its own test file rather than only a component test because the mistake
 * is a one-character one — `!configured` reading as "broken" — and because the
 * component test that would catch it is a jsdom render three layers away from
 * the branch.
 */
import { describe, expect, it } from "vitest";

import { syncHealthView, workerUrlError } from "@/renderer/lib/sync-health";
import { resolveSyncConfig } from "@/main/sync";
import type { DoctorReport, SyncConfigState } from "@/shared/ipc-types";

function config(over: Partial<SyncConfigState> = {}): SyncConfigState {
  return {
    workerUrl: "",
    tokenPresent: false,
    configured: false,
    error: null,
    vaultAvailable: true,
    ...over,
  };
}

const CONFIGURED = config({
  workerUrl: "https://wwb-sync.example.workers.dev",
  tokenPresent: true,
  configured: true,
});

function doctor(over: Partial<DoctorReport["sync"]> = {}, fp: Partial<DoctorReport["fingerprint"]> = {}) {
  return {
    sync: {
      configured: true,
      pendingRows: 0,
      lastFlushOkMs: 1_700_000_000_000,
      lastFlushError: null,
      lastPullMs: 1_700_000_000_000,
      lastPullError: null,
      watermark: 42,
      lastCloudWriteMs: 1_700_000_000_000,
      silentForMs: 60_000,
      ...over,
    },
    fingerprint: {
      checkedAtMs: 1_700_000_000_000,
      matched: true,
      localCount: 1284,
      cloudCount: 1284,
      localSha: "a",
      cloudSha: "a",
      ...fp,
    },
  } as DoctorReport;
}

describe("not configured is not a failure", () => {
  it("is its own tone, with no problems attached", () => {
    const v = syncHealthView(config(), null);
    expect(v.tone).toBe("unconfigured");
    expect(v.problems).toEqual([]);
    // The sentence has to say the hours are safe. An owner who has not created
    // a D1 database is not in trouble.
    expect(v.note).toMatch(/kept on this Mac/i);
  });

  it("names the half that is still missing rather than repeating 'not set up'", () => {
    expect(
      syncHealthView(config({ workerUrl: "https://x.workers.dev" }), null).note,
    ).toMatch(/token/i);
    expect(syncHealthView(config({ tokenPresent: true }), null).note).toMatch(/URL/);
  });

  it("says nothing at all before the first snapshot lands", () => {
    const v = syncHealthView(null, null);
    expect(v.tone).toBe("unknown");
    expect(v.problems).toEqual([]);
  });
});

describe("a URL that is set but unusable is a failure, not an empty install", () => {
  it("shows the reason, because a field you know you filled in reading 'not set up' is the worst of the three", () => {
    const v = syncHealthView(
      config({ workerUrl: "wwb-sync", error: "worker URL is not a URL: wwb-sync" }),
      null,
    );
    expect(v.tone).toBe("failing");
    expect(v.problems).toEqual(["worker URL is not a URL: wwb-sync"]);
  });

  it("does not tell someone with no keychain to paste a token", () => {
    const v = syncHealthView(config({ vaultAvailable: false }), null);
    expect(v.tone).toBe("failing");
    expect(v.note).toMatch(/keychain/i);
    expect(v.note).not.toMatch(/paste/i);
  });
});

describe("configured and working", () => {
  it("is healthy, and says pending rows when there are any", () => {
    expect(syncHealthView(CONFIGURED, doctor()).tone).toBe("healthy");
    expect(syncHealthView(CONFIGURED, doctor({ pendingRows: 3 })).note).toContain("3 rows");
    expect(syncHealthView(CONFIGURED, doctor({ pendingRows: 1 })).note).toContain("1 row ");
  });

  it("is healthy before any doctor report has arrived — configured is the fact", () => {
    expect(syncHealthView(CONFIGURED, null).tone).toBe("healthy");
  });
});

describe("configured and failing", () => {
  it("puts a fingerprint mismatch above a failed request", () => {
    // Rows are MISSING. That outranks one request that will be retried.
    const v = syncHealthView(
      CONFIGURED,
      doctor({ lastFlushError: "fetch failed" }, { matched: false, cloudCount: 1200 }),
    );
    expect(v.tone).toBe("failing");
    expect(v.problems[0]).toMatch(/disagree about how many rows/);
    expect(v.problems[1]).toMatch(/fetch failed/);
  });

  it("reports a failed pull separately from a flush that succeeded", () => {
    const v = syncHealthView(CONFIGURED, doctor({ lastPullError: "500" }));
    expect(v.problems).toHaveLength(1);
    expect(v.problems[0]).toMatch(/download/i);
  });

  it("raises the 72-hour silence alarm and not before", () => {
    expect(syncHealthView(CONFIGURED, doctor({ silentForMs: 71 * 3_600_000 })).tone).toBe(
      "healthy",
    );
    expect(syncHealthView(CONFIGURED, doctor({ silentForMs: 73 * 3_600_000 })).tone).toBe(
      "failing",
    );
  });

  it("promises that nothing is lost, because nothing is — the mirror is the outbox", () => {
    expect(syncHealthView(CONFIGURED, doctor({ lastFlushError: "offline" })).note).toMatch(
      /nothing is lost/i,
    );
  });
});

describe("workerUrlError", () => {
  it("accepts a blank, which is how sync is turned off", () => {
    expect(workerUrlError("")).toBeNull();
    expect(workerUrlError("   ")).toBeNull();
  });

  it("accepts what bringup prints", () => {
    expect(workerUrlError("https://wwb-sync.example.workers.dev")).toBeNull();
    expect(workerUrlError("  https://wwb-sync.example.workers.dev  ")).toBeNull();
    // http is allowed: `resolveSyncConfig` allows it, and a local wrangler dev
    // server is the reason.
    expect(workerUrlError("http://localhost:8787")).toBeNull();
  });

  it("rejects the mistakes that would otherwise save silently", () => {
    expect(workerUrlError("wwb-sync.example.workers.dev")).toMatch(/not a URL/);
    expect(workerUrlError("ftp://example.com")).toMatch(/http/);
    expect(workerUrlError("just some words")).toMatch(/not a URL/);
  });

  it("agrees with main about every case", () => {
    // The renderer's check exists only to answer beside the field. If the two
    // ever disagreed, one of them would be rejecting a URL the other would
    // happily use — or worse, accepting one main will not.
    //
    // This test lives under test/ rather than beside the module BECAUSE it
    // imports main: `src/renderer/**` may not, and a test that reached across
    // that line from inside the renderer tree would be teaching the wrong
    // shape even while proving the right thing.
    for (const url of [
      "https://wwb-sync.example.workers.dev",
      "http://localhost:8787",
      "wwb-sync.example.workers.dev",
      "ftp://example.com",
      "just some words",
    ]) {
      const mainSaysOk = resolveSyncConfig(url, "a-token").config !== null;
      expect(workerUrlError(url) === null).toBe(mainSaysOk);
    }
  });
});
