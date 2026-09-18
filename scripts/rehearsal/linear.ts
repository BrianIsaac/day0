/**
 * The rehearsal's own Linear calls: read the workspace before, assign the
 * ticket, read it back after, and put it back. Every call is a named GraphQL
 * document with its ids as variables, so the key never travels in a query
 * string and a test can read the exact request.
 */

const ENDPOINT = 'https://api.linear.app/graphql';

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/** The pause before the one retry when Linear did not say how long to wait. */
export const RETRY_PAUSE_MS = 2_000;
/** The longest wait a retry honours; Linear asking for more is reported instead. */
export const MAX_RETRY_WAIT_MS = 60_000;

/** A Linear call that failed, and whether a second attempt could succeed. */
export class LinearRequestError extends Error {
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

/** Not yet implemented: runs the first attempt only. */
export async function retryOnce<T>(
  _what: string,
  _io: RetryIo,
  first: () => Promise<T>,
  _again: (failure: LinearRequestError) => Promise<T> = first,
): Promise<T> {
  return await first();
}

/** A GraphQL client over one API key and an injectable fetch. */
export class LinearClient {
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
   *   Error: On a transport failure or a GraphQL error list.
   */
  async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await this.fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    const parsed = (await response.json()) as GraphqlResponse<T>;
    if (parsed.errors?.length) {
      throw new Error(`Linear: ${parsed.errors.map((error) => error.message).join('; ')}`);
    }
    if (!response.ok || parsed.data === undefined) {
      throw new Error(`Linear answered HTTP ${response.status} with no data.`);
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
