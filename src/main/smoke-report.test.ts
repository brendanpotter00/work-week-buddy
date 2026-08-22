/**
 * The smoke run's RULES, without a window.
 *
 * `checkSmokeReport()` is pure so that the half of the smoke test that encodes
 * "what working means" runs everywhere — including the Linux CI job, which
 * cannot open a window at all. The macOS job produces the measurements; this
 * file proves the checker would actually reject them.
 *
 * A checker nobody tested is a checker that returns `[]` for everything, and a
 * smoke run that always passes is worse than no smoke run: it is the same green
 * suite that let the bug ship, with more machinery behind it.
 */
import { describe, expect, it } from "vitest";

import { WINDOW_SIZE } from "../shared/constants";
import { checkSmokeReport, type SmokeReport, type WindowProbe } from "./smoke-report";

function dashboardProbe(over: Partial<WindowProbe> = {}): WindowProbe {
  return {
    window: "dashboard",
    scenario: "degraded",
    view: "dashboard",
    bounds: { width: 1100, height: 860 },
    resizable: true,
    innerWidth: 1100,
    innerHeight: 860,
    scrollWidth: 1100,
    scrollHeight: 979,
    innerScroll: null,
    widest: null,
    headings: ["Work Week Buddy", "This week", "By machine"],
    text: "Work Week Buddy This week 36.5h By machine",
    jiggler: null,
    ...over,
  };
}

function onboardingProbe(over: Partial<WindowProbe> = {}): WindowProbe {
  return {
    window: "onboarding",
    scenario: "degraded",
    view: "onboarding",
    bounds: { ...WINDOW_SIZE.onboarding },
    resizable: false,
    innerWidth: 560,
    innerHeight: 640,
    scrollWidth: 560,
    scrollHeight: 640,
    innerScroll: { clientHeight: 507, scrollHeight: 507, contentHeight: 474 },
    widest: null,
    headings: ["Two permissions", "Input Monitoring", "Accessibility"],
    text: "Two permissions Restart to finish Input Monitoring Accessibility Done",
    jiggler: { present: true, disabled: true, checked: false },
    ...over,
  };
}

function cloudSetupProbe(over: Partial<WindowProbe> = {}): WindowProbe {
  return {
    window: "cloud-setup",
    scenario: "degraded",
    view: "cloud-setup",
    bounds: { width: WINDOW_SIZE.cloudSetup.width, height: WINDOW_SIZE.cloudSetup.height },
    resizable: true,
    innerWidth: 640,
    innerHeight: 720,
    scrollWidth: 640,
    scrollHeight: 700,
    innerScroll: null,
    widest: null,
    headings: ["Cloud sync"],
    text: "Cloud sync second copy free plan Continue Cancel",
    jiggler: null,
    ...over,
  };
}

/** A clean run: every window, both scenarios, and a jiggler click that landed. */
function healthyReport(over: Partial<SmokeReport> = {}): SmokeReport {
  return {
    ranAtMs: Date.parse("2026-08-20T12:00:00Z"),
    appVersion: "0.1.0",
    packaged: false,
    maxStallMs: 0,
    probes: [
      dashboardProbe(),
      onboardingProbe(),
      dashboardProbe({ scenario: "granted" }),
      onboardingProbe({
        scenario: "granted",
        // No restart banner and no "without" lines once everything is granted.
        text: "Two permissions Input Monitoring Granted Accessibility Granted Done",
        innerScroll: { clientHeight: 507, scrollHeight: 507, contentHeight: 225 },
        jiggler: { present: true, disabled: false, checked: false },
      }),
      cloudSetupProbe(),
    ],
    jigglerClick: { switchChecked: true, runtimeJiggler: true, error: null },
    screenshots: [],
    ...over,
  };
}

/** Replaces one probe, so a test changes exactly the fact it is about. */
function withProbe(report: SmokeReport, i: number, over: Partial<WindowProbe>): SmokeReport {
  const probes = [...report.probes];
  probes[i] = { ...probes[i]!, ...over };
  return { ...report, probes };
}

describe("a healthy run", () => {
  it("reports nothing", () => {
    expect(checkSmokeReport(healthyReport())).toEqual([]);
  });
});

