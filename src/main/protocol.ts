/**
 * `app://` and the CSP — `docs/IMPL_UI.md` §1.4.
 *
 * Why a custom scheme at all: Vite emits ESM, and Electron cannot load ESM over
 * `file://` — the module graph fails with a CORS-shaped error that reads like a
 * bundler bug. `app://` with `standard: true` gives the renderer a real origin,
 * which also makes the CSP and `localStorage` behave normally.
 *
 * `protocol.registerSchemesAsPrivileged()` MUST run at module scope in
 * `index.ts`, before `app.whenReady()`. Called after ready it is a silent
 * no-op and every ESM import in the renderer 404s.
 */
import { app, net, protocol } from "electron";
import { existsSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { log } from "./log";

export const APP_SCHEME = "app";
export const APP_HOST = "wwb";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/**
 * Production CSP. Set HERE and nowhere else.
 *
 * Do NOT also add a `<meta http-equiv="Content-Security-Policy">` to
 * index.html: two policies intersect, and the day someone edits one and not the
 * other, a chart stops rendering with a console message nobody reads.
 *
 * `style-src 'unsafe-inline'` is REQUIRED and is not laziness: Recharts writes
 * inline style attributes on every path it draws, and @floating-ui positions
 * with inline transforms. Both land under `style-src-attr`, which
 * `'unsafe-inline'` on `style-src` covers. `script-src` stays `'self'` — the
 * FOUC killer is a real file, not an inline tag.
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export type Resolved =
  | { kind: "file"; path: string }
  | { kind: "error"; status: 403 | 404; body: string };

/**
 * Pure, so the traversal guard is testable without a running Electron.
 * Resolve first, THEN prove the result is still under the root — checking the
 * raw URL for `..` is the version of this that gets bypassed.
 */
export function resolveAppPath(root: string, rawUrl: string): Resolved {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { kind: "error", status: 404, body: "not found" };
  }
  if (url.host !== APP_HOST) return { kind: "error", status: 404, body: "not found" };

  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const filePath = normalize(join(root, rel === "" ? "index.html" : rel));
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    return { kind: "error", status: 403, body: "forbidden" };
  }
  return { kind: "file", path: filePath };
}

export function rendererRoot(): string {
  // Never `__dirname`: the main bundle's module format is a build-time decision
  // and this file is also loaded by the unit tests.
  return join(app.getAppPath(), "out", "renderer");
}

export function registerAppProtocol(root: string = rendererRoot()): void {
  log.info(`app:// serving ${root}`);
  protocol.handle(APP_SCHEME, async (request) => {
    // EVERY PATH THROUGH HERE ANSWERS. `protocol.handle` swallows a rejected
    // handler: the renderer sees a bare network error, `ready-to-show` never
    // fires, the window stays hidden, and main says nothing. A blank window
    // with no explanation is the failure this whole file is downstream of, so
    // the one thing this handler may never do is throw.
    try {
      const resolved = resolveAppPath(root, request.url);
      if (resolved.kind === "error") {
        // 403 is a traversal attempt and is worth a line; 404s are ordinary.
        if (resolved.status === 403) log.warn(`app:// refused ${request.url}`);
        return new Response(resolved.body, { status: resolved.status });
      }
      if (!existsSync(resolved.path)) {
        log.warn(`app:// 404 ${request.url} → ${resolved.path}`);
        return new Response("not found", { status: 404 });
      }

      // net.fetch on a file:// URL gives us the right Content-Type for free,
      // and it reads through Electron's fs — inside an asar included.
      const res = await net.fetch(pathToFileURL(resolved.path).toString());
      const headers = new Headers(res.headers);
      headers.set("Content-Security-Policy", CSP);
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(res.body, { status: res.status, headers });
    } catch (err) {
      log.error(`app:// FAILED ${request.url}`, err);
      return new Response("internal error", { status: 500 });
    }
  });
}
