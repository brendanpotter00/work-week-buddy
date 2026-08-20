/**
 * The slice of the Cloudflare D1 surface this Worker actually uses.
 *
 * Declared here rather than pulled from `@cloudflare/workers-types` for two
 * reasons. First, it costs the repo no dependency and no install step for a
 * module whose whole job is four routes. Second — the load-bearing one — the
 * `node:sqlite` double in `worker/test/fake-d1.ts` implements *this* interface,
 * so the fake and the real binding are held to the same contract by the
 * compiler instead of by hope.
 *
 * These declarations are structurally compatible with the official ones: when
 * `@cloudflare/workers-types` is added at deploy time, `import type` from there
 * instead and nothing else changes.
 */

export interface D1Result<T = Record<string, unknown>> {
  readonly results: T[];
  readonly success: boolean;
}

export interface D1PreparedStatement {
  /** D1 returns a NEW statement rather than mutating; the fake does too. */
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result<never>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  /** All statements commit or none do — D1 runs a batch as one transaction. */
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]>;
}

export interface Env {
  readonly DB: D1Database;
  /** 32 random bytes, base64. Set with `wrangler secret put`, never committed. */
  readonly TOKEN_PERSONAL: string;
  readonly TOKEN_WORK: string;
  /**
   * The IOPlatformUUID each token stands for. The Worker stamps this onto every
   * row, so a stolen token cannot forge the other machine's rows. Optional: an
   * unset value falls back to the slot name, which keeps a fresh deploy
   * coherent before the ids are known.
   */
  readonly MACHINE_ID_PERSONAL?: string | undefined;
  readonly MACHINE_ID_WORK?: string | undefined;
}

/** The presence answer. `seq` is what the client stores as `cloud_seq`. */
export interface PresentRow {
  readonly id: string;
  readonly seq: number;
}

/**
 * The default-export shape workerd invokes. The runtime passes an
 * `ExecutionContext` third argument that this Worker has no use for — nothing
 * here outlives its response — so it is simply not declared.
 */
export interface ExportedHandler<E> {
  fetch(request: Request, env: E): Promise<Response>;
}
