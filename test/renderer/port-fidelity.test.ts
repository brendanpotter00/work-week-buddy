/**
 * The parts of the port that fail SILENTLY and that a jsdom render cannot see.
 *
 * `design/README.md` lists them: each one produces a dashboard that looks
 * plausible in a component test and wrong in the built app. They are asserted
 * against the files themselves because that is where the mistake would live.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

describe("files copied verbatim stay verbatim", () => {
  it("src/renderer/index.css is design/index.css, byte for byte", () => {
    // `shadcn init --force` silently reverts the :root/.dark blocks, which is
    // why the palette is committed rather than generated.
    expect(read("src/renderer/index.css")).toBe(read("design/index.css"));
  });

  it("the theme provider is the reference file, unedited", () => {
    // design/README.md: "Copy verbatim. Do not rewrite." useResolvedTheme()
    // exists precisely so this file never needs a resolvedTheme field.
    expect(read("src/renderer/lib/theme-provider.tsx")).toBe(
      read("design/theme-provider.reference.tsx"),
    );
  });

  it("keeps the Notion-warm palette the mockups were screenshotted with", () => {
    const css = read("src/renderer/index.css");
    expect(css).toContain("--background: #ffffff");
    expect(css).toContain("--foreground: #37352F");
    expect(css).toContain("--background: #191919");
    expect(css).toContain("--card: #202020");
    expect(css).toContain("--foreground: #D4D4D4");
  });
});

describe("the three fixes that fail silently", () => {
  const app = read("src/renderer/App.tsx");

  it("imports the tooltips stylesheet", () => {
    // Without it the tooltips render as unstyled text blocks at the top-left of
    // the page. No error, no warning.
    expect(app).toContain('import "react-activity-calendar/tooltips.css"');
  });

  it("passes colorScheme explicitly", () => {
    // The component follows prefers-color-scheme; the app follows a class.
    expect(app).toContain("colorScheme={resolvedTheme}");
  });

  it("serves the renderer over app://, with relative asset URLs", () => {
    // Vite emits ESM, which Electron cannot load over file://. The renderer's
    // half of that fix is base: "./" — an absolute /assets/… resolves under
    // app:// only by luck of the host.
    const cfg = read("electron.vite.config.ts");
    expect(cfg).toMatch(/renderer:\s*\{[\s\S]*base:\s*"\.\/"/);
    expect(read("src/main/protocol.ts")).toContain('export const APP_SCHEME = "app"');
  });
});

describe("the heatmap's width", () => {
  it("scrolls inside its own card rather than the page body", () => {
    // The 53-week SVG is ~745 px and does not shrink.
    const app = read("src/renderer/App.tsx");
    expect(app).toMatch(/overflow-x-auto[\s\S]{0,200}<ActivityCalendar/);
  });

  it("is paired with the window's minWidth", () => {
    // 880 − 64 (page px-8) − 40 (card px-5) = 776 px, i.e. 31 px of headroom.
    // Both halves are required: minWidth for the common case, the wrapper for
    // the safety case.
    expect(read("src/main/windows.ts")).toContain("minWidth: 880");
  });

  it("uses the 5-stop ramp, not a 2-stop one", () => {
    // A 2-stop ramp renders a realistic full-time year as an unreadable
    // near-black block.
    const app = read("src/renderer/App.tsx");
    expect(app).toContain('light: ["#F1F0EE", "#D3D1CB", "#A8A49C", "#6B6862", "#37352F"]');
    expect(app).toContain('dark: ["#242424", "#3A3A3A", "#5C5C5C", "#8A8A8A", "#D4D4D4"]');
  });

  it("uses the v3 prop names, which the v2 names would silently replace", () => {
    // react-activity-calendar v3 takes showColorLegend / showTotalCount /
    // showMonthLabels. The v2 `hide*` names are ignored without an error.
    const app = read("src/renderer/App.tsx");
    expect(app).toContain("showTotalCount={false}");
    expect(app).not.toMatch(/hideColorLegend|hideTotalCount|hideMonthLabels/);
  });
});

describe("the FOUC killer", () => {
  const html = read("src/renderer/index.html");

  it("is a classic script in <head>, not a module", () => {
    // A classic <script src> blocks parsing and runs before the first paint;
    // Vite's module bundle is deferred and runs far too late.
    expect(html).toMatch(/<head>[\s\S]*<script src="\.\/theme-boot\.js"><\/script>[\s\S]*<\/head>/);
    expect(html).not.toMatch(/<script type="module" src="\.\/theme-boot\.js">/);
  });

  it("is a real file, so the CSP can stay script-src 'self'", () => {
    const boot = read("src/renderer/public/theme-boot.js");
    // The storage key must match ThemeProvider's default storageKey.
    expect(boot).toContain('localStorage.getItem("theme")');
    expect(read("src/main/protocol.ts")).toContain("\"script-src 'self'\"");
  });

  it("does not add a second CSP in the page", () => {
    // Two policies intersect. The day someone edits one and not the other,
    // Recharts stops drawing and the console message is not the one you would
    // search for. The policy is a response header, set in protocol.ts.
    expect(html).not.toMatch(/http-equiv=["']Content-Security-Policy/i);
    // …and the one that IS set must keep the inline styles Recharts and
    // @floating-ui write.
    expect(read("src/main/protocol.ts")).toContain("\"style-src 'self' 'unsafe-inline'\"");
  });
});

describe("no mock data ships", () => {
  it("nothing under src/ imports design/mock-data.reference", () => {
    // It is a shape reference, and it carries a UTC date bug (§0.1 rule 8)
    // that must not travel.
    for (const f of ["src/renderer/App.tsx", "src/renderer/main.tsx", "src/renderer/lib/ipc.ts"]) {
      expect(read(f)).not.toContain("mock-data");
      expect(read(f)).not.toContain("@/data");
    }
  });
});
