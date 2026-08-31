/**
 * Turn a backend failure into the sentence a person should read.
 *
 * A Convex action that throws reaches the browser wrapped: the function name,
 * a request id, `Server Error`, `Uncaught Error:`, the stack frames and
 * `Called by client`. That envelope is right for a log and wrong for a form,
 * where it buries a message written for a human under four lines of file paths
 * and turns "start this component" into something that looks like a crash.
 *
 * Only the envelope is removed. Nothing is shortened, reworded or truncated,
 * and a message with no envelope comes back as it was - so a failure this does
 * not recognise still reaches the reader whole.
 */

/** Lines that are frame or plumbing rather than message. */
const FRAME = /^\s*at\s/;

/**
 * Strip the transport's envelope from an error message.
 *
 * Args:
 *   raw: The message as the client received it.
 *
 * Returns:
 *   The message a person should read, or the original when nothing was found
 *   to strip.
 */
export function plainErrorMessage(raw: string): string {
  const kept = raw
    .split('\n')
    .filter((line: string): boolean => !FRAME.test(line))
    .map((line: string): string =>
      line
        .replace(/^\s*\[CONVEX [^\]]*\]\s*/, '')
        .replace(/^\s*\[Request ID:[^\]]*\]\s*/, '')
        .replace(/^\s*Server Error\s*/, '')
        .replace(/^\s*Uncaught\s+\w*Error:\s*/, '')
        .replace(/^\s*Called by client\s*$/, '')
        .trim(),
    )
    .filter(Boolean);
  return kept.join(' ') || raw.trim();
}
