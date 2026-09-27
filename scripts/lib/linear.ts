/**
 * Day0's own Linear calls, for the scripts that set up and put back a
 * workspace (the company bed and its rehearsal): one GraphQL client with a
 * single transient retry, and the comment reads and deletes both of them use.
 * Every call is a named GraphQL document with its ids as variables, so the key
 * never travels in a query string and a test can read the exact request.
 */

const ENDPOINT = 'https://api.linear.app/graphql';
/** How long one Linear call may take before it counts as a timeout. */
export const LINEAR_TIMEOUT_MS = 30_000;
/** The pause before the one retry when Linear did not say how long to wait. */
export const RETRY_PAUSE_MS = 2_000;
/** The longest wait a retry honours; Linear asking for more is reported instead. */
export const MAX_RETRY_WAIT_MS = 60_000;

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

/** A Linear call that failed, and whether a second attempt could succeed. */
export class LinearRequestError extends Error {
  /**
   * Args:
   *   message: What failed, for the line that reports it.
   *   reason: The failure in the words a retry line uses: `a timeout`, `HTTP 503`.
   *   transient: True for a timeout, a network failure, a 5xx or a rate
   *     limit; false when Linear refused the request as it was sent.
   *   waitMs: How long Linear asked to wait before the next call, when it said.
   */
  constructor(
    message: string,
    readonly reason: string,
    readonly transient: boolean,
    readonly waitMs?: number,
  ) {
    super(message);
    this.name = 'LinearRequestError';
  }
}

/** Where a retry says what it is doing, and how it waits. */
export interface RetryIo {
  say(line: string): void;
  sleep(ms: number): Promise<void>;
}

function seconds(ms: number): number {
  return Math.ceil(ms / 1_000);
}

/**
 * Run one Linear call, and once more when it failed in a way a second
 * attempt could survive.
 *
 * Args:
 *   what: The call in the output's words: `label delete`.
 *   io: Where the retry line goes, and how the pause is waited.
 *   first: The call.
 *   again: The second attempt, given the first failure. A write whose first
 *     attempt may have landed before the failure re-reads here and is sent
 *     again only when it did not land. Defaults to the call itself.
 *
 * Returns:
 *   What whichever attempt succeeded returned.
 *
 * Raises:
 *   Error: The first failure unchanged when it is not a transient Linear
 *     failure; a LinearRequestError naming both failures when the retry fails
 *     too, or naming the wait when Linear asked for longer than
 *     MAX_RETRY_WAIT_MS.
 */
export async function retryOnce<T>(
  what: string,
  io: RetryIo,
  first: () => Promise<T>,
  again: (failure: LinearRequestError) => Promise<T> = first,
): Promise<T> {
  try {
    return await first();
  } catch (error) {
    if (!(error instanceof LinearRequestError) || !error.transient) throw error;
    const asked = error.waitMs;
    if (asked !== undefined && asked > MAX_RETRY_WAIT_MS) {
      throw new LinearRequestError(
        `${what} failed: Linear asked to wait ${seconds(asked)} s after ${error.reason}, longer than the ${seconds(MAX_RETRY_WAIT_MS)} s a retry waits`,
        error.reason,
        false,
        asked,
      );
    }
    io.say(
      `retrying ${what} after ${error.reason}${asked === undefined ? '' : `, in ${seconds(asked)} s as Linear asked`}`,
    );
    await io.sleep(asked ?? RETRY_PAUSE_MS);
    try {
      return await again(error);
    } catch (second) {
      const reason =
        second instanceof LinearRequestError && second.transient
          ? second.reason
          : (second as Error).message;
      throw new LinearRequestError(
        `${what} failed twice: ${error.reason}, then ${reason}`,
        reason,
        false,
      );
    }
  }
}

