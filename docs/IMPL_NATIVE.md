# `native.ts` — every koffi declaration, verbatim

**Task 1.2.** This document *is* the native layer. Type it as written.

`docs/MACOS.md` says what the APIs are and which ones bite. This says what to type. Where the two disagree, MACOS.md wins on facts and this wins on structure — but they were written not to disagree, and every deviation below is called out with the reason.

---

## 0. Ground rules

| Rule | Why |
|---|---|
| **`src/native/native.ts` is the only file in the repo that imports `koffi`.** | AGENTS.md structural rule. A wrong prototype is a segfault, not a type error — keep the blast radius to one file that is reviewed once and then frozen. |
| **No pointer ever crosses `native.ts`'s export boundary.** | Every export takes and returns plain JS values. A `bigint` pointer leaking into `src/main/` means someone can `CFRelease` it twice from two places. |
| **No `BigInt` crosses an IPC or a log boundary.** | `JSON.stringify(1n)` throws. Masks are logged as hex strings. |
| **The tap callback never throws into C.** | A JS exception propagating through a koffi trampoline into CoreGraphics is undefined behaviour. The whole body is wrapped in `try/catch`. |
| **The magic number is written exactly once, as a `Number` literal, with no `n` suffix.** | AGENTS trap #4. `0x57574B31n !== 0x57574B31` and the comparison silently classifies our own jiggle as a human. One constant, imported everywhere. |
| **One constant for the tap location, used by both create and post.** | AGENTS trap #6. If the two can't be spelled differently, they can't diverge. |
| **`src/core/` is untouched by all of this.** | native imports *types* from core (`import type`), never the reverse, and never `electron`. |

### File map

```
src/native/
  types.ts        SignalSource, RawSignal, NativeStatus, … — zero imports, safe anywhere
  levels.ts       levelEdge() — the pure camera/mic edge synthesiser, shared by real and fake
  native.ts       ALL koffi. Declarations + thin wrappers + the tap callback. Pointer-free exports.
  mac-source.ts   MacSignalSource implements SignalSource on top of native.ts
  fake-source.ts  FakeSignalSource implements SignalSource with zero native calls
  index.ts        createSignalSource() — the only import site for the rest of the app
```

Sections 1–12 below are `native.ts`, in order. Concatenated verbatim they *are* the file.

---

## 1. Loading the frameworks

macOS 11+ keeps system libraries in the dyld shared cache, so these paths do not exist on disk. `dlopen` resolves them from the cache anyway — `koffi.load()` on these exact paths works, and `ls` on them does not. Do not "fix" a path because the file is missing.

`ApplicationServices` is an umbrella. `AXIsProcessTrusted` actually lives in its `HIServices` sub-framework, so we try the sub-framework first and fall back to the umbrella. That is the only symbol group with a fallback.

```ts
// src/native/native.ts
import koffi, { type LibraryHandle } from 'koffi';
import type { RawSignal, SignalSink } from './types.js';

if (process.platform !== 'darwin') {
  // Loud, at import time. index.ts must dynamic-import this module so a non-Mac
  // test run never reaches here — see §13.
  throw new Error('native.ts is macOS-only; use FakeSignalSource (WWB_FAKE_NATIVE=1)');
}

function loadFirst(name: string, paths: readonly string[]): LibraryHandle {
  const failures: string[] = [];
  for (const p of paths) {
    try {
      return koffi.load(p);
    } catch (err) {
      failures.push(`${p}: ${(err as Error).message}`);
    }
  }
  throw new Error(`native: cannot load ${name}\n  ${failures.join('\n  ')}`);
}

const CG = loadFirst('CoreGraphics', [
  '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics',
]);
const CF = loadFirst('CoreFoundation', [
  '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation',
]);
const CMIO = loadFirst('CoreMediaIO', [
  '/System/Library/Frameworks/CoreMediaIO.framework/CoreMediaIO',
]);
const CA = loadFirst('CoreAudio', [
  '/System/Library/Frameworks/CoreAudio.framework/CoreAudio',
]);
const IOKIT = loadFirst('IOKit', [
  '/System/Library/Frameworks/IOKit.framework/IOKit',
]);
const AS = loadFirst('ApplicationServices', [
  '/System/Library/Frameworks/ApplicationServices.framework/Frameworks/HIServices.framework/HIServices',
  '/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices',
]);
const SYS = loadFirst('libSystem', ['/usr/lib/libSystem.B.dylib']);
```

**The one thing `koffi` does check:** `lib.func()` throws at declaration time if the *symbol name* does not exist. It never checks the *signature*. So a typo in a name is a loud crash on `import`; a typo in a type is a segfault at the first call, possibly hours later. That asymmetry is the entire reason this file exists.

---

## 2. Types, brands, structs, constants

Every C pointer is declared to koffi as plain `void *`. Type safety comes from **branded `bigint`s** in TypeScript — compile-time discrimination, zero runtime cost, and no ambiguity about what koffi hands a callback (it hands it a `BigInt`, or `null` for `NULL`).

```ts
declare const cfBrand: unique symbol;
/** A retained CoreFoundation / CoreGraphics pointer. Never leaves this file. */
type Ref<T extends string> = bigint & { readonly [cfBrand]: T };

type CGEventRef         = Ref<'CGEvent'>;
type CGEventSourceRef   = Ref<'CGEventSource'>;
type CFMachPortRef      = Ref<'CFMachPort'>;
type CFRunLoopSourceRef = Ref<'CFRunLoopSource'>;
type CFRunLoopRef       = Ref<'CFRunLoop'>;
type CFStringRef        = Ref<'CFString'>;
type CFDictionaryRef    = Ref<'CFDictionary'>;
type CBuf               = Ref<'buffer'>;      // koffi.alloc() result

/** Declare a koffi function with a real TypeScript signature. */
function fn<T extends (...args: never[]) => unknown>(lib: LibraryHandle, proto: string): T {
  return lib.func(proto) as unknown as T;
}

// ── structs ──────────────────────────────────────────────────────────────────
const CGPoint = koffi.struct('CGPoint', { x: 'double', y: 'double' });

// Field ORDER is the ABI. Do not alphabetise. koffi inserts the padding.
const CGEventTapInformation = koffi.struct('CGEventTapInformation', {
  eventTapID:         'uint32_t',
  tapPoint:           'uint32_t',
  options:            'uint32_t',
  eventsOfInterest:   'uint64_t',   // 8-byte aligned → 4 bytes of padding land above it
  tappingProcess:     'int32_t',
  processBeingTapped: 'int32_t',
  enabled:            'bool',       // 1 byte + 3 padding
  minUsecLatency:     'float',
  avgUsecLatency:     'float',
  maxUsecLatency:     'float',
});

const CMIOObjectPropertyAddress = koffi.struct('CMIOObjectPropertyAddress', {
  mSelector: 'uint32_t', mScope: 'uint32_t', mElement: 'uint32_t',
});
const AudioObjectPropertyAddress = koffi.struct('AudioObjectPropertyAddress', {
  mSelector: 'uint32_t', mScope: 'uint32_t', mElement: 'uint32_t',
});
const MachTimebase = koffi.struct('mach_timebase_info_data_t', {
  numer: 'uint32_t', denom: 'uint32_t',
});

// ── constants ────────────────────────────────────────────────────────────────
// Plain frozen objects, never `const enum`: electron-vite runs esbuild with
// isolatedModules, where `const enum` is a build error.
export const EventType = {
  Null: 0,
  LeftMouseDown: 1, LeftMouseUp: 2, RightMouseDown: 3, RightMouseUp: 4,
  MouseMoved: 5, LeftMouseDragged: 6, RightMouseDragged: 7,
  KeyDown: 10, KeyUp: 11, FlagsChanged: 12,
  ScrollWheel: 22, TabletPointer: 23, TabletProximity: 24,
  OtherMouseDown: 25, OtherMouseUp: 26, OtherMouseDragged: 27,
  TapDisabledByTimeout: 0xFFFFFFFE,
  TapDisabledByUserInput: 0xFFFFFFFF,
} as const;

/** CGEventField numbers. 41 and 42 are the two discriminators; 45 is a decoy. */
const kCGEventSourceUnixProcessID = 41;
const kCGEventSourceUserData      = 42;
// const kCGEventSourceStateID    = 45;  ← NOT a discriminator. See §5.

/** 'WWK1'. The ONLY place this number appears. Number literal — never `0x57574B31n`. */
export const WWB_MAGIC = 0x57574B31;

/** kCGSessionEventTap. Used by BOTH CGEventTapCreate and CGEventPost. */
const TAP_LOCATION = 1;
const kCGHeadInsertEventTap = 0;
const kCGEventTapOptionListenOnly = 1;
const kCGEventSourceStateHIDSystemState = 1;

const kCFStringEncodingUTF8 = 0x08000100;
const kIOPMAssertionLevelOn = 255;

// CoreMediaIO / CoreAudio four-char codes, written out so nobody has to trust a comment.
const kCMIOObjectSystemObject                  = 1;
const kCMIOHardwarePropertyDevices             = 0x64657623; // 'dev#'
const kCMIODevicePropertyDeviceIsRunningSomewhere = 0x676F6E65; // 'gone'
const kCMIOObjectPropertyScopeGlobal           = 0x676C6F62; // 'glob'
const kAudioObjectSystemObject                 = 1;
const kAudioHardwarePropertyDevices            = 0x64657623; // 'dev#'
const kAudioDevicePropertyDeviceIsRunningSomewhere = 0x676F6E65; // 'gone'
const kAudioObjectPropertyScopeGlobal          = 0x676C6F62; // 'glob'
const kAudioObjectPropertyScopeInput           = 0x696E7074; // 'inpt'
const kAudioDevicePropertyStreams              = 0x73746D23; // 'stm#'
const kElementMain = 0;
```

