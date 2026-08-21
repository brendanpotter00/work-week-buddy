/**
 * Every koffi declaration in the application, in one file.
 *
 * This is docs/IMPL_NATIVE.md, typed. The rules, from that document's section 0:
 *
 *   - This is the ONLY file in the repo that imports koffi. A wrong prototype is
 *     a segfault, not a type error, so the blast radius stays in one file that is
 *     reviewed once and then frozen.
 *   - No pointer ever crosses this file's export boundary. Every export takes and
 *     returns plain JS values.
 *   - No BigInt crosses an IPC or a log boundary. Masks are exported as hex
 *     strings; `JSON.stringify(1n)` throws.
 *   - The tap callback never throws into C. A JS exception propagating through a
 *     koffi trampoline into CoreGraphics is undefined behaviour, so the whole
 *     body is wrapped in try/catch.
 *   - The magic number is written exactly once, as a Number literal with no `n`
 *     suffix (AGENTS.md trap #4), and imported from src/shared/constants.ts.
 *   - ONE constant for the tap location, used by both create and post (trap #6).
 *     If the two cannot be spelled differently, they cannot diverge.
 *
 * Nothing here is exercised by the test suite: creating a tap needs Input
 * Monitoring and posting an event needs Accessibility, and a test that passes
 * only because a grant happens to be in place is worse than no test. The real
 * exercise is `--selftest` (section 12), run by a human on the target machine.
 * Every other module tests against FakeSignalSource.
 */
import koffi, { type LibraryHandle } from "koffi";
import { WWB_MAGIC } from "../shared/constants";
import type {
  AccessState,
  Permissions,
  RawSignal,
  SelfTestCheck,
  SelfTestReport,
  SignalSink,
  TapRevival,
} from "./types";

if (process.platform !== "darwin") {
  // Loud, at import time. index.ts dynamic-imports this module so a non-Mac
  // test run never reaches here — see section 13 / src/native/index.ts.
  throw new Error("native.ts is macOS-only; use FakeSignalSource (WWB_FAKE_NATIVE=1)");
}

/** Re-exported so the magic number has exactly one definition in the repo. */
export { WWB_MAGIC };

// ─────────────────────────────────────────────────────────────────────────────
// 1. Loading the frameworks
//
// macOS 11+ keeps system libraries in the dyld shared cache, so these paths do
// not exist on disk. dlopen resolves them from the cache anyway: koffi.load() on
// these exact strings works and `ls` on them does not. Do not "fix" a path
// because the file appears to be missing.
//
// ApplicationServices is an umbrella and AXIsProcessTrusted actually lives in
// its HIServices sub-framework, so that is tried first. It is the only symbol
// group with a fallback.
// ─────────────────────────────────────────────────────────────────────────────

function loadFirst(name: string, paths: readonly string[]): LibraryHandle {
  const failures: string[] = [];
  for (const p of paths) {
    try {
      return koffi.load(p);
    } catch (err) {
      failures.push(`${p}: ${(err as Error).message}`);
    }
  }
  throw new Error(`native: cannot load ${name}\n  ${failures.join("\n  ")}`);
}

const CG = loadFirst("CoreGraphics", [
  "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics",
]);
const CF = loadFirst("CoreFoundation", [
  "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
]);
const CMIO = loadFirst("CoreMediaIO", [
  "/System/Library/Frameworks/CoreMediaIO.framework/CoreMediaIO",
]);
const CA = loadFirst("CoreAudio", [
  "/System/Library/Frameworks/CoreAudio.framework/CoreAudio",
]);
const IOKIT = loadFirst("IOKit", ["/System/Library/Frameworks/IOKit.framework/IOKit"]);
const AS = loadFirst("ApplicationServices", [
  "/System/Library/Frameworks/ApplicationServices.framework/Frameworks/HIServices.framework/HIServices",
  "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices",
]);
const SYS = loadFirst("libSystem", ["/usr/lib/libSystem.B.dylib"]);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Types, brands, structs, constants
//
// Every C pointer is declared to koffi as a plain `void *`. Type safety comes
// from branded bigints in TypeScript: compile-time discrimination, zero runtime
// cost, and no ambiguity about what koffi hands a callback (a BigInt, or null).
// ─────────────────────────────────────────────────────────────────────────────

declare const cfBrand: unique symbol;
/** A retained CoreFoundation / CoreGraphics pointer. Never leaves this file. */
type Ref<T extends string> = bigint & { readonly [cfBrand]: T };

type CGEventRef = Ref<"CGEvent">;
type CGEventSourceRef = Ref<"CGEventSource">;
type CFMachPortRef = Ref<"CFMachPort">;
type CFRunLoopSourceRef = Ref<"CFRunLoopSource">;
type CFRunLoopRef = Ref<"CFRunLoop">;
type CFStringRef = Ref<"CFString">;
type CFDictionaryRef = Ref<"CFDictionary">;
type CBuf = Ref<"buffer">; // koffi.alloc() result

/** Declare a koffi function with a real TypeScript signature. */
function fn<T extends (...args: never[]) => unknown>(lib: LibraryHandle, proto: string): T {
  return lib.func(proto) as unknown as T;
}

// ── structs ──────────────────────────────────────────────────────────────────
// Registered by NAME; the prototype strings below refer to them by that name,
// which is why several of these are not bound to a variable.
koffi.struct("CGPoint", { x: "double", y: "double" });

// Field ORDER is the ABI. Do not alphabetise. koffi inserts the padding.
const CGEventTapInformation = koffi.struct("CGEventTapInformation", {
  eventTapID: "uint32_t",
  tapPoint: "uint32_t",
  options: "uint32_t",
  eventsOfInterest: "uint64_t", // 8-byte aligned → 4 bytes of padding land above it
  tappingProcess: "int32_t",
  processBeingTapped: "int32_t",
  enabled: "bool", // 1 byte + 3 padding
  minUsecLatency: "float",
  avgUsecLatency: "float",
  maxUsecLatency: "float",
});

koffi.struct("CMIOObjectPropertyAddress", {
  mSelector: "uint32_t",
  mScope: "uint32_t",
  mElement: "uint32_t",
});
koffi.struct("AudioObjectPropertyAddress", {
  mSelector: "uint32_t",
  mScope: "uint32_t",
  mElement: "uint32_t",
});
koffi.struct("mach_timebase_info_data_t", { numer: "uint32_t", denom: "uint32_t" });

// ── constants ────────────────────────────────────────────────────────────────
// Plain frozen objects, never `const enum`: electron-vite runs esbuild with
// isolatedModules, where `const enum` is a build error.
export const EventType = {
  Null: 0,
  LeftMouseDown: 1,
  LeftMouseUp: 2,
  RightMouseDown: 3,
  RightMouseUp: 4,
  MouseMoved: 5,
  LeftMouseDragged: 6,
  RightMouseDragged: 7,
  KeyDown: 10,
  KeyUp: 11,
  FlagsChanged: 12,
  ScrollWheel: 22,
  TabletPointer: 23,
  TabletProximity: 24,
  OtherMouseDown: 25,
  OtherMouseUp: 26,
  OtherMouseDragged: 27,
  TapDisabledByTimeout: 0xfffffffe,
  TapDisabledByUserInput: 0xffffffff,
} as const;

/** CGEventField numbers. 41 and 42 are the two discriminators; 45 is a decoy. */
const kCGEventSourceUnixProcessID = 41;
const kCGEventSourceUserData = 42;
// const kCGEventSourceStateID  = 45;  ← NOT a discriminator. See isOurs(), section 5.

/** kCGSessionEventTap. Used by BOTH CGEventTapCreate and CGEventPost (trap #6). */
const TAP_LOCATION = 1;
const kCGHeadInsertEventTap = 0;
const kCGEventTapOptionListenOnly = 1;
const kCGEventSourceStateHIDSystemState = 1;

const kCFStringEncodingUTF8 = 0x08000100;
const kIOPMAssertionLevelOn = 255;

// CoreMediaIO / CoreAudio four-char codes, written out so nobody has to trust a comment.
const kCMIOObjectSystemObject = 1;
const kCMIOHardwarePropertyDevices = 0x64657623; // 'dev#'
const kCMIODevicePropertyDeviceIsRunningSomewhere = 0x676f6e65; // 'gone'
const kCMIOObjectPropertyScopeGlobal = 0x676c6f62; // 'glob'
const kAudioObjectSystemObject = 1;
const kAudioHardwarePropertyDevices = 0x64657623; // 'dev#'
const kAudioDevicePropertyDeviceIsRunningSomewhere = 0x676f6e65; // 'gone'
const kAudioObjectPropertyScopeGlobal = 0x676c6f62; // 'glob'
const kAudioObjectPropertyScopeInput = 0x696e7074; // 'inpt'
const kAudioDevicePropertyStreams = 0x73746d23; // 'stm#'
const kElementMain = 0;

