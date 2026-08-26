/**
 * The app's outbound HTTP, on Chromium's stack rather than Node's.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * `globalThis.fetch` in Electron's main process is Node's undici. It reads
 * NEITHER the macOS system trust store NOR the macOS proxy configuration. On a
 * managed Mac — a PAC file pushed by MDM, and a corporate root CA that macOS
 * trusts and Node has never heard of — every outbound request fails with the
 * single word "fetch failed" while Chrome loads the same URL perfectly. That is
 * a fault the owner cannot see, cannot reproduce in a browser, and cannot fix
 * by changing hostnames.
 *
 * `net.fetch` is the same WHATWG shape over Chromium's network stack, which
 * reads both. Verified against Electron's documentation: system proxy
 * configuration including WPAD/PAC, and the system certificate store.
 *
 * ── WHAT WAS MEASURED BEFORE THIS WAS WIRED IN ──────────────────────────────
 * `net.fetch` is documented as not a strict drop-in, and the one difference
 * that would have mattered here is a deadline that stops working:
 * `src/cloud/api.ts` and `src/sync/client.ts` both set
 * `init.signal = AbortSignal.timeout(...)` and both depend on it firing. A
 * flusher whose request never returns leaves the single-flight guard closed and
 * the outbox never moves again.
 *
 * Measured under Electron 43.4.1, against a local server that never answers,
 * reproducing both call shapes exactly:
 *
 *   api.ts shape,    GET  hung 400 ms deadline → rejected at 403 ms, TimeoutError
 *   api.ts shape,    POST hung 400 ms deadline → rejected at 402 ms, TimeoutError
 *   client.ts shape, GET  hung 400 ms deadline → rejected at 403 ms, TimeoutError
 *   client.ts shape, POST hung 400 ms deadline → rejected at 402 ms, TimeoutError
 *   a response BODY that never ends, 500 ms    → rejected at 503 ms, AbortError
 *
 * The last one matters on its own: both callers `await res.json()` after the
 * fetch resolves, so a deadline that covered only the headers would not have
 * been a deadline.
 *
 * The other documented differences are all inert here: `integrity` is not used,
 * `Response.type`/`.url` are not read (the code reads `res.ok`, `res.status`,
 * `res.json()`, `res.text()`), `file:` and custom protocols are irrelevant to
 * two https hosts, and this app registers no `webRequest` handler.
 *
 * ── THE FAILURE VOCABULARY CHANGES, AND THAT IS HANDLED ELSEWHERE ───────────
 * Chromium reports failures completely differently from undici: no `code`, no
 * `cause`, everything in the message — `Error("net::ERR_NAME_NOT_RESOLVED")`.
 * `describeFetchFailure` in `src/cloud/errors.ts` reads both vocabularies, so
 * the sentence the owner sees does not change with the stack underneath.
 *
 * ── NOTHING BELOW MAIN IMPORTS THIS ─────────────────────────────────────────
 * `src/cloud/` and `src/sync/` never import this file, and must not: they take
 * a `fetchImpl` and main supplies it. That seam already existed for the tests,
 * which is what makes this change two wiring lines rather than a refactor.
 */
import { app, net } from "electron";

/**
 * `net.fetch`, bound.
 *
 * It requires `app` to have emitted `ready`, which every caller satisfies: the
 * wizard is button-driven and the sync cycle runs in `afterBoot()`. The guard
 * below is not defensive tidiness — calling `net.fetch` before ready throws
 * from inside Electron with a message that names none of this, and a
 * reachability check that dies that way would look exactly like the network
 * failure it was trying to diagnose.
 */
export const appFetch: typeof fetch = (input, init) => {
  if (!app.isReady()) {
    return Promise.reject(
      new Error(
        "an outbound request was made before the app was ready — nothing in " +
          "this app should do that, and Chromium's network stack does not " +
          "exist yet at that point",
      ),
    );
  }
  // `net.fetch` takes `string | Request` where the WHATWG signature also
  // allows a `URL`. Every caller in this app passes a string; the conversion is
  // here so that stays a fact about the callers rather than a constraint on
  // them.
  return net.fetch(input instanceof URL ? input.toString() : input, init);
};
