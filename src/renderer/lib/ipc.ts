/**
 * The typed IPC client — `docs/IMPL_UI.md` §2.7.
 *
 * The renderer's ONLY route to the machine. There is no database handle here,
 * no `node:*` import, and no `electron` import; eslint enforces all three for
 * `src/renderer/**`.
 *
 * Two deliberate divergences from §2.7, both because the committed code wins:
 *
 * 1. §2.7 does `const wwb = window.wwb` at module scope. That captures the
 *    bridge at import time, so a preload that failed to load (the CJS/ESM trap
 *    in `docs/IMPL_UI.md` §1.10) blows up during module evaluation with
 *    "cannot read invoke" and the window renders white. `bridge()` reads it per
 *    call and throws a message that names the cause, which is also what makes
 *    the hooks testable against a stub.
 * 2. Every hook reports `error` alongside `data`. `T | null` cannot distinguish
 *    "not loaded yet" from "the call failed", and a failed call that renders as
 *    an empty dashboard is exactly the silent-zero this project treats as a
 *    defect (PRD §4).
 *
 * The 15-minute deadline is NOT scheduled from here. `LiveStatus.deadlineMs` is
 * display-only; a renderer timer collapses when the window is hidden
 * (`AGENTS.md` trap #10) and the countdown lives in main.
 */
import * as React from "react";

import {
  DEFAULT_METRICS_POLICY,
  type AppInfo,
  type CloudProbeRequest,
  type CloudProbeResult,
  type CloudRevokeRequest,
  type CloudRevokeResult,
  type CloudSetupProgress,
  type CloudSetupResult,
  type CloudSetupRunRequest,
  type DoctorReport,
  type FlushResult,
  type LiveStatus,
  type MetricsBundle,
  type MetricsPolicy,
  type PermissionKey,
  type PermissionSnapshot,
  type PushChannel,
  type PushContract,
  type SyncConfigState,
  type SyncTestResult,
  type ToggleChange,
  type Toggles,
  type UiSettings,
} from "@/shared/ipc-types";

/**
 * The bridge the preload exposes. `src/shared/window.d.ts` already declares
 * `window.wwb` globally, so this is an alias rather than a second declaration —
 * two declarations of the same global with different modifiers do not merge.
 */
export type WwbBridge = Window["wwb"];

/** Read per call, never captured at import time. See the header. */
function bridge(): WwbBridge {
  // Typed as always present, because in a healthy app it is. It is genuinely
  // `undefined` when the preload failed to load — the CJS/ESM trap — and that
  // is the case worth naming, since the symptom is otherwise a white window.
  const w = globalThis.window?.wwb as WwbBridge | undefined;
  if (!w) {
    throw new Error(
      "window.wwb is missing — the preload did not load. It must be built as CommonJS (docs/IMPL_UI.md §1.10).",
    );
  }
  return w;
}

