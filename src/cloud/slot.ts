/**
 * Which Mac is this — `personal` or `work`?
 *
 * ── WHY THIS FILE IS THE DANGEROUS ONE ──────────────────────────────────────
 * The Worker stamps `machine_id` from the TOKEN and never from the request body
 * (`worker/src/auth.ts`), which is what stops a stolen token forging the other
 * Mac's rows. The cost of that guarantee is that each token's machine id has to
 * be the IOPlatformUUID of the Mac that will carry it.
 *
 * Get it wrong and NOTHING BREAKS. Both Macs sync. Both mirrors converge. Every
 * total is correct. The per-machine breakdown attributes every hour to the
 * wrong laptop, for ever, and there is no error anywhere. `bringup-cloud.sh`
 * answers this by refusing to guess and requiring `--this`. A wizard cannot
 * refuse — asking is the thing it exists to avoid — so it has to actually know.
 *
 * ── WHAT CAN BE OBSERVED, AND WHAT CANNOT ───────────────────────────────────
 * A `secret_text` binding's value cannot be read back out of Cloudflare. That
 * is the whole difficulty, and the way through it is to notice that the machine
 * ids are NOT SECRETS. `worker/wrangler.toml` says so out loud: "MACHINE_ID_*
 * are not secret in the confidentiality sense, but they are set the same way so
 * that bring-up is one uniform ritual." They were secrets for tidiness.
 *
 * So the wizard stores them as **`plain_text` bindings**, whose values the
 * settings endpoint returns. The Worker cannot tell the difference — `env.X` is
 * `env.X` — and the app gains the one fact that makes this decidable: reading
 * back that `MACHINE_ID_PERSONAL` is this Mac's UUID, or someone else's.
 *
 * The first run against a deployment `scripts/bringup-cloud.sh` created is the
 * exception: there the ids are still secrets and unreadable. `R5` below is what
 * covers that case, and it is sound rather than a guess — see its comment.
 *
 * Nothing here reads a clock, imports electron or performs I/O. It is a pure
 * function from evidence to a verdict, so every branch is a table-driven test.
 */

export type MachineSlot = "personal" | "work";

export const SLOT_BINDING = {
  personal: { token: "TOKEN_PERSONAL", machineId: "MACHINE_ID_PERSONAL" },
  work: { token: "TOKEN_WORK", machineId: "MACHINE_ID_WORK" },
} as const;

export const OTHER_SLOT: Record<MachineSlot, MachineSlot> = {
  personal: "work",
  work: "personal",
};

export interface SlotEvidence {
  /** This Mac's IOPlatformUUID. Empty when `ioreg` could not be read. */
  readonly thisMachineId: string;
  /** `MACHINE_ID_PERSONAL` as a readable plain_text binding, else null. */
  readonly readableMachineIdPersonal: string | null;
  readonly readableMachineIdWork: string | null;
  /** Every binding name on the deployed script, whatever its type. */
  readonly bindingNames: readonly string[];
  /**
   * Distinct `machine_id` values already in the cloud database.
   *
   * Every one of these was stamped SERVER-SIDE by the Worker from a token's
   * slot, which is what makes them evidence rather than hearsay.
   */
  readonly stampedMachineIds: readonly string[];
  /** False when no Worker has ever been deployed under this name. */
  readonly workerExists: boolean;
}

export type SlotVerdict =
  /** Decided from evidence that admits no other reading. Do not ask. */
  | { readonly kind: "certain"; readonly slot: MachineSlot; readonly because: string }
  /**
   * Nothing contradicts it and nothing can go wrong if it is taken — both slots
   * are free, so whichever this Mac takes, the other Mac takes the other. Shown
   * to the owner, not asked about.
   */
  | { readonly kind: "assumed"; readonly slot: MachineSlot; readonly because: string }
  /** Genuinely ambiguous. Ask, and say what is and is not known. */
  | { readonly kind: "ask"; readonly suggested: MachineSlot | null; readonly because: string };

/**
 * The verdict, from first matching rule.
 *
 * The rules are ordered by how much they know, not by how common they are: an
 * `ask` that could have been a `certain` is a question the owner should not
 * have been asked, and a `certain` that should have been an `ask` is the silent
 * lifelong misattribution at the top of this file. Every rule below is
 * therefore either provable or it asks.
 */
