/**
 * The machine id.
 *
 * `docs/DATA_MODEL.md` specifies `IOPlatformUUID` — stable across reinstalls,
 * unique per Mac, and the key the cross-machine union merge groups on. Getting
 * it wrong is not a cosmetic bug: a machine id that changes forks one Mac's
 * history into two, and the union merge then double-counts every overlap.
 *
 * `ioreg` is read rather than an FFI call because it needs no permission, no
 * koffi declaration, and no WindowServer connection, and because it is the same
 * value the rest of the system reports.
 */
import { execFileSync } from "node:child_process";

const UUID_RE = /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]+)"/;

export function parsePlatformUuid(ioregOutput: string): string | null {
  const m = UUID_RE.exec(ioregOutput);
  return m?.[1] ?? null;
}

/**
 * `null` when it cannot be read — on a non-Mac, or if `ioreg` ever changes its
 * output. The caller falls back to a persisted random id and records the fact,
 * because silently minting a NEW id on every launch is the failure mode here.
 */
export function readPlatformUuid(
  run: () => string = () =>
    execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
      encoding: "utf8",
    }),
): string | null {
  if (process.platform !== "darwin") return null;
  try {
    return parsePlatformUuid(run());
  } catch {
    return null;
  }
}