// ── the event mask ───────────────────────────────────────────────────────────
// Do ALL mask arithmetic in BigInt. JS bitwise operators are 32-bit signed:
// `1 << 32 === 1`, and `1 << 31` is negative. Our highest type today is 27, so a
// Number would happen to work — until someone adds type 32 and the mask silently
// loses a bit. CGEventMask is uint64_t; treat it as one.

const bit = (type: number): bigint => 1n << BigInt(type);

/** keyDown | keyUp | flagsChanged = 0x1C00. FlagsChanged is AGENTS trap #3. */
export const KEYBOARD_BITS =
  bit(EventType.KeyDown) | bit(EventType.KeyUp) | bit(EventType.FlagsChanged); // 0x0000_1C00

export const MOUSE_BITS =
  bit(1) | bit(2) | bit(3) | bit(4) | bit(5) | bit(6) | bit(7) | // 0x0000_00FE
  bit(22) | bit(23) | bit(24) | // 0x01C0_0000
  bit(25) | bit(26) | bit(27); // 0x0E00_0000

/**
 * kCGEventNull — the type the jiggler posts, and a DEVIATION from
 * docs/IMPL_NATIVE.md section 2, which writes the mask as 0x0FC01CFE.
 *
 * Measured on macOS 26.5.1, arm64, posting three stamped null events to
 * kCGSessionEventTap while a listen-only tap at the same location pumped its own
 * run loop:
 *
 *   mask 0x0FC01CFE (as written)  →  0 callbacks. The jiggle is never delivered.
 *   mask 0x0FC01CFF (this)        →  3 callbacks, every one identified as ours.
 *
 * eventsOfInterest filters by type like any other bit, and kCGEventNull is type
 * 0. Without bit 0 the tap cannot see our own jiggle at all: isOurs() would never
 * run against a real event, the self-test's round-trip check could never pass,
 * and M1 gate (c) would be unpassable — which is also why docs/MACOS.md section 1
 * could measure `ourSynthetic: 3` at all. The bit is what makes the filter, and
 * the gate that proves the filter, real.
 */
const NULL_BIT = bit(EventType.Null);

/** 0x0FC01CFF === 264248575n. Asserted in the self-test. */
export const EVENT_MASK = KEYBOARD_BITS | MOUSE_BITS | NULL_BIT;

// mouseMoved (5) is deliberately IN the mask: measured worst case is 0.15% CPU
// and a 1.6 µs callback, and the countdown is lazily re-armed, so 300 events/s
// is still one timer op per 15 minutes. (docs/IMPL_NATIVE.md section 2.)

// ─────────────────────────────────────────────────────────────────────────────
// 3. The declarations
//
// The one thing koffi DOES check: lib.func() throws at declaration time if the
// SYMBOL NAME does not exist. It never checks the signature. A typo in a name is
// a loud crash on import; a typo in a type is a segfault at the first call,
// possibly hours later. That asymmetry is the entire reason this file exists.
// ─────────────────────────────────────────────────────────────────────────────

type PropAddr = { mSelector: number; mScope: number; mElement: number };

// ═══ CoreGraphics ════════════════════════════════════════════════════════════

// CGEventRef (*CGEventTapCallBack)(CGEventTapProxy, CGEventType, CGEventRef, void *)
const CGEventTapCallBack = koffi.proto(
  "void *CGEventTapCallBack(void *proxy, uint32_t type, void *event, void *userInfo)",
);

// CFMachPortRef CGEventTapCreate(CGEventTapLocation, CGEventTapPlacement,
//                                CGEventTapOptions, CGEventMask,
//                                CGEventTapCallBack, void *)
const CGEventTapCreate = fn<
  (
    tap: number,
    place: number,
    options: number,
    mask: bigint,
    callback: bigint,
    userInfo: null,
  ) => CFMachPortRef | null
>(
  CG,
  "void *CGEventTapCreate(uint32_t tap, uint32_t place, uint32_t options, " +
    "uint64_t eventsOfInterest, CGEventTapCallBack *callback, void *userInfo)",
);

// void CGEventTapEnable(CFMachPortRef, bool)
const CGEventTapEnable = fn<(tap: CFMachPortRef, enable: boolean) => void>(
  CG,
  "void CGEventTapEnable(void *tap, bool enable)",
);

// bool CGEventTapIsEnabled(CFMachPortRef)
const CGEventTapIsEnabled = fn<(tap: CFMachPortRef) => boolean>(
  CG,
  "bool CGEventTapIsEnabled(void *tap)",
);

// CGError CGGetEventTapList(uint32_t, CGEventTapInformation *, uint32_t *)
//   tapList == NULL → returns only the count.
const CGGetEventTapList = fn<
  (maxTaps: number, tapList: CBuf | null, count: [number | null]) => number
>(
  CG,
  "int32_t CGGetEventTapList(uint32_t maxNumberOfTaps, void *tapList, _Out_ uint32_t *eventTapCount)",
);

// int64_t CGEventGetIntegerValueField(CGEventRef, CGEventField)
//   MUST be int64_t. Declaring `int` truncates every field silently.
const CGEventGetIntegerValueField = fn<(ev: CGEventRef, field: number) => number | bigint>(
  CG,
  "int64_t CGEventGetIntegerValueField(void *event, uint32_t field)",
);

// CGEventTimestamp CGEventGetTimestamp(CGEventRef)  — uint64, nanoseconds since boot
const CGEventGetTimestamp = fn<(ev: CGEventRef) => number | bigint>(
  CG,
  "uint64_t CGEventGetTimestamp(void *event)",
);

// CGEventType CGEventGetType(CGEventRef)
const CGEventGetType = fn<(ev: CGEventRef) => number>(CG, "uint32_t CGEventGetType(void *event)");

// CGPoint CGEventGetLocation(CGEventRef)  — struct returned by value (v0/v1 on arm64)
const CGEventGetLocation = fn<(ev: CGEventRef) => { x: number; y: number }>(
  CG,
  "CGPoint CGEventGetLocation(void *event)",
);

// CGEventRef CGEventCreate(CGEventSourceRef)  — returns a kCGEventNull event, +1 retained
const CGEventCreate = fn<(source: CGEventSourceRef | null) => CGEventRef | null>(
  CG,
  "void *CGEventCreate(void *source)",
);

// void CGEventPost(CGEventTapLocation, CGEventRef)
const CGEventPost = fn<(tap: number, ev: CGEventRef) => void>(
  CG,
  "void CGEventPost(uint32_t tap, void *event)",
);

// CGEventSourceRef CGEventSourceCreate(CGEventSourceStateID)  — int32, NOT uint32
const CGEventSourceCreate = fn<(stateID: number) => CGEventSourceRef | null>(
  CG,
  "void *CGEventSourceCreate(int32_t stateID)",
);

// void CGEventSourceSetUserData(CGEventSourceRef, int64_t)
const CGEventSourceSetUserData = fn<(src: CGEventSourceRef, userData: number) => void>(
  CG,
  "void CGEventSourceSetUserData(void *source, int64_t userData)",
);

// int64_t CGEventSourceGetUserData(CGEventSourceRef)  — self-test only
const CGEventSourceGetUserData = fn<(src: CGEventSourceRef) => number | bigint>(
  CG,
  "int64_t CGEventSourceGetUserData(void *source)",
);

// bool CGPreflightListenEventAccess(void)  — no prompt
const CGPreflightListenEventAccess = fn<() => boolean>(
  CG,
  "bool CGPreflightListenEventAccess()",
);
// bool CGRequestListenEventAccess(void)    — PROMPTS. Onboarding only.
const CGRequestListenEventAccess = fn<() => boolean>(CG, "bool CGRequestListenEventAccess()");
// bool CGPreflightPostEventAccess(void)    — no prompt
const CGPreflightPostEventAccess = fn<() => boolean>(CG, "bool CGPreflightPostEventAccess()");
// bool CGRequestPostEventAccess(void)      — PROMPTS. Onboarding only.
const CGRequestPostEventAccess = fn<() => boolean>(CG, "bool CGRequestPostEventAccess()");

// ═══ CoreFoundation ══════════════════════════════════════════════════════════

// CFRunLoopSourceRef CFMachPortCreateRunLoopSource(CFAllocatorRef, CFMachPortRef, CFIndex)
//   CFIndex is `long` (8 bytes, signed) on arm64.
const CFMachPortCreateRunLoopSource = fn<
  (alloc: null, port: CFMachPortRef, order: number) => CFRunLoopSourceRef | null
>(CF, "void *CFMachPortCreateRunLoopSource(void *allocator, void *port, long order)");

// void CFRunLoopAddSource(CFRunLoopRef, CFRunLoopSourceRef, CFRunLoopMode)
const CFRunLoopAddSource = fn<
  (rl: CFRunLoopRef, src: CFRunLoopSourceRef, mode: CFStringRef) => void
>(CF, "void CFRunLoopAddSource(void *rl, void *source, void *mode)");

