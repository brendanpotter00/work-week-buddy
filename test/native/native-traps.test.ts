import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Structural assertions on src/native/native.ts.
 *
 * native.ts cannot be unit-tested. Creating the tap needs Input Monitoring,
 * posting a jiggle needs Accessibility, and there is no honest way to assert
 * either from a test runner — a green test on a terminal that already holds
 * Accessibility says nothing about the packaged app, which is a different TCC
 * subject entirely. The real exercise is `--selftest`, run by a human.
 *
 * What CAN be checked here, and is checked here, is that the shape of the code
 * has not drifted away from the five silent-failure mitigations that live in
 * that file. Each of these has exactly one symptom in production — wrong hours,
 * no error — and by then it is weeks of data too late.
 */

const ROOT = process.cwd();
const NATIVE_DIR = join(ROOT, "src", "native");
const NATIVE_TS = join(NATIVE_DIR, "native.ts");

const SOURCE = readFileSync(NATIVE_TS, "utf8");

/** Comments say what we meant; only code does anything. Assertions run on code. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
const CODE = stripComments(SOURCE);

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}
const SRC_FILES = tsFilesUnder(join(ROOT, "src"));
/** Production source: the assertions below are about shipped code, not tests. */
const PROD_FILES = SRC_FILES.filter((f) => !f.endsWith(".test.ts"));
const rel = (f: string): string => relative(ROOT, f).split(sep).join("/");

/** The body of one top-level `function name(` … up to the next top-level `\n}`. */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `${name} must exist in native.ts`).toBeGreaterThan(-1);
  const end = src.indexOf("\n}", start);
  return src.slice(start, end);
}

