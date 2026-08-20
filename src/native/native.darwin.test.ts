import { describe, it, expect } from "vitest";

/**
 * The boot test for the koffi declarations — the permission-free half of it.
 *
 * koffi validates a SYMBOL NAME at declaration time and never validates a
 * signature, so importing native.ts is itself the assertion that all ~45 symbol
 * names exist: a typo is a throw right here, on import. What koffi cannot check
 * — that every prototype's types are right — is a segfault at the first call,
 * possibly hours later, and no test runner can catch that safely.
 *
 * NOTHING HERE DEPENDS ON A TCC GRANT. No tap is created, no event is posted,
 * and no assertion reads a permission's value. That is deliberate: this terminal
 * may well hold Input Monitoring and Accessibility already, and a test that
 * passed because of that would report green on a machine where the packaged app
 * — a different TCC subject entirely — is silently dead. The calls that need a
 * grant are exercised by `--selftest`, by a human, on the target machine.
 *
 * Skipped off macOS: importing native.ts throws there by design.
 */
describe.skipIf(process.platform !== "darwin")("native.ts declarations, on macOS", () => {
  it("loads every framework and declares every symbol without throwing", async () => {
    const native = await import("./native");
    expect(typeof native.installTap).toBe("function");
    expect(typeof native.postJiggle).toBe("function");
    expect(typeof native.selfTest).toBe("function");
  });

  it("builds the event mask to exactly 0x0FC01CFF, with the keyboard bits in it", async () => {
    const { EVENT_MASK, KEYBOARD_BITS, MOUSE_BITS } = await import("./native");
    expect(KEYBOARD_BITS).toBe(0x1c00n); // keyDown | keyUp | flagsChanged
    expect(MOUSE_BITS).toBe(0x0fc000fen);
    expect(EVENT_MASK).toBe(0x0fc01cffn);
    expect(EVENT_MASK).toBe(264248575n);
    // flagsChanged (12) is trap #3: without it, modifier-only presses are
    // invisible and hours come out slightly low, forever.
    expect((EVENT_MASK >> 12n) & 1n).toBe(1n);
    // Bit 0 is kCGEventNull, the type the jiggler posts. Measured: without it
    // the tap receives zero of our own events, so the filter that keeps our
    // jiggle from counting as a human is never exercised and the self-test's
    // round-trip check can never pass. See the comment in native.ts.
    expect(EVENT_MASK & 1n).toBe(1n);
  });

  it("keeps the magic number a Number all the way through the module", async () => {
    const { WWB_MAGIC } = await import("./native");
    expect(typeof WWB_MAGIC).toBe("number");
    expect(WWB_MAGIC).toBe(0x57574b31);
  });

  it("lays CGEventTapInformation out at the ABI the C header specifies", async () => {
    // Imported here rather than at the top of the file so that a non-Mac run,
    // where every test in this block is skipped, never loads the addon at all.
    const koffi = (await import("koffi")).default;
    await import("./native");
    // Registered by name inside native.ts, so this reads that declaration and
    // not a copy of it. A reordered field or `enabled` declared as an int makes
    // eventsOfInterest read garbage — which is the granted-mask assertion, the
    // one thing standing between us and traps #2 and #3.
    const info = koffi.type("CGEventTapInformation");
    expect(koffi.sizeof(info)).toBe(48);
    // Three uint32s make 12 bytes; a uint64 must be 8-aligned, so four bytes of
    // padding land above eventsOfInterest and it starts at 16.
    expect(koffi.offsetof(info, "eventsOfInterest")).toBe(16);
    expect(koffi.offsetof(info, "tappingProcess")).toBe(24);
    expect(koffi.offsetof(info, "enabled")).toBe(32);
  });

  it("preflights permissions without prompting, and reports them as booleans", async () => {
    const { permissions } = await import("./native");
    const perms = permissions();
    // The VALUES are not asserted on purpose — see the header comment.
    expect(typeof perms.listenEvent).toBe("boolean");
    expect(typeof perms.postEvent).toBe("boolean");
    expect(typeof perms.axTrusted).toBe("boolean");
  });

  it("reports no tap and no granted mask before one is installed", async () => {
    const { isTapEnabled, grantedMask, keyboardBitsGranted } = await import("./native");
    // Never inferred from CGEventTapCreate returning non-NULL: it does that even
    // when the keyboard bits have been stripped.
    expect(isTapEnabled()).toBe(false);
    expect(grantedMask()).toBeNull();
    expect(keyboardBitsGranted()).toBe(false);
  });

  it("creates and releases exactly one power assertion", async () => {
    const { setKeepAwake, keepAwakeActive } = await import("./native");
    // IOPMAssertionCreateWithName needs no permission, so this is the one part
    // of the native layer that can be asserted end to end here. `pmset -g
    // assertions` showing exactly one row is gate m5.d, run by a human.
    expect(keepAwakeActive()).toBe(false);
    setKeepAwake(true);
    expect(keepAwakeActive()).toBe(true);
    setKeepAwake(true); // idempotent: never a second assertion
    expect(keepAwakeActive()).toBe(true);
    setKeepAwake(false);
    expect(keepAwakeActive()).toBe(false);
    setKeepAwake(false); // and releasing twice is a no-op, not a crash
    expect(keepAwakeActive()).toBe(false);
  });

  it("clamps a converted event timestamp forward only", async () => {
    const { reanchorClock, eventEpochMs } = await import("./native");
    reanchorClock();
    // An absurd hardware timestamp must not produce an interval that ends in
    // the future. The clamp is one-directional, so it can never add minutes.
    expect(eventEpochMs(Number.MAX_SAFE_INTEGER)).toBeLessThanOrEqual(Date.now());
    expect(eventEpochMs(0)).toBeLessThanOrEqual(Date.now());
  });
});
