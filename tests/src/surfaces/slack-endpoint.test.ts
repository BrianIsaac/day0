import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../../convex/_generated/server';
import type { Id } from '../../../convex/_generated/dataModel';
import type { SurfaceRecord } from '../../../src/surfaces/types';

afterEach((): void => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function endpointModule(): Promise<typeof import('../../../src/surfaces/slack-endpoint')> {
  return await import('../../../src/surfaces/slack-endpoint');
}

describe('the local Slack proof endpoint', (): void => {
  it('uses Slack unless the explicit local test seam is configured', async (): Promise<void> => {
    const { slackApiUrl, slackAuthorizeUrl } = await endpointModule();
    expect(slackApiUrl('auth.test').href).toBe('https://slack.com/api/auth.test');
    expect(slackAuthorizeUrl().href).toBe('https://slack.com/oauth/v2/authorize');
  });

  it('admits only the fake service in local no-auth real mode', async (): Promise<void> => {
    vi.stubEnv('DAY0_SURFACE_MODE', 'real');
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('DAY0_TEST_SLACK_API_URL', 'http://fake-slack:8090/api/');
    vi.stubEnv(
      'DAY0_TEST_SLACK_AUTHORIZE_URL',
      'http://127.0.0.1:10092/oauth/v2/authorize',
    );
    const { slackApiUrl, slackAuthorizeUrl } = await endpointModule();
    expect(slackApiUrl('apps.manifest.create').href).toBe(
      'http://fake-slack:8090/api/apps.manifest.create',
    );
    expect(slackAuthorizeUrl().href).toBe(
      'http://127.0.0.1:10092/oauth/v2/authorize',
    );
  });

  it('keeps a fake-installed bot on the isolated provider during later HTTP actions', async (): Promise<void> => {
    vi.stubEnv('DAY0_SURFACE_MODE', 'real');
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('DAY0_TEST_SLACK_API_URL', 'http://fake-slack:8090/api/');
    const { HttpAdapter } = await import('../../../src/surfaces/http');
    const calls: string[] = [];
    const surface: SurfaceRecord = {
      slug: 'slack',
      displayName: 'Slack',
      class: 'chat',
      verdict: 'connected',
      credentialLanded: true,
      lastVerifiedAt: Date.now(),
      endpoint: 'https://slack.com/api/',
      path: 'documented-api',
      toolAllowlist: ['chat.postMessage'],
      credentialId: 'fake-oauth',
      credentialKind: 'oauth',
    };
    const adapter = new HttpAdapter([surface], {
      decrypt: vi.fn(async (): Promise<string> => 'xoxb-fake-dedicated'),
      fetch: vi.fn(async (url: URL): Promise<Response> => {
        calls.push(url.href);
        return new Response(JSON.stringify({ ok: true, ts: '1.1' }));
      }),
      now: (): number => Date.now(),
    });

    await adapter.apply(
      {} as ActionCtx,
      {
        agentId: 'agent' as Id<'agents'>,
        agentName: 'review closer',
        workItemId: 'work' as Id<'workItems'>,
        runId: 'run' as Id<'events'>,
      },
      {
        tool: 'http.request',
        args: {
          surface: 'slack',
          method: 'POST',
          path: '/chat.postMessage',
          headersJson: '{"Authorization":"Bearer {{secret}}"}',
          body: '{"channel":"D_DAY0_MANAGER","text":"proof"}',
        },
      },
      0,
      'work:run:0',
    );

    expect(calls).toEqual(['http://fake-slack:8090/api/chat.postMessage']);
  });

  it('refuses the override outside the isolated local proof', async (): Promise<void> => {
    vi.stubEnv('DAY0_TEST_SLACK_API_URL', 'https://evil.example/api/');
    const { slackApiUrl } = await endpointModule();
    expect(() => slackApiUrl('auth.test')).toThrow('local no-auth real mode');
  });
});
