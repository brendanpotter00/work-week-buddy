# Design reference

These files are the **visual acceptance target**, not inspiration. They were built with the real component stack (React 19 + shadcn/ui + Tailwind + Recharts + react-activity-calendar), themed, production-built and screenshotted before the spec was written.

| File | Use |
|---|---|
| `App.reference.tsx` | Port to `src/renderer/App.tsx`. Replace the mock data import with real IPC calls; change nothing else. Contains zero Tauri code. |
| `index.css` | Copy to `src/renderer/index.css` verbatim. Keep it in the repo — `shadcn init --force` silently reverts the theme block. |
| `theme-provider.reference.tsx` | Copy verbatim. Do not rewrite. |
| `mock-data.reference.ts` | Shape reference for what the queries must return. |
| `mockup-notion-warm-light.png` / `-dark.png` | What the finished dashboard must look like. Screenshot the **built app** and compare. |

## Palette

Notion-warm. Light: `#FFFFFF` background, `#37352F` text. Dark: `#191919` background, `#202020` surfaces, `#D4D4D4` text.

## Non-negotiable details

Each of these fails **silently** if got wrong:

- Window `minWidth: 880`. The 53-week heatmap is ~745 px and does not shrink — wrap it in `overflow-x-auto`.
- `react-activity-calendar` v3 uses `showColorLegend` / `showTotalCount` / `showMonthLabels`. The v2 `hide*` prop names are ignored without an error.
- Pass `colorScheme` explicitly — the component follows `prefers-color-scheme` while the app follows a class, so system and app can otherwise disagree.
- Use the **5-stop** ramp. A 2-stop ramp renders a realistic full-time year as an unreadable near-black block.
- Import `react-activity-calendar/tooltips.css` or tooltips render unstyled.
- Every number gets `tabular-nums`, or the layout jitters once a second.
- An inline script in `<head>` must stamp the theme class before React mounts, or the app flashes the wrong theme on launch.
