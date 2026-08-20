/**
 * THREE STATES, NOT TWO — the rule `src/main/sync-seam.ts` states and the
 * doctor's `sync.configured` already carries, turned into pixels.
 *
 * > False means no Worker URL and no token — which is neither healthy nor
 * > failing, and must not be painted as either.
 *
 * That distinction is the whole reason this is a pure function with its own
 * tests rather than a ternary inside a card. An owner who has not deployed a
 * Worker yet must never see a red error about a network he never asked us to
 * reach; an owner whose token is wrong must never see a calm grey line that
 * reads exactly like "you haven't set this up". Both are one `if` away from the
 * other, and both have shipped in other apps.
 *
 * A fourth tone, `unknown`, exists only for the frame before the first snapshot
 * lands. It is not a claim about anything.
 */
import type { DoctorReport, SyncConfigState } from "@/shared/ipc-types";

export type SyncTone = "unknown" | "unconfigured" | "healthy" | "failing";

export interface SyncHealthView {
  tone: SyncTone;
  /** The badge. Short enough to sit beside a heading. */
  label: string;
  /** One sentence saying what is true and, when something is missing, what to do. */
  note: string;
  /** Everything wrong, most-damaging first. Empty unless the tone is `failing`. */
  problems: string[];
}

/** DATA_MODEL backup layer 4: nothing has reached the cloud in three days. */
const SILENT_LIMIT_MS = 72 * 3_600_000;

export function syncHealthView(
  config: SyncConfigState | null,
  doctor: DoctorReport | null,
): SyncHealthView {
  if (config === null) {
    return { tone: "unknown", label: "Checking…", note: " ", problems: [] };
  }

  // A URL that is set but is not a URL is a TYPO, not an empty install. It is
  // the one unconfigured state that gets an error, because "not configured"
  // with no explanation for a field you know you filled in is the worst of the
  // three things to be shown (`resolveSyncConfig`, same reasoning).
  if (!config.configured && config.error !== null) {
    return {
      tone: "failing",
      label: "Not set up",
      note: "What is saved cannot be used.",
      problems: [config.error],
    };
  }

  if (!config.configured) {
    if (!config.vaultAvailable) {
      // No keychain means no token can be stored AT ALL, so this is not a step
      // the owner can take — saying "enter a token" would be a lie.
      return {
        tone: "failing",
        label: "Unavailable",
        note: "This Mac has no keychain available, so the token cannot be stored safely — and it will not be stored any other way.",
        problems: [],
      };
    }
    const hasUrl = config.workerUrl.trim() !== "";
    return {
      tone: "unconfigured",
      label: "Not set up",
      note:
        hasUrl && !config.tokenPresent
          ? "The Worker URL is saved. Paste this Mac’s token to finish."
          : !hasUrl && config.tokenPresent
            ? "A token is stored. Add the Worker URL to finish."
            : "Every hour is recorded and kept on this Mac. Nothing is sent anywhere until you set this up.",
      problems: [],
    };
  }

  const sync = doctor?.sync ?? null;
  const fingerprint = doctor?.fingerprint ?? null;
  const problems: string[] = [];

  // Most damaging first: a fingerprint mismatch means rows are MISSING, which
  // outranks a single failed request that will be retried.
  if (fingerprint?.matched === false) {
    problems.push(
      `The cloud and this Mac disagree about how many rows exist — ${String(
        fingerprint.localCount ?? "?",
      )} here, ${String(fingerprint.cloudCount ?? "?")} there.`,
    );
  }
  if (sync !== null && sync.silentForMs !== null && sync.silentForMs > SILENT_LIMIT_MS) {
    problems.push(
      `Nothing has reached the cloud for ${String(Math.floor(sync.silentForMs / 3_600_000))} hours.`,
    );
  }
  if (sync?.lastFlushError != null) problems.push(`Last upload failed: ${sync.lastFlushError}`);
  // A pull can fail while the flush that preceded it succeeded. Separate field,
  // separate truth, separate line.
  if (sync?.lastPullError != null) problems.push(`Last download failed: ${sync.lastPullError}`);

  if (problems.length > 0) {
    return {
      tone: "failing",
      label: "Not syncing",
      note: "Set up, but not getting through. Nothing is lost — every row stays here until it is confirmed.",
      problems,
    };
  }

  return {
    tone: "healthy",
    label: "Syncing",
    note:
      sync !== null && sync.pendingRows > 0
        ? `${String(sync.pendingRows)} row${sync.pendingRows === 1 ? "" : "s"} waiting to go up.`
        : "Everything recorded here has been confirmed by the cloud.",
    problems: [],
  };
}

/**
 * Is this a URL we would actually call? The same test `resolveSyncConfig` runs
 * in main, run before the round trip so a typo is rejected next to the field
 * rather than three seconds later next to nothing.
 *
 * Returns the reason it is not, or `null` when it is fine. A blank string is
 * fine here: clearing the URL is how you turn sync off.
 */
export function workerUrlError(raw: string): string | null {
  const url = raw.trim();
  if (url === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "That is not a URL. It looks like https://wwb-sync.<account>.workers.dev";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return `A Worker URL is http or https, not ${parsed.protocol.replace(":", "")}.`;
  }
  if (parsed.hostname === "") return "That URL has no host.";
  return null;
}
