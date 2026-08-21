# IMPL_LAYOUT — repo layout, configs, and module boundaries

**Task 1.1.** Everything else depends on this landing first and being right.

The versions below are pinned deliberately. Two of them are not conservatism — Vite 7 and Node 22.14.0 are both hard requirements with known failures above and below. See §3.

---

## 1. The tree

```
work-week-buddy/
├── .nvmrc                          22.14.0
├── package.json
├── tsconfig.json                   strict, project references off, paths for @/
├── electron.vite.config.ts         three builds: main, preload, renderer
├── vitest.config.ts
├── eslint.config.js                flat config; the guardrails live here
├── electron-builder.yml
├── .github/workflows/ci.yml        already committed
│
├── src/
│   ├── core/                       ← PURE. No electron, no node builtins, no clock.
│   │   ├── types.ts                Signal, TrackerState, Interval, Effect, Config
│   │   ├── reduce.ts               the reducer. The whole product is in here.
│   │   ├── levels.ts               camera/mic level → edge conversion
│   │   ├── metrics.ts              pure helpers: union-merge, formatting
│   │   └── index.ts
│   │
│   ├── native/                     ← the only place koffi is imported
│   │   ├── ffi.ts                  every koffi declaration, one file (IMPL_NATIVE §3)
│   │   ├── constants.ts            event types, field ids, masks, the magic number
│   │   ├── tap.ts                  event tap lifecycle + callback
│   │   ├── jiggler.ts              stamped null-event posting
│   │   ├── media.ts                camera + microphone in-use reads
│   │   ├── power.ts                IOPMAssertion keep-awake
│   │   ├── permissions.ts          preflight/request, mask assertion
│   │   ├── selftest.ts             the boot self-test
│   │   ├── source.ts               SignalSource interface + factory
│   │   ├── fake.ts                 the fake SignalSource — tests use this
│   │   └── index.ts
│   │
│   ├── store/                      ← node:sqlite. No electron imports.
│   │   ├── db.ts                   open, pragmas, schema
│   │   ├── intervals.ts            write/read closed intervals
│   │   ├── journal.ts              the single-row open-interval journal
│   │   ├── queries.ts              the six metric queries, typed
│   │   ├── sync-state.ts           watermark, last_cloud_write_ms
│   │   └── index.ts
│   │
│   ├── sync/
│   │   ├── client.ts               Worker HTTP client
│   │   ├── flush.ts                outbox drain, presence-keyed
│   │   ├── pull.ts                 watermark with the 200-row overlap
│   │   ├── fingerprint.ts          weekly reconciliation
│   │   ├── backup.ts               weekly self-export
│   │   └── index.ts
│   │
│   ├── main/
│   │   ├── index.ts                boot order, lifecycle
│   │   ├── runtime.ts              wires SignalSource + store + reducer together
│   │   ├── deadline.ts             the single lazy timer
│   │   ├── watchdog.ts             the 5-minute read-only sanity tick
│   │   ├── tray.ts                 NSStatusItem, title driven from here
│   │   ├── ipc.ts                  handlers
│   │   ├── windows.ts              dashboard window, destroy on close
│   │   ├── protocol.ts             app:// + CSP
│   │   ├── autostart.ts            LaunchAgent
│   │   ├── settings.ts
│   │   ├── onboarding.ts           the two permission panes
│   │   └── cli.ts                  --selftest, --doctor, --rebuild
│   │
│   ├── preload/index.ts            contextBridge only
│   ├── renderer/                   React. Never touches the DB.
│   │   ├── main.tsx
│   │   ├── App.tsx                 ported from design/App.reference.tsx
│   │   ├── index.css               copied from design/index.css, verbatim
│   │   ├── lib/theme-provider.tsx  copied from design/, verbatim
│   │   ├── lib/ipc.ts              typed client over the preload bridge
│   │   └── components/ui/          shadcn output
│   │
│   └── shared/
│       ├── ipc-types.ts            the contract both sides import
│       └── constants.ts            timeouts, bundle id, magic number
│
├── worker/
│   ├── src/index.ts                the four routes
│   ├── wrangler.toml
│   └── test/fake-d1.ts             node:sqlite-backed D1 double
│
├── scripts/
│   ├── make-signing-cert.sh
│   ├── install.sh
│   ├── launch-agent.sh
│   ├── bringup-cloud.sh            everything after `npx wrangler login`
│   └── doctor.ts
│
├── spike/run-m0.sh                 already committed
├── design/                         already committed — the acceptance target
└── docs/                           the spec and this plan
```