export function detectSlot(e: SlotEvidence): SlotVerdict {
  const has = (name: string): boolean => e.bindingNames.includes(name);
  const id = e.thisMachineId;

  // Without this Mac's own UUID there is nothing to compare against, and a
  // machine id the app cannot read is a machine id it must not write.
  if (id === "") {
    return {
      kind: "ask",
      suggested: null,
      because:
        "this Mac's hardware UUID could not be read, so its identity cannot be " +
        "matched against what is already deployed.",
    };
  }

  // ── R1/R2. This Mac is already registered. The strongest evidence there is:
  //    a value read back off the live deployment that IS this Mac.
  if (e.readableMachineIdPersonal === id) {
    return {
      kind: "certain",
      slot: "personal",
      because: "this Mac's hardware UUID is already set as MACHINE_ID_PERSONAL.",
    };
  }
  if (e.readableMachineIdWork === id) {
    return {
      kind: "certain",
      slot: "work",
      because: "this Mac's hardware UUID is already set as MACHINE_ID_WORK.",
    };
  }

  // ── R3/R4. One slot is readable and belongs to a DIFFERENT Mac, and the
  //    other is free. There are two slots and this Mac is not the one in that
  //    slot, so it is the other one.
  const personalTaken = e.readableMachineIdPersonal !== null;
  const workTaken = e.readableMachineIdWork !== null;
  if (personalTaken && workTaken) {
    return {
      kind: "ask",
      suggested: null,
      because:
        "both slots are already registered to other Macs. There are only two, " +
        "so one of them has to be reused — pick the Mac this one replaces.",
    };
  }
  if (personalTaken) {
    return {
      kind: "certain",
      slot: "work",
      because:
        "the personal slot is registered to a different Mac, so this one takes work.",
    };
  }
  if (workTaken) {
    return {
      kind: "certain",
      slot: "personal",
      because:
        "the work slot is registered to a different Mac, so this one takes personal.",
    };
  }

  // ── Neither machine id is readable. Either nothing is deployed, or the
  //    deployment came from `scripts/bringup-cloud.sh`, which sets them as
  //    secrets. Fall back to what the binding NAMES and the database say.
  const hasPersonalId = has(SLOT_BINDING.personal.machineId);
  const hasWorkId = has(SLOT_BINDING.work.machineId);

  // ── R5a. A clean slate. Both slots are free, so this cannot be got wrong:
  //    whichever this Mac takes, the other Mac takes the other.
  if (!e.workerExists || (!hasPersonalId && !hasWorkId)) {
    return {
      kind: "assumed",
      slot: "personal",
      because: e.workerExists
        ? "neither slot has a machine id yet, so both are free."
        : "nothing is deployed yet, so this is the first Mac.",
    };
  }

  // ── R5b/R5c. Exactly one machine id is set, and it is not readable.
  //
  //    The inference: `stampedMachineId()` falls back to the LITERAL SLOT NAME
  //    when its machine id is unset (`worker/src/auth.ts`). So while
  //    MACHINE_ID_WORK is unset, the work token can only ever have stamped the
  //    word "work" — it cannot have stamped a UUID. Therefore any UUID in the
  //    database came from the personal slot, and if this Mac's UUID is one of
  //    them, MACHINE_ID_PERSONAL is this Mac. That is a proof, not a guess.
  const stamped = new Set(e.stampedMachineIds);
  if (hasPersonalId && !hasWorkId) {
    if (stamped.has(id)) {
      return {
        kind: "certain",
        slot: "personal",
        because:
          "the work slot has no machine id, so it can only ever have stamped the " +
          "word “work” — and this Mac's UUID is already on rows in the database, " +
          "which means the personal slot is this Mac.",
      };
    }
    return {
      kind: "ask",
      suggested: "work",
      because:
        "a machine id is set for the personal slot but Cloudflare will not say " +
        "whose, and this Mac has never synced, so it cannot be matched against " +
        "the rows already stored.",
    };
  }
  if (hasWorkId && !hasPersonalId) {
    if (stamped.has(id)) {
      return {
        kind: "certain",
        slot: "work",
        because:
          "the personal slot has no machine id, so it can only ever have stamped " +
          "the word “personal” — and this Mac's UUID is already on rows in the " +
          "database, which means the work slot is this Mac.",
      };
    }
    return {
      kind: "ask",
      suggested: "personal",
      because:
        "a machine id is set for the work slot but Cloudflare will not say whose, " +
        "and this Mac has never synced, so it cannot be matched against the rows " +
        "already stored.",
    };
  }

  // ── R5d. Both set, neither readable — a deployment `bringup-cloud.sh` fully
  //    configured. Nothing observable separates the two Macs.
  return {
    kind: "ask",
    suggested: null,
    because:
      "both slots already have a machine id, set as secrets by the bring-up " +
      "script, and Cloudflare will not say which Mac either one is.",
  };
}

/** What the wizard should do without asking. `null` means it must ask. */
export function autoSlot(verdict: SlotVerdict): MachineSlot | null {
  return verdict.kind === "ask" ? null : verdict.slot;
}
