/**
 * Which Mac is this?
 *
 * The one decision in this feature that fails SILENTLY. A wrong slot does not
 * error: both Macs sync, both mirrors converge, every total stays right, and
 * every hour this Mac works is filed under the other laptop for ever. So every
 * branch of `detectSlot` is pinned here, and — just as importantly — every
 * branch that must ASK is pinned too. A rule that guesses confidently is worse
 * than one that admits it cannot tell.
 */
import { describe, it, expect } from "vitest";

import {
  OTHER_SLOT,
  SLOT_BINDING,
  autoSlot,
  detectSlot,
  type SlotEvidence,
} from "../../src/cloud/slot";
import type { CloudSlot } from "../../src/shared/ipc-types";

const THIS_MAC = "00000000-0000-0000-0000-00000000AAAA";
const OTHER_MAC = "00000000-0000-0000-0000-00000000BBBB";
const THIRD_MAC = "00000000-0000-0000-0000-00000000CCCC";

function evidence(over: Partial<SlotEvidence> = {}): SlotEvidence {
  return {
    thisMachineId: THIS_MAC,
    readableMachineIdPersonal: null,
    readableMachineIdWork: null,
    bindingNames: [],
    stampedMachineIds: [],
    workerExists: false,
    ...over,
  };
}

describe("when the machine ids can be read back", () => {
  it("recognises this Mac in the personal slot", () => {
    const v = detectSlot(evidence({ workerExists: true, readableMachineIdPersonal: THIS_MAC }));
    expect(v.kind).toBe("certain");
    expect(autoSlot(v)).toBe("personal");
  });

  it("recognises this Mac in the work slot", () => {
    const v = detectSlot(evidence({ workerExists: true, readableMachineIdWork: THIS_MAC }));
    expect(v.kind).toBe("certain");
    expect(autoSlot(v)).toBe("work");
  });

  it("takes the free slot when the other one belongs to a different Mac", () => {
    const takenPersonal = detectSlot(
      evidence({ workerExists: true, readableMachineIdPersonal: OTHER_MAC }),
    );
    expect(takenPersonal.kind).toBe("certain");
    expect(autoSlot(takenPersonal)).toBe("work");

    const takenWork = detectSlot(
      evidence({ workerExists: true, readableMachineIdWork: OTHER_MAC }),
    );
    expect(takenWork.kind).toBe("certain");
    expect(autoSlot(takenWork)).toBe("personal");
  });

  it("asks when both slots belong to other Macs — there is no third", () => {
    const v = detectSlot(
      evidence({
        thisMachineId: THIRD_MAC,
        workerExists: true,
        readableMachineIdPersonal: THIS_MAC,
        readableMachineIdWork: OTHER_MAC,
      }),
    );
    expect(v.kind).toBe("ask");
    expect(autoSlot(v)).toBeNull();
    expect(v.kind === "ask" ? v.because : "").toContain("both slots");
  });
});

describe("a clean slate", () => {
  it("takes personal when nothing is deployed", () => {
    const v = detectSlot(evidence());
    // Safe by construction: both slots are free, so whichever this Mac takes,
    // the other Mac takes the other. Shown, not asked about.
    expect(v.kind).toBe("assumed");
    expect(autoSlot(v)).toBe("personal");
  });

  it("takes personal when a Worker exists but has no machine ids at all", () => {
    const v = detectSlot(
      evidence({ workerExists: true, bindingNames: ["DB", "TOKEN_PERSONAL"] }),
    );
    expect(v.kind).toBe("assumed");
    expect(autoSlot(v)).toBe("personal");
  });
});