### What must NOT be in each place

| Directory | Must not contain |
|---|---|
| `src/core/` | any `import` from `electron`, `node:*`, `koffi`, or the store. Any call to `Date.now()`. Any I/O. |
| `src/native/` | product logic. It converts OS facts into `Signal`s and nothing else. |
| `src/store/` | electron imports, or policy. Policy lives in the `v_countable` view. |
| `src/renderer/` | direct DB access, `node:*`, or `require`. It talks over IPC only. |
| `src/main/` | the interval rules. It calls `reduce()`; it does not reimplement it. |

---

## 2. Module boundaries, enforced

Rules that are only written down get broken. These are lint errors.

`eslint.config.js`:

> **The trap that cost a test run.** Flat config merges `rules` with later-wins
> **per rule name**, not per entry. A later block that redefines
> `no-restricted-properties` therefore replaces *every* earlier entry for the
> files it matches — so a core-only `Date.now` restriction is silently dropped
> the moment a broader block sets the same rule. Share the entries in a
> constant and order the narrowest block last. The guardrail tests in §2 catch
> this; they caught it here.

```js
import js from "@eslint/js";
import ts from "typescript-eslint";
import globals from "globals";

// ESLint flat config merges `rules` with later-wins PER RULE NAME, not per
// entry. So any block that redefines no-restricted-properties replaces every
// earlier entry for the files it matches. Share the list rather than repeat it.
const POLLUTED_APIS = [
  { object: "powerMonitor", property: "getSystemIdleTime",
    message: "Polluted by CGEventPost. Use lastRealSignalMs." },
  { object: "powerMonitor", property: "getSystemIdleState",
    message: "Polluted by CGEventPost. Use lastRealSignalMs." },
];

const NO_CLOCK = {
  object: "Date", property: "now",
  message: "src/core/ takes nowMs as a parameter. Never read the clock.",
};

export default ts.config(
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    languageOptions: {
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
      globals: { ...globals.node },
    },
  },

  // ── The polluted-API rule. AGENTS.md #7. These are reset by our own jiggler,
  //    so a tracker built on them reports 24-hour workdays, silently.
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    rules: {
      "no-restricted-properties": ["error", ...POLLUTED_APIS],
      "no-restricted-syntax": ["error", {
        selector: "CallExpression[callee.name='CGEventSourceSecondsSinceLastEventType']",
        message: "Reset by our own jiggler at every tap location. Use the per-event-type counters or lastRealSignalMs.",
      }],
    },
  },

  // ── Purity. src/core/ is a pure reducer over timestamps-as-data, which is
  //    why its tests run on Linux in CI and why a 15-minute test is arithmetic
  //    rather than a 15-minute wait.
  {
    files: ["src/core/**/*.ts"],
    ignores: ["src/core/**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "electron", message: "src/core/ must stay pure. Pass what you need in as a parameter." },
          { name: "koffi", message: "src/core/ must stay pure." },
        ],
        patterns: [
          { group: ["node:*"], message: "src/core/ must stay pure — no node builtins." },
          { group: ["../native/*", "../store/*", "../main/*", "@/native/*", "@/store/*", "@/main/*"],
            message: "src/core/ may not depend on any impure layer." },
        ],
      }],
      // Time is a parameter, never ambient. A reducer that reads the clock
      // cannot be tested for the sleep/wake cases, which is where the bugs are.
      // POLLUTED_APIS is repeated here because this block matches src/core/
      // and would otherwise replace the general block's entries entirely.
      "no-restricted-properties": ["error", NO_CLOCK, ...POLLUTED_APIS],
    },
  },

  // ── The renderer may not reach the machine.
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{ name: "electron", message: "The renderer talks over IPC. See src/shared/ipc-types.ts." }],
        patterns: [
          { group: ["node:*"], message: "The renderer has no node access." },
          { group: ["@/store/*", "@/native/*", "@/main/*", "@/core/*"],
            message: "The renderer talks over IPC only." },
        ],
      }],
    },
  },

  { ignores: ["dist/**", "out/**", "release/**", "node_modules/**", "design/**", "docs/**", "spike/**", "src/renderer/components/ui/**"] },
);
```