// void CFRunLoopRemoveSource(CFRunLoopRef, CFRunLoopSourceRef, CFRunLoopMode)
const CFRunLoopRemoveSource = fn<
  (rl: CFRunLoopRef, src: CFRunLoopSourceRef, mode: CFStringRef) => void
>(CF, "void CFRunLoopRemoveSource(void *rl, void *source, void *mode)");

// Boolean CFRunLoopContainsSource(CFRunLoopRef, CFRunLoopSourceRef, CFRunLoopMode)
const CFRunLoopContainsSource = fn<
  (rl: CFRunLoopRef, src: CFRunLoopSourceRef, mode: CFStringRef) => boolean
>(CF, "bool CFRunLoopContainsSource(void *rl, void *source, void *mode)");

// CFRunLoopRef CFRunLoopGetMain(void)
const CFRunLoopGetMain = fn<() => CFRunLoopRef>(CF, "void *CFRunLoopGetMain()");

// void CFRelease(CFTypeRef)  — crashes on NULL. Every call site guards.
const CFRelease = fn<(cf: bigint) => void>(CF, "void CFRelease(void *cf)");

// CFStringRef CFStringCreateWithCString(CFAllocatorRef, const char *, CFStringEncoding)
const CFStringCreateWithCString = fn<
  (alloc: null, cstr: string, encoding: number) => CFStringRef | null
>(CF, "void *CFStringCreateWithCString(void *alloc, const char *cStr, uint32_t encoding)");

// CFDictionaryRef CFDictionaryCreate(CFAllocatorRef, const void **, const void **,
//                                    CFIndex, const CFDictionaryKeyCallBacks *,
//                                    const CFDictionaryValueCallBacks *)
const CFDictionaryCreate = fn<
  (
    alloc: null,
    keys: CBuf,
    values: CBuf,
    n: number,
    keyCb: bigint,
    valCb: bigint,
  ) => CFDictionaryRef | null
>(
  CF,
  "void *CFDictionaryCreate(void *allocator, const void **keys, const void **values, " +
    "long numValues, const void *keyCallBacks, const void *valueCallBacks)",
);

// ═══ ApplicationServices / HIServices ════════════════════════════════════════

// Boolean AXIsProcessTrusted(void)
const AXIsProcessTrusted = fn<() => boolean>(AS, "bool AXIsProcessTrusted()");
// Boolean AXIsProcessTrustedWithOptions(CFDictionaryRef)  — PROMPTS when told to.
const AXIsProcessTrustedWithOptions = fn<(opts: CFDictionaryRef | null) => boolean>(
  AS,
  "bool AXIsProcessTrustedWithOptions(void *options)",
);

// ═══ CoreMediaIO ═════════════════════════════════════════════════════════════
//   NOTE the arg count: CMIO takes dataSize IN and dataUsed OUT (7 args).
//   CoreAudio takes a single ioDataSize INOUT (6 args). They are NOT symmetric.

// OSStatus CMIOObjectGetPropertyDataSize(CMIOObjectID, const CMIOObjectPropertyAddress *,
//                                        UInt32, const void *, UInt32 *)
const CMIOObjectGetPropertyDataSize = fn<
  (obj: number, addr: PropAddr, qSize: number, qData: null, out: [number | null]) => number
>(
  CMIO,
  "int32_t CMIOObjectGetPropertyDataSize(uint32_t objectID, const CMIOObjectPropertyAddress *address, " +
    "uint32_t qualifierDataSize, const void *qualifierData, _Out_ uint32_t *dataSize)",
);

// OSStatus CMIOObjectGetPropertyData(CMIOObjectID, const CMIOObjectPropertyAddress *,
//                                    UInt32, const void *, UInt32, UInt32 *, void *)
const CMIOObjectGetPropertyData = fn<
  (
    obj: number,
    addr: PropAddr,
    qSize: number,
    qData: null,
    dataSize: number,
    used: [number | null],
    data: CBuf,
  ) => number
>(
  CMIO,
  "int32_t CMIOObjectGetPropertyData(uint32_t objectID, const CMIOObjectPropertyAddress *address, " +
    "uint32_t qualifierDataSize, const void *qualifierData, uint32_t dataSize, " +
    "_Out_ uint32_t *dataUsed, void *data)",
);

// Boolean CMIOObjectHasProperty(CMIOObjectID, const CMIOObjectPropertyAddress *)
const CMIOObjectHasProperty = fn<(obj: number, addr: PropAddr) => boolean>(
  CMIO,
  "bool CMIOObjectHasProperty(uint32_t objectID, const CMIOObjectPropertyAddress *address)",
);

// ═══ CoreAudio ═══════════════════════════════════════════════════════════════

// OSStatus AudioObjectGetPropertyDataSize(AudioObjectID, const AudioObjectPropertyAddress *,
//                                         UInt32, const void *, UInt32 *)
const AudioObjectGetPropertyDataSize = fn<
  (obj: number, addr: PropAddr, qSize: number, qData: null, out: [number | null]) => number
>(
  CA,
  "int32_t AudioObjectGetPropertyDataSize(uint32_t objectID, const AudioObjectPropertyAddress *address, " +
    "uint32_t qualifierDataSize, const void *qualifierData, _Out_ uint32_t *outDataSize)",
);

// OSStatus AudioObjectGetPropertyData(AudioObjectID, const AudioObjectPropertyAddress *,
//                                     UInt32, const void *, UInt32 *, void *)
//   ioDataSize is INOUT: buffer size in, bytes written out.
const AudioObjectGetPropertyData = fn<
  (
    obj: number,
    addr: PropAddr,
    qSize: number,
    qData: null,
    ioDataSize: [number],
    data: CBuf,
  ) => number
>(
  CA,
  "int32_t AudioObjectGetPropertyData(uint32_t objectID, const AudioObjectPropertyAddress *address, " +
    "uint32_t qualifierDataSize, const void *qualifierData, _Inout_ uint32_t *ioDataSize, void *outData)",
);

// Boolean AudioObjectHasProperty(AudioObjectID, const AudioObjectPropertyAddress *)
const AudioObjectHasProperty = fn<(obj: number, addr: PropAddr) => boolean>(
  CA,
  "bool AudioObjectHasProperty(uint32_t objectID, const AudioObjectPropertyAddress *address)",
);

// ═══ IOKit ═══════════════════════════════════════════════════════════════════

// IOReturn IOPMAssertionCreateWithName(CFStringRef, IOPMAssertionLevel,
//                                      CFStringRef, IOPMAssertionID *)
const IOPMAssertionCreateWithName = fn<
  (type: CFStringRef, level: number, name: CFStringRef, out: [number | null]) => number
>(
  IOKIT,
  "int32_t IOPMAssertionCreateWithName(void *AssertionType, uint32_t AssertionLevel, " +
    "void *AssertionName, _Out_ uint32_t *AssertionID)",
);

// IOReturn IOPMAssertionRelease(IOPMAssertionID)
const IOPMAssertionRelease = fn<(id: number) => number>(
  IOKIT,
  "int32_t IOPMAssertionRelease(uint32_t AssertionID)",
);

// IOHIDAccessType IOHIDCheckAccess(IOHIDRequestType)
//
// The ONLY public API on this surface that distinguishes "denied" from "never
// asked". CGPreflightListenEventAccess / CGPreflightPostEventAccess return a
// bare bool and collapse the two, which is why a stale DENY used to look
// identical to a fresh install — and why the app offered a "Grant" button that
// could not possibly work, because macOS never prompts twice.
//
// From <IOKit/hidsystem/IOHIDLib.h>:
//   typedef enum { kIOHIDRequestTypePostEvent, kIOHIDRequestTypeListenEvent }
//   typedef enum { kIOHIDAccessTypeGranted, kIOHIDAccessTypeDenied, kIOHIDAccessTypeUnknown }
// Both enums are plain C enums, so: PostEvent=0, ListenEvent=1; Granted=0,
// Denied=1, Unknown=2. Denied IS `auth_value = 0` in TCC.db.
const IOHIDCheckAccess = fn<(requestType: number) => number>(
  IOKIT,
  "uint32_t IOHIDCheckAccess(uint32_t requestType)",
);

const kIOHIDRequestTypePostEvent = 0;
const kIOHIDRequestTypeListenEvent = 1;

// ═══ libSystem ═══════════════════════════════════════════════════════════════

// uint64_t mach_absolute_time(void)
const mach_absolute_time = fn<() => number | bigint>(SYS, "uint64_t mach_absolute_time()");
// kern_return_t mach_timebase_info(mach_timebase_info_t)
const mach_timebase_info = fn<(info: { numer?: number; denom?: number }) => number>(
  SYS,
  "int32_t mach_timebase_info(_Out_ mach_timebase_info_data_t *info)",
);

