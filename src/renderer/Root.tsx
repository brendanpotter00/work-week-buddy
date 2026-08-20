/**
 * One bundle, two windows — the seam that had no test.
 *
 * `src/main/windows.ts` opens the dashboard at `#/` and the onboarding window
 * at `#/onboarding`, and until this file existed `main.tsx` mounted `<App />`
 * unconditionally: the 560 × 640 non-resizable onboarding window rendered the
 * whole 1100-px dashboard, one word per line. `test/renderer/routing.test.tsx`
 * and the launched-app smoke run (`npm run smoke`) both assert the pairing now.
 *
 * Both views ship in one chunk on purpose. `React.lazy` would buy a smaller
 * onboarding payload and cost a Suspense fallback frame in a window whose whole
 * job is to be legible immediately, over a protocol that is reading a local
 * file.
 */
import * as React from "react";

import { App } from "./App";
import { Onboarding } from "./Onboarding";
import { useRoute } from "./lib/route";

export function Root(): React.ReactElement {
  return useRoute() === "onboarding" ? <Onboarding /> : <App />;
}

export default Root;