describe("native.ts is the only file that touches koffi", () => {
  it("imports koffi in exactly one production file", () => {
    const importers = PROD_FILES.filter((f) => /from\s+["']koffi["']/.test(readFileSync(f, "utf8")));
    // A wrong prototype is a segfault rather than a compile error, so the blast
    // radius stays in one file that is reviewed once and then frozen.
    expect(importers.map(rel)).toEqual(["src/native/native.ts"]);
  });

  it("has exactly one other file that touches koffi at all — the boot test", () => {
    // Static or dynamic: any mention of the module counts here.
    const importers = SRC_FILES.filter((f) => /["']koffi["']/.test(readFileSync(f, "utf8")));
    // native.darwin.test.ts reads the struct registration back out of koffi to
    // assert the ABI. Listing it explicitly means a third importer fails here.
    expect(importers.map(rel).sort()).toEqual([
      "src/native/native.darwin.test.ts",
      "src/native/native.ts",
    ]);
  });

  it("keeps electron out of src/native/ entirely", () => {
    // The whole point of the SignalSource seam is that everything below it can
    // be built and tested with no Electron and no Mac.
    const offenders = tsFilesUnder(NATIVE_DIR).filter((f) =>
      /from\s+["']electron["']/.test(readFileSync(f, "utf8")),
    );
    expect(offenders.map(rel)).toEqual([]);
  });

  it("shares levels.ts between the real source and the fake", () => {
    // Parity is not a promise in a comment: both sources call the same function.
    for (const f of ["mac-source.ts", "fake-source.ts"]) {
      const src = readFileSync(join(NATIVE_DIR, f), "utf8");
      expect(src, f).toMatch(/from\s+["']\.\/levels["']/);
    }
  });
});

describe("trap #4 — the magic number is a Number, never a BigInt literal", () => {
  it("is written exactly once in the shipped source, with no n suffix", () => {
    // `0x57574B31n !== 0x57574B31`. A BigInt literal here makes the comparison
    // silently false, our own jiggle counts as human input, and the app reports
    // 24-hour workdays with no error anywhere. One constant, imported everywhere.
    const occurrences = PROD_FILES.flatMap((f) => {
      const matches = stripComments(readFileSync(f, "utf8")).match(/0x57574b31n?/gi) ?? [];
      return matches.map((m) => ({ file: rel(f), literal: m }));
    });
    expect(occurrences).toEqual([{ file: "src/shared/constants.ts", literal: "0x57574b31" }]);
    expect(occurrences.every((o) => !o.literal.endsWith("n"))).toBe(true);
  });

  it("documents why the mistake is invisible", () => {
    // This is the whole bug, in one line: no error, no warning, just false.
    expect((0x57574b31 as unknown) === 0x57574b31n).toBe(false);
  });

  it("native.ts imports that one constant rather than restating it", () => {
    expect(CODE).toMatch(/import\s*\{\s*WWB_MAGIC\s*\}\s*from\s*["']\.\.\/shared\/constants["']/);
  });

  it("normalises every field read through one typeof-number helper", () => {
    const body = functionBody(CODE, "fieldAsNumber");
    expect(body).toMatch(/typeof v === "number"/);
    expect(body).toMatch(/numberContractViolations\+\+/);
    // The helper must not throw: a throw inside the tap callback unwinds into a
    // CoreGraphics trampoline, which is undefined behaviour.
    expect(body).not.toMatch(/\bthrow\b/);
  });

  it("compares userData with === against the Number constant", () => {
    expect(functionBody(CODE, "isOurs")).toMatch(/userData !== WWB_MAGIC/);
  });
});

describe("trap #5 — kCGEventSourceStateID is not a discriminator", () => {
  it("never reads field 45", () => {
    // A source created with kCGEventSourceStateHIDSystemState reads back 1, and
    // so does real HID input. It cannot separate them by construction.
    expect(CODE).not.toMatch(/kCGEventSourceStateID/);
    expect(CODE).not.toMatch(/,\s*45\s*\)/);
  });

  it("uses exactly the two fields that do discriminate — 41 and 42", () => {
    expect(CODE).toMatch(/const kCGEventSourceUnixProcessID = 41;/);
    expect(CODE).toMatch(/const kCGEventSourceUserData = 42;/);
    const body = functionBody(CODE, "isOurs");
    expect(body).toMatch(/kCGEventSourceUserData/);
    expect(body).toMatch(/kCGEventSourceUnixProcessID/);
    expect(body).toMatch(/srcPid === process\.pid/);
  });
});

describe("trap #6 — the jiggle is posted where the tap listens", () => {
  it("declares one tap-location constant", () => {
    const declarations = CODE.match(/const TAP_LOCATION = \d+;/g) ?? [];
    expect(declarations).toHaveLength(1);
  });

  it("passes that same constant to CGEventTapCreate and to CGEventPost", () => {
    // An HID-posted event is invisible to a session tap, so posting to the wrong
    // location looks exactly like "the jiggler works fine" while our own filter
    // never fires — and then the jiggle counts as a human.
    expect(CODE).toMatch(/CGEventTapCreate\(\s*TAP_LOCATION\s*,/);
    expect(CODE).toMatch(/CGEventPost\(\s*TAP_LOCATION\s*,/);
    // No numeric literal may be passed to either.
    expect(CODE).not.toMatch(/CGEventPost\(\s*\d/);
    expect(CODE).not.toMatch(/CGEventTapCreate\(\s*\d/);
  });
});

describe("trap #1 — the run-loop source is registered in BOTH modes", () => {
  const install = functionBody(CODE, "installTap");

  it("adds the source to kCFRunLoopDefaultMode and to kCFRunLoopCommonModes", () => {
    // Measured: Common only → 0 events, silently, with the tap still reporting
    // enabled. Default only → events flow. Default makes it work at all; Common
    // keeps it working during menu tracking and modal nested run-loop modes.
    expect(install).toMatch(/CFRunLoopAddSource\(rl, source, kCFRunLoopDefaultMode\(\)\)/);
    expect(install).toMatch(/CFRunLoopAddSource\(rl, source, kCFRunLoopCommonModes\(\)\)/);
  });

  it("asserts the source really landed in the default mode before returning", () => {
    expect(install).toMatch(/if \(!CFRunLoopContainsSource\(rl, source, kCFRunLoopDefaultMode\(\)\)\)/);
    expect(install).toMatch(/silently dead/);
  });

  it("decodes the mode symbols rather than passing their addresses", () => {
    // lib.symbol() yields &variable. Passing that matches no mode: zero events,
    // no error — trap #1's symptom with none of its warning signs.
    const body = functionBody(CODE, "cfStringSymbol");
    expect(body).toMatch(/koffi\.decode\(addr, "void \*"\)/);
    expect(body).toMatch(/resolved to NULL/);
    // Struct symbols are the opposite case and must NOT be decoded.
    expect(CODE).toMatch(/kCFTypeDictionaryKeyCallBacks = \(\): bigint => CF\.symbol\(/);
  });
});

describe("trap #13 — the disable notice is handled before any field read", () => {
  const body = functionBody(CODE, "tapCallback");

  it("checks for the two disable types first", () => {
    const disableCheck = body.indexOf("EventType.TapDisabledByTimeout");
    const firstFieldRead = Math.min(
      ...[body.indexOf("isOurs("), body.indexOf("CGEventGetTimestamp("), body.indexOf("fieldAsNumber(")]
        .filter((i) => i > -1),
    );
    expect(disableCheck).toBeGreaterThan(-1);
    // On type 0xFFFFFFFE the event carries no meaningful fields; reading one is
    // a garbage read.
    expect(disableCheck).toBeLessThan(firstFieldRead);
  });

  it("re-enables the tap and returns without falling through", () => {
    expect(body).toMatch(/CGEventTapEnable\(tapPort, true\)/);
    expect(body).toMatch(/counters\.disableNotices\+\+/);
  });

  it("never lets a JS exception escape into CoreGraphics", () => {
    expect(body).toMatch(/try \{/);
    expect(body).toMatch(/\} catch \(err\) \{/);
    expect(body).toMatch(/counters\.callbackErrors\+\+/);
  });

  it("drops a null event that is not ours instead of bucketing it as mouse input", () => {
    // Nothing a human does produces kCGEventNull. Another app's jiggler, or the
    // unstamped null the WindowServer emits with our first post, would otherwise
    // fall into the else branch and be counted as a mouse signal.
    const nullCheck = body.indexOf("type === EventType.Null");
    const realSignal = body.indexOf("counters.realEvents++");
    expect(nullCheck).toBeGreaterThan(-1);
    expect(nullCheck).toBeLessThan(realSignal);
    expect(body).toMatch(/counters\.foreignNullEvents\+\+/);
  });

  it("classifies our own event before anything else can", () => {
    const ours = body.indexOf("isOurs(ev)");
    expect(ours).toBeGreaterThan(-1);
    expect(ours).toBeLessThan(body.indexOf("counters.realEvents++"));
  });

  it("counts foreign pointer input separately, and below the isOurs branch", () => {
    // The cursor-stillness check reads this counter to decide whether anything
    // OTHER than our own jiggle could have moved the pointer inside its
    // measurement window. Two things have to hold or that decision inverts:
    //
    //   * our own event must never reach it — otherwise every window we create
    //     looks contaminated, the check can never reach a verdict, and a
    //     jiggler that really does drag the cursor passes forever;
    //   * a keystroke must never reach it — otherwise the owner typing (which
    //     is the normal state of the machine `install.sh` runs on) voids every
    //     window for something that cannot move a cursor.
    const ours = body.indexOf("isOurs(ev)");
    const pointer = body.indexOf("counters.realPointerEvents++");
    expect(pointer).toBeGreaterThan(-1);
    expect(ours).toBeLessThan(pointer);
    // It lives in the else branch of the key/mouse split, so keyboard types
    // cannot reach it.
    const keyBranch = body.indexOf("pending.keyCount++");
    expect(keyBranch).toBeGreaterThan(-1);
    expect(keyBranch).toBeLessThan(pointer);
    expect(body.slice(keyBranch, pointer)).toContain("} else {");
  });

  it("does no I/O in the callback — the budget is 1.6 microseconds", () => {
    // A 1.6-second block gets the tap disabled by the OS. Everything heavy
    // happens on the setImmediate turn.
    expect(body).toMatch(/setImmediate\(scheduledDrain\)/);
    expect(body).not.toMatch(/console\./);
    expect(body).not.toMatch(/require\(/);
  });

  it("NEVER drains from inside the callback", () => {
    // `drain()` calls the sink, which runs the reducer, which writes the
    // journal to SQLite and pushes to the tray and the renderer — synchronously,
    // on the one code path in this codebase where a slow return costs you the
    // tap. docs/IMPL_NATIVE.md's callback budget says it in as many words:
    // "It must never call SQLite, webContents.send, console.log to a file, or
    // the reducer's close path."
    //
    // It used to happen here, as a "belt and braces" fallback whenever
    // setImmediate was 50 ms late — i.e. precisely when the main thread was
    // already starved and a long callback was most likely. One hiccup became a
    // tap macOS disables, and the guard re-armed itself on the very next event
    // after every recovery, so it stayed dead. Every stored interval in the
    // owner's database was two to six minutes long.
    expect(body).not.toMatch(/\bdrain\(\)/);
  });

  it("verifies the re-enable instead of taking it on trust", () => {
    // macOS delivers the disable notice LAZILY — measured, it waits for the
    // next event, which is the very thing we have gone blind to. This callback
    // is the app's one chance to heal itself in place, so whether it worked is
    // a fact worth recording rather than assuming.
    const notice = body.slice(body.indexOf("TapDisabledByTimeout"));
    expect(notice).toMatch(/CGEventTapEnable\(tapPort, true\)/);
    expect(notice).toMatch(/if \(!CGEventTapIsEnabled\(tapPort\)\) counters\.reEnableFailures\+\+/);
  });
});

describe("traps #2 and #3 — the mask is asserted, not assumed", () => {
  it("includes flagsChanged in the keyboard bits", () => {
    // Without type 12, modifier-only presses are invisible: hours come out
    // slightly low, forever.
    expect(CODE).toMatch(/KEYBOARD_BITS =\s*bit\(EventType\.KeyDown\) \| bit\(EventType\.KeyUp\) \| bit\(EventType\.FlagsChanged\)/);
    expect(CODE).toMatch(/FlagsChanged: 12,/);
  });

  it("includes kCGEventNull so the tap can see the jiggler's own event", () => {
    // Measured: with 0x0FC01CFE the tap receives zero of our posts. The filter
    // and the self-test round trip both depend on the bit being here.
    expect(CODE).toMatch(/const NULL_BIT = bit\(EventType\.Null\);/);
    expect(CODE).toMatch(/EVENT_MASK = KEYBOARD_BITS \| MOUSE_BITS \| NULL_BIT;/);
  });

  it("does the mask arithmetic in BigInt", () => {
    // JS bitwise operators are 32-bit signed: `1 << 32 === 1`. CGEventMask is
    // uint64_t and the prototype must say so.
    expect(CODE).toMatch(/const bit = \(type: number\): bigint => 1n << BigInt\(type\)/);
    expect(CODE).toMatch(/uint64_t eventsOfInterest/);
  });

  it("reads the granted mask back from CGGetEventTapList for our own pid", () => {
    const body = functionBody(CODE, "grantedMask");
    // A tap created without Input Monitoring comes back NON-NULL with the
    // keyboard bits silently removed. Never trust the create call.
    expect(body).toMatch(/CGGetEventTapList/);
    expect(body).toMatch(/t\.tappingProcess === process\.pid/);
    expect(functionBody(CODE, "keyboardBitsGranted")).toMatch(
      /\(granted & KEYBOARD_BITS\) === KEYBOARD_BITS/,
    );
  });
});

describe("the APIs that must never appear", () => {
  it("declares none of the idle-time APIs polluted by our own jiggler", () => {
    // AGENTS.md #7 and #11. All three are reset by CGEventPost, and the private
    // state variant blocks forever on macOS 26.5.1.
    for (const banned of [
      "CGEventSourceSecondsSinceLastEventType",
      "kCGEventSourceStatePrivate",
      "HIDIdleTime",
      "getSystemIdleTime",
    ]) {
      expect(CODE, banned).not.toContain(banned);
    }
  });

  it("registers no CoreMediaIO or CoreAudio property listener", () => {
    // They deliver on a HAL thread. A koffi callback invoked off the JS thread
    // is not a latency problem, it is a crash — and the CMIO listener was never
    // observed to fire anyway.
    expect(CODE).not.toContain("AddPropertyListener");
  });

  it("never drives the run loop itself", () => {
    // Electron's pump owns the main run loop; calling these hangs the app.
    expect(CODE).not.toMatch(/CFRunLoopRun\b/);
    expect(CODE).not.toContain("CFRunLoopRunInMode");
  });

  it("synthesises exactly one event type and never a keystroke", () => {
    expect(CODE).not.toContain("CGEventCreateKeyboardEvent");
    expect(CODE).not.toContain("CGEventSetIntegerValueField");
  });
});

describe("teardown order, which is not stylistic", () => {
  it("disables, removes, releases, and only then unregisters the trampoline", () => {
    const body = functionBody(CODE, "removeTap");
    const order = [
      "CGEventTapEnable(tapPort, false)",
      "CFRunLoopRemoveSource(rl, runLoopSource, kCFRunLoopDefaultMode())",
      "CFRelease(runLoopSource)",
      "CFRelease(tapPort)",
      "koffi.unregister(registeredCallback)",
    ].map((needle) => {
      const i = body.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    });
    // Unregistering first leaves a mach port that can still dispatch into a
    // freed trampoline slot: a crash on the next keystroke, at shutdown, where
    // nobody sees the stack.
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("also removes the source from the common modes it was added to", () => {
    expect(functionBody(CODE, "removeTap")).toMatch(
      /CFRunLoopRemoveSource\(rl, runLoopSource, kCFRunLoopCommonModes\(\)\)/,
    );
  });

  it("restarts by full teardown and full rebuild, never a partial re-arm", () => {
    const body = functionBody(CODE, "restartTap");
    expect(body).toMatch(/removeTap\(\);\s*installTap\(nextSink\);/);
  });
});

describe("the close rule, in the drain path", () => {
  it("stamps signals from the hardware timestamp, never from the clock", () => {
    const body = functionBody(CODE, "drain");
    // eventEpochMs() converts an event's own nanosecond timestamp. Date.now()
    // appearing here would end intervals at the moment of noticing, which is
    // the one thing AGENTS.md says outranks everything.
    expect(body).toMatch(/eventEpochMs\(keyLastNs\)/);
    expect(body).toMatch(/eventEpochMs\(mouseLastNs\)/);
    expect(body).not.toMatch(/Date\.now\(\)/);
  });

  it("coalesces on the MAXIMUM timestamp in the burst", () => {
    const body = functionBody(CODE, "tapCallback");
    expect(body).toMatch(/if \(ns > pending\.keyLastNs\)/);
    expect(body).toMatch(/if \(ns > pending\.mouseLastNs\)/);
  });

  it("clamps a converted timestamp forward only, so it can never invent time", () => {
    const body = functionBody(CODE, "eventEpochMs");
    // A stale anchor can push a computed time into the future; the clamp stops
    // that. It can never move a time later, so it can never add minutes.
    expect(body).toMatch(/Math\.round\(Math\.min\(ms, Date\.now\(\)\)\)/);
  });
});

describe("the cursor check measures a Mac somebody is using", () => {
  it("never compares two bare cursor reads in the self-test", () => {
    // What it used to do: read the cursor, post, read it again, fail if they
    // differ. Correct on an idle Mac, a coin flip on a used one — and
    // `--selftest` runs one line after an install the owner just typed. It
    // failed his install twice while every discrimination check passed, and the
    // only way past it was to bypass the gate by hand.
    expect(CODE).not.toMatch(/after\.x === before\.x/);
    expect(CODE).not.toMatch(/cursorPosition\(\)[\s\S]{0,400}cursorPosition\(\)/);
  });

  it("routes the check through the testable decision logic", () => {
    // Everything that decides anything lives in cursor-stillness.ts, behind a
    // probe interface — which is the only reason any of this has tests at all.
    // native.ts contributes the four CoreGraphics reads and nothing else.
    expect(CODE).toMatch(/measureCursorStillness\(stillnessProbe\)/);
    expect(CODE).toMatch(/cursorStillnessCheck\(/);
    const probe = CODE.slice(CODE.indexOf("const stillnessProbe"));
    expect(probe).toMatch(/pointerEvents: \(\) => counters\.realPointerEvents/);
    expect(probe).toMatch(/tapAlive: isTapEnabled/);
  });

  it("clears the round-trip hook on every path out, including the not-posted one", () => {
    // `selfTestSaw` is a single global slot. Left armed, it would fire on the
    // next jiggle the app posts in production, long after the self-test ended.
    const body = functionBody(CODE, "postAndAwaitRoundTrip");
    const notPosted = body.indexOf("if (!posted)");
    expect(notPosted).toBeGreaterThan(-1);
    expect(body.slice(notPosted, body.indexOf("return { posted: false"))).toContain(
      "selfTestSaw = null",
    );
    expect(body.match(/selfTestSaw = null/g) ?? []).toHaveLength(2);
  });
});
