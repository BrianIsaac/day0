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
import { FIN_1_ITEM, FIN_1_ITEM_ACTIONS } from '../../fixtures/mateo-stopped-rows-2026-09-19';

const now = Date.UTC(2026, 8, 19, 9);
const ctx = {} as ActionCtx;
const run: AdapterRun = {
  agentId: 'agent' as Id<'agents'>,
  agentName: 'Mateo',
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

function parsed(action: MockAction): ParsedSurfaceAction {
  const result = parseSurfaceAction(action);
  if (!result.ok) throw new Error(result.reason);
  return result.action;
}

function post(path: string, body: Record<string, unknown> = {}, method = 'POST'): MockAction {
  return { tool: 'http.request', args: { surface: 'slack', method, path, body: JSON.stringify(body) } };
}

function deps(sent: string[]): RealAdapterDeps {
  return {
    decrypt: vi.fn(async (): Promise<string> => 'secret'),
    createMcpClient: (): never => {
      throw new Error('no MCP surface in this test');
    },
    fetch: async (url: URL): Promise<Response> => {
      sent.push(url.toString());
      return new Response(JSON.stringify({ ok: true, channels: [] }), { status: 200 });
    },
  };
}

describe('a documented-API read carried by POST (19 Sep third run, finding R)', (): void => {
  const refused = FIN_1_ITEM_ACTIONS[1]!;

  it("is the run's own row: POST /conversations.list with an empty body, refused as a write", (): void => {
    expect(refused.args).toMatchObject({ method: 'POST', path: '/conversations.list', body: '{}' });
    expect(FIN_1_ITEM.applied[1]).toMatchObject({ ok: false, reason: SHARED_WRITE_WITHOUT_ATTRIBUTION });
  });

  it('classes the row by its operation: a read, needing the read scope', (): void => {
    expect(actionIntent(parsed(refused))).toBe('read');
    expect(requiredScope(parsed(refused))).toBe('slack:read');
  });

  it('is no unattributable write under the shared credential, because it is no write', (): void => {
    expect(sharedWriteWithoutAttribution(parsed(refused), slack, 'value', 1, [], [])).toBe(false);
  });

  it.each([
    ['/auth.test', {}],
    ['/users.lookupByEmail', { email: 'manager@example.test' }],
    ['/conversations.list', { limit: 200, types: 'public_channel' }],
    ['conversations.history', { channel: 'C0C2P932A2H', limit: 50 }],
    ['/conversations.replies?limit=20', { channel: 'C0C2P932A2H', ts: '1789761522.764859' }],
  ])('reads the documented read method %s as a read under POST', (path, body): void => {
    expect(actionIntent(parsed(post(path, body)))).toBe('read');
  });

  it.each([
    '/conversations.info',
    '/users.info',
    '/users.list',
    '/chat.getPermalink',
    '/team.info',
  ])('reads an undocumented dotted method that leads with a read verb, %s, as a read', (path): void => {
    expect(actionIntent(parsed(post(path)))).toBe('read');
  });

  it.each([
    '/chat.postMessage',
    '/chat.update',
    '/chat.delete',
    '/chat.scheduleMessage',
    '/chat.meMessage',
    '/conversations.open',
    '/conversations.join',
    '/conversations.mark',
    '/conversations.invite',
    '/conversations.setTopic',
    '/reactions.add',
    '/pins.remove',
    '/files.getUploadURLExternal',
    '/users.setPresence',
    // Undocumented and not led by a read verb: a write until someone documents it.
    '/users.conversations',
    '/search.all',
    '/search.messages',
    '/conversations.members',
  ])('keeps %s a write under POST', (path): void => {
    expect(actionIntent(parsed(post(path, { channel: 'C1', text: 'x' })))).toBe('write');
  });

  it.each([
    '/graphql',
    '/v1/search',
    '/api/issues.list/42',
    '/issues',
    '/list',
    '/rpc/conversations.list',
  ])('keeps a POST that is not one dotted method, %s, a write', (path): void => {
    const action: MockAction = {
      tool: 'http.request',
      args: { surface: 'northstar', method: 'POST', path, body: '{"query":"{ viewer { id } }"}' },
    };
    expect(actionIntent(parsed(action))).toBe('write');
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('keeps %s a write whatever the operation is called', (method): void => {
    expect(actionIntent(parsed(post('/conversations.list', {}, method)))).toBe('write');
  });

  it('keeps a read method whose query smuggles a mutation a write', (): void => {
    expect(actionIntent(parsed(post('/conversations.history?operation=delete')))).toBe('write');
    expect(actionIntent(parsed(post('/conversations.list%2Fdelete')))).toBe('write');
  });

  it("sends the run's row under the read grant alone, through the shared credential", async (): Promise<void> => {
    const sent: string[] = [];
    const applied = await applySurfaceActions(ctx, 'real', [slack], run, [refused], {
      deps: deps(sent),
      grants: new Set(['slack:read']),
      now,
    });
    expect(applied[0]).toMatchObject({ ok: true });
    expect(applied[0]?.held).not.toBe(true);
    expect(sent).toEqual(['https://slack.com/api/conversations.list']);
  });

  it('still refuses an unattributable write under the shared credential, and sends nothing', async (): Promise<void> => {
    const sent: string[] = [];
    const applied = await applySurfaceActions(
      ctx,
      'real',
      [slack],
      run,
      [post('/conversations.open', { users: 'U0BTFHN6MKJ' })],
      { deps: deps(sent), grants: new Set(['slack:read', 'slack:write']), approvedIndexes: new Set([0]), now },
    );
    expect(applied[0]).toMatchObject({ ok: false, reason: SHARED_WRITE_WITHOUT_ATTRIBUTION });
    expect(sent).toEqual([]);
  });

  it('still asks the write scope of a chat post, which the read grant alone does not carry', (): void => {
    const chat = parsed(post('/chat.postMessage', { channel: 'C0C2P932A2H', text: 'Where the close stands.' }));
    expect(grantRefusal(chat, slack, new Set(['slack:read']))).toBe('no grant (slack:write)');
    expect(grantRefusal(parsed(refused), slack, new Set(['slack:read']))).toBeUndefined();
    expect(grantRefusal(parsed(refused), slack, new Set(['slack:write']))).toBe('no grant (slack:read)');
  });
});
