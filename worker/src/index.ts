/**
 * wwb-sync — the whole cloud tier.
 *
 * An append-only interval store for however many Macs are enrolled, plus a
 * liveness ping and a reconciliation fingerprint. It is deliberately tiny: the
 * local mirror is the source of truth for every render, and the cloud is only
 * ever a reconciliation target. See docs/IMPL_STORE_SYNC.md §7.
 *
 * Order of operations in `fetch` is itself a security property:
 *
 *   route lookup → is it public? → authenticate → dispatch
 *
 * Authentication runs before the 404 for everything except `/health`, so an
 * unauthenticated caller cannot map the route surface by watching which paths
 * answer 404 and which answer 401. An *authenticated* caller asking for
 * `DELETE /intervals` still gets 404, because no such handler exists to reach.
 *
 * The one thing reachable anonymously besides `/health` is the 503 for a
 * registry that cannot be read. It reveals only "this deployment's schema was
 * never applied" — not a secret, and precisely the diagnostic wanted.
 */

import { authenticate, RegistryUnavailable } from "./auth.js";
import { lookupRoute } from "./routes.js";
import type { Env, ExportedHandler } from "./types.js";

const UNAUTHORIZED = (): Response =>
  new Response("unauthorized", {
    status: 401,
    headers: { "www-authenticate": "Bearer" },
  });

const NOT_FOUND = (): Response => new Response("not found", { status: 404 });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(req.url);
      const route = lookupRoute(req.method, url.pathname);

      if (route && !route.auth) {
        return await route.handler({ req, env, url, machineId: "" });
      }

      let machineId: string | null;
      try {
        machineId = await authenticate(req, env);
      } catch (err) {
        if (err instanceof RegistryUnavailable) {
          console.error("wwb-sync registry unavailable", err);
          // 503, not 401 and not 500. The Worker is running and the URL is
          // right; what is missing is the schema. A 401 here would tell someone
          // to re-copy a token that is already perfect.
          return new Response("machine registry unavailable", { status: 503 });
        }
        throw err;
      }
      if (machineId === null) return UNAUTHORIZED();
      if (!route) return NOT_FOUND();

      return await route.handler({ req, env, url, machineId });
    } catch (err) {
      // A throw here would otherwise surface as an opaque 500 with nothing in
      // the log. The client treats any non-2xx identically — it backs off and
      // retries the same ids — so failing loudly costs nothing and a rejected
      // batch stays safely un-marked. AGENTS.md #8.
      console.error("wwb-sync request failed", err);
      return new Response("internal error", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