// ── data symbols ─────────────────────────────────────────────────────────────
// lib.symbol(name) returns the ADDRESS OF THE VARIABLE. What you do next depends
// on what the variable holds:
//
//   kCFRunLoopDefaultMode / kCFRunLoopCommonModes / kAXTrustedCheckOptionPrompt
//   / kCFBooleanTrue hold a POINTER  → koffi.decode(sym, 'void *'). Passing
//   &variable instead matches no run-loop mode: zero events, no error (trap #1).
//
//   kCFTypeDictionaryKeyCallBacks / …ValueCallBacks hold a STRUCT BY VALUE  →
//   the address IS the argument. Decoding one yields its first 8 bytes as a
//   pointer and segfaults inside CFDictionaryCreate.

function cfStringSymbol(lib: LibraryHandle, name: string): CFStringRef {
  const addr = lib.symbol(name);
  const value = koffi.decode(addr, "void *") as CFStringRef | null;
  if (value === null || value === 0n) {
    // A zero mode is trap #1's exact symptom with none of its warning signs.
    throw new Error(`native: ${name} resolved to NULL`);
  }
  return value;
}

let _defaultMode: CFStringRef | null = null;
let _commonModes: CFStringRef | null = null;
const kCFRunLoopDefaultMode = (): CFStringRef =>
  (_defaultMode ??= cfStringSymbol(CF, "kCFRunLoopDefaultMode"));
const kCFRunLoopCommonModes = (): CFStringRef =>
  (_commonModes ??= cfStringSymbol(CF, "kCFRunLoopCommonModes"));

/** Struct symbols: the address IS the argument. Never decode these. */
const kCFTypeDictionaryKeyCallBacks = (): bigint => CF.symbol("kCFTypeDictionaryKeyCallBacks");
const kCFTypeDictionaryValueCallBacks = (): bigint =>
  CF.symbol("kCFTypeDictionaryValueCallBacks");

