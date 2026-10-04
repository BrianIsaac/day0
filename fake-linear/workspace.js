/**
 * The fake's Linear workspace: its people, the app users its OAuth apps install, its teams, workflow
 * states, projects, labels and issues with their comments and state history. The GraphQL API and
 * the MCP server read and write the same rows, as Linear's two front doors do.
 *
 * The capability rule is the one decision 5 of the real-vendor walk saw (R41V, 3 October 2026): an
 * app user can be made an issue's delegate or assignee only while a live token of its app holds
 * `app:assignable`; a token holding it that was revoked before the change grants nothing.
 */
import { randomUUID } from 'node:crypto';

/** Linear's default workflow, which every new team starts with. */
const DEFAULT_STATES = [
  { name: 'Backlog', type: 'backlog' },
  { name: 'Todo', type: 'unstarted' },
  { name: 'In Progress', type: 'started' },
  { name: 'Done', type: 'completed' },
  { name: 'Canceled', type: 'canceled' },
];

/**
 * Words the walk quoted for a delegate or assignee refused for want of the capability (R41V decision
 * 5): the message, the code and the words. The rest was elided ("...") and the HTTP status not
 * logged ("400 in-band"): the status is 400 as R-W's bed answered it, and the other fields follow the
 * shape of the authentication error the re-walk logged whole. A real walk must log the whole answer.
 */
export const CAPABILITY_REFUSAL = Object.freeze({
  message: 'App user not valid',
  code: 'INPUT_ERROR',
  type: 'invalid input',
  status: 400,
  userPresentableMessage: 'One or more app users lack the required capability.',
});

/**
 * Words for an entity the request names that the workspace does not hold. Not seen by either walk:
 * the message is this fake's, under the one input-error code a walk saw (`INPUT_ERROR`); a real walk
 * must name an issue, a user and a state Linear does not hold.
 *
 * @param {string} kind
 * @returns {import('./linear').WorkspaceRefusal}
 */
export function notFound(kind) {
  return {
    message: `Entity not found: ${kind}`,
    code: 'INPUT_ERROR',
    type: 'invalid input',
    status: 400,
    userPresentableMessage: `Could not find referenced ${kind}.`,
  };
}

/**
 * @param {string} text
 * @returns {string}
 */
