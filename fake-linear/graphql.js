/**
 * The fake's GraphQL API (`api.linear.app/graphql`): `viewer` as Day0's issuers read it, and the
 * issues, people and app users a bed stages and reads back with a person's key, as the two
 * real-vendor walks of 3 October 2026 did on real Linear. Every answer carries only the fields the
 * query selects, as a GraphQL server's does.
 */
import { json } from './http.js';
import { GraphqlSyntaxError, parseOperation, valueOf } from './graphql-parse.js';

/**
 * The body real Linear answered a revoked token's `viewer` with, word for word (the re-walk's log,
 * row 4), under HTTP 401.
 */
export const NOT_AUTHENTICATED = Object.freeze({
  errors: [
    {
      message: 'Authentication required, not authenticated',
      extensions: {
        type: 'authentication error',
        code: 'AUTHENTICATION_ERROR',
        statusCode: 401,
        userError: true,
        userPresentableMessage: 'You need to authenticate to access this operation.',
        meta: {},
        http: { status: 401 },
      },
    },
  ],
});

/**
 * An error answer in the shape of the one the re-walk logged whole: the words, the code and the
 * status in the extensions, and the same status on the wire.
 *
 * @param {import('./linear').WorkspaceRefusal} refusal
 * @returns {Response}
 */
function refusalAnswer(refusal) {
  return json(refusal.status, {
    errors: [
      {
        message: refusal.message,
        extensions: {
          type: refusal.type,
          code: refusal.code,
          statusCode: refusal.status,
          userError: true,
          userPresentableMessage: refusal.userPresentableMessage,
          meta: {},
          http: { status: refusal.status },
        },
      },
    ],
    data: null,
  });
}

/**
 * A query that cannot be run as written (syntax, an unknown field). Not seen by either walk: the
 * shape is GraphQL's own validation failure, its status 400 as the reach check saw a bare GET
 * answered (the re-walk: "reached https://api.linear.app/graphql (HTTP 400)").
 *
 * @param {string} message
 * @returns {Response}
 */
function invalidQuery(message) {
  return json(400, {
    errors: [
      {
        message,
        extensions: {
          type: 'graphql error',
          code: 'GRAPHQL_VALIDATION_FAILED',
          statusCode: 400,
          userError: true,
          meta: {},
          http: { status: 400 },
        },
      },
    ],
  });
}

/** A field a query named that its type does not have. */
class UnknownField extends Error {}

/** A refusal raised by a resolver, answered whole. */
class Refused extends Error {
  /** @param {import('./linear').WorkspaceRefusal} refusal */
  constructor(refusal) {
    super(refusal.message);
    this.refusal = refusal;
  }
}

/**
 * Create the GraphQL endpoint over a workspace.
 *
 * @param {import('./linear').FakeWorkspace} workspace
 * @returns {{ handle(request: Request, actor: import('./linear').WorkspaceUser | undefined): Promise<Response> }}
 */
