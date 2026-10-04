/**
 * A test double of Linear for beds and tests: the OAuth token, revoke and authorise endpoints, the
 * GraphQL API and the MCP server Day0 calls, answering as real Linear answered the two real-vendor
 * walks of 3 October 2026 (round 0141: R-V on `v0.14.0`, the re-walk on `18b8261b`), and the admin
 * controls a bed needs to do what a Linear administrator does in Linear's settings. Never a
 * production service: anyone who reaches it may act as any of its people.
 *
 * One handler answers the three hosts Day0 names (`api.linear.app`, `linear.app`,
 * `mcp.linear.app`): their paths do not overlap, so it routes by path alone and a bed may reach it
 * under the three names or at one published port. It is written on the Fetch API alone (`Request`
 * in, `Response` out), so `server.js` serves it over Node's own listener and a test calls it in
 * process. Its state lives in memory and is gone at a restart.
 */
import { randomUUID } from 'node:crypto';
import { createGrants } from './grants.js';
import { createGraphql } from './graphql.js';
import { formOf, json, presentedToken } from './http.js';
import { createMcp } from './mcp.js';
import { createOAuth } from './oauth.js';
import { createWorkspace } from './workspace.js';

/**
 * The workspace's people by default: an administrator, who installs apps, and a member. Their
 * personal API keys are fakes in the tree's short shape.
 *
 * @type {ReadonlyArray<import('./linear').FakePerson>}
 */
export const DEFAULT_PEOPLE = [
  {
    id: '6f1c2a40-0000-4000-8000-00000000a001',
    name: 'Sam',
    displayName: 'sam',
    email: 'sam@acme.test',
    admin: true,
    apiKey: 'lin_api_day0_fake_sam',
  },
  {
    id: '6f1c2a40-0000-4000-8000-00000000a002',
    name: 'Ana',
    displayName: 'ana',
    email: 'ana@acme.test',
    admin: false,
    apiKey: 'lin_api_day0_fake_ana',
  },
];

/**
 * The OAuth apps by default: the organisation's shared app, with client credentials on (the
 * operator's app "Day0", W-L1), and one employee's own app, authorisation code only (the re-walk's
 * "Leo (Day0)", W-L4). Their redirect URIs are the bed's.
 *
 * @param {readonly string[]} redirectUris
 * @returns {import('./linear').FakeLinearApp[]}
 */
export function defaultApps(redirectUris) {
  return [
    {
      id: '6f1c2a40-0000-4000-8000-00000000c001',
      clientId: 'day0-fake-linear-shared',
      clientSecret: 'day0-fake-linear-shared-secret',
      name: 'Day0',
      clientCredentials: true,
      redirectUris,
    },
    {
      id: '6f1c2a40-0000-4000-8000-00000000c002',
      clientId: 'day0-fake-linear-leo',
      clientSecret: 'day0-fake-linear-leo-secret',
      name: 'Leo (Day0)',
      clientCredentials: false,
      redirectUris,
    },
  ];
}

/**
 * Create the double.
 *
 * @param {import('./linear').FakeLinearOptions} options
 * @returns {import('./linear').FakeLinear}
 */
