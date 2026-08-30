/**
 * Work-item states the evaluation treats as final.
 *
 * Shared by the harness's poll loop and the backend's timeout mutation so
 * that neither can terminalise, or keep waiting on, a row the other regards
 * as settled.
 */
export const EVALUATION_TERMINAL_STATES: ReadonlySet<string> = new Set([
  'completed',
  'cancelled',
  'failed',
  'skipped',
  'deferred',
]);

/** Whether a work-item state is final for the evaluation. */
export function isTerminalWorkState(state: string): boolean {
  return EVALUATION_TERMINAL_STATES.has(state);
}
