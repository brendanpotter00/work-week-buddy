/**
 * Reading values back out of `node:sqlite`.
 *
 * Rows arrive as `Record<string, null | number | bigint | string | Uint8Array>`.
 * A missing column reads as `undefined`, which would coerce to `NaN` and then
 * to a plausible-looking wrong number several layers away. Programmer error
 * throws here instead, at the row that caused it.
 */
export type SqlValue = null | number | bigint | string | ArrayBufferView | undefined;

export type Row = Record<string, SqlValue>;

export function n(row: Row, col: string): number {
  const v = row[col];
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new Error(`column ${col}: expected a number, got ${describe(v)}`);
}

export function nOrNull(row: Row, col: string): number | null {
  const v = row[col];
  if (v === null) return null;
  return n(row, col);
}

export function s(row: Row, col: string): string {
  const v = row[col];
  if (typeof v === "string") return v;
  throw new Error(`column ${col}: expected text, got ${describe(v)}`);
}

export function sOrNull(row: Row, col: string): string | null {
  const v = row[col];
  if (v === null) return null;
  return s(row, col);
}

/** `SUM()` over no rows is NULL. That is zero hours, not a crash and not NaN. */
export function nOrZero(row: Row | undefined, col: string): number {
  if (row === undefined) return 0;
  return nOrNull(row, col) ?? 0;
}

function describe(v: SqlValue): string {
  if (v === undefined) return "undefined (no such column?)";
  if (v === null) return "null";
  return `${typeof v} ${String(v)}`;
}
