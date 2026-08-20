// The FOUC killer — docs/IMPL_UI.md §5.5.
//
// Stamps the theme class on <html> BEFORE React mounts, so the app never
// flashes the wrong background on launch. Kept as a real file rather than an
// inline <script> so the CSP can stay `script-src 'self'` (src/main/protocol.ts
// sets it; an inline tag would need 'unsafe-inline' or a build-time hash).
//
// It must be a CLASSIC script in <head>: a classic `<script src>` blocks
// parsing and runs before the first paint, while Vite's module bundle is
// deferred and runs far too late to prevent the flash.
//
// The storage key MUST match ThemeProvider's storageKey ('theme').
(function () {
  try {
    var stored = localStorage.getItem("theme");
    var t =
      stored === "dark" || stored === "light"
        ? stored
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    document.documentElement.classList.add(t);
    // Native scrollbars and form controls follow this, not the class.
    document.documentElement.style.colorScheme = t;
  } catch {
    document.documentElement.classList.add("light");
  }
})();