describe("THE BUG: the window main opened and the view the renderer mounted", () => {
  it("rejects the dashboard rendering in the onboarding window", () => {
    // The shipped bug, exactly: main loads #/onboarding, the renderer mounts
    // <App />, and 560 × 640 of window holds an 1100-px page.
    const fail = checkSmokeReport(withProbe(healthyReport(), 1, { view: "dashboard" }));
    expect(fail.join("\n")).toMatch(/onboarding window \(degraded\) rendered view "dashboard"/);
  });

  it("rejects the onboarding view rendering in the dashboard window", () => {
    const fail = checkSmokeReport(withProbe(healthyReport(), 0, { view: "onboarding" }));
    expect(fail.join("\n")).toMatch(/dashboard window \(degraded\) rendered view "onboarding"/);
  });

  it("rejects a window that mounted no view at all", () => {
    // A white window: the preload failed, or the bundle threw on import.
    const fail = checkSmokeReport(withProbe(healthyReport(), 0, { view: null }));
    expect(fail.join("\n")).toMatch(/rendered view "none"/);
  });

  it("names the seam, so the next reader knows where to look", () => {
    const fail = checkSmokeReport(withProbe(healthyReport(), 1, { view: "dashboard" }));
    expect(fail.join("\n")).toContain("src/renderer/lib/route.ts");
    expect(fail.join("\n")).toContain("src/main/windows.ts");
  });
});

describe("THE SQUISH: content wider than the window it is in", () => {
  it("rejects a page body that scrolls sideways, in either window", () => {
    for (const i of [0, 1]) {
      const fail = checkSmokeReport(
        withProbe(healthyReport(), i, {
          scrollWidth: 1400,
          widest: { tag: "div", className: "grid grid-cols-4", width: 1400 },
        }),
      );
      expect(fail.join("\n")).toMatch(/content 1400px wide in a \d+px viewport/);
      // Diagnostic, so the failure names the offender rather than the symptom.
      expect(fail.join("\n")).toContain("<div> 1400px");
    }
  });

  it("tolerates a single pixel of sub-pixel rounding", () => {
    expect(checkSmokeReport(withProbe(healthyReport(), 0, { scrollWidth: 1101 }))).toEqual([]);
  });
});

describe("the dashboard", () => {
  it("rejects a window narrower than the heatmap it has to hold", () => {
    // The 53-week SVG is ~745px and does not shrink; 880 is the arithmetic.
    const fail = checkSmokeReport(
      withProbe(healthyReport(), 0, { bounds: { width: 560, height: 640 } }),
    );
    expect(fail.join("\n")).toMatch(/is 560px wide; minWidth is 880px/);
  });

  it("rejects a dashboard window with no dashboard in it", () => {
    // `data-view` can be right while the page is empty — a failed IPC call
    // renders a skeleton that is neither the dashboard nor an error.
    const fail = checkSmokeReport(withProbe(healthyReport(), 0, { text: "Work Week Buddy" }));
    expect(fail.join("\n")).toMatch(/shows no "This week" card/);
  });
});

describe("the onboarding window is a fixed box, so its content has to fit", () => {
  it("rejects a window that is not 560 × 640", () => {
    const fail = checkSmokeReport(
      withProbe(healthyReport(), 1, { bounds: { width: 620, height: 700 } }),
    );
    expect(fail.join("\n")).toMatch(/is 620×700; the fixed onboarding box is 560×640/);
  });

  it("rejects a resizable onboarding window", () => {
    // The fixed box is what makes "it fits" a promise rather than a hope. Make
    // it resizable and every fit assertion below becomes meaningless.
    const fail = checkSmokeReport(withProbe(healthyReport(), 1, { resizable: true }));
    expect(fail.join("\n")).toMatch(/is resizable; onboarding is a fixed box/);
  });

  it("rejects a page taller than a window nobody can resize", () => {
    const fail = checkSmokeReport(withProbe(healthyReport(), 1, { scrollHeight: 720 }));
    expect(fail.join("\n")).toMatch(/needs 720px of height in a 640px window that cannot be resized/);
  });

  it("rejects panes that overflow their own scroll region", () => {
    // The bug the first real smoke run found: 581px of panes in 486px, with the
    // Accessibility buttons and the jiggler switch clipped off the bottom.
    const fail = checkSmokeReport(
      withProbe(healthyReport(), 1, {
        innerScroll: { clientHeight: 486, scrollHeight: 581, contentHeight: 581 },
      }),
    );
    expect(fail.join("\n")).toMatch(/the permission panes overflow their region/);
    expect(fail.join("\n")).toMatch(/581px of content in 486px/);
  });

  it("rejects a fit with nothing to spare, which is not the same as fitting", () => {
    const fail = checkSmokeReport(
      withProbe(healthyReport(), 1, {
        innerScroll: { clientHeight: 507, scrollHeight: 507, contentHeight: 500 },
      }),
    );
    expect(fail.join("\n")).toMatch(/fit with only 7px to spare/);
  });

  it("accepts a comfortable fit", () => {
    expect(
      checkSmokeReport(
        withProbe(healthyReport(), 1, {
          innerScroll: { clientHeight: 507, scrollHeight: 507, contentHeight: 491 },
        }),
      ),
    ).toEqual([]);
  });

  it("insists both permissions and a way out are named", () => {
    for (const missing of ["Input Monitoring", "Accessibility", "Done"]) {
      const text = "Two permissions Restart Input Monitoring Accessibility Done".replace(
        missing,
        "",
      );
      const fail = checkSmokeReport(withProbe(healthyReport(), 1, { text }));
      expect(fail.join("\n")).toContain(`never mentions "${missing}"`);
    }
  });
});