**Prove the guardrails fire.** A rule nobody tested is a comment. `test/guardrails.test.ts` lints two fixtures and asserts each is rejected:

```ts
import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";

const lintText = async (code: string, filePath: string) => {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [res] = await eslint.lintText(code, { filePath });
  return res.messages.map((m) => m.message).join("\n");
};

describe("guardrails", () => {
  it("rejects electron imports from src/core/", async () => {
    const out = await lintText(`import { app } from "electron";\nexport const x = app;\n`,
      "src/core/__fixture__.ts");
    expect(out).toMatch(/must stay pure/);
  });

  it("rejects Date.now() in src/core/", async () => {
    const out = await lintText(`export const t = () => Date.now();\n`, "src/core/__fixture__.ts");
    expect(out).toMatch(/nowMs as a parameter/);
  });

  it("rejects powerMonitor.getSystemIdleTime anywhere", async () => {
    const out = await lintText(
      `import { powerMonitor } from "electron";\nexport const t = () => powerMonitor.getSystemIdleTime();\n`,
      "src/main/__fixture__.ts");
    expect(out).toMatch(/Polluted by CGEventPost/);
  });
});
```

---

## 3. `package.json`

```json
{
  "name": "work-week-buddy",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./out/main/index.js",
  "engines": { "node": ">=22.14.0 <23" },
  "scripts": {
    "dev": "electron-vite dev",
    "build": "npm run typecheck && electron-vite build",
    "package": "npm run build && electron-builder --mac --dir",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:native": "vitest run --dir src/native --passWithNoTests",
    "selftest": "electron-vite build && electron . --selftest",
    "doctor": "tsx scripts/doctor.ts"
  },
  "dependencies": {
    "koffi": "3.1.5"
  },
  "devDependencies": {
    "@eslint/js": "^9.20.0",
    "@fontsource-variable/inter": "5.3.0",
    "@types/node": "^22.14.0",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "5.2.0",
    "electron": "43.4.1",
    "electron-builder": "26.15.3",
    "electron-vite": "5.0.0",
    "eslint": "^9.20.0",
    "fast-check": "^4.1.1",
    "globals": "^16.0.0",
    "lucide-react": "^1.33.0",
    "react": "19.2.8",
    "react-activity-calendar": "3.2.1",
    "react-dom": "19.2.8",
    "recharts": "3.10.1",
    "tailwindcss": "4.3.3",
    "@tailwindcss/vite": "4.3.3",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.24.0",
    "vite": "7.3.6",
    "vitest": "4.1.11"
  }
}
```

**Every Electron invocation is `electron .`, never `electron out/main/index.js`.**
With a script path, `app.getAppPath()` resolves to `out/main/` and
`preloadPath()` looks for `out/main/out/preload/index.js` — the preload never
loads, `window.wwb` is `undefined`, and every window renders empty (§8 and
`docs/IMPL_UI.md` §1.10). `electron .` reads `main` from `package.json` and puts
`getAppPath()` at the project root, which is where the packaged app has it. This
bit `smoke`, and `selftest` had the same form: harmless only because a self-test
opens no window, which is luck rather than correctness — `scripts/install.sh`
hard-gates on `--selftest`.

**Two pins that are requirements, not preferences:**