function slugOf(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Create the workspace.
 *
 * @param {import('./linear').FakeWorkspaceOptions} options
 * @param {() => number} now
 * @param {(appUserId: string) => boolean} assignable whether a live token of the app user's app holds `app:assignable`
 * @returns {import('./linear').FakeWorkspace}
 */
export function createWorkspace(options, now, assignable) {
  const urlKey = options.urlKey ?? 'acme';
  const people = (options.people ?? []).map((person) => ({ ...person, app: false }));
  /** @type {Map<string, import('./linear').AppUser>} */
  const appUsers = new Map();
  const teams = (options.teams ?? [{ key: 'REVOPS', name: 'RevOps' }]).map((team) => ({
    id: team.id ?? randomUUID(),
    key: team.key,
    name: team.name,
    issueCount: team.issueCount ?? 0,
    states: DEFAULT_STATES.map((state, position) => ({ id: randomUUID(), position, ...state })),
  }));
  const projects = (options.projects ?? [{ name: 'Q3 close', team: 'REVOPS' }]).map((project) => ({
    id: project.id ?? randomUUID(),
    name: project.name,
    teamId: teamByAny(project.team)?.id ?? teams[0]?.id ?? '',
  }));
  /** @type {{ id: string, name: string }[]} */
  const labels = (options.labels ?? []).map((name) => ({ id: randomUUID(), name }));
  /** @type {import('./linear').Issue[]} */
  const issues = [];

  /**
   * @param {string | null | undefined} value a team's id, key or name
   */
  function teamByAny(value) {
    if (!value) return undefined;
    const wanted = value.toLowerCase();
    return teams.find(
      (team) =>
        team.id === value ||
        team.key.toLowerCase() === wanted ||
        team.name.toLowerCase() === wanted,
    );
  }

  /**
   * @param {string | null | undefined} id
   * @returns {import('./linear').WorkspaceUser | undefined}
   */
  function userById(id) {
    if (!id) return undefined;
    return (
      people.find((person) => person.id === id) ??
      [...appUsers.values()].find((user) => user.id === id)
    );
  }

  /**
   * A user named by id, name, display name or address, or `me` for the actor.
   *
   * @param {string | null | undefined} value
   * @param {import('./linear').WorkspaceUser | undefined} actor
   */
  function userByAny(value, actor) {
    if (!value) return undefined;
    if (value.toLowerCase() === 'me') return actor;
    const wanted = value.toLowerCase();
    return [...people, ...appUsers.values()].find(
      (user) =>
        user.id === value ||
        user.name.toLowerCase() === wanted ||
        user.displayName.toLowerCase() === wanted ||
        user.email.toLowerCase() === wanted,
    );
  }

  /**
   * @param {string} value an issue's id or its identifier (`REVOPS-3`)
   * @returns {import('./linear').Issue | undefined}
   */
  function issueByAny(value) {
    const match = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/.exec(value);
    if (match) {
      const team = teamByAny(match[1]);
      return issues.find((issue) => issue.teamId === team?.id && issue.number === Number(match[2]));
    }
    return issues.find((issue) => issue.id === value);
  }

  /**
   * @param {import('./linear').Issue} issue
   */
  function teamOf(issue) {
    const team = teams.find((candidate) => candidate.id === issue.teamId);
    if (!team) throw new Error(`issue ${issue.id} names no team the workspace holds`);
    return team;
  }

  /**
   * @param {import('./linear').Issue} issue
   */
  function stateOf(issue) {
    const state = teamOf(issue).states.find((candidate) => candidate.id === issue.stateId);
    if (!state) throw new Error(`issue ${issue.id} names no state its team holds`);
    return state;
  }

  /**
   * Why a user cannot take an issue as its delegate or assignee, or nothing when it can.
   *
   * @param {import('./linear').WorkspaceUser} user
   * @returns {import('./linear').WorkspaceRefusal | undefined}
   */
  function takeRefusal(user) {
    if (!user.app) return undefined;
    return assignable(user.id) ? undefined : CAPABILITY_REFUSAL;
  }

  /**
   * Apply one change to an issue on behalf of an actor: the fields set, its state history and its
   * timestamps, or the refusal the change meets before anything is written.
   *
   * @param {import('./linear').Issue} issue
   * @param {import('./linear').IssueChange} change
   * @param {import('./linear').WorkspaceUser} actor
   * @returns {import('./linear').WorkspaceRefusal | undefined}
   */
  function applyChange(issue, change, actor) {
    const team = teamOf(issue);
    /** @type {Partial<import('./linear').Issue>} */
    const next = {};
    for (const field of /** @type {const} */ (['assigneeId', 'delegateId'])) {
      const value = change[field];
      if (value === undefined) continue;
      if (value === null) {
        next[field] = null;
        continue;
      }
      const user = userById(value) ?? userByAny(value, actor);
      if (!user) return notFound('User');
      const refusal = takeRefusal(user);
      if (refusal) return refusal;
      next[field] = user.id;
    }
    if (change.state !== undefined) {
      const wanted = change.state.toLowerCase();
      const state = team.states.find(
        (candidate) =>
          candidate.id === change.state ||
          candidate.name.toLowerCase() === wanted ||
          candidate.type === wanted,
      );
      if (!state) return notFound('WorkflowState');
      next.stateId = state.id;
    }
    if (change.projectId !== undefined) {
      const project =
        change.projectId === null
          ? null
          : projects.find(
              (candidate) =>
                candidate.id === change.projectId ||
                candidate.name.toLowerCase() === String(change.projectId).toLowerCase(),
            );
      if (project === undefined) return notFound('Project');
      next.projectId = project === null ? null : project.id;
    }
    if (change.labelIds !== undefined) {
      const ids = [];
      for (const value of change.labelIds) {
        const label = labels.find(
          (candidate) => candidate.id === value || candidate.name === value,
        );
        if (!label) return notFound('IssueLabel');
        ids.push(label.id);
      }
      next.labelIds = ids;
    }
    if (change.title !== undefined) next.title = change.title;
    if (change.description !== undefined) next.description = change.description;
    if (change.priority !== undefined) next.priority = change.priority;

    const at = new Date(now()).toISOString();
    if (next.stateId !== undefined && next.stateId !== issue.stateId) {
      const from = stateOf(issue);
      const to = team.states.find((candidate) => candidate.id === next.stateId);
      issue.history.push({
        id: randomUUID(),
        actorId: actor.id,
        fromStateId: from.id,
        toStateId: next.stateId,
        createdAt: at,
      });
      if (to?.type === 'completed') issue.completedAt = at;
      if (to?.type === 'canceled') issue.canceledAt = at;
      if (to?.type === 'started' && issue.startedAt === null) issue.startedAt = at;
    }
    Object.assign(issue, next);
    issue.updatedAt = at;
    return undefined;
  }

  return {
    urlKey,
    people,
    appUsers,
    teams,
    projects,
    labels,
    issues,
    userById,
    userByAny,
    issueByAny,
    teamByAny,
    teamOf,
    stateOf,

    installApp(app) {
      const held = appUsers.get(app.clientId);
      if (held) return held;
      // Seen (R41V): an app user carries the app's name, a lower-case display name and an
      // address at `oauthapp.linear.app` named by the OAuth application's id.
      const user = {
        id: app.appUserId ?? randomUUID(),
        name: app.name,
        displayName: app.name.toLowerCase().replace(/[^a-z0-9]+/g, ''),
        email: `${app.id}@oauthapp.linear.app`,
        app: true,
        clientId: app.clientId,
      };
      appUsers.set(app.clientId, user);
      return user;
    },

    urlOf(issue) {
      return `https://linear.app/${urlKey}/issue/${this.identifierOf(issue)}/${slugOf(issue.title)}`;
    },

    identifierOf(issue) {
      return `${teamOf(issue).key}-${issue.number}`;
    },

    createIssue(input, actor) {
      const team = teamByAny(input.teamId);
      if (!team) return { refused: notFound('Team') };
      team.issueCount += 1;
      const at = new Date(now()).toISOString();
      const firstState = team.states.find((state) => state.type === 'backlog') ?? team.states[0];
      if (!firstState) throw new Error(`team ${team.key} holds no workflow state`);
      /** @type {import('./linear').Issue} */
      const issue = {
        id: randomUUID(),
        number: team.issueCount,
        teamId: team.id,
        title: input.title,
        description: input.description ?? '',
        priority: input.priority ?? 0,
        projectId: null,
        stateId: firstState.id,
        assigneeId: null,
        delegateId: null,
        labelIds: [],
        creatorId: actor.id,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        completedAt: null,
        startedAt: null,
        canceledAt: null,
        comments: [],
        history: [],
      };
      // The issue is written only once every field it names is accepted, as a refused mutation
      // writes nothing (R41V decision 5: "the earlier delegate and assignee attempts ... wrote nothing").
      const refusal = applyChange(issue, { ...input, title: input.title }, actor);
      if (refusal) {
        team.issueCount -= 1;
        return { refused: refusal };
      }
      issue.history.length = 0;
      issues.push(issue);
      return { issue };
    },

    updateIssue(issue, change, actor) {
      // Validate on a copy first, so a refused change leaves the issue untouched.
      const trial = { ...issue, history: [...issue.history] };
      const refusal = applyChange(trial, change, actor);
      if (refusal) return refusal;
      applyChange(issue, change, actor);
      return undefined;
    },

    addComment(issue, body, actor) {
      const at = new Date(now()).toISOString();
      const comment = { id: randomUUID(), body, userId: actor.id, createdAt: at, updatedAt: at };
      issue.comments.push(comment);
      issue.updatedAt = at;
      return comment;
    },

    archiveIssue(issue) {
      issue.archivedAt = new Date(now()).toISOString();
    },
  };
}
