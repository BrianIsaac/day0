import { describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../../convex/_generated/server';
import type { Id } from '../../../convex/_generated/dataModel';
import {
  actionIntent,
  grantRefusal,
  parseSurfaceAction,
  requiredScope,
  SHARED_WRITE_WITHOUT_ATTRIBUTION,
  sharedWriteWithoutAttribution,
  type ParsedSurfaceAction,
} from '../../../src/surfaces/policy';
import { applySurfaceActions, type RealAdapterDeps } from '../../../src/surfaces/registry';
import type { AdapterRun, SurfaceRecord } from '../../../src/surfaces/types';
import type { MockAction } from '../../../src/work/types';
import { FAKE_BOT_TOKEN } from '../../fake-slack/spawn';
import { OPS_REQUESTS_ASK, OPS_REQUESTS_ASK_ACTIONS } from '../../fixtures/priya-stopped-rows-2026-09-19';

const now = Date.UTC(2026, 8, 19, 9);
const ctx = {} as ActionCtx;
const run: AdapterRun = {
  agentId: 'agent' as Id<'agents'>,
  agentName: 'Priya',
  workItemId: 'wi_1' as Id<'workItems'>,
  runId: 'run_1' as Id<'events'>,
};

const slack: SurfaceRecord = {
  slug: 'slack',
  displayName: 'Slack',
  class: 'chat',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: now,
  endpoint: 'https://slack.com/api/',
  path: 'documented-api',
  toolAllowlist: [
    'auth.test',
    'users.lookupByEmail',
    'conversations.open',
    'conversations.list',
    'conversations.history',
    'conversations.replies',
    'chat.postMessage',
  ],
  credentialId: 'cred-slack',
  credentialKind: 'value',
  managerDmChannelId: 'D0MANAGER',
};

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function parsed(action: MockAction): ParsedSurfaceAction {
  const result = parseSurfaceAction(action);
  if (!result.ok) throw new Error(result.reason);
  return result.action;
}

function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  surface = 'slack',
): MockAction {
  return {
    tool: 'http.request',
    args: {
      surface,
      method,
      path,
      headersJson: '{"Authorization":"Bearer {{secret}}","Content-Type":"application/json; charset=utf-8"}',
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  };
}

function deps(sent: Sent[], fetcher?: RealAdapterDeps['fetch']): RealAdapterDeps {
  return {
    decrypt: vi.fn(async (): Promise<string> => FAKE_BOT_TOKEN),
    createMcpClient: (): never => {
      throw new Error('no MCP surface in this test');
    },
    fetch: async (url: URL, init: RequestInit): Promise<Response> => {
      sent.push({
        url: url.toString(),
        method: String(init.method),
        headers: init.headers as Record<string, string>,
        body: init.body === undefined || init.body === null ? undefined : String(init.body),
      });
      return fetcher
        ? fetcher(url, init)
        : new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
    },
  };
}

const refused = OPS_REQUESTS_ASK_ACTIONS[8]!;
const CHANNEL = 'C0C2U2UJUTU';
const THREAD = '1789761553.312049';

describe('a documented-API read carried by GET with a body (19 Sep fourth run, finding U)', (): void => {
  it("is the run's own row: GET /conversations.replies with its parameters in a JSON body, refused as a write", (): void => {
    expect(refused.args).toMatchObject({
      surface: 'slack',
      method: 'GET',
      path: '/conversations.replies',
      body: JSON.stringify({ channel: CHANNEL, thread_ts: THREAD }),
    });
    expect(OPS_REQUESTS_ASK.applied[8]).toMatchObject({ ok: false, reason: SHARED_WRITE_WITHOUT_ATTRIBUTION });
    expect(OPS_REQUESTS_ASK.skipReason).toContain('Refused: GET /conversations.replies on slack');
  });

  it('classes the row by its operation: a read, needing the read scope', (): void => {
    expect(actionIntent(parsed(refused))).toBe('read');
    expect(requiredScope(parsed(refused))).toBe('slack:read');
    expect(grantRefusal(parsed(refused), slack, new Set(['slack:read']))).toBeUndefined();
  });

  it('is no unattributable write under the shared credential, because it is no write', (): void => {
    expect(sharedWriteWithoutAttribution(parsed(refused), slack, 'value', 1, [], [])).toBe(false);
  });

  it.each([
    ['GET', '/auth.test', { unused: true }],
    ['GET', '/users.lookupByEmail', { email: 'manager@example.test' }],
    ['GET', '/conversations.list', { limit: 200, types: 'public_channel' }],
    ['GET', 'conversations.history', { channel: CHANNEL, limit: 50 }],
    ['HEAD', '/conversations.replies?limit=20', { channel: CHANNEL, ts: THREAD }],
  ])('reads the documented read method under %s %s as a read whatever its body', (method, path, body): void => {
    expect(actionIntent(parsed(request(method, path, body)))).toBe('read');
  });

  it.each(['/conversations.info', '/users.info', '/chat.getPermalink'])(
    'reads an undocumented dotted method that leads with a read verb, %s, as a read under GET with a body',
    (path): void => {
      expect(actionIntent(parsed(request('GET', path, { channel: CHANNEL })))).toBe('read');
    },
  );

  it.each([
    '/users.conversations',
    '/search.messages',
    '/conversations.members',
    '/conversations.mark',
    '/chat.meMessage',
  ])('keeps the undocumented dotted method %s a write under GET with a body', (path): void => {
    expect(actionIntent(parsed(request('GET', path, { channel: CHANNEL })))).toBe('write');
  });

  it.each(['/v1/search', '/issues', '/graphql', '/rpc/conversations.list', '/api/issues.list/42'])(
    'keeps the body rule for a GET that is not one dotted method, %s',
    (path): void => {
      expect(actionIntent(parsed(request('GET', path, { query: 'x' }, 'northstar')))).toBe('write');
      expect(actionIntent(parsed(request('GET', path, undefined, 'northstar')))).toBe('read');
    },
  );

  it.each(['GET', 'HEAD', 'POST'])('keeps a read method whose body names a mutation a write under %s', (method): void => {
    expect(actionIntent(parsed(request(method, '/conversations.history', { mark: 'read' })))).toBe('write');
    expect(actionIntent(parsed(request(method, '/conversations.replies', { channel: CHANNEL, operation: 'delete' })))).toBe('write');
    expect(actionIntent(parsed(request(method, '/issues.list', { action: 'archive' }, 'northstar')))).toBe('write');
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('keeps %s a write whatever the operation is called', (method): void => {
    expect(actionIntent(parsed(request(method, '/conversations.replies', { channel: CHANNEL })))).toBe('write');
  });

  it('keeps a read method whose path or query smuggles a mutation a write, body or no body', (): void => {
    expect(actionIntent(parsed(request('GET', '/conversations.history?operation=delete', { channel: CHANNEL })))).toBe('write');
    expect(actionIntent(parsed(request('GET', '/conversations.list%2Fdelete', { limit: 1 })))).toBe('write');
    expect(actionIntent(parsed(request('GET', '/chat.delete', { channel: CHANNEL })))).toBe('write');
  });

  it('still refuses an unattributable write under the shared credential, and sends nothing', async (): Promise<void> => {
    const sent: Sent[] = [];
    const applied = await applySurfaceActions(
      ctx,
      'real',
      [slack],
      run,
      [request('GET', '/conversations.open', { users: 'U0BTFHN6MKJ' })],
      { deps: deps(sent), grants: new Set(['slack:read', 'slack:write']), approvedIndexes: new Set([0]), now },
    );
    expect(applied[0]).toMatchObject({ ok: false, reason: SHARED_WRITE_WITHOUT_ATTRIBUTION });
    expect(sent).toEqual([]);
  });
});
