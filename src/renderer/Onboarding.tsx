/**
 * The onboarding window — `docs/IMPL_UI.md` §4.
 *
 * 560 × 640, `resizable: false` (`src/main/windows.ts`). Everything below is
 * sized for that box: the two panes are a LIST, not a wizard, because a fixed
 * window that cannot scroll has room for both and a user who has to click
 * "Next" to discover the second permission usually does not.
 *
 * Two facts this screen exists to say out loud, both of which are otherwise
 * silent failures:
 *
 *  - **Input Monitoring is the one that matters.** Without it typing is
 *    invisible and the hours read LOW, forever, with no error anywhere
 *    (`AGENTS.md` trap #2).
 *  - **Accessibility is genuinely optional.** It powers the jiggler and nothing
 *    else. Tracking is completely unaffected without it, and saying so is the
 *    difference between an honest permission screen and one that demands
 *    everything because asking is easier than explaining.
 *
 * THE RELAUNCH CASE IS THE LOUD ONE. macOS hands the event mask out at tap
 * creation, so an Input Monitoring grant does not reach a tap that already
 * exists — `keyboardBitsGranted` stays false while the permission reads as
 * granted. That is `relaunchRequired`, and it is the state the app ships in on
 * a fresh install. It gets a banner above everything else and a button that
 * closes the open interval before restarting (`wwb:permissions:relaunch`).
 *
 * Divergences from §4.4, deliberate:
 *
 *  1. One screen instead of a two-step wizard. See above.
 *  2. "Open System Settings…" is always available, not revealed 8 s after a
 *     request. §4.1 hides it so nobody learns to skip the system prompt, but
 *     the prompt is one-shot per app identity and every user who has already
 *     spent it needs that button immediately — including the owner, whose
 *     install spent both prompts before this screen existed.
 *  3. The jiggler switch lives here. It is the only thing Accessibility buys,
 *     so the pane that explains Accessibility is where it belongs — and it
 *     means "grant, then turn it on" is one screen rather than two windows.
 */
import * as React from "react";
import { Check, ExternalLink, KeyRound, MousePointer2, RotateCw } from "lucide-react";

import { AlertBanner } from "@/renderer/components/alert-banner";
import { Badge } from "@/renderer/components/ui/badge";
import { Button } from "@/renderer/components/ui/button";
import { Switch } from "@/renderer/components/ui/switch";
import { ipc, messageOf, usePermissions, useToggles } from "@/renderer/lib/ipc";
import { useThemeMirror } from "@/renderer/lib/use-theme-mirror";
import type { PermissionKey, PermissionSnapshot } from "@/shared/ipc-types";

/** granted · granted-but-the-tap-missed-it · not granted · nothing read yet. */
type PaneState = "granted" | "needs-restart" | "not-granted" | "unknown";

interface Pane {
  id: PermissionKey;
  title: string;
  /** "required" is a promise about the DATA, not about whether the app runs. */
  requirement: "required" | "optional";
  icon: React.ReactNode;
  why: string;
  without: string;
  state: (p: PermissionSnapshot) => PaneState;
}

const PANES: readonly Pane[] = [
  {
    id: "inputMonitoring",
    title: "Input Monitoring",
    requirement: "required",
    icon: <KeyRound className="size-4" />,
    why: "Notices that a key was pressed — never which key. No text is read or stored.",
    without:
      "Without it your typing is invisible, so your hours quietly read low. Mouse and camera still count, which is what hides it.",
    // The MASK is the authority, not the TCC row: granted-with-no-keyboard-bits
    // is the whole reason this screen has a restart button.
    state: (p) =>
      p.relaunchRequired ? "needs-restart" : p.keyboardBitsGranted ? "granted" : "not-granted",
  },
  {
    id: "accessibility",
    title: "Accessibility",
    requirement: "optional",
    icon: <MousePointer2 className="size-4" />,
    why: "Used only by the mouse jiggler, whose event carries no coordinates.",
    without: "Tracking is completely unaffected. The jiggler switch simply stays off.",
    state: (p) => (p.accessibility === "granted" ? "granted" : "not-granted"),
  },
];

const STATE_LABEL: Record<PaneState, string> = {
  granted: "Granted",
  "needs-restart": "Restart needed",
  "not-granted": "Not granted",
  unknown: "Checking…",
};

function StatusBadge({ state }: { state: PaneState }): React.ReactElement {
  return (
    <Badge
      data-slot="pane-status"
      data-state={state}
      variant={
        state === "granted" ? "secondary" : state === "needs-restart" ? "destructive" : "outline"
      }
    >
      {state === "granted" ? <Check className="size-3" /> : null}
      {STATE_LABEL[state]}
    </Badge>
  );
}

