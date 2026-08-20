import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@": resolve("src") } },
    build: {
      // koffi loads a prebuilt .node at runtime; node:sqlite is a builtin.
      // Neither may be bundled.
      rollupOptions: { external: ["koffi", "node:sqlite"] },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@": resolve("src") } },
    build: {
      // TRAP (docs/IMPL_UI.md §1.10): a sandboxed preload MUST be CommonJS.
      // package.json carries "type": "module", so electron-vite would emit
      // out/preload/index.mjs — and an ESM preload under `sandbox: true` fails
      // to load with NO renderer error at all. `window.wwb` is simply
      // `undefined` and every IPC call throws "cannot read invoke". Pinning
      // both the format and the filename is what keeps `windows.ts`'s
      // `preloadPath()` pointing at a file that exists AND loads.
      rollupOptions: { output: { format: "cjs", entryFileNames: "index.js" } },
    },
  },
  renderer: {
    root: "src/renderer",
    // Relative asset URLs. The renderer is served over app:// (protocol.ts),
    // where an absolute "/assets/…" resolves only by luck of the host and
    // breaks the moment the host changes. docs/IMPL_UI.md §5.2 fix 3.
    base: "./",
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": resolve("src") } },
    build: { rollupOptions: { input: resolve("src/renderer/index.html") } },
  },
});
