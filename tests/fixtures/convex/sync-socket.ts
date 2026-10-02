/**
 * A Convex deployment at the other end of the browser client's socket: the network seam of the
 * real `ConvexReactClient`, for a test that must see what the client sends and in what order.
 *
 * It speaks just enough of the sync protocol for a page's queries: it records every message the
 * client sends, tracks the query set and the identity the client has asked for, and answers each
 * change with one `Transition` whose modifications the test's `answer` decides. A query the
 * answer leaves out stays loading, as one the deployment is still running does.
 */

/** What the deployment answers a query with: its value, or the message it threw. */
export type QueryAnswer = { readonly value: unknown } | { readonly error: string };

/**
 * How the deployment answers a query.
 *
 * @param udfPath - The query's path, `module:function`.
 * @param signedIn - Whether the client has authenticated with a user token.
 * @param subject - The `sub` of that token, so two users can be answered apart; null when
 *   signed out or the token carries none.
 * @returns The answer, or undefined to leave the query loading.
 */
export type Answer = (
  udfPath: string,
  signedIn: boolean,
  subject: string | null,
) => QueryAnswer | undefined;

/** A message the client sent, as parsed from the wire. */
export interface ClientMessage {
  readonly type: string;
  readonly [field: string]: unknown;
}

/** The deployment, and the socket class the client is to be given in place of `WebSocket`. */
export interface SyncServer {
  /** Every message the client sent, in order. */
  readonly sent: readonly ClientMessage[];
  /** Stands in for `WebSocket`; every instance talks to this deployment. */
  readonly Socket: new (url: string) => unknown;
  /** Whether nothing is on the wire: every socket opened and every answer delivered. */
  quiet(): boolean;
  /**
   * Answer every query the client holds again, in one transition: a write on the deployment
   * changed what they read, as another manager's acceptance does.
   */
  rerun(): void;
}

interface QueryAdd {
  readonly type: 'Add';
  readonly queryId: number;
  readonly udfPath: string;
}

interface QueryRemove {
  readonly type: 'Remove';
  readonly queryId: number;
}

/** The protocol's timestamps are unsigned 64-bit integers, little-endian and base64 encoded. */
function encodeTs(ts: number): string {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(ts));
  return bytes.toString('base64');
}

/** The `sub` of a JWT's payload, read without checking its signature (the deployment's job). */
function subjectOf(token: unknown): string | null {
  if (typeof token !== 'string') return null;
  const payload = token.split('.')[1];
  if (payload === undefined) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: unknown;
    };
    return typeof claims.sub === 'string' ? claims.sub : null;
  } catch {
    // Not a JWT this double can read: the client is signed in as nobody it can name.
    return null;
  }
}

function modificationFor(queryId: number, answer: QueryAnswer): Record<string, unknown> {
  return 'error' in answer
    ? { type: 'QueryFailed', queryId, errorMessage: answer.error, logLines: [], journal: null }
    : { type: 'QueryUpdated', queryId, value: answer.value, logLines: [], journal: null };
}

/**
 * Start a deployment that answers through `answer`.
 *
 * @param answer - How each query is answered, given whether the client is signed in.
 */
export function syncServer(answer: Answer): SyncServer {
  const sent: ClientMessage[] = [];
  const queries = new Map<number, string>();
  let signedIn = false;
  let subject: string | null = null;
  let inFlight = 0;
  let version = { querySet: 0, identity: 0, ts: 0 };

  const transition = (
    next: { readonly querySet: number; readonly identity: number },
    answered: readonly number[],
  ): string => {
    const start = version;
    version = { ...next, ts: start.ts + 1 };
    const modifications = answered.flatMap((queryId) => {
      const path = queries.get(queryId);
      const reply = path === undefined ? undefined : answer(path, signedIn, subject);
      return reply === undefined ? [] : [modificationFor(queryId, reply)];
    });
    return JSON.stringify({
      type: 'Transition',
      startVersion: { querySet: start.querySet, identity: start.identity, ts: encodeTs(start.ts) },
      endVersion: {
        querySet: version.querySet,
        identity: version.identity,
        ts: encodeTs(version.ts),
      },
      modifications,
    });
  };

  const reply = (message: ClientMessage): string | undefined => {
    if (message.type === 'ModifyQuerySet') {
      const changes = message.modifications as ReadonlyArray<QueryAdd | QueryRemove>;
      const added: number[] = [];
      for (const change of changes) {
        if (change.type === 'Add') {
          queries.set(change.queryId, change.udfPath);
          added.push(change.queryId);
        } else {
          queries.delete(change.queryId);
        }
      }
      return transition({ querySet: message.newVersion as number, identity: version.identity }, added);
    }
    if (message.type === 'Authenticate') {
      signedIn = message.tokenType === 'User';
      subject = signedIn ? subjectOf(message.value) : null;
      // A new identity reruns every query the client holds.
      return transition(
        { querySet: version.querySet, identity: (message.baseVersion as number) + 1 },
        [...queries.keys()],
      );
    }
    return undefined;
  };

  const open = new Set<{ deliver(data: string): void }>();

  class Socket {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    readyState = 0;
    readonly url: string;

    constructor(url: string) {
      this.url = url;
      inFlight += 1;
      open.add(this);
      setTimeout(() => {
        inFlight -= 1;
        this.readyState = 1;
        this.onopen?.();
      }, 0);
    }

    send(data: string): void {
      const message = JSON.parse(data) as ClientMessage;
      sent.push(message);
      const answerText = reply(message);
      if (answerText === undefined) return;
      this.deliver(answerText);
    }

    /** Hands the client one message from the deployment, on a later turn of the event loop. */
    deliver(data: string): void {
      inFlight += 1;
      setTimeout(() => {
        inFlight -= 1;
        this.onmessage?.({ data });
      }, 0);
    }

    close(): void {
      // The test ends the page; nothing reconnects to a deployment that is going away.
      this.readyState = 3;
      open.delete(this);
    }
  }

  const rerun = (): void => {
    const text = transition(
      { querySet: version.querySet, identity: version.identity },
      [...queries.keys()],
    );
    for (const socket of open) socket.deliver(text);
  };

  return { sent, Socket, quiet: (): boolean => inFlight === 0, rerun };
}
