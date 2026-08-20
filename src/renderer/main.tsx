import React from "react";
import { createRoot } from "react-dom/client";

import { Root } from "./Root";
import { ThemeProvider } from "./lib/theme-provider";
import "./index.css";

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      {/* `storageKey` must stay "theme": public/theme-boot.js reads the same key
          to stamp the class before the first paint. */}
      <ThemeProvider defaultTheme="system" storageKey="theme">
        <Root />
      </ThemeProvider>
    </React.StrictMode>,
  );
}