### The event mask, with the arithmetic spelled out

**Do all mask arithmetic in `BigInt`.** JS bitwise operators are 32-bit signed: `1 << 32 === 1`, and `1 << 31` is negative. Our highest type today is 27, so a Number would happen to work — until someone adds type 32 and the mask silently loses a bit. `CGEventMask` is `uint64_t`; treat it as one.

```ts
const bit = (type: number): bigint => 1n << BigInt(type);

/** keyDown | keyUp | flagsChanged = 0x1C00. FlagsChanged is AGENTS trap #3. */
export const KEYBOARD_BITS =
  bit(EventType.KeyDown) | bit(EventType.KeyUp) | bit(EventType.FlagsChanged);   // 0x0000_1C00

export const MOUSE_BITS =
  bit(1) | bit(2) | bit(3) | bit(4) | bit(5) | bit(6) | bit(7) |                 // 0x0000_00FE
  bit(22) | bit(23) | bit(24) |                                                  // 0x01C0_0000
  bit(25) | bit(26) | bit(27);                                                   // 0x0E00_0000

/** 0x0FC01CFE === 264248574n. Assert this literal in the boot test. */
export const EVENT_MASK = KEYBOARD_BITS | MOUSE_BITS;
```

`mouseMoved` (5) is deliberately **in** the mask: measured worst case is 0.15% CPU and a 1.6 µs callback, and the countdown is lazily re-armed so 300 events/s is still one timer op per 15 minutes.

---

## 3. The declarations

Every one. Grouped by framework, with the real C signature above each.

```ts
// ═══ CoreGraphics ════════════════════════════════════════════════════════════

// CGEventRef (*CGEventTapCallBack)(CGEventTapProxy, CGEventType, CGEventRef, void *)
const CGEventTapCallBack = koffi.proto(
  'void *CGEventTapCallBack(void *proxy, uint32_t type, void *event, void *userInfo)'
);

// CFMachPortRef CGEventTapCreate(CGEventTapLocation, CGEventTapPlacement,
//                                CGEventTapOptions, CGEventMask,
//                                CGEventTapCallBack, void *)
const CGEventTapCreate = fn<(
  tap: number, place: number, options: number, mask: bigint,
  callback: bigint, userInfo: null,
) => CFMachPortRef | null>(CG,
  'void *CGEventTapCreate(uint32_t tap, uint32_t place, uint32_t options, ' +
  'uint64_t eventsOfInterest, CGEventTapCallBack *callback, void *userInfo)');

// void CGEventTapEnable(CFMachPortRef, bool)
const CGEventTapEnable = fn<(tap: CFMachPortRef, enable: boolean) => void>(CG,
  'void CGEventTapEnable(void *tap, bool enable)');

// bool CGEventTapIsEnabled(CFMachPortRef)
const CGEventTapIsEnabled = fn<(tap: CFMachPortRef) => boolean>(CG,
  'bool CGEventTapIsEnabled(void *tap)');

// CGError CGGetEventTapList(uint32_t, CGEventTapInformation *, uint32_t *)
//   tapList == NULL → returns only the count.
const CGGetEventTapList = fn<(
  maxTaps: number, tapList: CBuf | null, count: [number | null],
) => number>(CG,
  'int32_t CGGetEventTapList(uint32_t maxNumberOfTaps, void *tapList, _Out_ uint32_t *eventTapCount)');

// int64_t CGEventGetIntegerValueField(CGEventRef, CGEventField)
//   MUST be int64_t. Declaring `int` truncates every field silently.
const CGEventGetIntegerValueField = fn<(ev: CGEventRef, field: number) => number | bigint>(CG,
  'int64_t CGEventGetIntegerValueField(void *event, uint32_t field)');

// CGEventTimestamp CGEventGetTimestamp(CGEventRef)   — uint64, nanoseconds since boot
const CGEventGetTimestamp = fn<(ev: CGEventRef) => number | bigint>(CG,
  'uint64_t CGEventGetTimestamp(void *event)');

// CGEventType CGEventGetType(CGEventRef)
const CGEventGetType = fn<(ev: CGEventRef) => number>(CG,
  'uint32_t CGEventGetType(void *event)');

// CGPoint CGEventGetLocation(CGEventRef)   — struct returned by value (x0/x1 → v0/v1 on arm64)
const CGEventGetLocation = fn<(ev: CGEventRef) => { x: number; y: number }>(CG,
  'CGPoint CGEventGetLocation(void *event)');

// CGEventRef CGEventCreate(CGEventSourceRef)   — returns a kCGEventNull event, +1 retained
const CGEventCreate = fn<(source: CGEventSourceRef | null) => CGEventRef | null>(CG,
  'void *CGEventCreate(void *source)');

// void CGEventPost(CGEventTapLocation, CGEventRef)
const CGEventPost = fn<(tap: number, ev: CGEventRef) => void>(CG,
  'void CGEventPost(uint32_t tap, void *event)');

// CGEventSourceRef CGEventSourceCreate(CGEventSourceStateID)   — int32, NOT uint32
const CGEventSourceCreate = fn<(stateID: number) => CGEventSourceRef | null>(CG,
  'void *CGEventSourceCreate(int32_t stateID)');

// void CGEventSourceSetUserData(CGEventSourceRef, int64_t)
const CGEventSourceSetUserData = fn<(src: CGEventSourceRef, userData: number) => void>(CG,
  'void CGEventSourceSetUserData(void *source, int64_t userData)');

// int64_t CGEventSourceGetUserData(CGEventSourceRef)   — self-test only
const CGEventSourceGetUserData = fn<(src: CGEventSourceRef) => number | bigint>(CG,
  'int64_t CGEventSourceGetUserData(void *source)');

// bool CGPreflightListenEventAccess(void)   — no prompt
const CGPreflightListenEventAccess = fn<() => boolean>(CG,
  'bool CGPreflightListenEventAccess()');
// bool CGRequestListenEventAccess(void)     — PROMPTS. Onboarding only.
const CGRequestListenEventAccess = fn<() => boolean>(CG,
  'bool CGRequestListenEventAccess()');
// bool CGPreflightPostEventAccess(void)     — no prompt
const CGPreflightPostEventAccess = fn<() => boolean>(CG,
  'bool CGPreflightPostEventAccess()');
// bool CGRequestPostEventAccess(void)       — PROMPTS. Onboarding only.
const CGRequestPostEventAccess = fn<() => boolean>(CG,
  'bool CGRequestPostEventAccess()');

// ═══ CoreFoundation ══════════════════════════════════════════════════════════

// CFRunLoopSourceRef CFMachPortCreateRunLoopSource(CFAllocatorRef, CFMachPortRef, CFIndex)
//   CFIndex is `long` (8 bytes, signed) on arm64.
const CFMachPortCreateRunLoopSource = fn<(
  alloc: null, port: CFMachPortRef, order: number,
) => CFRunLoopSourceRef | null>(CF,
  'void *CFMachPortCreateRunLoopSource(void *allocator, void *port, long order)');

// void CFRunLoopAddSource(CFRunLoopRef, CFRunLoopSourceRef, CFRunLoopMode)
const CFRunLoopAddSource = fn<(rl: CFRunLoopRef, src: CFRunLoopSourceRef, mode: CFStringRef) => void>(CF,
  'void CFRunLoopAddSource(void *rl, void *source, void *mode)');

// void CFRunLoopRemoveSource(CFRunLoopRef, CFRunLoopSourceRef, CFRunLoopMode)
const CFRunLoopRemoveSource = fn<(rl: CFRunLoopRef, src: CFRunLoopSourceRef, mode: CFStringRef) => void>(CF,
  'void CFRunLoopRemoveSource(void *rl, void *source, void *mode)');

// Boolean CFRunLoopContainsSource(CFRunLoopRef, CFRunLoopSourceRef, CFRunLoopMode)
const CFRunLoopContainsSource = fn<(rl: CFRunLoopRef, src: CFRunLoopSourceRef, mode: CFStringRef) => boolean>(CF,
  'bool CFRunLoopContainsSource(void *rl, void *source, void *mode)');

// CFRunLoopRef CFRunLoopGetMain(void)
const CFRunLoopGetMain = fn<() => CFRunLoopRef>(CF, 'void *CFRunLoopGetMain()');

// void CFRelease(CFTypeRef)   — crashes on NULL. Every call site guards.
const CFRelease = fn<(cf: bigint) => void>(CF, 'void CFRelease(void *cf)');

// CFStringRef CFStringCreateWithCString(CFAllocatorRef, const char *, CFStringEncoding)
const CFStringCreateWithCString = fn<(
  alloc: null, cstr: string, encoding: number,
) => CFStringRef | null>(CF,
  'void *CFStringCreateWithCString(void *alloc, const char *cStr, uint32_t encoding)');

// CFDictionaryRef CFDictionaryCreate(CFAllocatorRef, const void **, const void **,
//                                    CFIndex, const CFDictionaryKeyCallBacks *,
//                                    const CFDictionaryValueCallBacks *)
const CFDictionaryCreate = fn<(
  alloc: null, keys: CBuf, values: CBuf, n: number, keyCb: bigint, valCb: bigint,
) => CFDictionaryRef | null>(CF,
  'void *CFDictionaryCreate(void *allocator, const void **keys, const void **values, ' +
  'long numValues, const void *keyCallBacks, const void *valueCallBacks)');

// ═══ ApplicationServices / HIServices ════════════════════════════════════════

// Boolean AXIsProcessTrusted(void)
const AXIsProcessTrusted = fn<() => boolean>(AS, 'bool AXIsProcessTrusted()');
// Boolean AXIsProcessTrustedWithOptions(CFDictionaryRef)   — PROMPTS when told to.
const AXIsProcessTrustedWithOptions = fn<(opts: CFDictionaryRef | null) => boolean>(AS,
  'bool AXIsProcessTrustedWithOptions(void *options)');

// ═══ CoreMediaIO ═════════════════════════════════════════════════════════════
//   NOTE the arg count: CMIO takes dataSize IN and dataUsed OUT (7 args).
//   CoreAudio takes a single ioDataSize INOUT (6 args). They are NOT symmetric.

// OSStatus CMIOObjectGetPropertyDataSize(CMIOObjectID, const CMIOObjectPropertyAddress *,
//                                        UInt32, const void *, UInt32 *)
const CMIOObjectGetPropertyDataSize = fn<(
  obj: number, addr: PropAddr, qSize: number, qData: null, out: [number | null],
) => number>(CMIO,
  'int32_t CMIOObjectGetPropertyDataSize(uint32_t objectID, const CMIOObjectPropertyAddress *address, ' +
  'uint32_t qualifierDataSize, const void *qualifierData, _Out_ uint32_t *dataSize)');

// OSStatus CMIOObjectGetPropertyData(CMIOObjectID, const CMIOObjectPropertyAddress *,
//                                    UInt32, const void *, UInt32, UInt32 *, void *)
const CMIOObjectGetPropertyData = fn<(
  obj: number, addr: PropAddr, qSize: number, qData: null,
  dataSize: number, used: [number | null], data: CBuf,
) => number>(CMIO,
  'int32_t CMIOObjectGetPropertyData(uint32_t objectID, const CMIOObjectPropertyAddress *address, ' +
  'uint32_t qualifierDataSize, const void *qualifierData, uint32_t dataSize, ' +
  '_Out_ uint32_t *dataUsed, void *data)');

// Boolean CMIOObjectHasProperty(CMIOObjectID, const CMIOObjectPropertyAddress *)
const CMIOObjectHasProperty = fn<(obj: number, addr: PropAddr) => boolean>(CMIO,
  'bool CMIOObjectHasProperty(uint32_t objectID, const CMIOObjectPropertyAddress *address)');

// ═══ CoreAudio ═══════════════════════════════════════════════════════════════

// OSStatus AudioObjectGetPropertyDataSize(AudioObjectID, const AudioObjectPropertyAddress *,
//                                         UInt32, const void *, UInt32 *)
const AudioObjectGetPropertyDataSize = fn<(
  obj: number, addr: PropAddr, qSize: number, qData: null, out: [number | null],
) => number>(CA,
  'int32_t AudioObjectGetPropertyDataSize(uint32_t objectID, const AudioObjectPropertyAddress *address, ' +
  'uint32_t qualifierDataSize, const void *qualifierData, _Out_ uint32_t *outDataSize)');

// OSStatus AudioObjectGetPropertyData(AudioObjectID, const AudioObjectPropertyAddress *,
//                                     UInt32, const void *, UInt32 *, void *)
//   ioDataSize is INOUT: buffer size in, bytes written out.
const AudioObjectGetPropertyData = fn<(
  obj: number, addr: PropAddr, qSize: number, qData: null,
  ioDataSize: [number], data: CBuf,
) => number>(CA,
  'int32_t AudioObjectGetPropertyData(uint32_t objectID, const AudioObjectPropertyAddress *address, ' +
  'uint32_t qualifierDataSize, const void *qualifierData, _Inout_ uint32_t *ioDataSize, void *outData)');

// Boolean AudioObjectHasProperty(AudioObjectID, const AudioObjectPropertyAddress *)
const AudioObjectHasProperty = fn<(obj: number, addr: PropAddr) => boolean>(CA,
  'bool AudioObjectHasProperty(uint32_t objectID, const AudioObjectPropertyAddress *address)');

// ═══ IOKit ═══════════════════════════════════════════════════════════════════

// IOReturn IOPMAssertionCreateWithName(CFStringRef, IOPMAssertionLevel,
//                                      CFStringRef, IOPMAssertionID *)
const IOPMAssertionCreateWithName = fn<(
  type: CFStringRef, level: number, name: CFStringRef, out: [number | null],
) => number>(IOKIT,
  'int32_t IOPMAssertionCreateWithName(void *AssertionType, uint32_t AssertionLevel, ' +
  'void *AssertionName, _Out_ uint32_t *AssertionID)');

// IOReturn IOPMAssertionRelease(IOPMAssertionID)
const IOPMAssertionRelease = fn<(id: number) => number>(IOKIT,
  'int32_t IOPMAssertionRelease(uint32_t AssertionID)');

// ═══ libSystem ═══════════════════════════════════════════════════════════════

// uint64_t mach_absolute_time(void)
const mach_absolute_time = fn<() => number | bigint>(SYS, 'uint64_t mach_absolute_time()');
// kern_return_t mach_timebase_info(mach_timebase_info_t)
const mach_timebase_info = fn<(info: { numer?: number; denom?: number }) => number>(SYS,
  'int32_t mach_timebase_info(_Out_ mach_timebase_info_data_t *info)');

type PropAddr = { mSelector: number; mScope: number; mElement: number };
```

