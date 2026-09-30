/**
 * How long a room waits for its session before saying the one-to-one could not start. Opening a
 * session is one mutation; a client that has lost its connection queues it and would wait for
 * ever without this.
 */
export const START_DEADLINE_MS = 15_000;

/**
 * How long a room waits on one turn of the employee's before it stops waiting and offers Ask
 * again: the chat route's own 60-second cut (`maxDuration`) and a margin. A turn past it has
 * stalled somewhere the route's cut cannot reach (a dropped connection that never closed, a
 * platform that held the request), and the manager's reply is already kept on the session.
 */
export const TURN_DEADLINE_MS = 75_000;

/**
 * Settle with the work, or reject with `reason` once `ms` has passed, whichever comes first. The
 * work itself is not cancelled: a room that stopped waiting ignores what it later settles to.
 *
 * @param reason - The sentence the room shows when the deadline wins.
 * @throws Error with `reason` at the deadline.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject): void => {
    timer = setTimeout((): void => reject(new Error(reason)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
