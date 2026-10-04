/**
 * The fake's MCP server (`mcp.linear.app/mcp`), the endpoint Day0's Linear rung calls: JSON-RPC over
 * streamable HTTP, answered as JSON. It answers an app actor's token and a person's key, as Linear's
 * server does (L4, and both walks), and refuses a token it does not hold with the answer recorded
 * from real Linear on 2 October. The tools Day0's intake, plan grounding and ticket skill call
 * (`list_issues`, `get_issue`, `save_comment`, `save_issue`, `get_user`) read and write the same
 * workspace as the GraphQL API.
 */
import { json } from './http.js';
import { LIST_ISSUES_FIELDS, toolDefinitions } from './tools.js';

/** The resource metadata the recorded challenges name. */
const RESOURCE_METADATA = 'https://mcp.linear.app/.well-known/oauth-protected-resource/mcp';

/** Recorded (`MCP_WITHOUT_BEARER`): no `Authorization` header, an empty body. */
function withoutBearer() {
  return new Response('', {
    status: 401,
    headers: {
      'www-authenticate': `Bearer realm="OAuth", resource_metadata="${RESOURCE_METADATA}", scope="read write"`,
    },
  });
}

/**
 * Recorded (`MCP_INVALID_TOKEN`), and what the walk saw for a token revoked in Linear's settings
 * (R41V-9: the client's text carried this body): a bearer the server does not hold.
 */
function invalidToken() {
  return new Response('{"error":"invalid_token","error_description":"Invalid access token"}', {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': `Bearer realm="OAuth", resource_metadata="${RESOURCE_METADATA}", error="invalid_token", scope="read write"`,
    },
  });
}

/**
 * Recorded on a real workspace (1 October, the real-Linear walk's m1, `src/surfaces/mcp.ts`): Linear's
 * MCP server's answer to an approved write when Linear itself did not answer it.
 */
export const UPSTREAM_UNAVAILABLE =
  '{"error":"upstream_unavailable","message":"Linear is temporarily unavailable. Please try again.","status":502}';

/**
 * The protocol revisions the fake answers, newest first. Not recorded from Linear: the client's own
 * revision is answered where the fake knows it.
 */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** Linear's priority names by value, as `get_issue` prints them (`{"value":0,"name":"No priority"}`). */
const PRIORITY_NAMES = ['No priority', 'Urgent', 'High', 'Medium', 'Low'];

/** A tool's failure, answered as a result with `isError`. */
class ToolFailure extends Error {}

/**
 * Create the MCP endpoint over a workspace.
 *
 * @param {{ workspace: import('./linear').FakeWorkspace, unavailable: { writes: number } }} context
 */