/** Milliseconds a `Retry-After` header asks for: delta seconds or an HTTP date. */
function retryAfterMs(header: string | null, now: number): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Milliseconds until the rate-limit window Linear names (UTC epoch milliseconds) ends. */
function resetMs(header: string | null, now: number): number | undefined {
  const at = Number(header?.trim() || Number.NaN);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** The failure a rejected fetch or body read stands for; anything else is not Linear's. */
function transportFailure(error: unknown): unknown {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new LinearRequestError(
      `Linear did not answer within ${seconds(LINEAR_TIMEOUT_MS)} s.`,
      'a timeout',
      true,
    );
  }
  if (error instanceof TypeError && error.message === 'fetch failed') {
    const cause = (error as { cause?: { message?: string } }).cause?.message;
    return new LinearRequestError(
      `Linear could not be reached${cause ? ` (${cause})` : ''}.`,
      'a network failure',
      true,
    );
  }
  return error;
}

/** A GraphQL client over one API key and an injectable fetch. */
export class LinearClient {
  /**
   * Args:
   *   apiKey: The personal API key, sent as the authorization header.
   *   fetchImpl: The fetch to call Linear with.
   *   now: The clock a rate-limit reset is measured against.
   */
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Run one document.
   *
   * Args:
   *   query: The GraphQL document.
   *   variables: Its variables.
   *
   * Returns:
   *   The `data` object.
   *
   * Raises:
   *   LinearRequestError: On a timeout, a network failure, an HTTP failure or
   *     a GraphQL error list, saying whether a second attempt could succeed.
   */
  async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(LINEAR_TIMEOUT_MS),
      });
      // The timeout also runs while the body arrives, so it is read inside the same guard.
      text = await response.text();
    } catch (error) {
      throw transportFailure(error);
    }
    let parsed: GraphqlResponse<T> | undefined;
    try {
      parsed = JSON.parse(text) as GraphqlResponse<T>;
    } catch {
      parsed = undefined;
    }
    const errors = parsed?.errors ?? [];
    const listed = errors.map((error) => error.message).join('; ');
    const status = `HTTP ${response.status}`;
    const now = this.now();
    // Linear answers a rate limit with HTTP 400 and RATELIMITED, not 429.
    if (errors.some((error) => error.extensions?.code === 'RATELIMITED')) {
      const wait =
        retryAfterMs(response.headers.get('retry-after'), now) ??
        resetMs(response.headers.get('x-ratelimit-requests-reset'), now);
      throw new LinearRequestError(
        `Linear rate-limited the call: ${listed}`,
        'a Linear rate limit',
        true,
        wait,
      );
    }
    if (response.status === 429) {
      const wait = retryAfterMs(response.headers.get('retry-after'), now);
      throw new LinearRequestError(`Linear answered ${status}.`, status, true, wait);
    }
    if (response.status >= 500) {
      throw new LinearRequestError(
        `Linear answered ${status}${listed ? `: ${listed}` : '.'}`,
        status,
        true,
      );
    }
    if (errors.length > 0) throw new LinearRequestError(`Linear: ${listed}`, status, false);
    if (!response.ok || parsed?.data === undefined) {
      throw new LinearRequestError(`Linear answered ${status} with no data.`, status, false);
    }
    return parsed.data;
  }
}

export interface IssueComment {
  id: string;
  body: string;
  createdAt: string;
}

const ISSUE_COMMENTS = `query RehearsalComments($id: String!) {
  issue(id: $id) { comments { nodes { id body createdAt } } }
}`;

const COMMENT_DELETE = `mutation RehearsalCommentDelete($id: String!) {
  commentDelete(id: $id) { success }
}`;

/** Every comment on the issue, oldest first as Linear orders them. */
export async function readComments(client: LinearClient, issueId: string): Promise<IssueComment[]> {
  const data = await client.request<{ issue: { comments: { nodes: IssueComment[] } } }>(
    ISSUE_COMMENTS,
    { id: issueId },
  );
  return data.issue.comments.nodes;
}

/** Delete one comment. */
export async function deleteComment(client: LinearClient, commentId: string): Promise<void> {
  const data = await client.request<{ commentDelete: { success: boolean } }>(COMMENT_DELETE, {
    id: commentId,
  });
  if (!data.commentDelete.success)
    throw new Error(`Linear commentDelete ${commentId} did not succeed.`);
}