/** Caller owns the result and must CFRelease it. */
function cfString(s: string): CFStringRef {
  const ref = CFStringCreateWithCString(null, s, kCFStringEncodingUTF8);
  if (ref === null) {
    throw new Error(`native: CFStringCreateWithCString failed for ${JSON.stringify(s)}`);
  }
  return ref;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Clock — hardware timestamps to epoch milliseconds
//
// CGEventGetTimestamp is nanoseconds since boot; the reducer works in epoch ms.
// The conversion is the last place a phantom minute can enter, so it is written
// once, here.
// ─────────────────────────────────────────────────────────────────────────────

let tbNumer = 1;
let tbDenom = 1;
let timebaseRead = false;
let anchorEpochMs = 0;
let anchorMachNs = 0;

/**
 * The timebase is a property of the machine and never changes, so this is read
 * once and then cached. It is idempotent rather than call-once because the
 * default of 1/1 is WRONG on Apple Silicon (it is 125/3) and a missed read would
 * scale every converted timestamp by 41.67 — silently, and only on the machines
 * we actually run on.
 */
function readTimebase(): void {
  if (timebaseRead) return;
  const info: { numer?: number; denom?: number } = {};
  const rc = mach_timebase_info(info);
  if (rc !== 0 || !info.numer || !info.denom) {
    throw new Error(`native: mach_timebase_info rc=${rc}`);
  }
  tbNumer = info.numer; // 125/3 on Apple Silicon, 1/1 on Intel
  tbDenom = info.denom;
  timebaseRead = true;
}

function machNowNs(): number {
  readTimebase();
  const raw = mach_absolute_time();
  const ticks = typeof raw === "bigint" ? raw : BigInt(raw);
  return Number((ticks * BigInt(tbNumer)) / BigInt(tbDenom));
}

/**
 * Re-take the wall-clock ↔ mach anchor. Called at boot, on powerMonitor
 * 'resume', and on every watchdog probe. It reads two clocks and posts nothing.
 */
export function reanchorClock(): void {
  const ns = machNowNs();
  anchorEpochMs = Date.now();
  anchorMachNs = ns;
}

/**
 * Convert an event's hardware timestamp to epoch ms.
 *
 * The clamp is one-directional on purpose: a stale anchor can push a computed
 * time INTO THE FUTURE, and an interval must never end in the future. It can
 * never push a time later than it already is, so it can never add phantom
 * minutes — which is the only direction AGENTS.md cares about.
 */
export function eventEpochMs(tsNs: number | bigint): number {
  const ns = typeof tsNs === "bigint" ? Number(tsNs) : tsNs;
  const ms = anchorEpochMs + (ns - anchorMachNs) / 1e6;
  return Math.round(Math.min(ms, Date.now()));
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. isOurs(event) — the two-field discriminator
// ─────────────────────────────────────────────────────────────────────────────

let numberContractViolations = 0;

/**
 * Read a CGEvent field as a JS number.
 *
 * THE FAILURE THIS EXISTS TO PREVENT — AGENTS.md trap #4: comparing a field
 * against a BigInt literal. `0x57574B31n === 0x57574B31` is false, so our own
 * jiggle would be classified as human input and log 24-hour workdays, silently.
 * The fix is not a cast at the comparison — it is that the magic constant is a
 * Number and every field read is normalised here.
 *
 * This never throws: a throw in the tap callback goes into C. The strict
 * `typeof === 'number'` assertion lives in the boot self-test (section 12),
 * where throwing is safe. Here we count and carry on — a counter surfaced by
 * probe() is a red banner; a crash in a CoreGraphics trampoline is a corrupt
 * process.
 */
function fieldAsNumber(ev: CGEventRef, field: number): number {
  const v = CGEventGetIntegerValueField(ev, field);
  if (typeof v === "number") return v;
  numberContractViolations++;
  return Number(v);
}

/**
 * True iff this event is one of ours.
 *
 * Two independent discriminators, measured clean across 422 events:
 *   real:  srcPid = 0        userData = 0
 *   ours:  srcPid = <us>     userData = 0x57574B31
 *
 * AGENTS.md trap #5: kCGEventSourceStateID (field 45) is NOT a third
 * discriminator and must never be used as one. A source created with
 * kCGEventSourceStateHIDSystemState — the one the jiggler creates in section 8 —
 * reads back 1, and real HID input also reads back 1. It cannot separate them by
 * construction.
 *
 * userData is checked first: it is the cheap rejection for the ~100% case.
 */
export function isOurs(ev: CGEventRef): boolean {
  const userData = fieldAsNumber(ev, kCGEventSourceUserData);
  if (userData !== WWB_MAGIC) return false;
  const srcPid = fieldAsNumber(ev, kCGEventSourceUnixProcessID);
  return srcPid === process.pid;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. The tap callback
// ─────────────────────────────────────────────────────────────────────────────

interface Coalesced {
  keyCount: number;
  keyLastNs: number;
  mouseCount: number;
  mouseLastNs: number;
}
const pending: Coalesced = { keyCount: 0, keyLastNs: 0, mouseCount: 0, mouseLastNs: 0 };
let drainScheduled = false;
let drainScheduledAtMs = 0;

let sink: SignalSink = () => {};
let tapPort: CFMachPortRef | null = null;
let runLoopSource: CFRunLoopSourceRef | null = null;
let registeredCallback: bigint | null = null;
let selfTestSaw: ((ev: CGEventRef, type: number) => void) | null = null;
let debugStallMs = 0; // M1 gate (d) only

/**
 * A drain that ran this long after it was scheduled means the Node loop was
 * starved. It is recorded, never acted on from inside the callback — see the
 * comment on step 2 of `tapCallback`.
 */
const DRAIN_LATE_MS = 50;

export const counters = {
  realEvents: 0,
  ourEvents: 0,
  foreignNullEvents: 0,
  disableNotices: 0,
  disableNoticesByUserInput: 0,
  lastDisableType: 0,
  lastDisableAtMs: 0,
  /** Re-enables issued from inside the disable-notice callback. */
  reEnables: 0,
  /**
   * Re-enables that DID NOT TAKE — `CGEventTapEnable(tap, true)` returned and
   * `CGEventTapIsEnabled` still said false. Non-zero means the callback cannot
   * heal the tap on its own and the watchdog's revive path is carrying the app.
   * Nothing checked this before: the re-enable was issued and never verified,
   * so "the recovery path exists" and "the recovery works" were never the same
   * statement.
   */
  reEnableFailures: 0,
  callbackErrors: 0,
  lastCallbackError: "",
  /** Drains that ran more than DRAIN_LATE_MS after being scheduled. */
  drainsOverdue: 0,
  /** The worst such lateness. A field diagnosis of a starved main thread. */
  worstDrainLagMs: 0,
  get numberContractViolations(): number {
    return numberContractViolations;
  },
  lastRealSignalMs: 0,
};

/**
 * The C signature is
 *   CGEventRef (*)(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *userInfo)
 * — four arguments, event THIRD. `userInfo` is always null (we pass null at
 * create) so it is simply not declared here; koffi calls this with four
 * arguments regardless.
 */
function tapCallback(_proxy: bigint | null, type: number, event: bigint | null): bigint {
  if (event === null) return 0n;
  const ev = event as CGEventRef;
  try {
    // 1 ─ DISABLE NOTICES FIRST. AGENTS.md trap #13: on these two types the
    //     event carries no meaningful fields and reading one is a garbage read.
    //     Nothing above this line touches a field.
    if (type === EventType.TapDisabledByTimeout || type === EventType.TapDisabledByUserInput) {
      counters.disableNotices++;
      counters.lastDisableType = type;
      counters.lastDisableAtMs = Date.now();
      if (type === EventType.TapDisabledByUserInput) counters.disableNoticesByUserInput++;
      if (tapPort !== null) {
        CGEventTapEnable(tapPort, true);
        counters.reEnables++;
        // VERIFY IT. Measured: macOS delivers this notice LAZILY — it rides
        // along with the next event that would have been delivered, not on a
        // timer. Pumping the run loop for three seconds after a disable
        // produced no notice at all; posting one event produced it instantly.
        // So this callback is the app's only chance to heal itself, it comes
        // exactly once, and it must not be taken on trust.
        if (!CGEventTapIsEnabled(tapPort)) counters.reEnableFailures++;
      }
      return event;
    }

    // 2 ─ NO DRAIN HERE, EVER.
    //
    //     This step used to be a "belt and braces" inline `drain()` whenever
    //     setImmediate was more than 50 ms late. `drain()` calls the sink,
    //     which runs the reducer, which writes the journal to SQLite and
    //     pushes to the tray and the renderer — all of it synchronously, on
    //     the CGEventTap callback, which is the one place in this codebase
    //     where a slow return is fatal. docs/IMPL_NATIVE.md's own callback
    //     budget forbids exactly that: "It must never call SQLite,
    //     `webContents.send`, `console.log` to a file, or the reducer's close
    //     path."
    //
    //     Worse, it fired precisely when the main thread was ALREADY starved,
    //     which is the moment a long callback is most likely — so a single
    //     hiccup became a tap that macOS disables, and then re-disables on the
    //     very next event after every recovery, because the guard re-arms
    //     itself. That is a tap that dies every few minutes forever out of one
    //     transient stall.
    //
    //     Nothing is lost by removing it. The coalesced counts sit in
    //     `pending` until the loop recovers, and `drain()` emits the MAXIMUM
    //     hardware timestamp, so the interval still ends at the true last
    //     keystroke. The countdown that could have closed it early is a timer
    //     on the same starved loop and cannot fire either. The lateness is
    //     recorded in `drainsOverdue` / `worstDrainLagMs` instead, which is
    //     the diagnosis the inline drain was really there to provide.

    // 2b ─ M1 gate (d), and NOTHING ELSE. Zero in production, armed only by the
    //      self-test, which blocks the callback on purpose to prove that macOS
    //      really does disable the tap here and that the app really does get it
    //      back unaided. It sits above the `isOurs` branch so the gate can be
    //      driven by our own posted events and needs no foreign input.
    if (debugStallMs > 0) {
      const until = Date.now() + debugStallMs;
      debugStallMs = 0;
      while (Date.now() < until) {
        /* deliberate block → kCGEventTapDisabledByTimeout */
      }
    }

    // 3 ─ Our own jiggle: never a signal, ever. (Traps #4, #5, #6 all land here.)
    if (isOurs(ev)) {
      counters.ourEvents++;
      selfTestSaw?.(ev, type);
      return event;
    }

    // 4 ─ A null event that is NOT ours is still not a human.
    //     Nothing a person does produces kCGEventNull: it carries no
    //     coordinates and no key code, and the only things that post one are
    //     jigglers — another app's, or the single unstamped null the
    //     WindowServer was measured to emit alongside our very first post.
    //     Falling through would bucket it as 'mouse' (the else branch below)
    //     and count someone else's jiggler as our owner working, which is
    //     AGENTS.md trap #4's outcome arriving through a different door.
    //     Counted rather than ignored, so it is visible in probe().
    if (type === EventType.Null) {
      counters.foreignNullEvents++;
      return event;
    }

    // 5 ─ A real signal. Coalesce; do not touch SQLite, IPC, or the reducer here.
    counters.realEvents++;
    const raw = CGEventGetTimestamp(ev);
    const ns = typeof raw === "bigint" ? Number(raw) : raw;
    if (
      type === EventType.KeyDown ||
      type === EventType.KeyUp ||
      type === EventType.FlagsChanged
    ) {
      pending.keyCount++;
      if (ns > pending.keyLastNs) pending.keyLastNs = ns;
    } else {
      pending.mouseCount++;
      if (ns > pending.mouseLastNs) pending.mouseLastNs = ns;
    }
    if (!drainScheduled) {
      drainScheduled = true;
      drainScheduledAtMs = Date.now();
      setImmediate(scheduledDrain);
    }
  } catch (err) {
    counters.callbackErrors++;
    counters.lastCallbackError = String(err);
  }
  // Listen-only taps ignore the return value. Returning the event anyway means
  // that if this ever became an active tap, it would pass events through rather
  // than delete every keystroke on the machine.
  return event;
}

/**
 * Emit at most one 'key' and one 'mouse' signal per turn, each carrying the
 * MAXIMUM timestamp seen and the event count.
 *
 * Coalescing is safe for the close rule precisely because we keep the max: the
 * reducer's lastRealSignalMs lands on the true final keystroke, not on the first
 * of the burst. And key_events / mouse_events stay exact for the row.
 */
function drain(): void {
  drainScheduled = false;
  const { keyCount, keyLastNs, mouseCount, mouseLastNs } = pending;
  pending.keyCount = 0;
  pending.keyLastNs = 0;
  pending.mouseCount = 0;
  pending.mouseLastNs = 0;

  const out: RawSignal[] = [];
  if (keyCount > 0) out.push({ kind: "key", atMs: eventEpochMs(keyLastNs), count: keyCount });
  if (mouseCount > 0) {
    out.push({ kind: "mouse", atMs: eventEpochMs(mouseLastNs), count: mouseCount });
  }
  out.sort((a, b) => a.atMs - b.atMs);
  for (const s of out) {
    if (s.atMs > counters.lastRealSignalMs) counters.lastRealSignalMs = s.atMs;
    sink(s);
  }
}

/**
 * What `setImmediate` actually schedules.
 *
 * The lateness accounting lives HERE and not in `drain()` on purpose: `drain()`
 * must contain no `Date.now()` at all, because a wall-clock read in the path
 * that stamps signals is how an interval ends at the moment of noticing instead
 * of at the last keystroke. There is a source-text test that enforces it.
 *
 * A large `worstDrainLagMs` in the field means the main thread was held for
 * that long — which is the condition that gets the tap disabled. It is a
 * diagnosis, not a trigger: nothing reacts to it from inside the callback.
 */
function scheduledDrain(): void {
  const lag = Date.now() - drainScheduledAtMs;
  if (lag > DRAIN_LATE_MS) {
    counters.drainsOverdue++;
    if (lag > counters.worstDrainLagMs) counters.worstDrainLagMs = lag;
  }
  drain();
}

/** M1 gate (d) only. Never called in production; never wired to a menu item. */
export function setDebugStallMs(ms: number): void {
  debugStallMs = ms;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Install, run-loop registration, teardown
// ─────────────────────────────────────────────────────────────────────────────

export function installTap(nextSink: SignalSink): void {
  if (tapPort !== null) throw new Error("native: tap already installed");
  sink = nextSink;
  readTimebase();
  reanchorClock();

  // Registered, not transient: the tap calls us long after CGEventTapCreate
  // returns, and a transient callback is invalidated the moment that call does.
  registeredCallback = koffi.register(tapCallback, koffi.pointer(CGEventTapCallBack));

  const port = CGEventTapCreate(
    TAP_LOCATION,
    kCGHeadInsertEventTap,
    kCGEventTapOptionListenOnly,
    EVENT_MASK,
    registeredCallback,
    null,
  );
  if (port === null) {
    koffi.unregister(registeredCallback);
    registeredCallback = null;
    throw new Error(
      "native: CGEventTapCreate returned NULL — no Input Monitoring, or not a GUI session",
    );
  }
  tapPort = port;

  const source = CFMachPortCreateRunLoopSource(null, port, 0);
  if (source === null) throw new Error("native: CFMachPortCreateRunLoopSource returned NULL");
  runLoopSource = source;

  const rl = CFRunLoopGetMain();
  // BOTH modes — AGENTS.md trap #1, and not a belt-and-braces flourish.
  // Measured on macOS 26.5.1 inside the Electron main process:
  //   only kCFRunLoopCommonModes → 0 events, silently, tap still "enabled"
  //   only kCFRunLoopDefaultMode → 104 events
  // Default is what makes events flow at all; Common is what keeps them flowing
  // while the run loop is in a nested mode (menu tracking, a modal drag).
  CFRunLoopAddSource(rl, source, kCFRunLoopDefaultMode());
  CFRunLoopAddSource(rl, source, kCFRunLoopCommonModes());

  if (!CFRunLoopContainsSource(rl, source, kCFRunLoopDefaultMode())) {
    throw new Error(
      "native: source not in kCFRunLoopDefaultMode after add — the tap would be silently dead",
    );
  }
  CGEventTapEnable(port, true);
}

/**
 * Idempotent. Teardown ORDER is not stylistic: disable the tap → remove the
 * source → release the source → release the port → THEN koffi.unregister.
 * Unregistering first leaves a mach port that can still dispatch into a freed
 * trampoline slot: an immediate crash on the next keystroke, at shutdown, where
 * nobody will see the stack.
 */
export function removeTap(): void {
  const rl = CFRunLoopGetMain();
  if (tapPort !== null) CGEventTapEnable(tapPort, false);
  if (runLoopSource !== null) {
    CFRunLoopRemoveSource(rl, runLoopSource, kCFRunLoopDefaultMode());
    CFRunLoopRemoveSource(rl, runLoopSource, kCFRunLoopCommonModes());
    CFRelease(runLoopSource);
    runLoopSource = null;
  }
  if (tapPort !== null) {
    CFRelease(tapPort);
    tapPort = null;
  }
  if (registeredCallback !== null) {
    koffi.unregister(registeredCallback);
    registeredCallback = null;
  }
  sink = () => {};
}

export function isTapEnabled(): boolean {
  return tapPort !== null && CGEventTapIsEnabled(tapPort);
}

/** Watchdog recovery. Full teardown then full rebuild — never a partial re-arm. */
export function restartTap(nextSink: SignalSink): void {
  removeTap();
  installTap(nextSink);
}

/**
 * Get the tap back, by whatever means, without posting a single event.
 *
 * THE REASON THIS EXISTS. When macOS disables a tap it does NOT tell you
 * promptly. Measured on this machine: a callback blocked for 6 s with a burst
 * of events queued behind it left `CGEventTapIsEnabled` false, and then three
 * full seconds of pumping the run loop produced NO disable notice at all. The
 * notice only arrived when the next event did — it rides along with traffic
 * rather than arriving on its own.
 *
 * For an app whose entire job is to see input, that is the worst possible
 * delivery guarantee: the one channel that could tell us we have gone deaf is
 * the channel we have gone deaf on. So the tap-disabled callback cannot be the
 * recovery mechanism. Something has to ASK, on a clock, and that is this
 * function plus the watchdog's liveness beat.
 *
 * It is safe to call as often as you like: the healthy path is a single
 * CoreGraphics boolean read and returns immediately. It posts nothing, so it is
 * not a jiggler (AGENTS.md #7) and it does not touch the idle clock.
 */
export function reviveTap(nextSink: SignalSink): TapRevival {
  if (tapPort === null) {
    // No port at all — either we were never installed, or a previous rebuild
    // failed halfway. Either way the only move is a fresh install.
    try {
      installTap(nextSink);
      return { outcome: "rebuilt", detail: "no port; installed a new tap" };
    } catch (err) {
      return { outcome: "dead", detail: String(err) };
    }
  }

  if (CGEventTapIsEnabled(tapPort)) return { outcome: "healthy", detail: "" };

  // Cheapest first: the port is still ours, just switched off.
  CGEventTapEnable(tapPort, true);
  if (CGEventTapIsEnabled(tapPort)) {
    return { outcome: "reenabled", detail: "CGEventTapEnable took" };
  }

  // It did not take. The port itself is no good — rebuild from scratch.
  try {
    restartTap(nextSink);
  } catch (err) {
    return { outcome: "dead", detail: String(err) };
  }
  return isTapEnabled()
    ? { outcome: "rebuilt", detail: "re-enable refused; rebuilt the tap" }
    : { outcome: "dead", detail: "rebuilt tap is still not enabled" };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. The jiggler
//
// Post kCGEventNull — an event type with no coordinates, so it CANNOT move the
// cursor — from a source stamped with our magic, to the SAME tap location the
// tap listens at (trap #6). An HID-posted event is invisible to a session tap,
// so posting anywhere else looks exactly like "the jiggler works fine" while our
// own filter never fires.
// ─────────────────────────────────────────────────────────────────────────────

let jiggleSource: CGEventSourceRef | null = null;

function ensureJiggleSource(): CGEventSourceRef {
  if (jiggleSource !== null) return jiggleSource;
  const src = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
  if (src === null) throw new Error("native: CGEventSourceCreate returned NULL");
  // The stamp. Written BEFORE any event is created from this source.
  CGEventSourceSetUserData(src, WWB_MAGIC);
  const readBack = CGEventSourceGetUserData(src);
  if (Number(readBack) !== WWB_MAGIC) {
    throw new Error(`native: userData did not stick (got ${String(readBack)})`);
  }
  jiggleSource = src;
  return src;
}

/**
 * Post exactly one stamped null event. Returns false and posts NOTHING when
 * Accessibility is not granted.
 *
 * CGEventPost fails silently without kTCCServicePostEvent: no error, no
 * exception, cursor delta 0. A toggle that reads "on" and does nothing is the
 * exact failure mode to design against, so the gate is explicit and the caller
 * gets a boolean it must act on.
 */
export function postJiggle(): boolean {
  if (!AXIsProcessTrusted() && !CGPreflightPostEventAccess()) return false;
  const src = ensureJiggleSource();
  const ev = CGEventCreate(src); // type kCGEventNull, +1 retained
  if (ev === null) return false;
  try {
    CGEventPost(TAP_LOCATION, ev); // ← the SAME constant installTap() creates the tap with
    return true;
  } finally {
    CFRelease(ev); // 2,880 jiggles/day; leaking one event each is a leak
  }
}

export function releaseJiggleSource(): void {
  if (jiggleSource !== null) {
    CFRelease(jiggleSource);
    jiggleSource = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Camera and microphone — level reads, no listeners
//
// No property listeners are declared, deliberately. CMIOObjectAddPropertyListener
// / AudioObjectAddPropertyListener deliver on an internal HAL thread, and a koffi
// registered callback invoked off the JS thread is not a latency problem, it is a
// crash. docs/MACOS.md records the CMIO listener registering cleanly (OSStatus 0)
// and never being observed to fire. Correctness is anchored on the re-read from
// the existing 5-minute watchdog, so the listener buys nothing and risks the
// process. No second timer is added anywhere.
// ─────────────────────────────────────────────────────────────────────────────

function cmioDeviceIds(): number[] {
  const addr: PropAddr = {
    mSelector: kCMIOHardwarePropertyDevices,
    mScope: kCMIOObjectPropertyScopeGlobal,
    mElement: kElementMain,
  };
  const size: [number | null] = [null];
  if (CMIOObjectGetPropertyDataSize(kCMIOObjectSystemObject, addr, 0, null, size) !== 0) return [];
  const bytes = size[0] ?? 0;
  if (bytes < 4) return [];
  const buf = koffi.alloc("uint32_t", bytes / 4) as CBuf;
  try {
    const used: [number | null] = [null];
    if (CMIOObjectGetPropertyData(kCMIOObjectSystemObject, addr, 0, null, bytes, used, buf) !== 0) {
      return [];
    }
    return Array.from(koffi.decode(buf, "uint32_t", (used[0] ?? 0) / 4) as Uint32Array);
  } finally {
    koffi.free(buf);
  }
}

/** OR'd across every device: a machine can have a built-in camera AND an external one. */
export function anyCameraInUse(): boolean {
  const addr: PropAddr = {
    mSelector: kCMIODevicePropertyDeviceIsRunningSomewhere,
    mScope: kCMIOObjectPropertyScopeGlobal,
    mElement: kElementMain,
  };
  for (const id of cmioDeviceIds()) {
    if (!CMIOObjectHasProperty(id, addr)) continue;
    const buf = koffi.alloc("uint32_t", 1) as CBuf;
    try {
      const used: [number | null] = [null];
      if (
        CMIOObjectGetPropertyData(id, addr, 0, null, 4, used, buf) === 0 &&
        (koffi.decode(buf, "uint32_t") as number) !== 0
      ) {
        return true;
      }
    } finally {
      koffi.free(buf);
    }
  }
  return false;
}

function audioDeviceIds(): number[] {
  const addr: PropAddr = {
    mSelector: kAudioHardwarePropertyDevices,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kElementMain,
  };
  const size: [number | null] = [null];
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, addr, 0, null, size) !== 0) {
    return [];
  }
  const bytes = size[0] ?? 0;
  if (bytes < 4) return [];
  const buf = koffi.alloc("uint32_t", bytes / 4) as CBuf;
  try {
    const io: [number] = [bytes]; // INOUT — this is the CoreAudio shape, not CMIO's
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, addr, 0, null, io, buf) !== 0) {
      return [];
    }
    return Array.from(koffi.decode(buf, "uint32_t", io[0] / 4) as Uint32Array);
  } finally {
    koffi.free(buf);
  }
}

/** An output-only device can also report 'gone'; only input devices are the mic. */
function hasInputStreams(deviceId: number): boolean {
  const addr: PropAddr = {
    mSelector: kAudioDevicePropertyStreams,
    mScope: kAudioObjectPropertyScopeInput,
    mElement: kElementMain,
  };
  const size: [number | null] = [null];
  return (
    AudioObjectGetPropertyDataSize(deviceId, addr, 0, null, size) === 0 && (size[0] ?? 0) > 0
  );
}

export function anyMicInUse(): boolean {
  const addr: PropAddr = {
    mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kElementMain,
  };
  for (const id of audioDeviceIds()) {
    if (!hasInputStreams(id)) continue;
    if (!AudioObjectHasProperty(id, addr)) continue;
    const buf = koffi.alloc("uint32_t", 1) as CBuf;
    try {
      const io: [number] = [4];
      if (
        AudioObjectGetPropertyData(id, addr, 0, null, io, buf) === 0 &&
        (koffi.decode(buf, "uint32_t") as number) !== 0
      ) {
        return true;
      }
    } finally {
      koffi.free(buf);
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. Keep awake
// ─────────────────────────────────────────────────────────────────────────────

let assertionId: number | null = null;

/**
 * Exactly ONE assertion, type PreventUserIdleDisplaySleep.
 *
 * docs/MACOS.md section 5 names both PreventUserIdleSystemSleep and
 * PreventUserIdleDisplaySleep, and its own measurement shows `pmset -g
 * assertions` count 1 — because preventing idle display sleep already prevents
 * idle system sleep. M5 gate (d) requires exactly one assertion while on and
 * none after, so one is what we create. Do not "complete" this with a second.
 *
 * Held in-process and released by the kernel on process death. Never
 * spawn("/usr/bin/caffeinate"): that orphans a child which outlives the app.
 *
 * Toggling keep-awake is NEVER a work signal. This function emits nothing.
 */
export function setKeepAwake(on: boolean): void {
  if (on) {
    if (assertionId !== null) return;
    const type = cfString("PreventUserIdleDisplaySleep");
    const name = cfString("Work Week Buddy keep-awake");
    const out: [number | null] = [null];
    const rc = IOPMAssertionCreateWithName(type, kIOPMAssertionLevelOn, name, out);
    CFRelease(type);
    CFRelease(name);
    if (rc !== 0 || out[0] === null) {
      throw new Error(`native: IOPMAssertionCreateWithName rc=${rc}`);
    }
    assertionId = out[0];
  } else {
    if (assertionId === null) return;
    const id = assertionId;
    assertionId = null; // clear first: a failed release must not strand the toggle
    const rc = IOPMAssertionRelease(id);
    if (rc !== 0) counters.lastCallbackError = `IOPMAssertionRelease rc=${rc}`;
  }
}

export function keepAwakeActive(): boolean {
  return assertionId !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. Permissions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps `IOHIDAccessType` onto something with names. Anything unexpected becomes
 * "unknown", which is the state that still offers a prompt — erring towards
 * asking is safe, whereas a wrong "denied" would send the user to System
 * Settings for no reason.
 */
function accessState(raw: number): AccessState {
  switch (raw) {
    case 0:
      return "granted";
    case 1:
      return "denied";
    default:
      return "unknown";
  }
}

/** Preflight only. Never prompts. Safe to call from the watchdog. */
export function permissions(): Permissions {
  return {
    listenEvent: CGPreflightListenEventAccess(),
    postEvent: CGPreflightPostEventAccess(),
    axTrusted: AXIsProcessTrusted(),
    listenEventAccess: accessState(IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)),
    postEventAccess: accessState(IOHIDCheckAccess(kIOHIDRequestTypePostEvent)),
  };
}

/**
 * Onboarding only — every call here can raise a system dialog.
 *
 * Both buckets are requested because which one governs the keyboard bits is
 * genuinely disputed: Apple's CGEvent.h attributes them to Accessibility,
 * current vendor documentation to Input Monitoring. We do not pick a side; we
 * ask for both and then decide by inspecting the granted mask (section 12).
 */
export function requestPermissions(opts: { prompt: boolean }): Permissions {
  if (!CGPreflightListenEventAccess()) CGRequestListenEventAccess();
  if (!CGPreflightPostEventAccess()) CGRequestPostEventAccess();
  if (opts.prompt && !AXIsProcessTrusted()) {
    const key = cfStringSymbol(AS, "kAXTrustedCheckOptionPrompt");
    const yes = koffi.decode(CF.symbol("kCFBooleanTrue"), "void *") as bigint;
    const keys = koffi.alloc("void *", 1) as CBuf;
    const values = koffi.alloc("void *", 1) as CBuf;
    try {
      koffi.encode(keys, "void *", key);
      koffi.encode(values, "void *", yes);
      const dict = CFDictionaryCreate(
        null,
        keys,
        values,
        1,
        kCFTypeDictionaryKeyCallBacks(),
        kCFTypeDictionaryValueCallBacks(),
      );
      if (dict !== null) {
        AXIsProcessTrustedWithOptions(dict);
        CFRelease(dict);
      }
    } finally {
      koffi.free(keys);
      koffi.free(values);
    }
  }
  return permissions();
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. The mask assertion and the boot self-test
//
// A tap created without the keyboard permission comes back NON-NULL with the
// keyboard bits silently removed (traps #2 and #3). Never trust the create call.
// ─────────────────────────────────────────────────────────────────────────────

/** OR of eventsOfInterest across every tap this process owns, or null if we have none. */
export function grantedMask(): bigint | null {
  const count: [number | null] = [null];
  if (CGGetEventTapList(0, null, count) !== 0) return null;
  const n = count[0] ?? 0;
  if (n < 1) return null;

  const buf = koffi.alloc(CGEventTapInformation, n) as CBuf;
  try {
    const got: [number | null] = [null];
    if (CGGetEventTapList(n, buf, got) !== 0) return null;
    const list = koffi.decode(buf, CGEventTapInformation, got[0] ?? 0) as Array<{
      tappingProcess: number;
      eventsOfInterest: number | bigint;
      enabled: boolean;
    }>;
    const mine = list.filter((t) => t.tappingProcess === process.pid);
    if (mine.length === 0) return null;
    return mine.reduce((acc, t) => acc | BigInt(t.eventsOfInterest), 0n);
  } finally {
    koffi.free(buf);
  }
}

/**
 * granted & KEYBOARD_BITS === KEYBOARD_BITS → all three keyboard bits survived
 * granted & KEYBOARD_BITS === 0n            → Input Monitoring denied → red
 *                                             banner, tracking continues
 * Partial survival has never been observed; anything other than full survival is
 * treated as denied.
 */
export function keyboardBitsGranted(): boolean {
  const granted = grantedMask();
  return granted !== null && (granted & KEYBOARD_BITS) === KEYBOARD_BITS;
}

export function cursorPosition(): { x: number; y: number } {
  const ev = CGEventCreate(null);
  if (ev === null) return { x: NaN, y: NaN };
  try {
    return CGEventGetLocation(ev);
  } finally {
    CFRelease(ev);
  }
}

interface SeenJiggle {
  type: number;
  typeFromEvent: number;
  userDataType: string;
  pidType: string;
  epochMs: number;
}

/**
 * Runs at boot in the packaged app and as the hard gate in install.sh
 * (`--selftest`). It exercises every declaration that is safe to call and
 * asserts the things that otherwise fail silently.
 *
 * CGRequestListenEventAccess and CGRequestPostEventAccess are the only two
 * declarations this does not call — they prompt. Their NAMES are still
 * validated: lib.func() threw at import if either symbol were misspelled.
 */
/** Long enough to be well past any plausible tap timeout. */
const GATE_STALL_MS = 2_500;
/**
 * Events queued behind the blocked callback. Measured: a block on its own does
 * NOT get the tap disabled — macOS only kills a tap that is holding up traffic.
 * Sixty of our own null posts is plenty and moves no cursor.
 */
const GATE_BURST = 60;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function timed<T>(fn: () => T): { value: T; ms: number } {
  const at = Date.now();
  const value = fn();
  return { value, ms: Date.now() - at };
}

/**
 * Block the tap callback until macOS disables the tap, then prove the app gets
 * it back on its own.
 *
 * The first check is INFORMATIONAL. Whether a given macOS version kills the tap
 * at this exact block length is not ours to guarantee, and gating an install on
 * it would fail the install for the wrong reason. The check that matters is the
 * second one, and it is conditional in exactly the honest way: if the tap did
 * go down, it must have come back.
 */
async function tapRecoveryChecks(): Promise<SelfTestCheck[]> {
  const out: SelfTestCheck[] = [];
  if (!isTapEnabled()) {
    return [{ name: "tap recovery (M1 gate d)", ok: false, detail: "no live tap to test" }];
  }
  if (!AXIsProcessTrusted() && !CGPreflightPostEventAccess()) {
    return [
      {
        name: "tap recovery (M1 gate d)",
        ok: true,
        detail: "skipped — needs Accessibility to generate the traffic",
      },
    ];
  }

  const noticesBefore = counters.disableNotices;
  const failuresBefore = counters.reEnableFailures;
  setDebugStallMs(GATE_STALL_MS);
  for (let i = 0; i < GATE_BURST; i++) postJiggle();
  await sleep(GATE_STALL_MS + 600);

  const notices = counters.disableNotices - noticesBefore;
  const wentDown = notices > 0 || !isTapEnabled();
  out.push({
    name: `a ${String(GATE_STALL_MS)} ms block in the callback disables the tap (informational)`,
    ok: true,
    detail: wentDown
      ? `yes — notices ${String(notices)}, enabled=${String(isTapEnabled())}`
      : "no — this macOS tolerated the block",
  });
  // THE NUMBER THIS WHOLE FILE TURNS ON. Measured here on 2026-08-21: the tap
  // went down and `notices` was ZERO — macOS disabled it and said nothing, and
  // was still saying nothing 600 ms later. The disable-notice callback is not a
  // recovery mechanism; it is a courtesy that may never arrive. Everything the
  // app does to stay alive has to come from asking on a clock instead.
  out.push({
    name: "how the app found out the tap was down (informational)",
    ok: true,
    detail: wentDown
      ? notices > 0
        ? `a disable notice arrived (${String(notices)})`
        : "NO disable notice — only the liveness beat would have caught this"
      : "n/a",
  });

  // The recovery, with no window focused and nobody touching the app. This is
  // the watchdog's liveness beat, called by hand.
  const revival = reviveTap(sink);
  const alive = isTapEnabled();
  out.push({
    name: "the tap comes back with no user interaction (M1 gate d)",
    ok: alive,
    detail: `${revival.outcome}${revival.detail === "" ? "" : `: ${revival.detail}`}`,
  });

  // And it is not enough to be "enabled" — events have to actually arrive.
  let resumed = false;
  if (alive) {
    const seenAgain = new Promise<boolean>((resolve) => {
      selfTestSaw = () => resolve(true);
    });
    postJiggle();
    resumed = await Promise.race([seenAgain, sleep(2000).then(() => false)]);
    selfTestSaw = null;
  }
  out.push({
    name: "events resume after the recovery",
    ok: resumed,
    detail: resumed ? "seen" : "nothing arrived within 2000 ms",
  });

  out.push({
    name: "re-enables from the callback all took",
    ok: counters.reEnableFailures === failuresBefore,
    detail: String(counters.reEnableFailures - failuresBefore),
  });
  return out;
}

export async function selfTest(): Promise<SelfTestReport> {
  const checks: SelfTestCheck[] = [];
  const add = (name: string, ok: boolean, detail = ""): void => {
    checks.push({ name, ok, detail });
  };

  // 1 ─ ABI sanity. Catches a reordered or mistyped struct before it reads garbage.
  add(
    "CGEventTapInformation is 48 bytes",
    koffi.sizeof(CGEventTapInformation) === 48,
    `${koffi.sizeof(CGEventTapInformation)}`,
  );
  add("EVENT_MASK === 0x0FC01CFF", EVENT_MASK === 0x0fc01cffn, `0x${EVENT_MASK.toString(16)}`);

  // 2 ─ Permissions, recorded rather than judged.
  const perms = permissions();
  add("preflight recorded", true, JSON.stringify(perms));

  // 3 ─ The mask assertion. AGENTS.md traps #2 and #3.
  const granted = grantedMask();
  add(
    "tap present in CGGetEventTapList",
    granted !== null,
    granted === null ? "no tap owned by this pid" : `0x${granted.toString(16)}`,
  );
  add(
    "keyboard bits survived",
    granted !== null && (granted & KEYBOARD_BITS) === KEYBOARD_BITS,
    granted === null
      ? "-"
      : `0x${(granted & KEYBOARD_BITS).toString(16)} of 0x${KEYBOARD_BITS.toString(16)}`,
  );

  // 4 ─ The round trip: a tagged jiggle must come back identified as ours.
  const before = cursorPosition();
  const arrived = new Promise<SeenJiggle | null>((resolve) => {
    selfTestSaw = (ev, type) => {
      const rawUser = CGEventGetIntegerValueField(ev, kCGEventSourceUserData);
      const rawPid = CGEventGetIntegerValueField(ev, kCGEventSourceUnixProcessID);
      const ts = CGEventGetTimestamp(ev);
      resolve({
        type,
        typeFromEvent: CGEventGetType(ev),
        userDataType: typeof rawUser,
        pidType: typeof rawPid,
        epochMs: eventEpochMs(ts),
      });
    };
  });
  const posted = postJiggle();
  add("CGEventPost accepted", posted, posted ? "" : "Accessibility not granted — jiggler disabled");
  const seen = posted
    ? await Promise.race([
        arrived,
        new Promise<SeenJiggle | null>((r) => setTimeout(() => r(null), 2000)),
      ])
    : null;
  selfTestSaw = null;

  add(
    "tagged jiggle round-tripped as ours",
    seen !== null,
    seen === null ? "not seen within 2000 ms" : "seen",
  );
  // M1 gate (c): the typeof assertion, strict, where throwing is safe.
  // AGENTS.md trap #4 — a BigInt here means the ours-vs-theirs comparison is
  // silently false and our own jiggle counts as human input.
  add("userData read as a number", seen?.userDataType === "number", seen?.userDataType ?? "-");
  add("srcPid read as a number", seen?.pidType === "number", seen?.pidType ?? "-");
  add("posted event was kCGEventNull", seen?.type === EventType.Null, String(seen?.type ?? "-"));
  add(
    "CGEventGetType agrees with the callback's type argument",
    seen !== null && seen.typeFromEvent === seen.type,
    seen === null ? "-" : `${seen.typeFromEvent} vs ${seen.type}`,
  );
  // Proves CGEventGetTimestamp really is nanoseconds and the anchor is sane.
  // If it were mach ticks, every interval would be off by 41.67x.
  add(
    "timestamp converts to within 2 s of wall clock",
    seen !== null && Math.abs(seen.epochMs - Date.now()) < 2000,
    seen === null ? "-" : `${seen.epochMs - Date.now()} ms`,
  );

  // 5 ─ M5 gate (a): the cursor did not move one pixel.
  const after = cursorPosition();
  add(
    "cursor did not move",
    after.x === before.x && after.y === before.y,
    `${before.x},${before.y} → ${after.x},${after.y}`,
  );

  // 5b ─ M1 GATE (d). THE ONE THAT WAS NEVER RUN.
  //
  // `setDebugStallMs` has been in this file since M1 and nothing has ever
  // called it. docs/MACOS.md records that a 1.6 s block disables the tap and
  // prescribes `CGEventTapEnable(tap, true)` — but it never records a re-enable
  // being observed to work, because nobody ever made one happen. The app then
  // shipped, the tap started dying every few minutes, and the recovery path
  // that was supposed to catch it had never executed once.
  //
  // So: block the callback on purpose, with a burst of our own events queued
  // behind it, and then check that the tap comes back WITHOUT anybody clicking
  // anything. Measured — a lone blocked callback is not enough; macOS only
  // disables the tap when there is traffic waiting on it.
  for (const check of await tapRecoveryChecks()) checks.push(check);

  // 6 ─ Every remaining declaration, called once, harmlessly.
  add("CGEventTapIsEnabled", isTapEnabled(), "");
  // TIMED, not just called. These two walk the CoreMediaIO and CoreAudio device
  // lists, which are synchronous round trips to `coreaudiod` and the camera
  // daemon — the most plausible remaining source of a multi-second main-thread
  // block, and the reason the full probe stays on the five-minute cadence while
  // the tap check runs every two seconds. A number here is worth more than a
  // "callable", because the day one of them blocks is the day this line proves
  // it.
  const camMs = timed(() => anyCameraInUse());
  add("anyCameraInUse callable", typeof camMs.value === "boolean", `${String(camMs.ms)} ms`);
  const micMs = timed(() => anyMicInUse());
  add("anyMicInUse callable", typeof micMs.value === "boolean", `${String(micMs.ms)} ms`);
  const maskMs = timed(() => grantedMask());
  add("grantedMask callable", true, `${String(maskMs.ms)} ms`);
  setKeepAwake(true);
  const held = keepAwakeActive();
  setKeepAwake(false);
  add("power assertion create+release", held && !keepAwakeActive(), "");
  add(
    "number contract violations === 0",
    numberContractViolations === 0,
    String(numberContractViolations),
  );

  return { ok: checks.every((c) => c.ok), checks };
}