### The data symbols — and the trap that separates them

`lib.symbol(name)` returns **the address of the variable**, as a `BigInt`. What you do next depends on what the variable *holds*:

| Symbol | C type | What to do | Getting it wrong |
|---|---|---|---|
| `kCFRunLoopDefaultMode` | `CFStringRef` (a pointer) | **`koffi.decode(sym, 'void *')`** — you want the pointer stored *in* the variable | Passing `&variable` as the mode → `CFRunLoopAddSource` matches no mode → **zero events, no error** |
| `kCFRunLoopCommonModes` | `CFStringRef` | decode | same |
| `kAXTrustedCheckOptionPrompt` | `CFStringRef` | decode | dictionary key never matches → no prompt, silently |
| `kCFBooleanTrue` | `CFBooleanRef` | decode | garbage value in the dict |
| `kCFTypeDictionaryKeyCallBacks` | `struct` (by value) | **use the address directly, do NOT decode** | decoding yields the first 8 bytes as a pointer → segfault inside `CFDictionaryCreate` |
| `kCFTypeDictionaryValueCallBacks` | `struct` | address directly | same |

```ts
function cfStringSymbol(lib: LibraryHandle, name: string): CFStringRef {
  const addr = lib.symbol(name);
  const value = koffi.decode(addr, 'void *') as CFStringRef | null;
  if (value === null || value === 0n) {
    // A zero mode is trap #1's exact symptom with none of its warning signs.
    throw new Error(`native: ${name} resolved to NULL`);
  }
  return value;
}

let _defaultMode: CFStringRef | null = null;
let _commonModes: CFStringRef | null = null;
const kCFRunLoopDefaultMode = (): CFStringRef =>
  (_defaultMode ??= cfStringSymbol(CF, 'kCFRunLoopDefaultMode'));
const kCFRunLoopCommonModes = (): CFStringRef =>
  (_commonModes ??= cfStringSymbol(CF, 'kCFRunLoopCommonModes'));

/** Struct symbols: the address IS the argument. Never decode these. */
const kCFTypeDictionaryKeyCallBacks   = (): bigint => CF.symbol('kCFTypeDictionaryKeyCallBacks');
const kCFTypeDictionaryValueCallBacks = (): bigint => CF.symbol('kCFTypeDictionaryValueCallBacks');

/** Caller owns the result and must CFRelease it. */
function cfString(s: string): CFStringRef {
  const ref = CFStringCreateWithCString(null, s, kCFStringEncodingUTF8);
  if (ref === null) throw new Error(`native: CFStringCreateWithCString failed for ${JSON.stringify(s)}`);
  return ref;
}
```

---

## 4. Clock — hardware timestamps to epoch milliseconds

`CGEventGetTimestamp` is nanoseconds since boot. The reducer works in **epoch ms**. The conversion is the last place a phantom minute can enter, so it is written once, here.

