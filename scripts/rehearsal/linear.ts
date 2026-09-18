/**
 * The rehearsal's own Linear calls: read the workspace before, assign the
 * ticket, read it back after, and put it back. Every call is a named GraphQL
 * document with its ids as variables, so the key never travels in a query
 * string and a test can read the exact request.
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
    io.say(`retrying ${what} after ${error.reason}${asked === undefined ? '' : `, in ${seconds(asked)} s as Linear asked`}`);
    await io.sleep(asked ?? RETRY_PAUSE_MS);
    try {
      return await again(error);
    } catch (second) {
      const reason = second instanceof LinearRequestError && second.transient ? second.reason : (second as Error).message;
      throw new LinearRequestError(`${what} failed twice: ${error.reason}, then ${reason}`, reason, false);
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
    return new LinearRequestError(`Linear did not answer within ${seconds(LINEAR_TIMEOUT_MS)} s.`, 'a timeout', true);
  }
  if (error instanceof TypeError && error.message === 'fetch failed') {
    const cause = (error as { cause?: { message?: string } }).cause?.message;
    return new LinearRequestError(`Linear could not be reached${cause ? ` (${cause})` : ''}.`, 'a network failure', true);
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
      throw new LinearRequestError(`Linear rate-limited the call: ${listed}`, 'a Linear rate limit', true, wait);
    }
    if (response.status === 429) {
      const wait = retryAfterMs(response.headers.get('retry-after'), now);
      throw new LinearRequestError(`Linear answered ${status}.`, status, true, wait);
    }
    if (response.status >= 500) {
      throw new LinearRequestError(`Linear answered ${status}${listed ? `: ${listed}` : '.'}`, status, true);
    }
    if (errors.length > 0) throw new LinearRequestError(`Linear: ${listed}`, status, false);
    if (!response.ok || parsed?.data === undefined) {
      throw new LinearRequestError(`Linear answered ${status} with no data.`, status, false);
    }
    return parsed.data;
  }
}

export interface IssueSnapshot {
  id: string;
  identifier: string;
  stateId: string;
  stateName: string;
  assigneeId: string | null;
  commentIds: string[];
}

export interface IssueComment {
  id: string;
  body: string;
  createdAt: string;
}

/** One entry of an issue's history, reduced to who moved it between which states. */
export interface IssueStateChange {
  actorId: string | null;
  fromStateId: string | null;
  toStateId: string | null;
}

const VIEWER = `query RehearsalViewer { viewer { id name } }`;

const ISSUE_SNAPSHOT = `query RehearsalIssue($id: String!) {
  issue(id: $id) {
    id
    identifier
    state { id name }
    assignee { id }
    comments { nodes { id } }
  }
}`;

const ISSUE_COMMENTS = `query RehearsalComments($id: String!) {
  issue(id: $id) { comments { nodes { id body createdAt } } }
}`;

const ISSUE_STATE_HISTORY = `query RehearsalStateHistory($id: String!) {
  issue(id: $id) {
    history { nodes { id createdAt actor { id } fromState { id } toState { id } } }
  }
}`;

const MUTATION_NAMES = `query RehearsalMutations { __type(name: "Mutation") { fields { name } } }`;

