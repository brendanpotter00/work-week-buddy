/**
 * Main-side settings — `docs/IMPL_UI.md` §1.8.
 *
 * A JSON file, NOT the renderer's `localStorage`. The renderer can be closed
 * for a week; the tray still needs to know whether the jiggler is on and what
 * the countable-hours policy is.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULTS, MEETING_APPS, MIC_IGNORE } from "../shared/constants";

export interface MainSettings {
  machineId: string;
  machineLabel: string;
  /** 10–15, PRD §7. */
  idleTimeoutMin: number;
  jigglerPausePrompt: "ask" | "never";
  /** '#FFFFFF' | '#191919' — mirrored from the renderer so main can paint first. */
  windowBackground: string;
  onboardingDismissed: boolean;
  /** bundle ids, user-editable, PRD §3.5 */
  meetingApps: string[];
  micIgnoreApps: string[];
  heatmapThresholdsH: [number, number, number];
  minIntervalS: number;
  countJigglerTime: 0 | 1;
  graceS: number;
}

export const SETTINGS_DEFAULTS: MainSettings = {
  machineId: "",
  machineLabel: "",
  idleTimeoutMin: DEFAULTS.idleTimeoutMs / 60_000,
  jigglerPausePrompt: "ask",
  windowBackground: "#FFFFFF",
  onboardingDismissed: false,
  meetingApps: [...MEETING_APPS],
  micIgnoreApps: [...MIC_IGNORE],
  heatmapThresholdsH: [...DEFAULTS.heatmapThresholdsH] as [number, number, number],
  minIntervalS: DEFAULTS.minIntervalMs / 1000,
  countJigglerTime: DEFAULTS.countJigglerTime ? 1 : 0,
  graceS: 0,
};

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
      this.data = { ...SETTINGS_DEFAULTS, ...(raw as Partial<MainSettings>) };
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
