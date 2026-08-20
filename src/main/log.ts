/**
 * One logger, so a diagnostic line is greppable and a stack trace is not lost
 * inside a `void promise.catch(() => {})`.
 */
export const log = {
  info(msg: string, detail?: unknown): void {
    if (detail === undefined) console.log(`[wwb] ${msg}`);
    else console.log(`[wwb] ${msg}`, detail);
  },
  warn(msg: string, detail?: unknown): void {
    if (detail === undefined) console.warn(`[wwb] ${msg}`);
    else console.warn(`[wwb] ${msg}`, detail);
  },
  error(msg: string, detail?: unknown): void {
    if (detail === undefined) console.error(`[wwb] ${msg}`);
    else console.error(`[wwb] ${msg}`, detail);
  },
};
