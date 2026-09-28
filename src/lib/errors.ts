/**
 * The message of a caught value, whatever was thrown: an `Error`'s own,
 * or the value rendered as text. Every `catch (err)` is `unknown`
 * (standard 4.4), and this is the one place that narrows it.
 */
export function errorMessage(err: unknown, fallback = 'unknown error'): string {
  if (err === undefined || err === null) return fallback;
  if (err instanceof Error) return err.message || fallback;
  if (typeof err === 'string') return err || fallback;
  return String(err) || fallback;
}

/** The `code` a Node system error carries (`ECONNREFUSED`, `ENOENT`), when the value is one. */
export function errnoCode(err: unknown): string | undefined {
  return typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'string'
    ? (err as { code: string }).code
    : undefined;
}