describe("relaunchRequired has to be said out loud, in the window", () => {
  it("rejects an onboarding screen that never mentions restarting", () => {
    // macOS hands the event mask out at launch. A grant that needs a restart
    // and does not say so leaves the user watching a screen insist it is broken.
    const fail = checkSmokeReport(
      withProbe(healthyReport(), 1, { text: "Two permissions Input Monitoring Accessibility Done" }),
    );
    expect(fail.join("\n")).toMatch(/says nothing about restarting/);
  });

  it("rejects a screen still demanding a restart after the permission push", () => {
    // If this fires, wwb:push:permissions is not reaching the view and the user
    // fixes the permission while the app keeps telling them it is broken.
    const fail = checkSmokeReport(
      withProbe(healthyReport(), 3, { text: "Two permissions Restart Input Monitoring Accessibility Done" }),
    );
    expect(fail.join("\n")).toMatch(/still demands a restart after the permission push/);
  });
});

describe("the jiggler switch", () => {
  it("rejects a missing switch", () => {
    const fail = checkSmokeReport(withProbe(healthyReport(), 1, { jiggler: null }));
    expect(fail.join("\n")).toMatch(/has no mouse-jiggler switch/);
  });

  it("rejects a switch left disabled after Accessibility was granted", () => {
    // Live-push regression: the badge flips to Granted, the switch beside it
    // stays greyed out until the window is reopened.
    const fail = checkSmokeReport(
      withProbe(healthyReport(), 3, { jiggler: { present: true, disabled: true, checked: false } }),
    );
    expect(fail.join("\n")).toMatch(/Accessibility is granted but the jiggler switch is still disabled/);
  });

  it("rejects a switch that is live WITHOUT Accessibility", () => {
    // It would appear on and do nothing, which is the failure mode this whole
    // app is built against.
    const fail = checkSmokeReport(
      withProbe(healthyReport(), 1, { jiggler: { present: true, disabled: false, checked: false } }),
    );
    expect(fail.join("\n")).toMatch(/enabled without Accessibility/);
  });

  it("rejects a run that never clicked it", () => {
    expect(checkSmokeReport(healthyReport({ jigglerClick: null })).join("\n")).toMatch(
      /never clicked; the smoke run proves nothing about it/,
    );
  });

  it("rejects a DOM that flipped while the runtime did not", () => {
    const fail = checkSmokeReport(
      healthyReport({
        jigglerClick: { switchChecked: true, runtimeJiggler: false, error: null },
      }),
    );
    expect(fail.join("\n")).toMatch(/turned on in the DOM but the runtime's jiggler is still off/);
  });

  it("reports a click that threw", () => {
    const fail = checkSmokeReport(
      healthyReport({
        jigglerClick: { switchChecked: false, runtimeJiggler: false, error: "not clickable" },
      }),
    );
    expect(fail.join("\n")).toMatch(/clicking the jiggler switch failed: not clickable/);
  });
});

describe("a run that did not happen is a failure, not a pass", () => {
  it("rejects a report with no probes at all", () => {
    // The version of this test suite that matters most: an empty report must
    // never be green. That is exactly how a broken harness reports success.
    const fail = checkSmokeReport(healthyReport({ probes: [] }));
    expect(fail.length).toBeGreaterThanOrEqual(5);
    for (const w of ["dashboard", "onboarding"]) {
      for (const s of ["degraded", "granted"]) {
        expect(fail.join("\n")).toContain(`no probe for the ${w} window in the ${s} scenario`);
      }
    }
    // The fourth window is measured too — one that nothing measures is exactly
    // the bug `Root.tsx` exists for.
    expect(fail.join("\n")).toContain("no probe for the cloud-setup window");
  });

  it("rejects a run that skipped the granted scenario", () => {
    const fail = checkSmokeReport(healthyReport({ probes: healthyReport().probes.slice(0, 2) }));
    expect(fail.join("\n")).toContain("no probe for the dashboard window in the granted scenario");
    expect(fail.join("\n")).toContain("no probe for the onboarding window in the granted scenario");
  });

  it("returns EVERY failure, because one wrong route makes every window wrong", () => {
    const broken = withProbe(withProbe(healthyReport(), 1, { view: "dashboard" }), 3, {
      view: "dashboard",
    });
    expect(checkSmokeReport(broken).length).toBeGreaterThanOrEqual(2);
  });
});
