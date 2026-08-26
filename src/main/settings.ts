/**
 * Main-side settings — `docs/IMPL_UI.md` §1.8.
 *
 * A JSON file, NOT the renderer's `localStorage`. The renderer can be closed
 * for a week; the tray still needs to know whether the jiggler is on and what
 * the countable-hours policy is.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULTS } from "../shared/constants";
import type { SelfTestResult } from "../shared/ipc-types";

export interface MainSettings {
  machineId: string;
  machineLabel: string;
  /** 10–15, PRD §7. */
  idleTimeoutMin: number;
  jigglerPausePrompt: "ask" | "never";
  /** '#FFFFFF' | '#191919' — mirrored from the renderer so main can paint first. */
  windowBackground: string;
  onboardingDismissed: boolean;
  heatmapThresholdsH: [number, number, number];
  minIntervalS: number;
  countJigglerTime: 0 | 1;
  graceS: number;
  /**
   * The sync Worker's base URL. Empty until the owner deploys one, and empty is
   * the ordinary state — the app measures hours with no cloud at all.
   *
   * **The token is deliberately not here.** `settings.json` is plaintext on
   * disk; the token goes through Electron `safeStorage` into `sync-token.bin`
   * (see `token.ts`). A URL is not a credential. AGENTS.md, "Secrets".
   */
  syncWorkerUrl: string;
  /**
   * The OTHER address the same Worker answers on, when setup turned two on.
   *
   * Never used to sync — `resolveSyncConfig` does not look at it, deliberately.
   * It is remembered so Settings can test it and offer to switch in one click,
   * and so a run that had to fall back to the address this Mac could reach has
   * not silently forgotten the one it could not.
   */
  syncWorkerUrlAlt: string;
  /**
   * The last time the jiggler self-test ran, and what it said.
   *
   * NOT a preference — it is evidence, and it is the one thing in this file
   * nobody chooses. `docs/MACOS.md` calls the self-test the single most
   * important safety mechanism in the product: it is what proves our own
   * synthetic input cannot be mistaken for a human, and getting that wrong
   * inflates every hours figure silently. `scripts/install.sh` gates the
   * install on it — and then nothing ever ran it again, because there was
   * nowhere in the app to run it from and nowhere to see when it last passed.
   *
   * It lives here rather than in the database because it is a property of this
   * INSTALL — a binary, a code signature and a set of TCC grants — not of the
   * hours the database holds. Restoring a backup must not restore another
   * Mac's proof that this one is safe.
   */
  lastSelfTest: SelfTestResult | null;
}

export const SETTINGS_DEFAULTS: MainSettings = {
  machineId: "",
  machineLabel: "",
  idleTimeoutMin: DEFAULTS.idleTimeoutMs / 60_000,
  jigglerPausePrompt: "ask",
  windowBackground: "#FFFFFF",
  onboardingDismissed: false,
  heatmapThresholdsH: [...DEFAULTS.heatmapThresholdsH] as [number, number, number],
  minIntervalS: DEFAULTS.minIntervalMs / 1000,
  countJigglerTime: DEFAULTS.countJigglerTime ? 1 : 0,
  graceS: 0,
  syncWorkerUrl: "",
  syncWorkerUrlAlt: "",
  lastSelfTest: null,
};

/**
 * Keys this file used to persist and no longer understands.
 *
 * `meetingApps` and `micIgnoreApps` were the two user-editable bundle-id lists
 * behind the old mic conjunction (PRD §3.5). The mic is now a work signal on
 * its own, so the lists are gone — but they are sitting in `settings.json` on
 * every machine that ever ran an older build, and `load()` spreads the parsed
 * file over the defaults, so without this they would ride along forever and be
 * written back on the next save.
 *
 * Dropped SILENTLY. A settings file from an older version is the ordinary case,
 * not an error, and nothing here may ever be a reason the app declines to load.
 */
const RETIRED_KEYS = ["meetingApps", "micIgnoreApps"] as const;

export class SettingsStore {
  private data: MainSettings = { ...SETTINGS_DEFAULTS };

  /**
   * The directory arrives LAZILY, as a function.
   *
   * ES imports execute before the importing module's body, so a field
   * initialiser calling `app.getPath("userData")` would run BEFORE `index.ts`
   * runs `app.setName()` — and `userData` is derived from the name. The result
   * is a settings file in the wrong directory, silently, with defaults
   * everywhere. Taking a thunk makes that ordering impossible to get wrong, and
   * keeps `electron` out of this file entirely.
   */
  constructor(private readonly dir: () => string) {}

  private path(): string {
    return join(this.dir(), "settings.json");
  }

  async load(): Promise<MainSettings> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.path(), "utf8"));
      const merged: MainSettings & Record<string, unknown> = {
        ...SETTINGS_DEFAULTS,
        ...(raw as Partial<MainSettings>),
      };
      for (const key of RETIRED_KEYS) delete merged[key];
      this.data = merged;
    } catch {
      // Absent or corrupt reads as "first run". Never fatal: a settings file
      // that fails to parse must not stop the app from measuring.
      this.data = { ...SETTINGS_DEFAULTS };
    }
    return this.data;
  }

  get<K extends keyof MainSettings>(k: K): MainSettings[K] {
    return this.data[k];
  }

  all(): Readonly<MainSettings> {
    return this.data;
  }

  async set<K extends keyof MainSettings>(k: K, v: MainSettings[K]): Promise<void> {
    this.data[k] = v;
    await this.save();
  }

  async patch(values: Partial<MainSettings>): Promise<MainSettings> {
    this.data = { ...this.data, ...values };
    await this.save();
    return this.data;
  }

  private async save(): Promise<void> {
    const p = this.path();
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(this.data, null, 2), "utf8");
  }
}
