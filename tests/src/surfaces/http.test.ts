import { describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../../convex/_generated/server';
import type { Id } from '../../../convex/_generated/dataModel';
import { HttpAdapter, HTTP_TIMEOUT_MS, providerIdFrom, resolveRequestUrl } from '../../../src/surfaces/http';
import type { AdapterRun, SurfaceRecord } from '../../../src/surfaces/types';
import type { MockAction } from '../../../src/work/types';

const now = Date.UTC(2026, 7, 29, 9);
const ctx = {} as ActionCtx;
const run: AdapterRun = {
  agentId: 'agent' as Id<'agents'>,
  agentName: 'Priya',
  workItemId: 'wi' as Id<'workItems'>,
  runId: 'run' as Id<'events'>,
};

const slack: SurfaceRecord = {
  slug: 'slack',
  displayName: 'Slack',
  class: 'chat',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: now,
  endpoint: 'https://slack.com/api/',
  credentialId: 'cred-slack',
  credentialKind: 'value',
  managerDmChannelId: 'D0MANAGER',
};

const post: MockAction = {
  tool: 'http.request',
  args: {
    surface: 'slack',
    method: 'POST',
    path: '/chat.postMessage',
    headersJson: JSON.stringify({
      Authorization: 'Bearer {{secret}}',
      'Content-Type': 'application/json; charset=utf-8',
    }),
    body: JSON.stringify({ channel: 'D0MANAGER', text: 'Draft ready.' }),
  },
};

interface FakeFetch {
  calls: Array<{ url: string; init: RequestInit }>;
  fetch: (input: URL, init: RequestInit) => Promise<Response>;
}

function fakeFetch(respond: (url: URL, init: RequestInit) => Response | Promise<Response>): FakeFetch {
  const fake: FakeFetch = {
    calls: [],
    fetch: async (input: URL, init: RequestInit): Promise<Response> => {
      fake.calls.push({ url: input.toString(), init });
      return await respond(input, init);
    },
  };
  return fake;
}

function adapter(fetchImpl: FakeFetch, surfaces: SurfaceRecord[] = [slack], secret = 'xoxb-test-value'): HttpAdapter {
  return new HttpAdapter(surfaces, {
    decrypt: vi.fn(async (): Promise<string> => secret),
    fetch: fetchImpl.fetch,
    now: (): number => now,
  });
}

describe('HTTP adapter', (): void => {
  it('injects the secret, posts to the endpoint path and records the provider ts', async (): Promise<void> => {
    const fetchImpl = fakeFetch(
      (): Response =>
        new Response(JSON.stringify({ ok: true, channel: 'D0MANAGER', ts: '1787654400.000100' }), {
          status: 200,
        }),
    );
    const result = await adapter(fetchImpl).apply(ctx, run, post, 0, 'wi:run:0');
    expect(result).toEqual({
      tool: 'http.request',
      ok: true,
      effect: 'HTTP 200 · {"ok":true,"channel":"D0MANAGER","ts":"1787654400.000100"}',
      providerId: '1787654400.000100',
      idempotencyKey: 'wi:run:0',
    });
    expect(fetchImpl.calls).toHaveLength(1);
    const [call] = fetchImpl.calls;
    expect(call.url).toBe('https://slack.com/api/chat.postMessage');
    expect(call.init.method).toBe('POST');
    expect(call.init.headers).toEqual({
      Authorization: 'Bearer xoxb-test-value',
      'Content-Type': 'application/json; charset=utf-8',
    });
    expect(call.init.body).toBe(JSON.stringify({ channel: 'D0MANAGER', text: 'Draft ready.' }));
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(call.init.redirect).toBe('manual');
  });

  it('never echoes the request headers or the secret into the ledger', async (): Promise<void> => {
    const fetchImpl = fakeFetch(
      (): Response =>
        new Response(JSON.stringify({ ok: false, error: 'invalid_auth xoxb-test-value' }), { status: 200 }),
    );
    const result = await adapter(fetchImpl).apply(ctx, run, post, 0, 'k');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('HTTP 200 · invalid_auth <redacted> · {"ok":false,"error":"invalid_auth <redacted>"}');
    expect(JSON.stringify(result)).not.toContain('xoxb-test-value');
    expect(JSON.stringify(result)).not.toContain('Authorization');
  });

  it('treats a non-2xx status as not landed', async (): Promise<void> => {
    const fetchImpl = fakeFetch((): Response => new Response('rate limited', { status: 429 }));
    const result = await adapter(fetchImpl).apply(ctx, run, post, 0, 'k');
    expect(result).toMatchObject({ ok: false, reason: 'HTTP 429 · rate limited' });
  });

  it('reads an id from a JSON response without a ts', async (): Promise<void> => {
    const fetchImpl = fakeFetch((): Response => new Response(JSON.stringify({ id: 'rec_9' }), { status: 201 }));
    const result = await adapter(fetchImpl).apply(ctx, run, post, 0, 'k');
    expect(result).toMatchObject({ ok: true, providerId: 'rec_9', effect: 'HTTP 201 · {"id":"rec_9"}' });
  });

  it('refuses a path that escapes the surface endpoint before decrypting', async (): Promise<void> => {
    const fetchImpl = fakeFetch((): Response => new Response('should not be called'));
    for (const path of ['https://evil.example/steal', '../../other', '/../other']) {
      const result = await adapter(fetchImpl).apply(
        ctx,
        run,
        { tool: 'http.request', args: { ...post.args, path } },
        0,
        'k',
      );
      expect(result).toMatchObject({ ok: false, reason: 'path escapes the surface endpoint' });
    }
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('refuses a template naming another surface secret and sends nothing', async (): Promise<void> => {
    const fetchImpl = fakeFetch((): Response => new Response('should not be called'));
    const result = await adapter(fetchImpl).apply(
      ctx,
      run,
      {
        tool: 'http.request',
        args: { ...post.args, headersJson: JSON.stringify({ Authorization: 'Bearer {{secret:linear}}' }) },
      },
      0,
      'k',
    );
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('surface "linear"') });
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('reports a timeout as a failed row', async (): Promise<void> => {
    const fetchImpl = fakeFetch(async (): Promise<Response> => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    });
    const result = await adapter(fetchImpl).apply(ctx, run, post, 0, 'k');
    expect(result).toMatchObject({ ok: false, reason: `no response within ${HTTP_TIMEOUT_MS / 1000} s` });
  });

  it('refuses an unconnected surface and a surface without a credential', async (): Promise<void> => {
    const fetchImpl = fakeFetch((): Response => new Response('x'));
    await expect(adapter(fetchImpl, [{ ...slack, verdict: 'approved', credentialLanded: false }]).apply(ctx, run, post, 0, 'k')).resolves.toMatchObject({
      ok: false,
      reason: 'surface not connected (ungranted)',
    });
    await expect(adapter(fetchImpl, [{ ...slack, credentialId: undefined }]).apply(ctx, run, post, 0, 'k')).resolves.toMatchObject({
      ok: false,
      reason: 'surface has no credential',
    });
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('sends no body with a GET', async (): Promise<void> => {
    const fetchImpl = fakeFetch((): Response => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await adapter(fetchImpl).apply(
      ctx,
      run,
      { tool: 'http.request', args: { surface: 'slack', path: 'auth.test', headersJson: '{"Authorization":"Bearer {{secret}}"}', body: 'ignored' } },
      0,
      'k',
    );
    expect(fetchImpl.calls[0].init.body).toBeUndefined();
    expect(fetchImpl.calls[0].url).toBe('https://slack.com/api/auth.test');
  });
});

describe('request URL and provider id helpers', (): void => {
  it('resolves relative paths under the endpoint and refuses escapes', (): void => {
    expect(resolveRequestUrl('https://slack.com/api/', '/chat.postMessage').toString()).toBe('https://slack.com/api/chat.postMessage');
    expect(resolveRequestUrl('https://slack.com/api', 'auth.test?x=1').toString()).toBe('https://slack.com/api/auth.test?x=1');
    expect(resolveRequestUrl('https://slack.com/api/', '//evil.example/x').toString()).toBe('https://slack.com/api/evil.example/x');
    expect(() => resolveRequestUrl('https://slack.com/api/', 'https://slack.com/other')).toThrow('path escapes the surface endpoint');
    expect(() => resolveRequestUrl('not a url', 'x')).toThrow();
  });

  it('prefers ts, then id, then message.ts', (): void => {
    expect(providerIdFrom({ ts: '1.2', id: 'x' })).toBe('1.2');
    expect(providerIdFrom({ id: 7 })).toBe('7');
    expect(providerIdFrom({ message: { ts: '3.4' } })).toBe('3.4');
    expect(providerIdFrom({ ok: true })).toBeUndefined();
    expect(providerIdFrom('text')).toBeUndefined();
  });
});