| Pin | Why |
|---|---|
| `vite` **7.3.6** | `electron-vite@5`'s peer range is `^5 \|\| ^6 \|\| ^7`. Vite 8 is released and will resolve by default. It does not work here. |
| `@vitejs/plugin-react` **5.2.0** | v6 requires Vite **8**, which electron-vite 5 does not accept — `npm install` fails outright with ERESOLVE. 5.2.0 peers `^4 \|\| ^5 \|\| ^6 \|\| ^7 \|\| ^8`, so it spans both and survives a later Vite 8 move. |
| Node **22.14.0** | The machine default is 22.1.0, recorded on this host as breaking stdio ESM and hanging the vitest forks pool. Electron embeds its own Node 24; koffi is Node-API so ABI is irrelevant — this pin is for tooling only. |

**Not present, deliberately:** `better-sqlite3` and `electron-rebuild` (superseded by `node:sqlite`), `ffi-napi` (dead since 2021), `uiohook-napi` (its payload has no source pid or userData, so it structurally cannot tell our jiggle from a human).

`.nvmrc`:

```
22.14.0
```

---

## 4. `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["node", "vitest/globals"],
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src", "worker", "scripts", "test", "*.config.ts"],
  "exclude": ["node_modules", "dist", "out", "design"]
}
```

`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on because the reducer is a discriminated union over optional timestamps, and those two rules are what stop `undefined` leaking into a comparison that then silently reads as "no signal."

---

## 5. `electron.vite.config.ts`

```ts
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@": resolve("src") } },
    build: {
      rollupOptions: {
        // koffi loads a prebuilt .node at runtime. It must never be bundled.
        external: ["koffi", "node:sqlite"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@": resolve("src") } },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": resolve("src") } },
    build: {
      rollupOptions: { input: resolve("src/renderer/index.html") },
    },
  },
});
```

---

## 6. `vitest.config.ts`

```ts
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: { alias: { "@": resolve("src") } },
  test: {
    globals: true,
    environment: "node",
    // The forks pool hangs on Node 22.1.0. The .nvmrc pin is the real fix;
    // this is belt-and-braces so a wrong-Node run fails loudly instead of hanging.
    pool: "threads",
    include: ["src/**/*.test.ts", "test/**/*.test.ts", "worker/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/core/**", "src/store/**", "src/sync/**", "worker/src/**"],
      // src/core/ is pure with no I/O. There is no excuse for gaps in it.
      thresholds: { "src/core/**": { statements: 100, branches: 95, functions: 100, lines: 100 } },
    },
  },
});
```

---

## 7. `electron-builder.yml`

The file in the repo is the source of truth and carries the long-form reasoning
inline. What follows is the shape of it and the three keys that are easy to get
wrong.

```yaml
appId: com.bpotter.workweekbuddy
productName: Work Week Buddy
directories:
  output: release
files:
  - out/**
  - package.json
  - "!**/*.map"
mac:
  target:
    - target: dir          # a bare .app. No dmg, no installer ceremony.
      arch: [arm64]
  category: public.app-category.productivity
  # LSUIElement: menu-bar only, no Dock icon, no app switcher entry.
  extendInfo:
    LSUIElement: 1
  identity: null           # skip signing here; scripts/install.sh signs. See below.
  hardenedRuntime: false
  notarize: false
asar: true
asarUnpack:
  # koffi ships a prebuilt binary that must exist on disk to be dlopen'd.
  - "**/node_modules/koffi/**"
```

**`identity: null` does not mean ad-hoc.** In electron-builder 26 the three
values are distinct, and the distinction is the whole reason the grants stick:

| Value | What electron-builder does |
|---|---|
| unset | search the keychain; sign if a certificate is found, skip if not |
| `null` | skip signing entirely — `MacTargetHelper.handleNullIdentity()`, logged as *"skipped macOS code signing"* |
| `"-"` | ad-hoc sign, explicitly |

We use `null`, so `npm run package` emits a bundle carrying only the ad-hoc,
linker-signed signature that Electron's own prebuilt binary shipped with —
`codesign -dv` reports `Identifier=Electron`, `Signature=adhoc`,
`Sealed Resources=none`. That signature has no stable designated requirement, so
a bundle run straight out of `release/` loses its Input Monitoring and
Accessibility grants on **every rebuild**. `scripts/install.sh` is what gives the
bundle its real identity, re-signing with the `WWB Local Signing` leaf. Signing
here instead would make `npm run package` fail on a fresh clone that has no
certificate yet, which is exactly the path a first install has to walk.

