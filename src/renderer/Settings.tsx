/**
 * The settings window — the third view, and the reason it exists is one line
 * long: there was no way to turn cloud sync on.
 *
 * WHY A WINDOW AND NOT A PANEL. It has to be reachable from the tray, and the
 * tray is where this app actually lives — a menu item that opens the 1100-px
 * dashboard first, to reach two text fields, is a menu item nobody uses. It is
 * also the shape that needs the least new machinery: main already opens windows
 * by loading a hash (`ROUTE`), `route.ts` already matches on that, and both
 * halves are already tested together. A modal on the dashboard would have
 * needed a way for main to tell an existing renderer to open it, which is a new
 * push channel to carry one bit.
 *
 * WHAT IS HERE AND WHY IT IS IN THIS ORDER. Sync first, because it is the thing
 * that could not be done at all. Then the settings that already existed in
 * `src/main/settings.ts` with nothing to edit them: the machine label (reusing
 * `DeviceName`, which was written to be moved here), the idle timeout, the two
 * bundle-id lists, and the heatmap ramp. Nothing new was invented; every field
 * below is a `MainSettings` key that has been persisted since before this
 * window existed.
 *
 * The write rule: EVERY EDIT IS A WRITE. There is no page-level Save button, no
 * dirty state to lose, and the one place a draft exists — the sync form — has
 * its own Save precisely because a half-typed URL is worse than none. Main
 * validates everything again on arrival (`sanitizeUiSettings`), because a view
 * is the wrong place to hold an invariant.
 */
import * as React from "react";

import { AlertBanner } from "@/renderer/components/alert-banner";
import { BundleIdList } from "@/renderer/components/bundle-id-list";
import { DeviceName } from "@/renderer/components/device-name";
import { SelfTestCard } from "@/renderer/components/self-test-card";
import { Field, ReadRow, SettingsCard, inputClass } from "@/renderer/components/settings-ui";
import { SyncSettings } from "@/renderer/components/sync-settings";
import { Button } from "@/renderer/components/ui/button";
import { ipc, messageOf, useDoctor, useSettings, useSyncConfig } from "@/renderer/lib/ipc";
import { useThemeMirror } from "@/renderer/lib/use-theme-mirror";
import type { UiSettings } from "@/shared/ipc-types";

/** PRD §7: "15 minutes, adjustable 10–15 without touching history". */
const IDLE_MIN = 10;
const IDLE_MAX = 15;