describe("a deployment the shell script configured", () => {
  /**
   * `scripts/bringup-cloud.sh` sets the machine ids as SECRETS, so nothing can
   * read their values. This is the owner's live account today: TOKEN_PERSONAL,
   * TOKEN_WORK and MACHINE_ID_PERSONAL set, MACHINE_ID_WORK not.
   */
  const shellScriptState = {
    workerExists: true,
    bindingNames: ["DB", "TOKEN_PERSONAL", "TOKEN_WORK", "MACHINE_ID_PERSONAL"],
  } as const;

  it("proves this Mac is personal from a UUID the cloud has stamped", () => {
    // The inference: MACHINE_ID_WORK is unset, so `stampedMachineId` falls back
    // to the literal word "work" for that slot. A UUID in the database can
    // therefore only have come from the personal slot.
    const v = detectSlot(
      evidence({ ...shellScriptState, stampedMachineIds: ["work", THIS_MAC] }),
    );
    expect(v.kind).toBe("certain");
    expect(autoSlot(v)).toBe("personal");
  });

  it("asks — suggesting work — when this Mac has never synced", () => {
    const v = detectSlot(
      evidence({ ...shellScriptState, stampedMachineIds: ["work", OTHER_MAC] }),
    );
    expect(v.kind).toBe("ask");
    expect(v.kind === "ask" ? v.suggested : null).toBe("work");
  });

  it("mirrors the same reasoning when only the work id is set", () => {
    const state = {
      workerExists: true,
      bindingNames: ["DB", "TOKEN_PERSONAL", "TOKEN_WORK", "MACHINE_ID_WORK"],
    } as const;
    expect(autoSlot(detectSlot(evidence({ ...state, stampedMachineIds: [THIS_MAC] })))).toBe(
      "work",
    );
    const asks = detectSlot(evidence({ ...state, stampedMachineIds: [OTHER_MAC] }));
    expect(asks.kind).toBe("ask");
    expect(asks.kind === "ask" ? asks.suggested : null).toBe("personal");
  });

  it("asks when BOTH ids are set as secrets and neither can be read", () => {
    const v = detectSlot(
      evidence({
        workerExists: true,
        bindingNames: ["MACHINE_ID_PERSONAL", "MACHINE_ID_WORK"],
        stampedMachineIds: [THIS_MAC, OTHER_MAC],
      }),
    );
    expect(v.kind).toBe("ask");
    expect(autoSlot(v)).toBeNull();
  });
});

describe("refusing to guess", () => {
  it("asks when this Mac's own UUID could not be read", () => {
    // A machine id the app cannot read is a machine id it must not write:
    // stamping "" onto every row would fork this Mac's history from itself.
    const v = detectSlot(
      evidence({ thisMachineId: "", workerExists: true, readableMachineIdPersonal: OTHER_MAC }),
    );
    expect(v.kind).toBe("ask");
    expect(autoSlot(v)).toBeNull();
  });

  it("always explains itself, whatever it decided", () => {
    const cases = [
      evidence(),
      evidence({ workerExists: true, readableMachineIdPersonal: THIS_MAC }),
      evidence({ workerExists: true, readableMachineIdPersonal: OTHER_MAC }),
      evidence({ thisMachineId: "" }),
    ];
    for (const e of cases) {
      const because = detectSlot(e).because;
      expect(because.length).toBeGreaterThan(20);
      expect(because.endsWith(".")).toBe(true);
    }
  });
});

describe("the slot tables", () => {
  it("names the four bindings the Worker actually reads", () => {
    // `worker/src/auth.ts` and `worker/src/types.ts` read exactly these.
    expect(SLOT_BINDING.personal).toEqual({
      token: "TOKEN_PERSONAL",
      machineId: "MACHINE_ID_PERSONAL",
    });
    expect(SLOT_BINDING.work).toEqual({
      token: "TOKEN_WORK",
      machineId: "MACHINE_ID_WORK",
    });
  });

  it("has exactly two slots, and each is the other's other", () => {
    expect(OTHER_SLOT.personal).toBe("work");
    expect(OTHER_SLOT.work).toBe("personal");
  });

  it("stays in step with the IPC contract's copy of the union", () => {
    // `src/shared/ipc-types.ts` imports nothing, so it restates the slot type.
    // Two definitions that can drift are two definitions that will.
    const fromContract: CloudSlot[] = ["personal", "work"];
    expect(Object.keys(SLOT_BINDING).sort()).toEqual([...fromContract].sort());
  });
});