const ISSUE_UPDATE = `mutation RehearsalIssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

const COMMENT_DELETE = `mutation RehearsalCommentDelete($id: String!) {
  commentDelete(id: $id) { success }
}`;

/** The key's own user, who the ticket is assigned to as the manager. */
export async function readViewer(client: LinearClient): Promise<{ id: string; name: string }> {
  const data = await client.request<{ viewer: { id: string; name: string } }>(VIEWER);
  return { id: data.viewer.id, name: data.viewer.name };
}

/**
 * The issue's state, assignee and comment ids, read by identifier.
 *
 * Args:
 *   client: The client.
 *   identifier: `REVOPS-n`.
 *
 * Returns:
 *   The snapshot.
 */
export async function readIssueSnapshot(
  client: LinearClient,
  identifier: string,
): Promise<IssueSnapshot> {
  const data = await client.request<{
    issue: {
      id: string;
      identifier: string;
      state: { id: string; name: string };
      assignee: { id: string } | null;
      comments: { nodes: Array<{ id: string }> };
    } | null;
  }>(ISSUE_SNAPSHOT, { id: identifier });
  if (!data.issue) throw new Error(`Linear has no issue ${identifier}.`);
  return {
    id: data.issue.id,
    identifier: data.issue.identifier,
    stateId: data.issue.state.id,
    stateName: data.issue.state.name,
    assigneeId: data.issue.assignee?.id ?? null,
    commentIds: data.issue.comments.nodes.map((node) => node.id),
  };
}

/**
 * The issue's history as state changes with their actors, oldest first.
 *
 * Args:
 *   client: The client.
 *   issueId: The issue's id.
 *
 * Returns:
 *   Every history entry; one that changed no state carries null states.
 */
export async function readStateHistory(client: LinearClient, issueId: string): Promise<IssueStateChange[]> {
  const data = await client.request<{
    issue: {
      history: {
        nodes: Array<{
          actor: { id: string } | null;
          fromState: { id: string } | null;
          toState: { id: string } | null;
        }>;
      };
    } | null;
  }>(ISSUE_STATE_HISTORY, { id: issueId });
  if (!data.issue) throw new Error(`Linear has no issue ${issueId}.`);
  return data.issue.history.nodes.map((node): IssueStateChange => ({
    actorId: node.actor?.id ?? null,
    fromStateId: node.fromState?.id ?? null,
    toStateId: node.toState?.id ?? null,
  }));
}

/**
 * Whether the key's own user moved the issue from the snapshot's state to
 * its current one: attribution the provider keeps, so a landed move whose
 * receipt was lost is still the run's to put back.
 *
 * Args:
 *   history: The issue's state changes.
 *   actorId: The key's user.
 *   fromStateId: The snapshot's state.
 *   toStateId: The current state.
 *
 * Returns:
 *   True when that actor made exactly that change.
 */
export function stateMovedByActor(
  history: readonly IssueStateChange[],
  actorId: string,
  fromStateId: string,
  toStateId: string,
): boolean {
  return history.some(
    (change: IssueStateChange): boolean =>
      change.actorId === actorId && change.fromStateId === fromStateId && change.toStateId === toStateId,
  );
}

/** Every comment on the issue, oldest first as Linear orders them. */
export async function readComments(client: LinearClient, issueId: string): Promise<IssueComment[]> {
  const data = await client.request<{ issue: { comments: { nodes: IssueComment[] } } }>(
    ISSUE_COMMENTS,
    { id: issueId },
  );
  return data.issue.comments.nodes;
}

/** The mutation names the schema exposes, so a cleanup step is checked before it is relied on. */
export async function readMutationNames(client: LinearClient): Promise<string[]> {
  const data = await client.request<{ __type: { fields: Array<{ name: string }> } }>(MUTATION_NAMES);
  return data.__type.fields.map((field) => field.name);
}

async function issueUpdate(
  client: LinearClient,
  issueId: string,
  input: Record<string, unknown>,
): Promise<void> {
  const data = await client.request<{ issueUpdate: { success: boolean } }>(ISSUE_UPDATE, {
    id: issueId,
    input,
  });
  if (!data.issueUpdate.success) throw new Error(`Linear issueUpdate on ${issueId} did not succeed.`);
}

/** Assign the issue, or unassign it with null. */
export async function assignIssue(
  client: LinearClient,
  issueId: string,
  assigneeId: string | null,
): Promise<void> {
  await issueUpdate(client, issueId, { assigneeId });
}

/** Move the issue to a workflow state by id. */
export async function moveIssue(client: LinearClient, issueId: string, stateId: string): Promise<void> {
  await issueUpdate(client, issueId, { stateId });
}

/** Delete one comment. */
export async function deleteComment(client: LinearClient, commentId: string): Promise<void> {
  const data = await client.request<{ commentDelete: { success: boolean } }>(COMMENT_DELETE, {
    id: commentId,
  });
  if (!data.commentDelete.success) throw new Error(`Linear commentDelete ${commentId} did not succeed.`);
}

export type RestoreStep =
  | { kind: 'delete-comment'; commentId: string }
  | { kind: 'move'; stateId: string }
  | { kind: 'assign'; assigneeId: string | null };

/**
 * What puts an issue back to its snapshot: the run's comments deleted, then
 * the state, then the assignee. Nothing the run did not change is touched.
 *
 * Args:
 *   before: The snapshot taken before the run.
 *   after: The issue as read after the run.
 *
 * Returns:
 *   The steps, in the order to apply them.
 */
export function issueRestoreSteps(
  before: IssueSnapshot,
  after: { stateId: string; assigneeId: string | null; commentIds: readonly string[] },
  written: { commentIds: readonly string[]; stateId?: string; assigneeId?: string | null } = { commentIds: [] },
): RestoreStep[] {
  const steps: RestoreStep[] = after.commentIds
    .filter((id: string): boolean => !before.commentIds.includes(id) && written.commentIds.includes(id))
    .map((commentId: string): RestoreStep => ({ kind: 'delete-comment', commentId }));
  if (after.stateId !== before.stateId && after.stateId === written.stateId) steps.push({ kind: 'move', stateId: before.stateId });
  if (after.assigneeId !== before.assigneeId && after.assigneeId === written.assigneeId) {
    steps.push({ kind: 'assign', assigneeId: before.assigneeId });
  }
  return steps;
}

/** Workflow states in which the ticket is not at rest for a rehearsal. */
const BUSY_STATES: readonly string[] = ['In Progress', 'Done', 'Canceled', 'Cancelled', 'Duplicate'];

/**
 * Why the ticket cannot be rehearsed on as found, if it cannot: an earlier
 * run's leftovers are reported for the operator to put back, never repaired
 * here, because this run did not make them.
 *
 * Args:
 *   snapshot: The ticket as read before the run.
 *
 * Returns:
 *   The refusal, or undefined when the ticket is unassigned and open.
 */
export function ticketRestRefusal(snapshot: IssueSnapshot): string | undefined {
  if (snapshot.assigneeId) {
    return `${snapshot.identifier} is already assigned (${snapshot.assigneeId}); an earlier run's leftover, unassign it first.`;
  }
  if (BUSY_STATES.includes(snapshot.stateName)) {
    return `${snapshot.identifier} is ${snapshot.stateName}, not an open ticket; move it back to Backlog or Todo first.`;
  }
  return undefined;
}