export function Settings(): React.ReactElement {
  useThemeMirror();

  const settings = useSettings();
  const config = useSyncConfig();
  const doctor = useDoctor();

  // Optimistic, then authoritative — the same shape `useToggles` uses. Main
  // sanitises every value, so what comes back can legitimately differ from what
  // was sent, and the field must show the stored answer rather than the guess.
  const [local, setLocal] = React.useState<UiSettings | null>(null);
  const [writeError, setWriteError] = React.useState<string | null>(null);
  React.useEffect(() => setLocal(settings.data), [settings.data]);

  const value = local ?? settings.data;

  const write = React.useCallback((patch: Partial<UiSettings>) => {
    setLocal((s) => (s ? { ...s, ...patch } : s));
    setWriteError(null);
    ipc.setSettings(patch).then(
      (next) => setLocal(next),
      (e: unknown) => setWriteError(messageOf(e)),
    );
  }, []);

  const errors = [settings.error, config.error, doctor.error, writeError].filter(
    (e): e is string => e !== null,
  );
  const { reload: reloadSettings } = settings;
  const { reload: reloadConfig } = config;
  const { reload: reloadDoctor } = doctor;
  const retry = React.useCallback(() => {
    reloadSettings();
    reloadConfig();
    reloadDoctor();
  }, [reloadSettings, reloadConfig, reloadDoctor]);

  return (
    <div data-view="settings" className="flex h-svh flex-col bg-background">
      {/* `titleBarStyle: "hiddenInset"` leaves no chrome to drag, so the header
          IS the drag region. pt-8 clears the traffic lights. */}
      <header className="shrink-0 px-7 pt-8 pb-3 [-webkit-app-region:drag]">
        <h1 className="font-heading text-[19px] leading-tight font-semibold tracking-tight">
          Settings
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Changes apply immediately. Nothing here rewrites an hour you have already worked.
        </p>
      </header>

      {/* THIS scrolls, never the page body — the same rule the onboarding panes
          and the heatmap wrapper follow. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-6">
        {errors.length > 0 ? (
          <AlertBanner
            variant="error"
            title="Couldn’t read your settings"
            lines={errors}
            actionLabel="Retry"
            onAction={retry}
          />
        ) : null}

        <div className="flex flex-col gap-3">
          <SyncSettings config={config} doctor={doctor} />

          <SettingsCard
            id="machine"
            title="This Mac"
            description="The name every hour recorded here is filed under, on both Macs."
          >
            {/* Reused, not reimplemented. `device-name.tsx` was written in its
                own file specifically so it could be moved into a settings pane
                without touching the dashboard, and the dashboard still shows it
                too — one component, one rename path, one `wwb:machine:rename`. */}
            <DeviceName />
          </SettingsCard>

          <SettingsCard
            id="tracking"
            title="Tracking"
            description="When a quiet stretch ends the session you are in."
          >
            <Field
              htmlFor="idle-timeout"
              label={`Idle timeout — ${String(value?.idleTimeoutMin ?? IDLE_MAX)} minutes`}
              hint="The interval still ENDS at your last keystroke, never at the moment this runs out. Shortening it only makes the app notice sooner."
            >
              <input
                id="idle-timeout"
                type="range"
                min={IDLE_MIN}
                max={IDLE_MAX}
                step={1}
                className="w-full accent-foreground"
                value={value?.idleTimeoutMin ?? IDLE_MAX}
                disabled={value === null}
                onChange={(e) => write({ idleTimeoutMin: Number(e.target.value) })}
              />
            </Field>
          </SettingsCard>

          <SettingsCard
            id="meetings"
            title="Meetings"
            description="macOS says the microphone is in use, never by whom. These two lists are how a meeting is told apart from dictation."
          >
            <div className="flex flex-col gap-5">
              <BundleIdList
                id="meeting-apps"
                label="Counts as a meeting"
                hint="Mic in use AND one of these running keeps a session open with no mouse movement."
                // Deliberately NOT one of the seeded ids: a placeholder that
                // repeats a row already in the list above reads as a duplicate
                // rather than as an example.
                placeholder="add a bundle id, e.g. com.apple.FaceTime"
                values={value?.meetingApps ?? []}
                disabled={value === null}
                onChange={(next) => write({ meetingApps: next })}
              />
              <BundleIdList
                id="mic-ignore"
                label="Never a meeting"
                hint="Dictation tools hold the mic all day. Left in, one of them makes every waking hour look like a call."
                placeholder="add a bundle id, e.g. com.apple.VoiceMemos"
                values={value?.micIgnoreApps ?? []}
                disabled={value === null}
                onChange={(next) => write({ micIgnoreApps: next })}
              />
            </div>
          </SettingsCard>

          <SettingsCard
            id="heatmap"
            title="Daily hours colour"
            description="Where the five shades on the dashboard’s year change. Colour only — no hours move."
          >
            <ThresholdFields
              values={value?.heatmapThresholdsH ?? null}
              onChange={(next) => write({ heatmapThresholdsH: next })}
            />
          </SettingsCard>

          <SelfTestCard doctor={doctor} />

          <SettingsCard
            id="about"
            title="About"
            description="What a support question needs, and what the doctor already knows."
          >
            <ReadRow label="Version" value={doctor.data?.app.version ?? "—"} />
            <ReadRow label="Machine id" value={doctor.data?.machine.machineId ?? "—"} />
            <ReadRow label="Time zone" value={doctor.data?.machine.tz ?? "—"} />
            <ReadRow
              label="Database"
              value={doctor.data === null ? "—" : `${String(doctor.data.db.rows)} intervals`}
              title={doctor.data?.db.path}
            />
            <ReadRow
              label="Last local backup"
              value={
                doctor.data?.backup.lastAtMs == null
                  ? "—"
                  : new Date(doctor.data.backup.lastAtMs).toLocaleDateString()
              }
              title={doctor.data?.backup.lastPath ?? undefined}
            />
            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => void ipc.openDashboard()}>
                Open dashboard
              </Button>
              <Button size="sm" variant="ghost" onClick={reloadDoctor}>
                Refresh
              </Button>
            </div>
          </SettingsCard>
        </div>
      </div>
    </div>
  );
}

/**
 * The three ramp stops.
 *
 * Edited as a triple and written only when they are strictly ascending, because
 * a half-applied ramp renders a heatmap whose colours are not ordered — which
 * reads as data rather than as a rejected edit. Main enforces the same rule
 * again on arrival; this half is only so the reason appears next to the field.
 */
function ThresholdFields({
  values,
  onChange,
}: {
  values: readonly [number, number, number] | null;
  onChange: (next: [number, number, number]) => void;
}): React.ReactElement {
  const [draft, setDraft] = React.useState<[string, string, string] | null>(null);
  const shown: [string, string, string] = draft ?? [
    String(values?.[0] ?? ""),
    String(values?.[1] ?? ""),
    String(values?.[2] ?? ""),
  ];
  const nums = shown.map(Number) as [number, number, number];
  const ok =
    shown.every((s) => s.trim() !== "") &&
    nums.every((n) => Number.isFinite(n)) &&
    nums[0] > 0 &&
    nums[1] > nums[0] &&
    nums[2] > nums[1];

  const set = (i: 0 | 1 | 2, v: string): void => {
    const next: [string, string, string] = [...shown];
    next[i] = v;
    setDraft(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <div data-slot="threshold-row" className="flex items-end gap-2">
        {(["Light", "Medium", "Full"] as const).map((label, i) => (
          <div key={label} className="flex-1">
            <label htmlFor={`threshold-${String(i)}`} className="text-xs font-medium">
              {label}
            </label>
            <input
              id={`threshold-${String(i)}`}
              type="number"
              min={0.5}
              step={0.5}
              className={`${inputClass} mt-1`}
              aria-invalid={!ok}
              value={shown[i]}
              disabled={values === null}
              onChange={(e) => set(i as 0 | 1 | 2, e.target.value)}
            />
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          disabled={!ok || draft === null}
          onClick={() => {
            onChange(nums);
            setDraft(null);
          }}
        >
          Apply
        </Button>
      </div>
      <p className={`text-xs ${ok ? "text-muted-foreground" : "text-destructive"}`} role={ok ? undefined : "alert"}>
        {ok
          ? `A day is shaded darker at ${String(nums[0])} h, ${String(nums[1])} h and ${String(nums[2])} h. A 1.9-hour day must not look like a day off.`
          : "Each number has to be larger than the one before it, and above zero."}
      </p>
    </div>
  );
}

export default Settings;