**`hardenedRuntime` and `notarize` are inert while `identity` is null** — the
signing path returns before either is read — but both are the settings that must
hold if signing ever moves back into electron-builder, so deleting them would be
a regression rather than a tidy-up.

- `hardenedRuntime: false` — under the hardened runtime, library validation
  rejects Electron's pre-signed frameworks when the app is re-signed with a leaf
  carrying a different (here: no) Team ID. This is **not** the App Sandbox. That
  is an entitlement, is never declared anywhere in this repo, and must stay that
  way: under it the CoreMediaIO device list returns zero devices and camera
  detection dies silently (`docs/MACOS.md` §4).
- `notarize: false` — there is no Apple Developer account and no distribution.
  The app is built on the machine that runs it, so Gatekeeper never engages.

**`gatekeeperAssert` is not a key.** An earlier draft of this section listed it.
electron-builder validates `electron-builder.yml` against a schema with
`additionalProperties: false`, so the typo aborted `npm run package` outright.
The real key is `gatekeeperAssess`, it defaults to `false`, and `false` is what
was wanted — so nothing replaces it and the correct fix is deletion.

**`files` does not have to name `node_modules`.** Production dependencies are
copied regardless; `asarUnpack` then pulls `koffi` and its
`@koromix/koffi-darwin-arm64` platform package back out of the archive into
`Contents/Resources/app.asar.unpacked/`, which is where `dlopen` can reach
`koffi.node`. Verified on the built bundle, not assumed.

---

## 8. `app://` and the CSP

Vite emits ESM. **Electron cannot load ESM over `file://`** — it fails with an opaque module error that reads like a bundler problem and is not one. Register a custom scheme instead.

`src/main/protocol.ts`:

```ts
import { app, protocol, net } from "electron";
import { pathToFileURL } from "node:url";
import { join, normalize } from "node:path";

const SCHEME = "app";

// Must be called BEFORE app.whenReady().
export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

export function serveRenderer(): void {
  const root = join(app.getAppPath(), "out", "renderer");
  protocol.handle(SCHEME, (request) => {
    const { pathname } = new URL(request.url);
    // Contain the path. A traversal here would serve arbitrary local files.
    const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
    const target = join(root, rel === "/" || rel === "" ? "index.html" : rel);
    if (!target.startsWith(root)) return new Response("forbidden", { status: 403 });
    return net.fetch(pathToFileURL(target).toString());
  });
}

// Recharts and @floating-ui both write inline styles at runtime, so
// style-src must allow 'unsafe-inline'. script-src does not, and must not.
export const CSP =
  "default-src 'none'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self' data:; " +
  "connect-src 'self'";
```

---

## 9. `scripts/`

The scripts themselves are the specification — they carry their reasoning inline
and `test/scripts/shell.test.ts` and `test/scripts/install-flow.test.ts` hold
them to it. Earlier revisions of this section inlined copies of them; the copies
drifted, and a drifted copy of an install script is worse than no copy. What is
recorded here is only what a reader has to know before opening them.

`docs/BRINGUP.md` is the ordered, copy-pasteable version for a human doing this
for real.

### `scripts/make-signing-cert.sh`

Run once, on the first Mac. On the second, import the same `wwb.p12` — **both
Macs must share one leaf certificate**, or their designated requirements differ
and grants do not transfer.

Three things in it are load-bearing and each was learned by the failure:

- **The PKCS#12 password must not be empty.** `security import -P ""` fails with
  *"MAC verification failed during PKCS12 import (wrong password?)"* for a `.p12`
  exported with `-passout pass:` — with or without `-legacy`, and with any
  `-macalg`. It reads exactly like a wrong password and is really an empty one.
  The script uses a fixed, non-secret passphrase, and says in-line why that is
  not a secret: the `.p12` protects a self-signed local code-signing leaf and
  travels through 1Password.
