import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
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
  },
  renderer: {
    root: "src/renderer",
    plugins: [react()],
    resolve: { alias: { "@": resolve("src") } },
    build: { rollupOptions: { input: resolve("src/renderer/index.html") } },
  },
});