export function createGraphql(workspace) {
  /**
   * @param {unknown} value
   * @returns {string | undefined}
   */
  const text = (value) => (typeof value === 'string' && value !== '' ? value : undefined);

  /**
   * @param {string} id
   * @returns {import('./linear').Issue}
   */
  function issueOrRefuse(id) {
    const issue = workspace.issueByAny(id);
    if (!issue) {
      throw new Refused({
        message: 'Entity not found: Issue',
        code: 'INVALID_INPUT',
        type: 'invalid input',
        status: 400,
        userPresentableMessage: 'Could not find referenced Issue.',
      });
    }
    return issue;
  }

  /**
   * A connection of nodes, as Linear pages every list (`{ nodes }`), cut to `first`.
   *
   * @template T
   * @param {T[]} nodes
   * @param {Record<string, unknown>} args
   */
  function connection(nodes, args) {
    const first = typeof args.first === 'number' && args.first > 0 ? args.first : 50;
    return { nodes: nodes.slice(0, first) };
  }

  /**
   * Each type's fields: a scalar resolver, or `[type, resolver]` for a field holding an object (or
   * a connection, `Connection:<type>`).
   *
   * @type {Record<string, Record<string, ((parent: any, args: Record<string, unknown>, actor: import('./linear').WorkspaceUser) => unknown) | [string, (parent: any, args: Record<string, unknown>, actor: import('./linear').WorkspaceUser) => unknown]>>}
   */
  const types = {
    User: {
      id: (user) => user.id,
      name: (user) => user.name,
      displayName: (user) => user.displayName,
      email: (user) => user.email,
      app: (user) => user.app,
      active: () => true,
      isMe: (user, _args, actor) => user.id === actor.id,
    },
    Team: { id: (team) => team.id, key: (team) => team.key, name: (team) => team.name },
    Project: { id: (project) => project.id, name: (project) => project.name },
    IssueLabel: { id: (label) => label.id, name: (label) => label.name },
    WorkflowState: {
      id: (state) => state.id,
      name: (state) => state.name,
      type: (state) => state.type,
      position: (state) => state.position,
    },
    Comment: {
      id: (comment) => comment.id,
      body: (comment) => comment.body,
      createdAt: (comment) => comment.createdAt,
      updatedAt: (comment) => comment.updatedAt,
      user: ['User', (comment) => workspace.userById(comment.userId) ?? null],
    },
    IssueHistory: {
      id: (entry) => entry.id,
      createdAt: (entry) => entry.createdAt,
      actor: ['User', (entry) => workspace.userById(entry.actorId) ?? null],
      fromState: ['WorkflowState', (entry) => stateById(entry.fromStateId)],
      toState: ['WorkflowState', (entry) => stateById(entry.toStateId)],
    },
    Issue: {
      id: (issue) => issue.id,
      identifier: (issue) => workspace.identifierOf(issue),
      number: (issue) => issue.number,
      title: (issue) => issue.title,
      description: (issue) => issue.description,
      priority: (issue) => issue.priority,
      url: (issue) => workspace.urlOf(issue),
      createdAt: (issue) => issue.createdAt,
      updatedAt: (issue) => issue.updatedAt,
      archivedAt: (issue) => issue.archivedAt,
      // Seen in the walks' cleanup: an archived issue answered `trashed` null.
      trashed: () => null,
      completedAt: (issue) => issue.completedAt,
      startedAt: (issue) => issue.startedAt,
      canceledAt: (issue) => issue.canceledAt,
      state: ['WorkflowState', (issue) => workspace.stateOf(issue)],
      team: ['Team', (issue) => workspace.teamOf(issue)],
      project: [
        'Project',
        (issue) => workspace.projects.find((project) => project.id === issue.projectId) ?? null,
      ],
      assignee: ['User', (issue) => workspace.userById(issue.assigneeId) ?? null],
      delegate: ['User', (issue) => workspace.userById(issue.delegateId) ?? null],
      creator: ['User', (issue) => workspace.userById(issue.creatorId) ?? null],
      labels: [
        'Connection:IssueLabel',
        (issue, args) =>
          connection(
            workspace.labels.filter((label) => issue.labelIds.includes(label.id)),
            args,
          ),
      ],
      comments: ['Connection:Comment', (issue, args) => connection(issue.comments, args)],
      history: ['Connection:IssueHistory', (issue, args) => connection(issue.history, args)],
    },
    IssuePayload: {
      success: () => true,
      issue: ['Issue', (payload) => payload.issue],
    },
    CommentPayload: {
      success: () => true,
      comment: ['Comment', (payload) => payload.comment],
    },
    ArchivePayload: { success: () => true },
    Query: {
      viewer: ['User', (_root, _args, actor) => actor],
      issue: ['Issue', (_root, args) => issueOrRefuse(String(args.id ?? ''))],
      issues: [
        'Connection:Issue',
        (_root, args) =>
          connection(
            workspace.issues.filter((issue) => args.includeArchived === true || !issue.archivedAt),
            args,
          ),
      ],
      users: [
        'Connection:User',
        (_root, args) => {
          const filter = /** @type {{ app?: { eq?: unknown } } | undefined} */ (args.filter);
          const everyone = [...workspace.people, ...workspace.appUsers.values()];
          const wanted = filter?.app?.eq;
          return connection(
            typeof wanted === 'boolean' ? everyone.filter((user) => user.app === wanted) : everyone,
            args,
          );
        },
      ],
      teams: ['Connection:Team', (_root, args) => connection(workspace.teams, args)],
      projects: ['Connection:Project', (_root, args) => connection(workspace.projects, args)],
      workflowStates: [
        'Connection:WorkflowState',
        (_root, args) =>
          connection(
            workspace.teams.flatMap((team) => team.states),
            args,
          ),
      ],
    },
    Mutation: {
      issueCreate: [
        'IssuePayload',
        (_root, args, actor) => {
          const input = /** @type {Record<string, unknown>} */ (args.input ?? {});
          const title = text(input.title);
          if (!title) {
            throw new Refused({
              message: 'Argument Validation Error',
              code: 'INVALID_INPUT',
              type: 'invalid input',
              status: 400,
              userPresentableMessage: 'title must be a string.',
            });
          }
          const created = workspace.createIssue(
            {
              teamId: String(input.teamId ?? ''),
              title,
              ...changeOf(input),
            },
            actor,
          );
          if ('refused' in created) throw new Refused(created.refused);
          return { issue: created.issue };
        },
      ],
      issueUpdate: [
        'IssuePayload',
        (_root, args, actor) => {
          const issue = issueOrRefuse(String(args.id ?? ''));
          const refusal = workspace.updateIssue(
            issue,
            changeOf(/** @type {Record<string, unknown>} */ (args.input ?? {})),
            actor,
          );
          if (refusal) throw new Refused(refusal);
          return { issue };
        },
      ],
      issueArchive: [
        'ArchivePayload',
        (_root, args) => {
          workspace.archiveIssue(issueOrRefuse(String(args.id ?? '')));
          return {};
        },
      ],
      commentCreate: [
        'CommentPayload',
        (_root, args, actor) => {
          const input = /** @type {Record<string, unknown>} */ (args.input ?? {});
          const issue = issueOrRefuse(String(input.issueId ?? ''));
          return { comment: workspace.addComment(issue, String(input.body ?? ''), actor) };
        },
      ],
    },
  };

  /**
   * @param {string} id
   */
  function stateById(id) {
    return workspace.teams.flatMap((team) => team.states).find((state) => state.id === id) ?? null;
  }

  /**
   * The issue fields an input names, in the workspace's terms.
   *
   * @param {Record<string, unknown>} input
   * @returns {import('./linear').IssueChange}
   */
  function changeOf(input) {
    /** @type {import('./linear').IssueChange} */
    const change = {};
    if ('assigneeId' in input) change.assigneeId = text(input.assigneeId) ?? null;
    if ('delegateId' in input) change.delegateId = text(input.delegateId) ?? null;
    if ('stateId' in input && text(input.stateId)) change.state = String(input.stateId);
    if ('projectId' in input) change.projectId = text(input.projectId) ?? null;
    if (Array.isArray(input.labelIds)) change.labelIds = input.labelIds.map(String);
    if (typeof input.title === 'string') change.title = input.title;
    if (typeof input.description === 'string') change.description = input.description;
    if (typeof input.priority === 'number') change.priority = input.priority;
    return change;
  }

  /**
   * One object's selected fields.
   *
   * @param {string} type
   * @param {unknown} parent
   * @param {import('./linear').GraphqlField[]} selections
   * @param {Record<string, unknown>} variables
   * @param {import('./linear').WorkspaceUser} actor
   * @returns {Record<string, unknown>}
   */
  function select(type, parent, selections, variables, actor) {
    const fields = types[type];
    if (!fields) throw new Error(`no type ${type}`);
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const field of selections) {
      if (field.name === '__typename') {
        out[field.alias] = type;
        continue;
      }
      const resolver = fields[field.name];
      if (!resolver)
        throw new UnknownField(`Cannot query field "${field.name}" on type "${type}".`);
      const args = Object.fromEntries(
        Object.entries(field.args).map(([name, parsed]) => [name, valueOf(parsed, variables)]),
      );
      if (typeof resolver === 'function') {
        out[field.alias] = resolver(parent, args, actor);
        continue;
      }
      const [childType, resolve] = resolver;
      const child = resolve(parent, args, actor);
      if (!field.selections) {
        throw new UnknownField(
          `Field "${field.name}" of type "${childType}" must have a selection of subfields.`,
        );
      }
      if (child === null || child === undefined) {
        out[field.alias] = null;
      } else if (childType.startsWith('Connection:')) {
        const nodeType = childType.slice('Connection:'.length);
        const nodes = /** @type {{ nodes: unknown[] }} */ (child).nodes;
        out[field.alias] = Object.fromEntries(
          field.selections.map((part) => {
            if (part.name !== 'nodes' || !part.selections) {
              throw new UnknownField(
                `Cannot query field "${part.name}" on type "${nodeType}Connection".`,
              );
            }
            const chosen = part.selections;
            return [
              part.alias,
              nodes.map((node) => select(nodeType, node, chosen, variables, actor)),
            ];
          }),
        );
      } else {
        out[field.alias] = select(childType, child, field.selections, variables, actor);
      }
    }
    return out;
  }

  return {
    async handle(request, actor) {
      if (request.method !== 'POST') return invalidQuery('Must provide query string.');
      if (!actor) return json(401, NOT_AUTHENTICATED);
      /** @type {{ query?: unknown, variables?: unknown, operationName?: unknown }} */
      let body;
      try {
        body = JSON.parse(await request.text());
      } catch {
        return invalidQuery('Body is not valid JSON.');
      }
      if (typeof body.query !== 'string') return invalidQuery('Must provide query string.');
      const variables =
        typeof body.variables === 'object' && body.variables !== null
          ? /** @type {Record<string, unknown>} */ (body.variables)
          : {};
      let operation;
      try {
        operation = parseOperation(
          body.query,
          typeof body.operationName === 'string' ? body.operationName : null,
        );
      } catch (error) {
        if (error instanceof GraphqlSyntaxError) return invalidQuery(error.message);
        throw error;
      }
      const filled = {
        ...Object.fromEntries(
          Object.entries(operation.defaults).map(([name, parsed]) => [name, valueOf(parsed, {})]),
        ),
        ...variables,
      };
      try {
        const data = select(
          operation.type === 'mutation' ? 'Mutation' : 'Query',
          null,
          operation.selections,
          filled,
          actor,
        );
        return json(200, { data });
      } catch (error) {
        if (error instanceof UnknownField) return invalidQuery(error.message);
        if (error instanceof Refused) return refusalAnswer(error.refusal);
        throw error;
      }
    },
  };
}