```ts
let tbNumer = 1, tbDenom = 1;
let anchorEpochMs = 0;
let anchorMachNs = 0;

function readTimebase(): void {
  const info: { numer?: number; denom?: number } = {};
  const rc = mach_timebase_info(info);
  if (rc !== 0 || !info.numer || !info.denom) {
    throw new Error(`native: mach_timebase_info rc=${rc}`);
  }
  tbNumer = info.numer; tbDenom = info.denom;   // 125/3 on Apple Silicon, 1/1 on Intel
}

function machNowNs(): number {
  const raw = mach_absolute_time();
  const ticks = typeof raw === 'bigint' ? raw : BigInt(raw);
  return Number((ticks * BigInt(tbNumer)) / BigInt(tbDenom));
}

/**
 * Re-take the wall-clock ↔ mach anchor. Called at boot, on powerMonitor 'resume',
 * and on every watchdog probe. It reads two clocks and posts nothing.
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
  const ns = typeof tsNs === 'bigint' ? Number(tsNs) : tsNs;
  const ms = anchorEpochMs + (ns - anchorMachNs) / 1e6;
  return Math.round(Math.min(ms, Date.now()));
}
```

**Two facts that must be asserted at boot, not assumed.**

1. `mach_absolute_time()` counts *ticks*, not nanoseconds, on Apple Silicon (24 MHz, timebase 125/3). `CGEventGetTimestamp` was measured to be nanoseconds. If that were ever wrong, every interval would be off by 41.67×. §12 asserts it empirically: a round-tripped jiggle's converted timestamp must land within 2 s of `Date.now()`.
2. `CGEventGetTimestamp` returns `uint64`. koffi returns a `Number` while the value fits in 2⁵³ and a `BigInt` past it — which happens at **104 days of uptime**. Every read of a 64-bit field goes through a `number | bigint` normaliser. There is no "it's always a Number" anywhere in this file.

---

## 5. `isOurs(event)` — the two-field discriminator

```ts
let numberContractViolations = 0;

/**
 * Read a CGEvent field as a JS number.
 *
 * The failure this exists to prevent (AGENTS trap #4): comparing a field
 * against a BigInt literal. `0x57574B31n === 0x57574B31` is false, so our own
 * jiggle would be classified as human input and log 24-hour workdays, silently.
 * The fix is not a cast at the comparison — it is that the magic constant is a
 * Number and every field read is normalised here.
 *
 * This never throws: a throw in the tap callback goes into C. The strict
 * `typeof === 'number'` assertion lives in the boot self-test (§12), where it
 * throws for real. Here we count and carry on — a counter surfaced by probe()
 * is a red banner, a crash in a CoreGraphics trampoline is a corrupt process.
 */
function fieldAsNumber(ev: CGEventRef, field: number): number {
  const v = CGEventGetIntegerValueField(ev, field);
  if (typeof v === 'number') return v;
  numberContractViolations++;
  return Number(v);
}

/**
 * True iff this event is one of ours.
 *
 * Two independent discriminators, measured clean across 422 events:
 *   real:  srcPid = 0      userData = 0
 *   ours:  srcPid = <us>   userData = 0x57574B31
 *
 * kCGEventSourceStateID (field 45) is NOT a third discriminator and must never
 * be used as one: a source created with kCGEventSourceStateHIDSystemState — the
 * one we create in §8 — reads back 1, and real HID input also reads back 1. It
 * cannot separate them by construction.
 *
 * userData is checked first: it is the cheap rejection for the ~100% case.
 */
export function isOurs(ev: CGEventRef): boolean {
  const userData = fieldAsNumber(ev, kCGEventSourceUserData);
  if (userData !== WWB_MAGIC) return false;
  const srcPid = fieldAsNumber(ev, kCGEventSourceUnixProcessID);
  return srcPid === process.pid;
}
```

---

## 6. The tap callback