export function Onboarding(): React.ReactElement {
  useThemeMirror();

  const perms = usePermissions();
  const toggles = useToggles();
  const [actionError, setActionError] = React.useState<string | null>(null);
  const { reload: reloadPerms } = perms;

  /**
   * Main polls TCC at 1 Hz while this window exists and pushes every change
   * (`AGENTS.md` trap #10 — a hidden renderer's timers collapse, and this
   * window spends its life behind System Settings). That poll stops after 45 s,
   * so re-read once on focus too: coming back from System Settings is exactly
   * when the answer has changed and exactly when the poll has expired.
   */
  React.useEffect(() => {
    const onFocus = (): void => {
      ipc.refreshPermissions().then(reloadPerms, () => undefined);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reloadPerms]);

  const run = React.useCallback(
    (p: Promise<unknown>) => {
      setActionError(null);
      p.then(
        () => reloadPerms(),
        (e: unknown) => setActionError(messageOf(e)),
      );
    },
    [reloadPerms],
  );

  const snapshot = perms.data;
  const errors = [perms.error, toggles.error, actionError].filter((e): e is string => e !== null);

  return (
    <div data-view="onboarding" className="flex h-svh flex-col overflow-hidden bg-background">
      {/* `titleBarStyle: "hiddenInset"` leaves no chrome to drag, so the header
          IS the drag region and its buttons opt back out. pt-8 clears the
          traffic lights, which occupy roughly x 14–74 / y 14–27 at
          trafficLightPosition { x: 14, y: 14 } — the title starts below them
          because at px-7 it would otherwise start underneath them. */}
      <header className="shrink-0 px-7 pt-8 [-webkit-app-region:drag]">
        <h1 className="font-heading text-[19px] leading-tight font-semibold tracking-tight">
          Two permissions
        </h1>
        {/* ONE line. Every line here is a line the panes below do not get, and
            they are the ones that have to fit a window nobody can resize. */}
        <p className="mt-1 text-xs text-muted-foreground">
          One keeps your hours honest. The other is only the jiggler.
        </p>
      </header>

      {/* If the copy ever outgrows the window, THIS scrolls — the page body
          never does, and nothing is clipped. Same rule as the heatmap's
          overflow-x wrapper on the dashboard. */}
      <div data-slot="onboarding-panes" className="min-h-0 flex-1 overflow-y-auto px-7 pt-4">
        {errors.length > 0 ? (
          <AlertBanner
            variant="error"
            title="Couldn’t read the permission state"
            lines={errors}
            actionLabel="Retry"
            onAction={() => run(ipc.refreshPermissions())}
          />
        ) : null}

        {snapshot?.relaunchRequired ? (
          /* The button sits BESIDE the text, not under it. Stacked it cost ~45 px
             in the tallest state this screen has, and those pixels come out of a
             560 × 640 box that cannot be resized — the Accessibility pane's own
             buttons were being clipped to pay for them. */
          <section
            data-slot="relaunch-banner"
            role="alert"
            className="mb-3 flex items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">Restart to finish Input Monitoring</div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                macOS hands keyboard access out at launch, so the running copy still cannot see
                typing. Restarting closes your open interval cleanly first.
              </p>
            </div>
            <Button size="sm" className="shrink-0" onClick={() => run(ipc.relaunch())}>
              <RotateCw className="size-3.5" />
              Restart now
            </Button>
          </section>
        ) : null}

        <div className="flex flex-col gap-2.5 pb-3">
          {PANES.map((pane) => {
            const state = snapshot ? pane.state(snapshot) : "unknown";
            const promptSpent = snapshot?.promptConsumed[pane.id] ?? false;
            return (
              <section
                key={pane.id}
                data-slot="permission-pane"
                data-permission={pane.id}
                className="rounded-lg border border-border bg-card px-4 py-3"
              >
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">{pane.icon}</span>
                  <h2 className="font-heading text-sm font-medium">{pane.title}</h2>
                  <span className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">
                    {pane.requirement}
                  </span>
                  <span className="ml-auto">
                    <StatusBadge state={state} />
                  </span>
                </div>

                <p className="mt-1.5 text-xs text-muted-foreground">{pane.why}</p>
                {/* What you lose by not granting it. Once it IS granted the
                    sentence is stale — and the space it frees is space this
                    window does not have to spare in the state that matters. */}
                {state === "granted" ? null : (
                  <p className="mt-1 text-xs text-muted-foreground">{pane.without}</p>
                )}

                {state === "granted" ? null : (
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    {/* The system prompt is ONE SHOT per app identity (§4.1).
                        Once it is spent the only route left is the Settings
                        pane, so stop offering a button that does nothing. */}
                    {promptSpent ? null : (
                      <Button size="sm" onClick={() => run(ipc.requestPermission(pane.id))}>
                        Grant access
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant={promptSpent ? "default" : "outline"}
                      onClick={() => run(ipc.openPrivacyPane(pane.id))}
                    >
                      <ExternalLink className="size-3.5" />
                      Open System Settings
                    </Button>
                  </div>
                )}

                {pane.id === "accessibility" ? (
                  <label
                    data-slot="jiggler-row"
                    className="mt-2.5 flex items-center justify-between rounded-md border border-border bg-muted px-3 py-1.5"
                    title={toggles.data?.jigglerUnavailableReason ?? undefined}
                  >
                    <span className="flex items-center gap-2 text-xs">
                      <MousePointer2 className="size-3.5 text-muted-foreground" />
                      Mouse jiggler
                      <span className="text-muted-foreground">
                        {toggles.data?.jigglerAvailable === false
                          ? "· needs Accessibility"
                          : "· keeps you “available”"}
                      </span>
                    </span>
                    {/* Never a switch that appears on and does nothing
                        (docs/MACOS.md §6): without the grant it renders
                        disabled and the row says why. */}
                    <Switch
                      aria-label="Mouse jiggler"
                      checked={toggles.data?.jiggler ?? false}
                      disabled={!toggles.data?.jigglerAvailable}
                      onCheckedChange={(v) => toggles.setToggle("jiggler", v)}
                    />
                  </label>
                ) : null}
              </section>
            );
          })}
        </div>
      </div>

      <footer className="flex shrink-0 items-center justify-between border-t border-border px-7 py-3">
        <Button variant="ghost" size="sm" onClick={() => run(ipc.openDashboard())}>
          Open dashboard
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => run(ipc.refreshPermissions())}>
            Check again
          </Button>
          {/* Always available, always without granting anything. Dismissing is
              not consent to bad data, though: a missing keyboard grant keeps
              the dashboard banner and the tray warning until it is fixed. */}
          <Button size="sm" onClick={() => run(ipc.dismissOnboarding())}>
            Done
          </Button>
        </div>
      </footer>
    </div>
  );
}

export default Onboarding;