export function createMcp(context) {
  const { workspace, unavailable } = context;

  /**
   * @param {unknown} value
   * @returns {string | undefined}
   */
  const text = (value) =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

  /**
   * @param {string | undefined} id
   * @returns {import('./linear').Issue}
   */
  function issueOrFail(id) {
    const issue = id ? workspace.issueByAny(id) : undefined;
    // Not seen by either walk: the words for an issue the workspace does not hold.
    if (!issue) throw new ToolFailure(`Entity not found: Issue - Could not find referenced Issue.`);
    return issue;
  }

  /**
   * An issue as Linear's MCP server prints it, in the order the run of 19 September recorded
   * (`get_issue` on LOG-1). The assignee and delegate are printed only when set, by name with the id
   * beside (`createdBy`/`createdById` is the recorded pair): no record shows an assigned issue, so
   * a real walk must read one.
   *
   * @param {import('./linear').Issue} issue
   * @param {boolean} whole whether to add the history, attachments and documents `get_issue` adds
   * @returns {Record<string, unknown>}
   */
  function issueRecord(issue, whole) {
    const state = workspace.stateOf(issue);
    const team = workspace.teamOf(issue);
    const project = workspace.projects.find((candidate) => candidate.id === issue.projectId);
    const creator = workspace.userById(issue.creatorId);
    const assignee = workspace.userById(issue.assigneeId);
    const delegate = workspace.userById(issue.delegateId);
    const identifier = workspace.identifierOf(issue);
    return {
      id: identifier,
      uuid: issue.id,
      title: issue.title,
      description: issue.description,
      priority: { value: issue.priority, name: PRIORITY_NAMES[issue.priority] ?? 'No priority' },
      url: workspace.urlOf(issue),
      gitBranchName: `${creator?.displayName ?? 'user'}/${identifier.toLowerCase()}-${workspace
        .urlOf(issue)
        .split('/')
        .pop()}`,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      archivedAt: issue.archivedAt,
      completedAt: issue.completedAt,
      startedAt: issue.startedAt,
      canceledAt: issue.canceledAt,
      dueDate: null,
      slaStartedAt: null,
      slaMediumRiskAt: null,
      slaHighRiskAt: null,
      slaBreachesAt: null,
      status: state.name,
      statusType: state.type,
      labels: workspace.labels
        .filter((label) => issue.labelIds.includes(label.id))
        .map((label) => label.name),
      ...(whole
        ? {
            attachments: [],
            documents: [],
            stateHistory: stateHistory(issue),
          }
        : {}),
      ...(creator ? { createdBy: creator.name, createdById: creator.id } : {}),
      ...(assignee ? { assignee: assignee.name, assigneeId: assignee.id } : {}),
      ...(delegate ? { delegate: delegate.name, delegateId: delegate.id } : {}),
      ...(project ? { project: project.name, projectId: project.id } : {}),
      team: team.name,
      teamId: team.id,
    };
  }

  /**
   * The issue's states, each with when it started and ended, as `get_issue` recorded them.
   *
   * @param {import('./linear').Issue} issue
   */
  function stateHistory(issue) {
    const team = workspace.teamOf(issue);
    const stateById = (/** @type {string} */ id) => {
      const state = team.states.find((candidate) => candidate.id === id);
      return state ? { id: state.id, name: state.name, type: state.type } : null;
    };
    const first = issue.history[0]?.fromStateId ?? issue.stateId;
    const spans = [
      {
        state: stateById(first),
        startedAt: issue.createdAt,
        endedAt: /** @type {string | null} */ (null),
      },
    ];
    for (const change of issue.history) {
      const last = spans[spans.length - 1];
      if (last) last.endedAt = change.createdAt;
      spans.push({
        state: stateById(change.toStateId),
        startedAt: change.createdAt,
        endedAt: null,
      });
    }
    return spans;
  }

  /**
   * Keep only the fields a caller named: the server "returns only the fields a caller names" (the
   * run of 19 September, FIN-1).
   *
   * @param {Record<string, unknown>} record
   * @param {unknown} fields
   */
  function onlyFields(record, fields) {
    if (!Array.isArray(fields) || fields.length === 0) return record;
    return Object.fromEntries(
      fields
        .filter((field) => typeof field === 'string' && LIST_ISSUES_FIELDS.includes(field))
        .filter((field) => field in record)
        .map((field) => [field, record[field]]),
    );
  }

  /**
   * @param {Record<string, unknown>} args
   * @param {import('./linear').WorkspaceUser} actor
   */
  function listIssues(args, actor) {
    const team = text(args.team);
    const project = text(args.project);
    const state = text(args.state)?.toLowerCase();
    const assignee = text(args.assignee);
    const delegate = text(args.delegate);
    const query = text(args.query)?.toLowerCase();
    const since = text(args.updatedAt);
    const sinceMs = since ? Date.parse(since) : Number.NaN;
    const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 250) : 50;
    const matches = workspace.issues
      .filter((issue) => args.includeArchived === true || issue.archivedAt === null)
      .filter((issue) => !team || workspace.teamByAny(team)?.id === issue.teamId)
      .filter((issue) => {
        if (!project) return true;
        const held = workspace.projects.find((candidate) => candidate.id === issue.projectId);
        return (
          held !== undefined &&
          (held.id === project || held.name.toLowerCase() === project.toLowerCase())
        );
      })
      .filter((issue) => {
        if (!state) return true;
        const held = workspace.stateOf(issue);
        return held.name.toLowerCase() === state || held.type === state || held.id === state;
      })
      .filter((issue) => !assignee || workspace.userByAny(assignee, actor)?.id === issue.assigneeId)
      .filter((issue) => !delegate || workspace.userByAny(delegate, actor)?.id === issue.delegateId)
      .filter((issue) => !query || issue.title.toLowerCase().includes(query))
      .filter((issue) => Number.isNaN(sinceMs) || Date.parse(issue.updatedAt) >= sinceMs)
      // Not recorded: the order with no `orderBy`; `updatedAt`, newest first, as Linear's lists.
      .sort((left, right) =>
        args.orderBy === 'createdAt'
          ? right.createdAt.localeCompare(left.createdAt)
          : right.updatedAt.localeCompare(left.updatedAt),
      );
    const offset = Number(text(args.cursor) ?? 0) || 0;
    const page = matches.slice(offset, offset + limit);
    const more = offset + limit < matches.length;
    // Recorded (19 September): `{"issues":[...]}`. The paging fields are not recorded: the fake
    // names the next page as `pageInfo`, which a real walk with over a page of issues must read.
    return {
      issues: page.map((issue) => onlyFields(issueRecord(issue, false), args.fields)),
      ...(more ? { pageInfo: { hasNextPage: true, endCursor: String(offset + limit) } } : {}),
    };
  }

  /**
   * @param {Record<string, unknown>} args
   * @param {import('./linear').WorkspaceUser} actor
   */
  function saveIssue(args, actor) {
    /** @type {import('./linear').IssueChange} */
    const change = {};
    if (text(args.state)) change.state = String(text(args.state));
    if ('assignee' in args) change.assigneeId = text(args.assignee) ?? null;
    if ('delegate' in args) change.delegateId = text(args.delegate) ?? null;
    if (typeof args.title === 'string') change.title = args.title;
    if (typeof args.description === 'string') change.description = args.description;
    if (typeof args.priority === 'number') change.priority = args.priority;
    if ('project' in args) change.projectId = text(args.project) ?? null;
    if (Array.isArray(args.labels)) change.labelIds = args.labels.map(String);
    const id = text(args.id);
    if (!id) {
      const title = text(args.title);
      if (!title || !text(args.team))
        throw new ToolFailure('title and team are required to create an issue.');
      const created = workspace.createIssue(
        { ...change, teamId: String(text(args.team)), title },
        actor,
      );
      if ('refused' in created) throw new ToolFailure(created.refused.userPresentableMessage);
      return issueRecord(created.issue, true);
    }
    const issue = issueOrFail(id);
    const refusal = workspace.updateIssue(issue, change, actor);
    if (refusal) throw new ToolFailure(refusal.userPresentableMessage);
    // Recorded (17 and 19 September): `save_issue` answers with the issue as `get_issue` prints it.
    return issueRecord(issue, true);
  }

  /**
   * @param {string} name
   * @param {Record<string, unknown>} args
   * @param {import('./linear').WorkspaceUser} actor
   * @returns {unknown}
   */
  function callTool(name, args, actor) {
    switch (name) {
      case 'list_issues':
        return listIssues(args, actor);
      case 'get_issue':
        return issueRecord(issueOrFail(text(args.id)), true);
      case 'save_issue':
        return saveIssue(args, actor);
      case 'save_comment': {
        const body = text(args.body);
        if (!body) throw new ToolFailure('body is required.');
        const comment = workspace.addComment(issueOrFail(text(args.issueId)), body, actor);
        // Recorded (17 and 19 September): `{"id":"<uuid>","body":"..."}`, the rest cut by the
        // ledger's bound; a real walk must read the whole answer.
        return { id: comment.id, body: comment.body };
      }
      case 'list_comments': {
        const issue = issueOrFail(text(args.issueId));
        // Not recorded: the shape of a comment list. The author by name and id, as `createdBy`.
        return {
          comments: issue.comments.map((comment) => {
            const author = workspace.userById(comment.userId);
            return {
              id: comment.id,
              body: comment.body,
              createdAt: comment.createdAt,
              ...(author ? { author: author.name, authorId: author.id } : {}),
            };
          }),
        };
      }
      case 'get_user': {
        const user = workspace.userByAny(text(args.query) ?? 'me', actor);
        if (!user)
          throw new ToolFailure('Entity not found: User - Could not find referenced User.');
        // Not recorded: the user's shape. Day0 reads `id` and `email`, top level or under `user`.
        return {
          id: user.id,
          name: user.name,
          displayName: user.displayName,
          email: user.email,
          isMe: user.id === actor.id,
        };
      }
      case 'list_teams':
        return {
          teams: workspace.teams.map((team) => ({ id: team.id, key: team.key, name: team.name })),
        };
      case 'list_issue_statuses': {
        const team = workspace.teamByAny(text(args.team)) ?? workspace.teams[0];
        return (team?.states ?? []).map((state) => ({
          id: state.id,
          name: state.name,
          type: state.type,
        }));
      }
      default:
        throw new ToolFailure(`This test double of Linear does not answer ${name}.`);
    }
  }

  /**
   * @param {unknown} id
   * @param {unknown} result
   */
  const reply = (id, result) => json(200, { jsonrpc: '2.0', id, result });

  return {
    /**
     * @param {Request} request
     * @param {{ presented: boolean, actor: import('./linear').WorkspaceUser | undefined }} caller
     * @returns {Promise<Response>}
     */
    async handle(request, caller) {
      if (!caller.presented) return withoutBearer();
      if (!caller.actor) return invalidToken();
      const actor = caller.actor;
      // The client opens a GET stream after its handshake and swallows a 405; nothing is pushed.
      if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
      /** @type {{ id?: unknown, method?: unknown, params?: Record<string, unknown> }} */
      let message;
      try {
        message = JSON.parse(await request.text());
      } catch {
        return json(400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        });
      }
      if (message.id === undefined) return new Response(null, { status: 202 });
      if (message.method === 'initialize') {
        const asked = message.params?.protocolVersion;
        return reply(message.id, {
          protocolVersion:
            typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked)
              ? asked
              : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'Linear (test double)', version: '1.0.0' },
        });
      }
      if (message.method === 'ping') return reply(message.id, {});
      if (message.method === 'tools/list') {
        return reply(message.id, { tools: toolDefinitions(actor.app) });
      }
      if (message.method === 'tools/call') {
        const name = String(message.params?.name ?? '');
        const args = /** @type {Record<string, unknown>} */ (message.params?.arguments ?? {});
        if (unavailable.writes > 0 && /^(save|create|update|delete)_/.test(name)) {
          unavailable.writes -= 1;
          return reply(message.id, {
            content: [{ type: 'text', text: UPSTREAM_UNAVAILABLE }],
            isError: true,
          });
        }
        try {
          const result = callTool(name, args, actor);
          return reply(message.id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
        } catch (error) {
          if (!(error instanceof ToolFailure)) throw error;
          return reply(message.id, {
            content: [{ type: 'text', text: error.message }],
            isError: true,
          });
        }
      }
      return json(200, {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Method not found' },
      });
    },
  };
}