- **`-legacy` if and only if the `openssl` on `PATH` is OpenSSL 3.** OpenSSL 3's
  default PKCS#12 algorithms cannot be read by Security.framework, so it needs
  `-legacy`. macOS's own `/usr/bin/openssl` is **LibreSSL**, which already emits
  legacy algorithms and rejects the flag outright — a hard-coded `-legacy` makes
  the script fail on a Mac without Homebrew's openssl on `PATH`. The script
  reads `openssl version` and branches.
- **`-T /usr/bin/codesign`** pre-authorises codesign, so `install.sh` does not
  stop on a keychain prompt halfway through every build.

**Trust is NOT required.** This section used to claim the opposite, and it was
the most expensive wrong sentence in the repo: it added a GUI step that needs a
login password, cannot be scripted, has to be repeated on the second Mac, and
sends the reader hunting through Keychain Access for a certificate that
`find-identity -v` insists is not there.

Re-measured on macOS 26, against a leaf with **zero trust settings** in the
user, admin and system domains (`security dump-trust-settings` in each):

```
$ security find-identity -p codesigning          # all matching
  1) 6B69…F037 "WWB Local Signing" (CSSMERR_TP_NOT_TRUSTED)
$ security find-identity -v -p codesigning       # "valid" = the chain validates
     …the self-signed leaf is filtered out
$ codesign --force --sign 6B69…F037 App.app      # by hash
  App.app: replacing existing signature          → exit 0
$ codesign --force --sign "WWB Local Signing" …  # by common name
  → exit 0
$ codesign -d -r- App.app
  designated => identifier "com.bpotter.workweekbuddy"
                and certificate leaf = H"6b69…f037"
$ codesign --verify -R <that requirement> <a REBUILT App.app>
  App.app: explicit requirement satisfied        → exit 0
```

…and, decisively, `SecCodeCopyGuestWithAttributes(pid)` +
`SecCodeCheckValidity(code, [], requirement)` — the exact pair `tccd` runs
against a client process — returns `errSecSuccess` for a **live, rebuilt**,
untrusted-cert-signed process. Signing by SHA-1 is documented in `man codesign`:
*"If identity consists of exactly forty hexadecimal digits, it is instead
interpreted as the SHA-1 hash of the certificate part of the desired identity."*

The reason trust cannot matter is in the requirement itself: `certificate leaf =
H"…"` is a hash comparison with **no `anchor` clause**, so no chain is ever
built. Trust governs chain validation — Gatekeeper, `spctl`, and `-v`. Gatekeeper
is not involved either, because a locally built bundle has no
`com.apple.quarantine` attribute; `spctl` "rejects" the ad-hoc bundle that runs
fine today, which is the proof.

The earlier note recorded `codesign --sign "WWB Local Signing"` answering *"no
identity found"*, and read that as the symptom of an untrusted certificate. That
error is real, but trust is not what causes it — **the keychain search list is**.
Reproduced deliberately, with a throwaway leaf in a keychain that is not in the
search list:

```
$ security find-identity -p codesigning /tmp/scratch.keychain
  1) 90A1…919C "WWB Test Leaf" (CSSMERR_TP_NOT_TRUSTED)   ← present
$ codesign --keychain /tmp/scratch.keychain --sign 90A1…919C probe
  90A1…919C: no identity found                            ← and unusable
$ security list-keychains -d user -s /tmp/scratch.keychain <the login keychain>
$ codesign --keychain /tmp/scratch.keychain --sign 90A1…919C probe
  probe: replacing existing signature                     → exit 0
```

Nothing about trust changed between those last two commands. `--keychain` tells
codesign which keychain to *prefer*, not where it is allowed to look; a keychain
outside the search list is invisible to it. So "present in the keychain but
`no identity found`" means one of two things — the keychain is not in the search
list, or the `.p12` arrived without its private key — and **neither is fixed by
Always Trust**. `--show` distinguishes them by trying the operation.

What genuinely depended on trust was **this repo's own precondition check**:
`install.sh` gated on `find-identity -v`, which hides an identity whose chain
does not validate. The gate now resolves the identity without `-v` and then
signs a throwaway Mach-O and reads the requirement back — testing the operation
we care about instead of a proxy for it.