export function createLinear(options) {
  const now = options.now ?? (() => Date.now());
  const apps = options.apps.map((app) => ({ ...app, id: app.id ?? randomUUID() }));
  const grants = createGrants(now);
  const workspace = createWorkspace(
    { ...options.workspace, people: options.people ?? DEFAULT_PEOPLE },
    now,
    (appUserId) =>
      [...grants.tokens.values()].some(
        (token) =>
          token.actor.kind === 'app' &&
          token.actor.appUserId === appUserId &&
          token.kind !== 'refresh' &&
          grants.stateOf(token) === 'live' &&
          token.scopes.includes('app:assignable'),
      ),
  );
  const unavailable = { writes: 0 };
  /** @type {import('./linear').LoggedRequest[]} */
  const log = [];

  const signedIn = () => {
    const wanted = options.signedIn;
    return wanted
      ? workspace.people.find((person) => person.id === wanted || person.email === wanted)
      : (workspace.people.find((person) => person.admin) ?? workspace.people[0]);
  };
  const oauth = createOAuth({ apps, grants, workspace, signedIn, now });
  const graphql = createGraphql(workspace);
  const mcp = createMcp({ workspace, unavailable });

  /**
   * The user a request's token acts as: a person by their personal API key or by a token their own
   * consent issued, an app user by its app's token; nothing for a token not live.
   *
   * @param {Request} request
   * @returns {{ presented: boolean, actor: import('./linear').WorkspaceUser | undefined }}
   */
  function callerOf(request) {
    const presented = presentedToken(request);
    if (presented === '') return { presented: false, actor: undefined };
    const person = workspace.people.find((candidate) => candidate.apiKey === presented);
    if (person) return { presented: true, actor: person };
    const held = grants.find(presented);
    if (!held || held.kind === 'refresh' || grants.stateOf(held) !== 'live') {
      return { presented: true, actor: undefined };
    }
    const actor =
      held.actor.kind === 'app'
        ? [...workspace.appUsers.values()].find((user) => user.id === held.actor.appUserId)
        : workspace.userById(held.actor.personId);
    return { presented: true, actor };
  }

  /**
   * What the log keeps of a request: its route and the non-secret fields that name what it asked.
   *
   * @param {Request} request
   * @param {string} path
   */
  async function describe(request, path) {
    /** @type {Record<string, string>} */
    const asked = {};
    if (request.method === 'POST' && (path === '/oauth/token' || path === '/oauth/revoke')) {
      const form = await formOf(request.clone());
      for (const name of ['grant_type', 'client_id', 'scope', 'token_type_hint']) {
        const value = form.get(name);
        if (value !== null) asked[name] = value;
      }
    }
    if (request.method === 'POST' && path === '/mcp') {
      try {
        const message = JSON.parse(await request.clone().text());
        if (typeof message.method === 'string') asked.rpc = message.method;
        if (typeof message.params?.name === 'string') asked.tool = message.params.name;
      } catch {
        // Not JSON: the handler answers the parse error; the log keeps the route alone.
      }
    }
    return asked;
  }

  /**
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async function admin(request) {
    const url = new URL(request.url);
    const params = url.searchParams;
    if (url.pathname === '/admin/state') {
      return json(200, {
        ok: true,
        apps: apps.map((app) => {
          const user = workspace.appUsers.get(app.clientId);
          return {
            clientId: app.clientId,
            name: app.name,
            clientCredentials: app.clientCredentials,
            appUser: user ? { id: user.id, name: user.name } : null,
          };
        }),
        // Every token's state. The values are this double's own fakes, listed so a bed can read an
        // answer back with curl; a real token never reaches this service.
        tokens: [...grants.tokens.values()].map((token) => ({
          value: token.value,
          kind: token.kind,
          grant: token.grant,
          clientId: token.clientId,
          actor: token.actor.kind,
          scopes: token.scopes,
          state: grants.stateOf(token),
          issuedAt: new Date(token.issuedAt).toISOString(),
          expiresAt: token.expiresAt === null ? null : new Date(token.expiresAt).toISOString(),
        })),
        issues: workspace.issues.map((issue) => ({
          identifier: workspace.identifierOf(issue),
          state: workspace.stateOf(issue).name,
          assignee: workspace.userById(issue.assigneeId)?.name ?? null,
          delegate: workspace.userById(issue.delegateId)?.name ?? null,
          comments: issue.comments.length,
          archived: issue.archivedAt !== null,
        })),
        unavailableWrites: unavailable.writes,
        log,
      });
    }
    if (request.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
    if (url.pathname === '/admin/revoke-app') {
      // A Linear administrator's **Revoke access** in Settings, Applications (the re-walk, row 3):
      // "This will revoke all existing tokens for <app>."
      const app = apps.find((candidate) => candidate.clientId === params.get('client_id'));
      if (!app) return json(404, { ok: false, error: 'no such app' });
      return json(200, { ok: true, clientId: app.clientId, ended: grants.revokeApp(app.clientId) });
    }
    if (url.pathname === '/admin/expire') {
      // A token's own lapse, brought forward: one token by its value, or every live token of an
      // app's kind (`access`, `refresh`, `app-actor`).
      const value = params.get('token');
      if (value !== null) {
        return grants.expire(value)
          ? json(200, { ok: true, expired: 1 })
          : json(404, { ok: false, error: 'no such token' });
      }
      const clientId = params.get('client_id');
      const kind = params.get('kind');
      let expired = 0;
      for (const token of grants.tokens.values()) {
        if (
          token.clientId === clientId &&
          (kind === null || token.kind === kind) &&
          grants.stateOf(token) === 'live'
        ) {
          grants.expire(token.value);
          expired += 1;
        }
      }
      return json(200, { ok: true, expired });
    }
    if (url.pathname === '/admin/unavailable') {
      // The next writes answered as Linear's MCP server answered one on 1 October (m1).
      const writes = Number(params.get('writes') ?? '1');
      if (!Number.isInteger(writes) || writes < 0) {
        return json(400, { ok: false, error: 'writes must be a whole number' });
      }
      unavailable.writes = writes;
      return json(200, { ok: true, unavailableWrites: writes });
    }
    return json(404, { ok: false, error: 'not_found' });
  }

  /**
   * @param {Request} request
   * @param {string} path
   * @returns {Promise<Response>}
   */
  async function route(request, path) {
    if (path === '/healthz') return json(200, { ok: true });
    if (path.startsWith('/admin/')) return admin(request);
    if (path === '/oauth/token' && request.method === 'POST') return oauth.token(request);
    if (path === '/oauth/revoke' && request.method === 'POST') return oauth.revoke(request);
    if (path === '/oauth/authorize') return oauth.authorize(request);
    if (path === '/graphql') return graphql.handle(request, callerOf(request).actor);
    if (path === '/mcp') return mcp.handle(request, callerOf(request));
    return json(404, { error: 'not_found' });
  }

  return {
    workspace,
    async handle(request) {
      const path = new URL(request.url).pathname;
      const asked =
        path.startsWith('/admin/') || path === '/healthz' ? null : await describe(request, path);
      const answer = await route(request, path);
      if (asked !== null) {
        log.push({
          sequence: log.length + 1,
          at: new Date(now()).toISOString(),
          method: request.method,
          path,
          status: answer.status,
          ...asked,
        });
      }
      return answer;
    },
  };
}