Order is load-bearing: **disable notices are handled before any field read** (AGENTS trap #13 — on type `0xFFFFFFFE` the event's fields are meaningless and reading them is a garbage read).

```ts
interface Coalesced { keyCount: number; keyLastNs: number; mouseCount: number; mouseLastNs: number }
const pending: Coalesced = { keyCount: 0, keyLastNs: 0, mouseCount: 0, mouseLastNs: 0 };
let drainScheduled = false;
let drainScheduledAtMs = 0;

let sink: SignalSink = () => {};
let tapPort: CFMachPortRef | null = null;
let runLoopSource: CFRunLoopSourceRef | null = null;
let registeredCallback: bigint | null = null;
let selfTestSaw: ((ev: CGEventRef, type: number) => void) | null = null;
let debugStallMs = 0;   // M1 gate (d) only

export const counters = {
  realEvents: 0, ourEvents: 0, disableNotices: 0, lastDisableType: 0,
  callbackErrors: 0, lastCallbackError: '', inlineDrains: 0,
  get numberContractViolations() { return numberContractViolations; },
  lastRealSignalMs: 0,
};

function tapCallback(
  _proxy: bigint | null, type: number, event: bigint | null, _userInfo: bigint | null,
): bigint {
  if (event === null) return 0n;
  const ev = event as CGEventRef;
  try {
    // 1 ─ Disable notices FIRST. No field reads on these; the payload is garbage.
    if (type === EventType.TapDisabledByTimeout || type === EventType.TapDisabledByUserInput) {
      counters.disableNotices++;
      counters.lastDisableType = type;
      if (tapPort !== null) CGEventTapEnable(tapPort, true);
      return event;
    }

    // 2 ─ Belt and braces: if setImmediate has not run in 50 ms the loop is
    //     starved, so drain inline. A non-zero inlineDrains counter in the field
    //     is a real finding, not noise.
    if (drainScheduled && Date.now() - drainScheduledAtMs > 50) {
      counters.inlineDrains++;
      drain();
    }

    // 3 ─ Our own jiggle: never a signal, ever.
    if (isOurs(ev)) {
      counters.ourEvents++;
      selfTestSaw?.(ev, type);
      return event;
    }

    // 4 ─ A real signal. Coalesce; do not touch SQLite, IPC, or the reducer here.
    counters.realEvents++;
    const raw = CGEventGetTimestamp(ev);
    const ns = typeof raw === 'bigint' ? Number(raw) : raw;
    if (type === EventType.KeyDown || type === EventType.KeyUp || type === EventType.FlagsChanged) {
      pending.keyCount++;
      if (ns > pending.keyLastNs) pending.keyLastNs = ns;
    } else {
      pending.mouseCount++;
      if (ns > pending.mouseLastNs) pending.mouseLastNs = ns;
    }
    if (!drainScheduled) {
      drainScheduled = true;
      drainScheduledAtMs = Date.now();
      setImmediate(drain);
    }

    if (debugStallMs > 0) {                       // M1 gate (d)
      const until = Date.now() + debugStallMs;
      debugStallMs = 0;
      while (Date.now() < until) { /* deliberate block → kCGEventTapDisabledByTimeout */ }
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
 * reducer's lastRealSignalMs lands on the true final keystroke, not on the
 * first of the burst. And key_events / mouse_events stay exact for the row.
 */
function drain(): void {
  drainScheduled = false;
  const { keyCount, keyLastNs, mouseCount, mouseLastNs } = pending;
  pending.keyCount = 0; pending.keyLastNs = 0;
  pending.mouseCount = 0; pending.mouseLastNs = 0;

  const out: RawSignal[] = [];
  if (keyCount > 0)   out.push({ kind: 'key',   atMs: eventEpochMs(keyLastNs),   count: keyCount });
  if (mouseCount > 0) out.push({ kind: 'mouse', atMs: eventEpochMs(mouseLastNs), count: mouseCount });
  out.sort((a, b) => a.atMs - b.atMs);
  for (const s of out) {
    if (s.atMs > counters.lastRealSignalMs) counters.lastRealSignalMs = s.atMs;
    sink(s);
  }
}

/** M1 gate (d) only. Never called in production; never wired to a menu item. */
export function setDebugStallMs(ms: number): void { debugStallMs = ms; }
```

**Callback budget.** Measured average is 1.6 µs; a 1.6 s block disabled the tap. The callback does three field reads and an array push. It must never call SQLite, `webContents.send`, `console.log` to a file, or the reducer's close path — that work belongs on the `setImmediate` turn, where a slow write cannot kill the tap.

---

## 7. Install, run-loop registration, teardown

```ts
export function installTap(nextSink: SignalSink): void {
  if (tapPort !== null) throw new Error('native: tap already installed');
  sink = nextSink;
  readTimebase();
  reanchorClock();

  // Registered, not transient: the tap calls us long after CGEventTapCreate
  // returns. A transient callback is invalidated the moment that call returns.
  registeredCallback = koffi.register(tapCallback, koffi.pointer(CGEventTapCallBack));

  const port = CGEventTapCreate(
    TAP_LOCATION, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly,
    EVENT_MASK, registeredCallback, null,
  );
  if (port === null) {
    koffi.unregister(registeredCallback);
    registeredCallback = null;
    throw new Error('native: CGEventTapCreate returned NULL — no Input Monitoring, or not a GUI session');
  }
  tapPort = port;

  const source = CFMachPortCreateRunLoopSource(null, port, 0);
  if (source === null) throw new Error('native: CFMachPortCreateRunLoopSource returned NULL');
  runLoopSource = source;

  const rl = CFRunLoopGetMain();
  // BOTH modes. Not a belt-and-braces flourish — see the measurement below.
  CFRunLoopAddSource(rl, source, kCFRunLoopDefaultMode());
  CFRunLoopAddSource(rl, source, kCFRunLoopCommonModes());

  if (!CFRunLoopContainsSource(rl, source, kCFRunLoopDefaultMode())) {
    throw new Error('native: source not in kCFRunLoopDefaultMode after add — the tap would be silently dead');
  }
  CGEventTapEnable(port, true);
}

/** Idempotent. Order matters — see below. */
export function removeTap(): void {
  const rl = CFRunLoopGetMain();
  if (tapPort !== null) CGEventTapEnable(tapPort, false);
  if (runLoopSource !== null) {
    CFRunLoopRemoveSource(rl, runLoopSource, kCFRunLoopDefaultMode());
    CFRunLoopRemoveSource(rl, runLoopSource, kCFRunLoopCommonModes());
    CFRelease(runLoopSource);
    runLoopSource = null;
  }
  if (tapPort !== null) { CFRelease(tapPort); tapPort = null; }
  if (registeredCallback !== null) { koffi.unregister(registeredCallback); registeredCallback = null; }
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
```

### Why both modes, and what happens if you pick one

Measured, on macOS 26.5.1, inside the Electron main process:

```
source added ONLY to kCFRunLoopCommonModes  →  {"events": 0}     ← silently dead
source added ONLY to kCFRunLoopDefaultMode  →  {"events": 104}   ← works
```

- **Default** is what makes events flow at all. `kCFRunLoopCommonModes` is not a mode; it is a *set*, and a source added to it is dispatched only in modes that have been enrolled in that set. Chromium's pump does not run in a mode that gets our source that way. (Mechanism inferred; the two numbers above are measured.)
- **Common** is what keeps events flowing while the run loop is in a nested mode — menu tracking, a modal drag, a window resize. Without it, holding a menu bar open stops the tap for the duration.

The failure is **zero events with `CGEventTapIsEnabled` still returning true**. Nothing logs. Hours quietly become zero. Hence the `CFRunLoopContainsSource` assertion above and M1 gate (e).

**Teardown order is not stylistic.** Disable the tap → remove the source → release the source → release the port → *then* `koffi.unregister`. Unregistering first leaves a mach port that can still dispatch into a freed trampoline slot: an immediate crash on the next keystroke, at shutdown, where nobody will see the stack.

---

## 8. The jiggler

Post `kCGEventNull` — an event type with no coordinates, so it *cannot* move the cursor — from a source stamped with our magic, **to the same tap location the tap listens at**.

```ts
let jiggleSource: CGEventSourceRef | null = null;

function ensureJiggleSource(): CGEventSourceRef {
  if (jiggleSource !== null) return jiggleSource;
  const src = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
  if (src === null) throw new Error('native: CGEventSourceCreate returned NULL');
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
  const ev = CGEventCreate(src);                 // type kCGEventNull, +1 retained
  if (ev === null) return false;
  try {
    CGEventPost(TAP_LOCATION, ev);               // ← the SAME constant §7 creates the tap with
    return true;
  } finally {
    CFRelease(ev);                               // 2,880 jiggles/day; leaking one event each is a leak
  }
}

export function releaseJiggleSource(): void {
  if (jiggleSource !== null) { CFRelease(jiggleSource); jiggleSource = null; }
}
```

Three things this design buys, each measured:

- **The cursor cannot move.** A null event carries no coordinates. No drift, no accidental drags, nothing fighting the pointer. M5 gate (a) asserts zero pixels.
- **The idle clock still resets** — `hidIdleBefore 19.36 → hidIdleAfter 0.443`. Asynchronously: a read taken immediately after `CGEventPost` returns still showed 6.457 s, then 0.2995 s 300 ms later. Any test that asserts the reset must wait ~300 ms.
- **Our filter sees it**, because it is posted at `TAP_LOCATION`. An HID-posted event is invisible to a session tap, so the filter would never fire and the tap would see nothing to filter — which is failure mode #6, and it looks exactly like "the jiggler works fine".

**The jiggler owns no timer in this file.** The 30-second interval lives in `src/main/jiggler.ts`, alongside the rule that toggling it closes the current interval and opens a new one.

---

## 9. Camera and microphone — level reads, no listeners

```ts
function cmioDeviceIds(): number[] {
  const addr: PropAddr = {
    mSelector: kCMIOHardwarePropertyDevices,
    mScope: kCMIOObjectPropertyScopeGlobal, mElement: kElementMain,
  };
  const size: [number | null] = [null];
  if (CMIOObjectGetPropertyDataSize(kCMIOObjectSystemObject, addr, 0, null, size) !== 0) return [];
  const bytes = size[0] ?? 0;
  if (bytes < 4) return [];
  const buf = koffi.alloc('uint32_t', bytes / 4) as CBuf;
  try {
    const used: [number | null] = [null];
    if (CMIOObjectGetPropertyData(kCMIOObjectSystemObject, addr, 0, null, bytes, used, buf) !== 0) return [];
    return Array.from(koffi.decode(buf, 'uint32_t', (used[0] ?? 0) / 4) as Uint32Array);
  } finally {
    koffi.free(buf);
  }
}

/** OR'd across every device: this machine has a built-in camera AND an external one. */
export function anyCameraInUse(): boolean {
  const addr: PropAddr = {
    mSelector: kCMIODevicePropertyDeviceIsRunningSomewhere,
    mScope: kCMIOObjectPropertyScopeGlobal, mElement: kElementMain,
  };
  for (const id of cmioDeviceIds()) {
    if (!CMIOObjectHasProperty(id, addr)) continue;
    const buf = koffi.alloc('uint32_t', 1) as CBuf;
    try {
      const used: [number | null] = [null];
      if (CMIOObjectGetPropertyData(id, addr, 0, null, 4, used, buf) === 0 &&
          (koffi.decode(buf, 'uint32_t') as number) !== 0) return true;
    } finally {
      koffi.free(buf);
    }
  }
  return false;
}

function audioDeviceIds(): number[] {
  const addr: PropAddr = {
    mSelector: kAudioHardwarePropertyDevices,
    mScope: kAudioObjectPropertyScopeGlobal, mElement: kElementMain,
  };
  const size: [number | null] = [null];
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, addr, 0, null, size) !== 0) return [];
  const bytes = size[0] ?? 0;
  if (bytes < 4) return [];
  const buf = koffi.alloc('uint32_t', bytes / 4) as CBuf;
  try {
    const io: [number] = [bytes];                       // INOUT — this is the CoreAudio shape
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, addr, 0, null, io, buf) !== 0) return [];
    return Array.from(koffi.decode(buf, 'uint32_t', io[0] / 4) as Uint32Array);
  } finally {
    koffi.free(buf);
  }
}

/** An output-only device can also report 'gone'; only input devices are the mic. */
function hasInputStreams(deviceId: number): boolean {
  const addr: PropAddr = {
    mSelector: kAudioDevicePropertyStreams,
    mScope: kAudioObjectPropertyScopeInput, mElement: kElementMain,
  };
  const size: [number | null] = [null];
  return AudioObjectGetPropertyDataSize(deviceId, addr, 0, null, size) === 0 && (size[0] ?? 0) > 0;
}

export function anyMicInUse(): boolean {
  const addr: PropAddr = {
    mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
    mScope: kAudioObjectPropertyScopeGlobal, mElement: kElementMain,
  };
  for (const id of audioDeviceIds()) {
    if (!hasInputStreams(id)) continue;
    if (!AudioObjectHasProperty(id, addr)) continue;
    const buf = koffi.alloc('uint32_t', 1) as CBuf;
    try {
      const io: [number] = [4];
      if (AudioObjectGetPropertyData(id, addr, 0, null, io, buf) === 0 &&
          (koffi.decode(buf, 'uint32_t') as number) !== 0) return true;
    } finally {
      koffi.free(buf);
    }
  }
  return false;
}
```

**No property listeners are declared, deliberately.** `CMIOObjectAddPropertyListener` / `AudioObjectAddPropertyListener` deliver on an internal HAL thread. A koffi registered callback invoked off the JS thread is not a latency problem, it is a crash. And MACOS.md records that the CMIO listener registered cleanly (`OSStatus 0`) but was **never observed firing**, with reports of spurious and cross-process-leaked callbacks on Apple Silicon. Correctness was already anchored on the re-read, so the listener buys nothing and risks the process.

That leaves the camera and mic sampled by the **existing** 5-minute watchdog. It reads exactly three integers — tap-enabled, camera, mic — which is the tick ARCHITECTURE §3.5 already describes. No second timer is added anywhere.

**The edge timestamps, which are the close rule applied to levels:**

| Edge | `atMs` | Why |
|---|---|---|
| `camera_on`, `mic_on` | the probe instant | Later than the truth by up to 5 min. Starting late under-counts, which is the safe direction. |
| `camera_off`, `mic_off` | **the previous probe at which the level was still on** | Never the detection instant. Closing at detection would donate up to 5 phantom minutes to every call — the same bug as closing at the timeout instant, wearing a different hat. |

```ts
// src/native/levels.ts — pure, shared by MacSignalSource and FakeSignalSource
import type { RawSignal, SignalKind } from './types.js';

export interface LevelState { readonly on: boolean; readonly lastOnMs: number | null }
export const LEVEL_OFF: LevelState = { on: false, lastOnMs: null };

export function levelEdge(
  prev: LevelState, nowOn: boolean, nowMs: number, onKind: SignalKind, offKind: SignalKind,
): { next: LevelState; signal: RawSignal | null } {
  if (nowOn) {
    const next = { on: true, lastOnMs: nowMs };
    return prev.on ? { next, signal: null } : { next, signal: { kind: onKind, atMs: nowMs } };
  }
  if (!prev.on) return { next: prev, signal: null };
  return {
    next: LEVEL_OFF,
    signal: { kind: offKind, atMs: prev.lastOnMs ?? nowMs },   // ← last seen ON, never nowMs
  };
}
```

---

## 10. Keep awake

```ts
let assertionId: number | null = null;

/**
 * Exactly ONE assertion, type PreventUserIdleDisplaySleep.
 *
 * MACOS.md §5 names both PreventUserIdleSystemSleep and
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
    const type = cfString('PreventUserIdleDisplaySleep');
    const name = cfString('Work Week Buddy keep-awake');
    const out: [number | null] = [null];
    const rc = IOPMAssertionCreateWithName(type, kIOPMAssertionLevelOn, name, out);
    CFRelease(type); CFRelease(name);
    if (rc !== 0 || out[0] === null) throw new Error(`native: IOPMAssertionCreateWithName rc=${rc}`);
    assertionId = out[0];
  } else {
    if (assertionId === null) return;
    const id = assertionId;
    assertionId = null;                       // clear first: a failed release must not strand the toggle
    const rc = IOPMAssertionRelease(id);
    if (rc !== 0) counters.lastCallbackError = `IOPMAssertionRelease rc=${rc}`;
  }
}

export function keepAwakeActive(): boolean { return assertionId !== null; }
```

---

## 11. Permissions

```ts
export interface Permissions {
  /** kTCCServiceListenEvent — Input Monitoring. Keyboard bits in the tap. */
  readonly listenEvent: boolean;
  /** kTCCServicePostEvent — Accessibility. The jiggler. */
  readonly postEvent: boolean;
  /** AXIsProcessTrusted — the other half of the Accessibility story. */
  readonly axTrusted: boolean;
}

/** Preflight only. Never prompts. Safe to call from the watchdog. */
export function permissions(): Permissions {
  return {
    listenEvent: CGPreflightListenEventAccess(),
    postEvent: CGPreflightPostEventAccess(),
    axTrusted: AXIsProcessTrusted(),
  };
}

/**
 * Onboarding only — every call here can raise a system dialog.
 * Both buckets are requested because which one governs the keyboard bits is
 * genuinely disputed: Apple's CGEvent.h attributes them to Accessibility,
 * current vendor documentation to Input Monitoring. We do not pick a side; we
 * ask for both and then decide by inspecting the granted mask (§12).
 */
export function requestPermissions(opts: { prompt: boolean }): Permissions {
  if (!CGPreflightListenEventAccess()) CGRequestListenEventAccess();
  if (!CGPreflightPostEventAccess()) CGRequestPostEventAccess();
  if (opts.prompt && !AXIsProcessTrusted()) {
    const key = cfStringSymbol(AS, 'kAXTrustedCheckOptionPrompt');
    const yes = koffi.decode(CF.symbol('kCFBooleanTrue'), 'void *') as bigint;
    const keys = koffi.alloc('void *', 1) as CBuf;
    const values = koffi.alloc('void *', 1) as CBuf;
    try {
      koffi.encode(keys, 'void *', key);
      koffi.encode(values, 'void *', yes);
      const dict = CFDictionaryCreate(
        null, keys, values, 1, kCFTypeDictionaryKeyCallBacks(), kCFTypeDictionaryValueCallBacks(),
      );
      if (dict !== null) { AXIsProcessTrustedWithOptions(dict); CFRelease(dict); }
    } finally {
      koffi.free(keys); koffi.free(values);
    }
  }
  return permissions();
}
```

---

## 12. The mask assertion and the boot self-test

### The granted mask

A tap created without the keyboard permission comes back **non-NULL with the keyboard bits silently removed**. Never trust the create call.

```ts
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
      tappingProcess: number; eventsOfInterest: number | bigint; enabled: boolean;
    }>;
    const mine = list.filter((t) => t.tappingProcess === process.pid);
    if (mine.length === 0) return null;
    return mine.reduce((acc, t) => acc | BigInt(t.eventsOfInterest), 0n);
  } finally {
    koffi.free(buf);
  }
}

export function keyboardBitsGranted(): boolean {
  const granted = grantedMask();
  return granted !== null && (granted & KEYBOARD_BITS) === KEYBOARD_BITS;
}
```

The exact arithmetic, so nobody re-derives it:

```
KEYBOARD_BITS  = 1n<<10n | 1n<<11n | 1n<<12n            = 0x0000_1C00n =       7168n
MOUSE_BITS     = bits 1–7 | 22–24 | 25–27               = 0x0FC0_00FEn = 264241406n
EVENT_MASK     = KEYBOARD_BITS | MOUSE_BITS             = 0x0FC0_1CFEn = 264248574n

granted & KEYBOARD_BITS === KEYBOARD_BITS   →  all three keyboard bits survived
granted & KEYBOARD_BITS === 0n              →  Input Monitoring denied → red banner, tracking continues
```

Partial survival has never been observed; treat anything other than full survival as denied.

### The self-test

Runs at boot in the packaged app and as the hard gate in `install.sh` (`--selftest`). It exercises every declaration that is safe to call and asserts the five things that fail silently.

```ts
export interface SelfTestCheck { name: string; ok: boolean; detail: string }
export interface SelfTestReport { ok: boolean; checks: SelfTestCheck[] }

export function cursorPosition(): { x: number; y: number } {
  const ev = CGEventCreate(null);
  if (ev === null) return { x: NaN, y: NaN };
  try { return CGEventGetLocation(ev); } finally { CFRelease(ev); }
}

export async function selfTest(): Promise<SelfTestReport> {
  const checks: SelfTestCheck[] = [];
  const add = (name: string, ok: boolean, detail = ''): void => { checks.push({ name, ok, detail }); };

  // 1 ─ ABI sanity. Catches a reordered or mistyped struct before it reads garbage.
  add('CGEventTapInformation is 48 bytes',
      koffi.sizeof(CGEventTapInformation) === 48, `${koffi.sizeof(CGEventTapInformation)}`);
  add('EVENT_MASK === 0x0FC01CFE', EVENT_MASK === 0x0FC01CFEn, `0x${EVENT_MASK.toString(16)}`);

  // 2 ─ Permissions, recorded rather than judged.
  const perms = permissions();
  add('preflight recorded', true, JSON.stringify(perms));

  // 3 ─ The mask assertion. AGENTS traps #2 and #3.
  const granted = grantedMask();
  add('tap present in CGGetEventTapList', granted !== null,
      granted === null ? 'no tap owned by this pid' : `0x${granted.toString(16)}`);
  add('keyboard bits survived', granted !== null && (granted & KEYBOARD_BITS) === KEYBOARD_BITS,
      granted === null ? '-' : `0x${(granted & KEYBOARD_BITS).toString(16)} of 0x${KEYBOARD_BITS.toString(16)}`);

  // 4 ─ The round trip: a tagged jiggle must come back identified as ours.
  const before = cursorPosition();
  let seen: { type: number; userDataType: string; pidType: string; epochMs: number } | null = null;
  const arrived = new Promise<void>((resolve) => {
    selfTestSaw = (ev, type) => {
      const rawUser = CGEventGetIntegerValueField(ev, kCGEventSourceUserData);
      const rawPid  = CGEventGetIntegerValueField(ev, kCGEventSourceUnixProcessID);
      const ts = CGEventGetTimestamp(ev);
      seen = {
        type,
        userDataType: typeof rawUser,
        pidType: typeof rawPid,
        epochMs: eventEpochMs(ts),
      };
      resolve();
    };
  });
  const posted = postJiggle();
  add('CGEventPost accepted', posted, posted ? '' : 'Accessibility not granted — jiggler disabled');
  if (posted) {
    await Promise.race([arrived, new Promise<void>((r) => setTimeout(r, 2000))]);
  }
  selfTestSaw = null;

  add('tagged jiggle round-tripped as ours', seen !== null,
      seen === null ? 'not seen within 2000 ms' : 'seen');
  // M1 gate (c): the typeof assertion, strict, where throwing is safe.
  add('userData read as a number', seen?.userDataType === 'number', seen?.userDataType ?? '-');
  add('srcPid read as a number', seen?.pidType === 'number', seen?.pidType ?? '-');
  add('posted event was kCGEventNull', seen?.type === EventType.Null, String(seen?.type ?? '-'));
  // Proves CGEventGetTimestamp really is nanoseconds and the anchor is sane.
  add('timestamp converts to within 2 s of wall clock',
      seen !== null && Math.abs(seen.epochMs - Date.now()) < 2000,
      seen === null ? '-' : `${seen.epochMs - Date.now()} ms`);

  // 5 ─ M5 gate (a): the cursor did not move one pixel.
  const after = cursorPosition();
  add('cursor did not move', after.x === before.x && after.y === before.y,
      `${before.x},${before.y} → ${after.x},${after.y}`);

  // 6 ─ Every remaining declaration, called once, harmlessly.
  add('CGEventTapIsEnabled', isTapEnabled(), '');
  add('anyCameraInUse callable', typeof anyCameraInUse() === 'boolean', '');
  add('anyMicInUse callable', typeof anyMicInUse() === 'boolean', '');
  setKeepAwake(true); const held = keepAwakeActive(); setKeepAwake(false);
  add('power assertion create+release', held && !keepAwakeActive(), '');
  add('number contract violations === 0', numberContractViolations === 0, String(numberContractViolations));

  return { ok: checks.every((c) => c.ok), checks };
}
```

`CGRequestListenEventAccess` and `CGRequestPostEventAccess` are the only two declarations the self-test does not call — they prompt. Their *names* are still validated: `lib.func()` threw at import if either symbol were misspelled.

---

## 13. The mockable seam

Everything above hides behind one interface, so the whole app — reducer, store, flush, tray, dashboard — is built and tested on any machine, with no Mac in the loop.

```ts
// src/native/types.ts  — zero imports, safe to import from anywhere including tests
export type SignalKind =
  | 'key' | 'mouse'
  | 'camera_on' | 'camera_off'
  | 'mic_on' | 'mic_off';

export interface RawSignal {
  readonly kind: SignalKind;
  /** Epoch ms. From the hardware timestamp for key/mouse; see §9 for levels. */
  readonly atMs: number;
  /** Coalesced event count. Present for 'key' and 'mouse' only. */
  readonly count?: number;
}

export type SignalSink = (signal: RawSignal) => void;

export interface NativeCountersSnapshot {
  readonly realEvents: number; readonly ourEvents: number;
  readonly disableNotices: number; readonly lastDisableType: number;
  readonly callbackErrors: number; readonly lastCallbackError: string;
  readonly inlineDrains: number; readonly numberContractViolations: number;
  readonly lastRealSignalMs: number;
}

export interface NativeStatus {
  readonly tapInstalled: boolean;
  readonly tapEnabled: boolean;
  readonly keyboardBitsGranted: boolean;
  /** Hex string, never a BigInt: BigInt is not JSON-serialisable and dies in IPC logs. */
  readonly grantedMask: string;
  readonly cameraInUse: boolean;
  readonly micInUse: boolean;
  readonly probedAtMs: number;
  readonly counters: NativeCountersSnapshot;
}

export interface Permissions {
  readonly listenEvent: boolean;
  readonly postEvent: boolean;
  readonly axTrusted: boolean;
}

export interface SelfTestCheck { readonly name: string; readonly ok: boolean; readonly detail: string }
export interface SelfTestReport { readonly ok: boolean; readonly checks: readonly SelfTestCheck[] }

/**
 * The whole macOS surface, in one interface.
 *
 * Note what is NOT here: no timers. main owns the single 5-minute watchdog and
 * the jiggler's 30-second interval, and calls probe()/jiggle(). A source that
 * owned its own timers could not be driven deterministically from a test.
 */
export interface SignalSource {
  /** Install the tap and take the first level readings. Throws loudly on a fatal. */
  start(sink: SignalSink): Promise<NativeStatus>;
  /** Idempotent teardown. Safe to call twice, safe to call before start(). */
  stop(): void;
  /**
   * The read-only watchdog probe. Reads three integers, re-anchors the clock,
   * emits camera/mic edges through the sink, and POSTS NOTHING. There is no
   * side-effect-free active liveness probe — even a null canary resets the idle
   * clock — so this must stay passive.
   */
  probe(): NativeStatus;
  /** Full teardown + rebuild after a tap death. Caller logs the tap_lost row. */
  restart(): NativeStatus;
  /** Post one stamped null event. False (and nothing posted) without Accessibility. */
  jiggle(): boolean;
  /** One power assertion, or release it. Idempotent. Never a work signal. */
  setKeepAwake(on: boolean): void;
  permissions(): Permissions;
  requestPermissions(opts: { prompt: boolean }): Permissions;
  selfTest(): Promise<SelfTestReport>;
}
```

`src/main/runtime.ts` maps `RawSignal` onto whatever `src/core/` calls its input — including the mic's 60-second floor, which is a product rule and lives nowhere near this directory. (It was once a conjunction with a running meeting app; that half was removed, PRD §3.5.) **If core names a signal differently, core wins, and the rename happens at that boundary — never inside `native.ts`.**

### The real implementation

```ts
// src/native/mac-source.ts
import * as native from './native.js';
import { levelEdge, LEVEL_OFF, type LevelState } from './levels.js';
import type { NativeStatus, Permissions, SelfTestReport, SignalSink, SignalSource } from './types.js';

export class MacSignalSource implements SignalSource {
  private sink: SignalSink = () => {};
  private started = false;
  private camera: LevelState = LEVEL_OFF;
  private mic: LevelState = LEVEL_OFF;

  async start(sink: SignalSink): Promise<NativeStatus> {
    this.sink = sink;
    native.installTap(sink);
    this.started = true;
    return this.probe();
  }

  stop(): void {
    if (!this.started) return;
    native.removeTap();
    native.releaseJiggleSource();
    native.setKeepAwake(false);
    this.started = false;
  }

  probe(): NativeStatus {
    const at = Date.now();
    native.reanchorClock();
    const cameraOn = native.anyCameraInUse();
    const micOn = native.anyMicInUse();

    const cam = levelEdge(this.camera, cameraOn, at, 'camera_on', 'camera_off');
    this.camera = cam.next;
    if (cam.signal) this.sink(cam.signal);

    const m = levelEdge(this.mic, micOn, at, 'mic_on', 'mic_off');
    this.mic = m.next;
    if (m.signal) this.sink(m.signal);

    const mask = native.grantedMask();
    return {
      tapInstalled: this.started,
      tapEnabled: native.isTapEnabled(),
      keyboardBitsGranted: native.keyboardBitsGranted(),
      grantedMask: mask === null ? '-' : `0x${mask.toString(16)}`,
      cameraInUse: cameraOn,
      micInUse: micOn,
      probedAtMs: at,
      counters: { ...native.counters },
    };
  }

  restart(): NativeStatus { native.restartTap(this.sink); return this.probe(); }
  jiggle(): boolean { return native.postJiggle(); }
  setKeepAwake(on: boolean): void { native.setKeepAwake(on); }
  permissions(): Permissions { return native.permissions(); }
  requestPermissions(o: { prompt: boolean }): Permissions { return native.requestPermissions(o); }
  selfTest(): Promise<SelfTestReport> { return native.selfTest(); }
}
```

### The fake

No koffi, no timers, no `Date.now()` unless you hand it one. Everything the real Mac would do to you — a stripped mask, a dead tap, a revoked permission — is a one-line method call.

```ts
// src/native/fake-source.ts
import { levelEdge, LEVEL_OFF, type LevelState } from './levels.js';
import type {
  NativeStatus, Permissions, SelfTestReport, SignalSink, SignalSource,
} from './types.js';

export class FakeSignalSource implements SignalSource {
  private sink: SignalSink = () => {};
  private started = false;
  private camera: LevelState = LEVEL_OFF;
  private mic: LevelState = LEVEL_OFF;

  // ── knobs a test turns ──────────────────────────────────────────────────
  cameraOn = false;
  micOn = false;
  tapEnabled = true;
  keyboardBits = true;
  perms: Permissions = { listenEvent: true, postEvent: true, axTrusted: true };
  /** Every jiggle that was posted, as epoch ms. Assert on length, not on side effects. */
  readonly jiggles: number[] = [];
  keepAwake = false;
  restarts = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async start(sink: SignalSink): Promise<NativeStatus> {
    this.sink = sink; this.started = true; return this.probe();
  }
  stop(): void { this.started = false; this.keepAwake = false; }

  probe(): NativeStatus {
    const at = this.now();
    const c = levelEdge(this.camera, this.cameraOn, at, 'camera_on', 'camera_off');
    this.camera = c.next; if (c.signal) this.sink(c.signal);
    const m = levelEdge(this.mic, this.micOn, at, 'mic_on', 'mic_off');
    this.mic = m.next; if (m.signal) this.sink(m.signal);
    return {
      tapInstalled: this.started,
      tapEnabled: this.started && this.tapEnabled,
      keyboardBitsGranted: this.keyboardBits,
      grantedMask: this.keyboardBits ? '0xfc01cfe' : '0xfc000fe',
      cameraInUse: this.cameraOn, micInUse: this.micOn, probedAtMs: at,
      counters: {
        realEvents: this.realEvents, ourEvents: this.jiggles.length,
        disableNotices: 0, lastDisableType: 0, callbackErrors: 0, lastCallbackError: '',
        inlineDrains: 0, numberContractViolations: 0, lastRealSignalMs: this.lastRealSignalMs,
      },
    };
  }

  restart(): NativeStatus { this.restarts++; this.tapEnabled = true; return this.probe(); }
  jiggle(): boolean {
    if (!this.perms.postEvent && !this.perms.axTrusted) return false;  // silent-failure parity
    this.jiggles.push(this.now());
    return true;                                                       // and NO signal is emitted
  }
  setKeepAwake(on: boolean): void { this.keepAwake = on; }
  permissions(): Permissions { return this.perms; }
  requestPermissions(): Permissions { return this.perms; }
  async selfTest(): Promise<SelfTestReport> {
    return { ok: true, checks: [{ name: 'fake', ok: true, detail: 'no native calls' }] };
  }

  // ── the test driver ─────────────────────────────────────────────────────
  private realEvents = 0;
  private lastRealSignalMs = 0;
  key(atMs: number, count = 1): void { this.emit({ kind: 'key', atMs, count }); }
  mouse(atMs: number, count = 1): void { this.emit({ kind: 'mouse', atMs, count }); }
  /** Play a whole day in one call: [[epochMs, 'key'], …]. */
  script(events: ReadonlyArray<[number, 'key' | 'mouse']>): void {
    for (const [atMs, kind] of events) this.emit({ kind, atMs, count: 1 });
  }
  private emit(s: { kind: 'key' | 'mouse'; atMs: number; count: number }): void {
    this.realEvents += s.count;
    if (s.atMs > this.lastRealSignalMs) this.lastRealSignalMs = s.atMs;
    this.sink(s);
  }
  /** macOS killed the tap. Nothing is emitted — that is the whole point. */
  killTap(): void { this.tapEnabled = false; }
  /** Input Monitoring revoked: the tap lives, the keyboard bits are gone. */
  stripKeyboardBits(): void { this.keyboardBits = false; }
}
```

### The factory

```ts
// src/native/index.ts
import type { SignalSource } from './types.js';
export * from './types.js';

export interface SourceOptions {
  /** Pass app.isPackaged. A packaged build can never be faked, whatever the env says. */
  readonly isPackaged: boolean;
}

export async function createSignalSource(opts: SourceOptions): Promise<SignalSource> {
  const wantsFake = process.env.WWB_FAKE_NATIVE === '1' || process.env.NODE_ENV === 'test';
  if (wantsFake && !opts.isPackaged) {
    const { FakeSignalSource } = await import('./fake-source.js');
    console.warn('[native] FAKE signal source — no real input is being measured');
    return new FakeSignalSource();
  }
  // Dynamic: importing native.ts on a non-Mac throws at module scope, by design.
  const { MacSignalSource } = await import('./mac-source.js');
  return new MacSignalSource();
}
```

---

## 14. "Did not compile / segfaulted" triage

Symptom first, because that is what you will have.

| Symptom | Cause | Fix |
|---|---|---|
| `Error: Cannot find symbol 'CGEventTapCrate'` at import | Typo in a **name**. koffi validates names, never signatures. | Fix the spelling. This is the good failure. |
| `dlopen failed` at import | Wrong framework path, or you "corrected" a path because `ls` said it was missing | Paths live in the dyld shared cache. Use the §1 strings exactly. |
| Crash (`EXC_BAD_ACCESS`) on the **first keystroke**, none at startup | Callback arity or order wrong. It is `(proxy, type, event, userInfo)` — four args, event **third**. | Restore the proto in §3. |
| `Error: Cannot call transient callback` or a crash minutes in | Passed a bare JS function to `CGEventTapCreate` instead of `koffi.register(fn, koffi.pointer(Proto))` | Registered callbacks only. Transients die when the C call returns. |
| Crash on shutdown, or on the first event after "stop" | `koffi.unregister` called before the source was removed and the port released | Teardown order in §7. |
| **Zero events, `CGEventTapIsEnabled` returns true, nothing logged** | Source added only to `kCFRunLoopCommonModes`; **or** a mode symbol used without `koffi.decode` (you passed `&variable`) | Both modes; decode CFString symbols. The `CFRunLoopContainsSource` assertion catches it at boot. |
| Zero events, tap reports enabled, **and** the app is packaged | Different TCC subject: dev grants belong to Electron's own bundle | Grant the packaged app at `/Applications/Work Week Buddy.app`. Expect this exactly once. |
| Keyboard silent, mouse fine, hours slightly low forever | Keyboard bits stripped from the granted mask | `keyboardBitsGranted()` → red banner. Never infer from `CGEventTapCreate` returning non-NULL. |
| Modifier-only presses invisible | `kCGEventFlagsChanged` (12) missing from the mask | `EVENT_MASK` assertion in the self-test. |
| Mask looks like `0x1` or an absurd 64-bit value | `CGEventMask` declared `uint32_t`, or built with JS `<<` (`1 << 32 === 1`) | `uint64_t` in the prototype, `BigInt` in the arithmetic. |
| `eventsOfInterest` reads garbage from `CGGetEventTapList` | `CGEventTapInformation` members reordered, or `enabled` declared `int` instead of `bool` | `koffi.sizeof(...) === 48` assertion. Keep the §2 order. |
| **24-hour workdays, no error anywhere** | The jiggle is classified as human input — the field compared against a BigInt literal, or field 45 used as the discriminator | `WWB_MAGIC` is a Number; `isOurs` uses 41 + 42 only; self-test proves the round trip. |
| Jiggler "works" but the tap never sees our events | Posted to a different location than the tap listens at | One `TAP_LOCATION` constant, used by create and post. |
| Toggle says on, display still sleeps, cursor delta 0, no error | `CGEventPost` without Accessibility — it fails **silently** | `postJiggle()` returns false; the UI must show that, not the toggle state. |
| Crash inside `CFDictionaryCreate` | `kCFTypeDictionaryKeyCallBacks` decoded instead of used as an address | Struct symbols: address direct. CFString symbols: decode. |
| Crash in `CMIOObjectGetPropertyData` / `AudioObjectGetPropertyData` | The two are **not symmetric** — CMIO takes 7 args (dataSize in, dataUsed out), CoreAudio takes 6 (one INOUT) | Copy §3 exactly; do not mirror one from the other. |
| `IOPMAssertionCreateWithName` crashes or returns garbage | A Number passed where the `IOPMAssertionID *` out-param belongs | Pass `[null]` and read `[0]`, per `_Out_`. |
| Camera never reports in use, on a machine with a camera | App Sandbox is on — the CMIO device list returns **zero devices** | Never sandbox. Not fixable any other way. |
| Timestamps ~41× off, or intervals wildly long | `CGEventGetTimestamp` treated as mach ticks, or the anchor never taken | The "within 2 s of wall clock" self-test check. |
| `TypeError: Cannot mix BigInt and other types` at ~104 days uptime | A 64-bit read assumed to be a Number | Every 64-bit read goes through the `number \| bigint` normaliser. |
| `TypeError: Do not know how to serialize a BigInt` in a log or IPC | A pointer or mask escaped this file | Masks cross as hex strings. Pointers never cross at all. |
| `Error: Too many callbacks` after a few hours | `koffi.register` called on each tap restart without `unregister` | `removeTap()` unregisters. Restart = full teardown + rebuild. |
| Tap dies after a slow operation, comes back on its own | `kCGEventTapDisabledByTimeout` handled correctly | Working as designed. Watch `counters.disableNotices` — a rising count means the callback is doing too much. |

---

## 15. Deliberately not declared

Adding any of these is a spec violation, not an improvement.

| Not declared | Why |
|---|---|
| `CGEventSourceSecondsSinceLastEventType` | Reset by our own jiggler at every tap location — sawtooths 0.06 → 4.25 → 0.06 s while the user is idle. ESLint-banned along with `powerMonitor.getSystemIdleTime()`. |
| `CGEventSourceStatePrivate` anywhere | Blocks forever on macOS 26.5.1. |
| `CMIOObjectAddPropertyListener`, `AudioObjectAddPropertyListener` | Delivered on a HAL thread → a koffi callback off the JS thread. Never observed firing anyway. §9. |
| `CFRunLoopRun`, `CFRunLoopRunInMode` | Electron's pump owns the main run loop. Calling these hangs the app. Only a plain-Node build would need them. |
| `CGEventCreateKeyboardEvent`, `CGEventSetIntegerValueField` | We synthesize exactly one event type — `kCGEventNull` — and never keystrokes. |
| `IORegistryEntry*` | `machine_id` is `IOPlatformUUID` read via `ioreg` in `src/main/machine.ts`. Zero permissions, zero FFI. |
| `CGWindowListCopyWindowInfo`, `NSWorkspace` frontmost-app APIs, any running-application enumeration | NON_GOALS #8. No window, app or URL tracking. There is no longer a meeting-app check anywhere either — the mic counts on its own, so nothing in this app asks what is running. |

---

## 16. Packaging notes that break `native.ts` and nothing else

Two lines of config, both of which produce "works in dev, dead when packaged":

- **`koffi` must be externalized, not bundled.** electron-vite's `externalizeDepsPlugin()` handles it; if `koffi` ends up inside the main bundle, its Node-API binary is not found at runtime.
- **`koffi` must be unpacked from the asar.** In `electron-builder.yml`: `asarUnpack: ["**/node_modules/koffi/**"]`. `dlopen` cannot open a `.node` inside an asar archive.

And one that is not config: the app must run as a **GUI-session app**. Any `CGEventSource*` call from a LaunchDaemon hangs forever with no WindowServer connection. LaunchAgent only.