### `scripts/install.sh`

Order is the whole design:

```
node pin → npm ci → package → codesign → stop the LaunchAgent → replace
/Applications → SELF-TEST (hard gate) → doctor (advisory) → LaunchAgent
```

- The bundle always lands at exactly `/Applications/Work Week Buddy.app`. A TCC
  grant binds to (bundle id + designated requirement + on-disk path), so a
  bundle run from `~/Downloads` or from `release/` has no permissions and tracks
  nothing — silently.
- `rm -rf` then `ditto`, never `cp -R` over an existing bundle: `cp` merges
  directories, so a stale file from the previous build survives into the new app.
- The LaunchAgent is booted out **before** the bundle is replaced. `KeepAlive`
  would otherwise relaunch the app from a half-copied bundle.
- The self-test is a **hard gate**. If it fails, the app cannot tell its own
  synthetic jiggle from human input, and hours inflate with fake time without
  anything looking wrong.
- `doctor` is deliberately **not** a gate. On a first install the permissions
  have not been granted yet, so it is red by construction at that point;
  aborting on it would mean launch-at-login is never installed on precisely the
  run that needs it.

Every destination is overridable (`--dest`, `--app-src`, `--identity`,
`--plist-dir`, `--log-dir`, `--no-sign`, `--no-launchctl`) for one reason: so the
whole flow can be executed into `$TMPDIR` by a test. Nothing about the real
install path is optional, and the defaults are the real paths.

### `scripts/bringup-cloud.sh`

Everything after `npx wrangler login`, in one command: create the D1 database
(or adopt the existing one), apply `worker/schema.sql`, deploy the Worker, mint
the two per-machine tokens, and print what to paste into the app. Idempotent —
re-running it adopts rather than duplicates, and only rotates tokens when asked.
It never runs `wrangler login` itself: that is a browser OAuth flow against a
real, billable account, and it belongs to the human.

### `scripts/doctor.ts`

Prints one line per invariant, and exits non-zero if any is red. Checked: both
permission states, whether the tap is alive, the granted mask, the last
self-test result and date, last successful sync, fingerprint match, age of the
newest backup, and the local row count vs the cloud's.

---

## 10. `src/shared/constants.ts`

Every magic value in one place. Nothing here is a preference.

```ts
/** Stamped on our own synthetic events so the tap can identify and drop them.
 *  Read back from field 42. Two independent discriminators — this and our pid. */
export const WWB_MAGIC = 0x57574b31;

export const BUNDLE_ID = "com.bpotter.workweekbuddy";
export const APP_NAME = "Work Week Buddy";

/** Product defaults. All are settings rows; these are the initial values. */
export const DEFAULTS = {
  idleTimeoutMs: 15 * 60_000,
  minIntervalMs: 90_000,
  cameraOnlyMaxMs: 6 * 60 * 60_000,
  micMinCaptureMs: 60_000,
  jigglerIntervalMs: 30_000,
  watchdogMs: 5 * 60_000,
  trayRefreshMs: 60_000,
  weekStart: 1, // Monday
  /** PRD D1 = (a): time with our jiggler running does not count. */
  countJigglerTime: false,
  heatmapThresholdsH: [3, 6, 8],
} as const;
```

> `MEETING_APPS` and `MIC_IGNORE` used to live here — two bundle-id lists that told a call apart from dictation. Both are gone: the mic is a work signal on its own and there is no per-application rule left to seed. See PRD §3.5.

---

## 11. First-run acceptance

The scaffold is done when all of this passes:

```bash
nvm use && npm ci
npm run lint          # clean
npm run typecheck     # clean
npm run test          # green, and includes the three guardrail tests
npm run build         # builds
```

and `open release/mac-arm64/"Work Week Buddy".app` shows **a menu-bar icon and no Dock icon**.

The guardrail tests are not optional. Three of the thirteen traps in `AGENTS.md` are prevented by lint rules, and a lint rule nobody proved is a comment.