export const ipc = {
  appInfo: () => bridge().invoke("wwb:app:info", undefined),
  status: () => bridge().invoke("wwb:status:get", undefined),
  metrics: (p: MetricsPolicy): Promise<MetricsBundle> => bridge().invoke("wwb:metrics:get", p),
  toggles: () => bridge().invoke("wwb:toggles:get", undefined),
  setToggle: (c: ToggleChange): Promise<Toggles> => bridge().invoke("wwb:toggles:set", c),
  permissions: (): Promise<PermissionSnapshot> =>
    bridge().invoke("wwb:permissions:get", undefined),
  refreshPermissions: (): Promise<PermissionSnapshot> =>
    bridge().invoke("wwb:permissions:refresh", undefined),
  requestPermission: (k: PermissionKey): Promise<PermissionSnapshot> =>
    bridge().invoke("wwb:permissions:request", k),
  openPrivacyPane: (k: PermissionKey): Promise<void> =>
    bridge().invoke("wwb:permissions:openSettings", k),
  relaunch: (): Promise<void> => bridge().invoke("wwb:permissions:relaunch", undefined),
  dismissOnboarding: (): Promise<void> => bridge().invoke("wwb:onboarding:dismiss", undefined),
  doctor: (): Promise<DoctorReport> => bridge().invoke("wwb:doctor:get", undefined),
  flush: (): Promise<FlushResult> => bridge().invoke("wwb:sync:flush", undefined),
  syncConfig: (): Promise<SyncConfigState> => bridge().invoke("wwb:sync:config", undefined),
  /**
   * WRITE-ONLY for the token, and the type says so: the answer is a
   * `SyncConfigState`, which carries `tokenPresent` and never a token. Nothing
   * in the renderer may keep the typed value past this call.
   */
  setSyncConfig: (patch: {
    workerUrl?: string;
    /** Sent with `workerUrl` to SWAP the two addresses. Never used to sync. */
    workerUrlAlt?: string;
    token?: string;
  }): Promise<SyncConfigState> => bridge().invoke("wwb:sync:setConfig", patch),
  /** Same one-way rule, and it stores nothing. Omitted halves use the stored ones. */
  testSyncConfig: (patch: { workerUrl?: string; token?: string }): Promise<SyncTestResult> =>
    bridge().invoke("wwb:sync:test", patch),
  /**
   * Look at a Cloudflare account, change nothing.
   *
   * The API token goes IN and has no way back: `CloudProbeResult` has no field
   * that could carry one. Nothing in the renderer may hold the typed value past
   * this call except the DOM node it was typed into.
   */
  probeCloud: (req: CloudProbeRequest): Promise<CloudProbeResult> =>
    bridge().invoke("wwb:cloud:probe", req),
  /** The whole bring-up. Progress arrives on `wwb:push:cloud-setup` meanwhile. */
  runCloudSetup: (req: CloudSetupRunRequest): Promise<CloudSetupResult> =>
    bridge().invoke("wwb:cloud:run", req),
  /** Stop one Mac syncing. Never rejects — the result carries the reason. */
  revokeMachine: (req: CloudRevokeRequest): Promise<CloudRevokeResult> =>
    bridge().invoke("wwb:cloud:revoke", req),
  /**
   * Open Cloudflare's API-token page in the real browser.
   *
   * Takes no argument: main owns the URL. A plain `<a href>` would NOT work —
   * `lockDownNavigation` preventDefaults any non-app origin on `will-navigate`,
   * so a link here is inert and this has to be a button.
   */
  openTokenPage: (): Promise<void> => bridge().invoke("wwb:cloud:openTokenPage", undefined),
  renameMachine: (label: string): Promise<AppInfo> =>
    bridge().invoke("wwb:machine:rename", { label }),
  settings: (): Promise<UiSettings> => bridge().invoke("wwb:settings:get", undefined),
  setSettings: (p: Partial<UiSettings>): Promise<UiSettings> =>
    bridge().invoke("wwb:settings:set", p),
  openDashboard: (): Promise<void> => bridge().invoke("wwb:window:openDashboard", undefined),
  openSettings: (): Promise<void> => bridge().invoke("wwb:window:openSettings", undefined),
  /** Open the cloud-setup wizard in its own window. */
  openCloudSetup: (): Promise<void> => bridge().invoke("wwb:window:openCloudSetup", undefined),
  /** Double-click on the title bar. See the channel's note in `ipc-types.ts`. */
  zoomWindow: (): Promise<void> => bridge().invoke("wwb:window:zoom", undefined),
} as const;

export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Subscribe for the lifetime of the component. Always returns its unsubscribe. */
function usePush<K extends PushChannel>(
  channel: K | null,
  cb: (p: PushContract[K]) => void,
): void {
  const ref = React.useRef(cb);
  ref.current = cb;
  React.useEffect(() => {
    if (channel === null) return;
    // The bridge may be absent (no preload); the snapshot call already reported
    // that, and throwing again here would take the whole tree down.
    try {
      return bridge().on(channel, (p) => ref.current(p));
    } catch {
      return;
    }
  }, [channel]);
}

export interface Query<T> {
  data: T | null;
  error: string | null;
  reload: () => void;
}

/**
 * Snapshot on mount, then whole-snapshot pushes. Never derives the next state
 * from the previous one — `docs/IMPL_UI.md` §2.1: every push is complete.
 */
function useSnapshot<T>(
  load: () => Promise<T>,
  channel: PushChannel | null,
  deps: readonly unknown[],
): Query<T> {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const loadRef = React.useRef(load);
  loadRef.current = load;

  const [nonce, setNonce] = React.useState(0);
  const reload = React.useCallback(() => setNonce((n) => n + 1), []);

  React.useEffect(() => {
    let cancelled = false;
    try {
      void loadRef.current().then(
        (v) => {
          if (cancelled) return;
          setData(v);
          setError(null);
        },
        (e: unknown) => {
          if (cancelled) return;
          setError(messageOf(e));
        },
      );
    } catch (e) {
      setError(messageOf(e));
    }
    return () => {
      cancelled = true;
    };
  }, [nonce, ...deps]);

  usePush(channel, (p) => {
    setData(p as T);
    setError(null);
  });

  return { data, error, reload };
}

export function useLiveStatus(): Query<LiveStatus> {
  return useSnapshot<LiveStatus>(() => ipc.status(), "wwb:push:status", []);
}

