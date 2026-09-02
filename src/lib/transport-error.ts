/** Connection-failure markers preserved by Node, fetch and the MCP client. */
const UNREACHABLE_MARKERS = [
  'econnrefused',
  'enotfound',
  'eai_again',
  'ehostunreach',
  'enetunreach',
  'etimedout',
  'econnreset',
  'fetch failed',
  'failed to fetch',
  'connection refused',
  'socket hang up',
  'network error',
  'getaddrinfo',
  'could not connect',
  'failed to connect',
  'unable to connect',
  'connection closed',
] as const;

/** Whether an error chain says that no transport answered. */
export function isTransportUnreachable(error: unknown): boolean {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (typeof current === 'string') {
      parts.push(current);
      break;
    }
    if (!(current instanceof Error)) break;
    parts.push(current.message);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') parts.push(code);
    current = current.cause;
  }
  const text = parts.join(' ').toLowerCase();
  return UNREACHABLE_MARKERS.some((marker: string): boolean => text.includes(marker));
}