export function useAppInfo(): Query<AppInfo> {
  return useSnapshot<AppInfo>(() => ipc.appInfo(), null, []);
}

export function usePermissions(): Query<PermissionSnapshot> {
  return useSnapshot<PermissionSnapshot>(() => ipc.permissions(), "wwb:push:permissions", []);
}

/** The stored settings, so the pane can render what IS rather than a guess. */
export function useSettings(): Query<UiSettings> {
  return useSnapshot<UiSettings>(() => ipc.settings(), null, []);
}

/**
 * The sync configuration: a URL, whether a token exists, and why it is unusable
 * if it is. Never the token — `SyncConfigState` has no field for one.
 *
 * SUBSCRIBED, since the wizard moved into its own window. It used to be enough
 * to reload after `setSyncConfig`, because this window was the only thing that
 * could change the config. Now a different window can finish a setup, and this
 * card would otherwise sit there saying "not set up" for the rest of the
 * session. `SyncConfigGateway.write()` is the single funnel both paths already
 * pass through, so it pushes — which makes the manual Save path push too, and
 * the dashboard update without a reload.
 *
 * Rejected: re-reading on window focus. Fragile, and stale in the common case
 * where both windows are visible at once.
 */
export function useSyncConfig(): Query<SyncConfigState> {
  return useSnapshot<SyncConfigState>(() => ipc.syncConfig(), "wwb:push:sync-config", []);
}

/**
 * The doctor, on demand.
 *
 * `wwb:push:doctor` exists in the contract and nothing has ever sent one, so
 * this reloads explicitly rather than pretending to be live. Every number in it
 * is a snapshot with `generatedAtMs` attached; a pane that shows the timestamp
 * beside the numbers is honest about that, and one that implied it was live
 * would not be.
 */
export function useDoctor(): Query<DoctorReport> {
  return useSnapshot<DoctorReport>(() => ipc.doctor(), null, []);
}

/**
 * Cloud-setup progress, pushed a whole snapshot at a time.
 *
 * The setter comes back so the wizard can clear the list when a new run
 * starts — otherwise the previous run's ticks would still be on screen while
 * the first step of the next one is still in flight, which reads as progress
 * that has already happened.
 */
export function useCloudSetupProgress(): [
  CloudSetupProgress | null,
  (p: CloudSetupProgress | null) => void,
] {
  const [progress, setProgress] = React.useState<CloudSetupProgress | null>(null);
  usePush("wwb:push:cloud-setup", setProgress);
  return [progress, setProgress];
}

export interface TogglesQuery extends Query<Toggles> {
  setToggle: (key: ToggleChange["key"], value: boolean) => void;
}

export function useToggles(): TogglesQuery {
  const q = useSnapshot<Toggles>(() => ipc.toggles(), "wwb:push:toggles", []);
  const [local, setLocal] = React.useState<Toggles | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Optimistic, then authoritative: `setToggle` resolves only once the interval
  // boundary is durable (AGENTS.md: toggling the jiggler closes one interval and
  // opens another), so the resolved value is the truth and replaces the guess.
  const setToggle = React.useCallback(
    (key: ToggleChange["key"], value: boolean) => {
      setLocal((t) => (t ? { ...t, [key]: value } : t));
      ipc.setToggle({ key, value, source: "dashboard" }).then(
        (t) => {
          setLocal(t);
          setError(null);
        },
        (e: unknown) => setError(messageOf(e)),
      );
    },
    [],
  );

  React.useEffect(() => setLocal(q.data), [q.data]);

  return { data: local ?? q.data, error: error ?? q.error, reload: q.reload, setToggle };
}

/**
 * Metrics come from one round trip (`MetricsBundle`), refreshed when main says
 * they are stale. Main cannot push metrics itself: it does not know which
 * policy this window is displaying.
 */
export function useMetrics(policy: MetricsPolicy = DEFAULT_METRICS_POLICY): Query<MetricsBundle> {
  const key = JSON.stringify(policy);
  const q = useSnapshot<MetricsBundle>(
    () => ipc.metrics(JSON.parse(key) as MetricsPolicy),
    null,
    [key],
  );
  usePush("wwb:push:metrics-stale", q.reload);
  return q;
}

/**
 * 1 Hz display clock, armed only while an interval is open.
 *
 * Every consumer recomputes from ABSOLUTE epoch ms, so a collapsed timer (a
 * hidden renderer drops ticks — trap #10) costs a stale frame, never a wrong
 * number. Nothing is ever scheduled from `deadlineMs`.
 */
export function useNowMs(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}
