import { RedactorUnavailableError } from '../../../src/redaction/client';
import { describe, expect, it, vi } from 'vitest';
import { RecordedSpanModel } from '../../fixtures/redaction-double';
import type { ActionCtx } from '../../../convex/_generated/server';
import type { Id } from '../../../convex/_generated/dataModel';
import {
  connectCheckedApi,
  DocumentedApiLimitation,
  documentedApiOperations,
  documentedCredentialHeader,
  documentedProbeRead,
  EFFECT_LENGTH,
  HttpAdapter,
  HTTP_TIMEOUT_MS,
  probeDocumentedApi,
  providerIdFrom,
  resolveRequestUrl,
  type ApiConnector,
} from '../../../src/surfaces/http';
import { READ_EFFECT_LENGTH } from '../../../src/surfaces/mock';
import type {
  AdapterRun,
  BeforeSurfaceTransport,
  SurfaceRecord,
} from '../../../src/surfaces/types';
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
  path: 'documented-api',
  toolAllowlist: ['auth.test', 'chat.postMessage'],
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

function fakeFetch(
  respond: (url: URL, init: RequestInit) => Response | Promise<Response>,
): FakeFetch {
  const fake: FakeFetch = {
    calls: [],
    fetch: async (input: URL, init: RequestInit): Promise<Response> => {
      fake.calls.push({ url: input.toString(), init });
      return await respond(input, init);
    },
  };
  return fake;
}

function adapter(
  fetchImpl: FakeFetch,
  surfaces: SurfaceRecord[] = [slack],
  secret = 'xoxb-test-value',
  beforeTransport?: BeforeSurfaceTransport,
): HttpAdapter {
  return new HttpAdapter(surfaces, {
    decrypt: vi.fn(async (): Promise<string> => secret),
    fetch: fetchImpl.fetch,
    now: (): number => now,
    beforeTransport,
    spanModel: new RecordedSpanModel(),
  });
}

describe('HTTP adapter', (): void => {
  it('applies outcome redaction to extracted provider identifiers', async () => {
    const result = await adapter(fakeFetch(() => Response.json({ id: 'password: hunter2' }))).apply(
      ctx,
      run,
      post,
      0,
      'k',
    );
    expect(result.providerId).toBe('password: <redacted>');
  });

  it('marks the row degraded when redacting its extracted error fails', async () => {
    let calls = 0;
    const spanModel = {
      name: 'intermittent',
      spans: async () => {
        if (++calls > 1) throw new RedactorUnavailableError('offline');
        return [];
      },
    };
    const surfaceAdapter = new HttpAdapter([slack], {
      decrypt: async () => 'opaque-known',
      now: () => now,
      fetch: async () => Response.json({ ok: false, error: 'password: hunter2 opaque-known' }),
      spanModel,
    });
    const result = await surfaceAdapter.apply(ctx, run, post, 0, 'k');
    expect(calls).toBeGreaterThan(1);
    expect(result.redaction).toBe('structural-only');
    expect(result.reason).not.toContain('opaque-known');
  });

  it('keeps a read response whole for the closing phase and clips a write to the short effect', async (): Promise<void> => {
    const long = JSON.stringify({
      ok: true,
      members: Array.from({ length: 60 }, (_, index) => ({
        id: `U${index}`,
        name: `member ${index}`,
      })),
    });
    const get: MockAction = {
      tool: 'http.request',
      args: {
        surface: 'slack',
        method: 'GET',
        path: '/auth.test',
        headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
      },
    };
    const respond = (): Response => new Response(long, { status: 200 });

    const read = await adapter(fakeFetch(respond)).apply(ctx, run, get, 0, 'wi:run:0');
    const write = await adapter(fakeFetch(respond)).apply(ctx, run, post, 1, 'wi:run:1');

    expect(read.ok).toBe(true);
    expect(read.effect?.length).toBeGreaterThan(EFFECT_LENGTH);
    expect(read.effect?.length).toBeLessThanOrEqual(READ_EFFECT_LENGTH);
    expect(read.effect).toContain('"name":"member 59"}]}');
    expect(write.ok).toBe(true);
    expect(write.effect?.length).toBeLessThanOrEqual(EFFECT_LENGTH);
  });

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

  it('revalidates authority after decrypt and before fetch', async (): Promise<void> => {
    const fetchImpl = fakeFetch((): Response => new Response('should not be called'));
    const beforeTransport = vi.fn(async (): Promise<string> => 'agent not found');
    const result = await adapter(fetchImpl, [slack], 'xoxb-test-value', beforeTransport).apply(
      ctx,
      run,
      post,
      0,
      'k',
    );
    expect(result).toEqual({
      tool: 'http.request',
      ok: false,
      reason: 'agent not found',
      idempotencyKey: 'k',
    });
    expect(beforeTransport).toHaveBeenCalledWith(post, slack);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('never echoes the request headers or the secret into the ledger', async (): Promise<void> => {
    const fetchImpl = fakeFetch(
      (): Response =>
        new Response(JSON.stringify({ ok: false, error: 'invalid_auth xoxb-test-value' }), {
          status: 200,
        }),
    );
    const result = await adapter(fetchImpl).apply(ctx, run, post, 0, 'k');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(
      'HTTP 200 · invalid_auth <redacted> · {"ok":false,"error":"invalid_auth <redacted>"}',
    );
    expect(JSON.stringify(result)).not.toContain('xoxb-test-value');
    expect(JSON.stringify(result)).not.toContain('Authorization');
  });

  it('redacts a credential echoed as the provider id', async (): Promise<void> => {
    const fetchImpl = fakeFetch(
      (): Response =>
        new Response(JSON.stringify({ ok: true, ts: 'xoxb-test-value' }), { status: 200 }),
    );
    const result = await adapter(fetchImpl).apply(ctx, run, post, 0, 'k');
    expect(result).toMatchObject({ ok: true, providerId: '<redacted>' });
    expect(JSON.stringify(result)).not.toContain('xoxb-test-value');
  });

  it('treats a non-2xx status as not landed', async (): Promise<void> => {
    const fetchImpl = fakeFetch((): Response => new Response('rate limited', { status: 429 }));
    const result = await adapter(fetchImpl).apply(ctx, run, post, 0, 'k');
    expect(result).toMatchObject({ ok: false, reason: 'HTTP 429 · rate limited' });
  });

  it('treats redirects and oversized envelopes as not landed', async (): Promise<void> => {
    const redirect = fakeFetch(
      (): Response =>
        new Response('', { status: 302, headers: { Location: 'https://evil.example' } }),
    );
    await expect(adapter(redirect).apply(ctx, run, post, 0, 'k')).resolves.toMatchObject({
      ok: false,
      reason: 'HTTP 302 ·',
    });

    const oversized = fakeFetch(
      (): Response =>
        new Response(
          JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024), ok: false, error: 'denied' }),
          {
            status: 200,
          },
        ),
    );
    const result = await adapter(oversized).apply(ctx, run, post, 0, 'k');
    expect(result).toEqual({
      tool: 'http.request',
      ok: false,
      outcomeUnknown: true,
      reason: 'HTTP 200 · response exceeded 65536 bytes',
      idempotencyKey: 'k',
    });
  });

  it('records a successful non-JSON body as bounded evidence', async (): Promise<void> => {
    const fetchImpl = fakeFetch((): Response => new Response('accepted', { status: 200 }));
    await expect(adapter(fetchImpl).apply(ctx, run, post, 0, 'k')).resolves.toMatchObject({
      ok: true,
      effect: 'HTTP 200 · accepted',
    });
  });

  it('reads an id from a JSON response without a ts', async (): Promise<void> => {
    const fetchImpl = fakeFetch(
      (): Response => new Response(JSON.stringify({ id: 'rec_9' }), { status: 201 }),
    );
    const result = await adapter(fetchImpl).apply(ctx, run, post, 0, 'k');
    expect(result).toMatchObject({
      ok: true,
      providerId: 'rec_9',
      effect: 'HTTP 201 · {"id":"rec_9"}',
    });
  });

  it('refuses a path that escapes the surface endpoint before decrypting', async (): Promise<void> => {
    const fetchImpl = fakeFetch((): Response => new Response('should not be called'));
    for (const path of [
      '//evil.example/x',
      'http://slack.com/api/chat.postMessage',
      'https://user@slack.com/api/chat.postMessage',
      'https://evil.example/steal',
      '../../other',
      '/../other',
      '..%2f..%2fother',
      '%252e%252e%252fother',
    ]) {
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

  it('refuses an HTTP operation outside the surface allowlist before decrypt or fetch', async (): Promise<void> => {
    const fetchImpl = fakeFetch((): Response => new Response('should not be called'));
    const decrypt = vi.fn(async (): Promise<string> => 'xoxb-test-value');
    const surfaceAdapter = new HttpAdapter([slack], {
      decrypt,
      fetch: fetchImpl.fetch,
      now: (): number => now,
    });
    const result = await surfaceAdapter.apply(
      ctx,
      run,
      { tool: 'http.request', args: { ...post.args, path: '/chat.delete' } },
      0,
      'k',
    );
    expect(result).toMatchObject({
      ok: false,
      reason: 'tool not in the surface allowlist (chat.delete)',
    });
    expect(decrypt).not.toHaveBeenCalled();
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('refuses secret placeholders in header names and redacts non-Error failures', async (): Promise<void> => {
    const fetchImpl = fakeFetch(async (): Promise<never> => await Promise.reject('offline'));
    const badHeader = await adapter(fetchImpl).apply(
      ctx,
      run,
      {
        tool: 'http.request',
        args: { ...post.args, headersJson: '{"{{secret}}":"value"}' },
      },
      0,
      'k',
    );
    expect(badHeader).toMatchObject({
      ok: false,
      reason:
        '{{secret}} goes only in a header value, never in the header name {{secret}}, so the credential was not sent',
    });
    expect(fetchImpl.calls).toHaveLength(0);
    await expect(adapter(fetchImpl).apply(ctx, run, post, 0, 'k')).resolves.toMatchObject({
      ok: false,
      outcomeUnknown: true,
      reason: 'offline',
    });
  });

  it('refuses a template naming another surface secret and sends nothing', async (): Promise<void> => {
    const fetchImpl = fakeFetch((): Response => new Response('should not be called'));
    const result = await adapter(fetchImpl).apply(
      ctx,
      run,
      {
        tool: 'http.request',
        args: {
          ...post.args,
          headersJson: JSON.stringify({ Authorization: 'Bearer {{secret:linear}}' }),
        },
      },
      0,
      'k',
    );
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('surface "linear"'),
    });
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('reports a timeout as a failed row', async (): Promise<void> => {
    const fetchImpl = fakeFetch(async (): Promise<Response> => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    });
    const result = await adapter(fetchImpl).apply(ctx, run, post, 0, 'k');
    expect(result).toMatchObject({
      ok: false,
      reason: `no response within ${HTTP_TIMEOUT_MS / 1000} s`,
    });
  });

  it('refuses an unconnected surface and a surface without a credential', async (): Promise<void> => {
    const fetchImpl = fakeFetch((): Response => new Response('x'));
    await expect(
      adapter(fetchImpl, [{ ...slack, verdict: 'approved', credentialLanded: false }]).apply(
        ctx,
        run,
        post,
        0,
        'k',
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'surface not connected (ungranted)',
    });
    await expect(
      adapter(fetchImpl, [{ ...slack, credentialId: undefined }]).apply(ctx, run, post, 0, 'k'),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'surface has no credential',
    });
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('sends no body with a GET', async (): Promise<void> => {
    const fetchImpl = fakeFetch(
      (): Response => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await adapter(fetchImpl).apply(
      ctx,
      run,
      {
        tool: 'http.request',
        args: {
          surface: 'slack',
          path: 'auth.test',
          headersJson: '{"Authorization":"Bearer {{secret}}"}',
          body: 'ignored',
        },
      },
      0,
      'k',
    );
    expect(fetchImpl.calls[0].init.body).toBeUndefined();
    expect(fetchImpl.calls[0].url).toBe('https://slack.com/api/auth.test');
  });
});

describe('request URL and provider id helpers', (): void => {
  it('resolves relative paths under the endpoint and refuses escapes', (): void => {
    expect(resolveRequestUrl('https://slack.com/api/', '/chat.postMessage').toString()).toBe(
      'https://slack.com/api/chat.postMessage',
    );
    expect(resolveRequestUrl('https://slack.com/api', 'auth.test?x=1').toString()).toBe(
      'https://slack.com/api/auth.test?x=1',
    );
    expect(() => resolveRequestUrl('https://slack.com/api/', '//evil.example/x')).toThrow(
      'path escapes',
    );
    expect(() => resolveRequestUrl('https://slack.com/api/', '..%2fadmin')).toThrow('path escapes');
    expect(() => resolveRequestUrl('https://slack.com/api/', '%252e%252e%252fadmin')).toThrow(
      'path escapes',
    );
    expect(() => resolveRequestUrl('https://slack.com/api/', 'http:evil')).toThrow('path escapes');
    expect(() => resolveRequestUrl('https://user@slack.com/api/', 'auth.test')).toThrow(
      'without userinfo',
    );
    expect(() => resolveRequestUrl('https://slack.com/api/', 'https://slack.com/other')).toThrow(
      'path escapes the surface endpoint',
    );
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

/** A tracker's own runbook page, the shape a documented REST API takes in a team's docs. */
const TRACKER_PAGE = [
  '# Tracker',
  '',
  'The team tracker has a REST API at `https://tracker.example.com/api/v2/`. Send the service',
  'key as `X-Api-Key: {{secret}}` on every request.',
  '',
  '- `GET /issues` lists the open issues; add `?state=open` to filter.',
  '- `GET https://tracker.example.com/api/v2/projects` lists the projects.',
  '- `POST /comments` adds a comment to an issue.',
  '- `GET /issues/{id}` reads one issue.',
  '- `DELETE https://other.example.com/api/v2/issues` belongs to another system.',
  '- `Content-Type: application/json` on every write.',
  '- Probe read: `GET /issues`',
].join('\n');

const TRACKER = 'https://tracker.example.com/api/v2/';

/** A connector that skips DNS and answers every request from `respond`. */
function trackerConnector(respond: (url: URL, init: RequestInit) => Response): {
  connect: ApiConnector;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    connect: async (endpoint: string) => ({
      url: new URL(endpoint),
      fetch: async (input: URL, init: RequestInit): Promise<Response> => {
        calls.push({ url: input.href, init });
        return respond(input, init);
      },
    }),
  };
}

describe('the operations a documented API offers', (): void => {
  it('reads each backticked verb and path under the documented base', (): void => {
    expect(documentedApiOperations(TRACKER_PAGE, TRACKER)).toEqual([
      { method: 'GET', operation: 'issues' },
      { method: 'GET', operation: 'projects' },
      { method: 'POST', operation: 'comments' },
      { method: 'GET', operation: 'issues/{id}' },
    ]);
  });

  it('keeps a value segment as one template segment, whichever way the page spells it', (): void => {
    const page = '`GET /issues/{id}` `GET /issues/:id/comments` `PATCH /issues/<key>`';
    expect(documentedApiOperations(page, TRACKER)).toEqual([
      { method: 'GET', operation: 'issues/{id}' },
      { method: 'GET', operation: 'issues/{id}/comments' },
      { method: 'PATCH', operation: 'issues/{key}' },
    ]);
  });

  it('leaves out an address on another host or above the documented base', (): void => {
    const page = [
      '`GET https://other.example.com/api/v2/issues`',
      '`GET https://tracker.example.com/admin/users`',
      '`GET /../admin`',
    ].join('\n');
    expect(documentedApiOperations(page, TRACKER)).toEqual([]);
  });

  it('ignores prose, headers and verbs the rung does not send', (): void => {
    const page = 'GET /issues without backticks; `Authorization: Bearer`; `TRACE /issues`';
    expect(documentedApiOperations(page, TRACKER)).toEqual([]);
  });

  it('names each operation once whatever the page repeats', (): void => {
    const page = '`GET /issues` and again `GET /issues?state=open`';
    expect(documentedApiOperations(page, TRACKER)).toEqual([
      { method: 'GET', operation: 'issues' },
    ]);
  });

  it('finds nothing against an endpoint that is not a URL', (): void => {
    expect(documentedApiOperations(TRACKER_PAGE, 'not a url')).toEqual([]);
  });
});

describe('the header a documented API takes its credential in', (): void => {
  it('reads a header the page shows carrying the placeholder', (): void => {
    expect(documentedCredentialHeader(TRACKER_PAGE)).toEqual({ name: 'X-Api-Key' });
    expect(documentedCredentialHeader('Send `Authorization: Token {{secret}}`.')).toEqual({
      name: 'Authorization',
      scheme: 'Token',
    });
  });

  it('reads the scheme of an Authorization header named without the placeholder', (): void => {
    expect(documentedCredentialHeader('a bot token in the `Authorization: Bearer` header')).toEqual(
      { name: 'Authorization', scheme: 'Bearer' },
    );
  });

  it('falls back to a bearer token when the page names no header', (): void => {
    expect(documentedCredentialHeader('`Content-Type: application/json`')).toEqual({
      name: 'Authorization',
      scheme: 'Bearer',
    });
  });
});

describe('the read a page names for the probe', (): void => {
  it('takes the documented probe read, and a plain path under the base only', (): void => {
    expect(documentedProbeRead(TRACKER_PAGE, TRACKER)).toEqual({
      method: 'GET',
      operation: 'issues',
    });
    expect(
      documentedProbeRead('Probe read: `GET https://tracker.example.com/api/v2/me?x=1`', TRACKER),
    ).toEqual({ method: 'GET', operation: 'me' });
    expect(documentedProbeRead('Probe read: `GET /issues/{id}`', TRACKER)).toBeUndefined();
    expect(
      documentedProbeRead('Probe read: `GET https://other.example/me`', TRACKER),
    ).toBeUndefined();
    expect(documentedProbeRead('Probe read: `POST /me`', TRACKER)).toBeUndefined();
  });

  it('never guesses one: a documented GET is not a probe read (review M2)', (): void => {
    const page = '- `GET /auth/logout` signs the key out.\n- `GET /issues` lists the issues.';
    expect(documentedApiOperations(page, TRACKER)).toHaveLength(2);
    expect(documentedProbeRead(page, TRACKER)).toBeUndefined();
  });

  it('skips a named read the gate classes a write, and takes the next', (): void => {
    const page = 'Probe read: `GET /tokens/revoke`\nProbe read: `GET /me`';
    expect(documentedProbeRead(page, TRACKER)).toEqual({ method: 'GET', operation: 'me' });
  });
});

describe('probing a documented API that is not Slack', (): void => {
  it('checks the credential with the documented probe read and admits every operation with its verb', async (): Promise<void> => {
    const tracker = trackerConnector(() => Response.json([{ id: 'TRK-1' }]));
    const discovery = await probeDocumentedApi(
      TRACKER,
      'tracker-key',
      TRACKER_PAGE,
      tracker.connect,
    );
    expect(discovery).toEqual({
      toolAllowlist: ['GET issues', 'GET projects', 'POST comments', 'GET issues/{id}'],
      toolArguments: [],
    });
    expect(tracker.calls).toHaveLength(1);
    expect(tracker.calls[0].url).toBe('https://tracker.example.com/api/v2/issues');
    expect(tracker.calls[0].init.method).toBe('GET');
    expect(new Headers(tracker.calls[0].init.headers).get('x-api-key')).toBe('tracker-key');
    expect(new Headers(tracker.calls[0].init.headers).get('authorization')).toBeNull();
    expect(tracker.calls[0].init.redirect).toBe('manual');
  });

  it('never sends a documented write to check a credential', async (): Promise<void> => {
    const tracker = trackerConnector(() => Response.json({ ok: true }));
    await expect(
      probeDocumentedApi(
        TRACKER,
        'k',
        '# Tracker\n`POST /comments` `DELETE /issues`',
        tracker.connect,
      ),
    ).rejects.toThrow(DocumentedApiLimitation);
    await expect(
      probeDocumentedApi(
        TRACKER,
        'k',
        '# Tracker\n`GET /issues.delete`\nProbe read: `GET /issues.delete`',
        tracker.connect,
      ),
    ).rejects.toThrow('names no read');
    await expect(
      probeDocumentedApi(
        TRACKER,
        'k',
        '# Tracker\n`GET /auth/logout` `GET /issues`',
        tracker.connect,
      ),
    ).rejects.toThrow('does not guess one that could change something');
    expect(tracker.calls).toEqual([]);
  });

  it('says a page that names no operation is a limitation, not a dead system', async (): Promise<void> => {
    const tracker = trackerConnector(() => Response.json({}));
    const failure = probeDocumentedApi(TRACKER, 'k', '# Tracker\nIt has an API.', tracker.connect);
    await expect(failure).rejects.toThrow(DocumentedApiLimitation);
    await expect(failure).rejects.toThrow('not evidence that the system is unavailable');
    await expect(probeDocumentedApi(undefined, 'k', TRACKER_PAGE, tracker.connect)).rejects.toThrow(
      DocumentedApiLimitation,
    );
    expect(tracker.calls).toEqual([]);
  });

  it('reports a refused key with its status so the verdict reads it as access', async (): Promise<void> => {
    const tracker = trackerConnector(() => new Response('{"error":"bad key"}', { status: 401 }));
    await expect(probeDocumentedApi(TRACKER, 'k', TRACKER_PAGE, tracker.connect)).rejects.toThrow(
      'GET issues answered HTTP 401',
    );
  });

  it('does not follow a redirect with the credential', async (): Promise<void> => {
    const tracker = trackerConnector(
      () => new Response(null, { status: 302, headers: { Location: 'https://sso.example/' } }),
    );
    await expect(probeDocumentedApi(TRACKER, 'k', TRACKER_PAGE, tracker.connect)).rejects.toThrow(
      'HTTP 302',
    );
    expect(tracker.calls).toHaveLength(1);
  });

  it('reads an ok: false envelope inside a 200 as a failure', async (): Promise<void> => {
    const tracker = trackerConnector(() => Response.json({ ok: false, error: 'invalid_auth' }));
    await expect(probeDocumentedApi(TRACKER, 'k', TRACKER_PAGE, tracker.connect)).rejects.toThrow(
      'invalid_auth',
    );
  });

  it('names the operation that could not be reached', async (): Promise<void> => {
    const connect: ApiConnector = async (endpoint: string) => ({
      url: new URL(endpoint),
      fetch: async (): Promise<Response> => {
        throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
      },
    });
    await expect(probeDocumentedApi(TRACKER, 'k', TRACKER_PAGE, connect)).rejects.toThrow(
      'GET issues could not be reached: fetch failed',
    );
  });

  it('refuses a private address in the words of an API, not an MCP server', async (): Promise<void> => {
    const failure = connectCheckedApi('https://tracker.internal/api/v2/');
    await expect(failure).rejects.toThrow(DocumentedApiLimitation);
    await expect(failure).rejects.toThrow(
      'The approved API endpoint must use a public HTTPS hostname',
    );
    await expect(failure).rejects.not.toThrow(/\bMCP\b/);
  });

  it('lets the HTTP rung read the tracker the probe connected', async (): Promise<void> => {
    const tracker = trackerConnector(() => Response.json([{ id: 'TRK-1' }]));
    const { toolAllowlist } = await probeDocumentedApi(
      TRACKER,
      'tracker-key',
      TRACKER_PAGE,
      tracker.connect,
    );
    const fake = fakeFetch(() => Response.json([{ id: 'TRK-1', title: 'Renewal call' }]));
    const trackerAdapter = adapter(
      fake,
      [
        {
          slug: 'tracker',
          displayName: 'Tracker',
          class: 'kanban',
          verdict: 'connected',
          credentialLanded: true,
          lastVerifiedAt: now,
          endpoint: TRACKER,
          path: 'documented-api',
          toolAllowlist,
          credentialId: 'cred-tracker',
          credentialKind: 'value',
        },
      ],
      'tracker-key',
    );
    const row = await trackerAdapter.apply(
      ctx,
      run,
      {
        tool: 'http.request',
        args: {
          surface: 'tracker',
          method: 'GET',
          path: '/issues',
          headersJson: JSON.stringify({ 'X-Api-Key': '{{secret}}' }),
        },
      },
      0,
      'key-read',
    );
    expect(row).toMatchObject({ ok: true, effect: expect.stringContaining('Renewal call') });
    expect(fake.calls[0].url).toBe('https://tracker.example.com/api/v2/issues');
    expect(new Headers(fake.calls[0].init.headers).get('x-api-key')).toBe('tracker-key');
  });
});

describe('the HTTP rung on a documented API that is not Slack', (): void => {
  const tracker: SurfaceRecord = {
    slug: 'tracker',
    displayName: 'Tracker',
    class: 'kanban',
    verdict: 'connected',
    credentialLanded: true,
    lastVerifiedAt: now,
    endpoint: TRACKER,
    path: 'documented-api',
    toolAllowlist: ['GET issues', 'GET issues/{id}', 'POST comments'],
    credentialId: 'cred-tracker',
    credentialKind: 'value',
  };

  const request = (method: string, path: string, body?: string): MockAction => ({
    tool: 'http.request',
    args: {
      surface: 'tracker',
      method,
      path,
      headersJson: JSON.stringify({ 'X-Api-Key': '{{secret}}' }),
      ...(body === undefined ? {} : { body }),
    },
  });

  it('refuses DELETE /issues when only GET /issues is documented (review M3)', async (): Promise<void> => {
    const sent = fakeFetch(() => Response.json({}));
    const rung = adapter(sent, [tracker], 'tracker-key');
    for (const method of ['DELETE', 'PATCH', 'PUT']) {
      await expect(rung.apply(ctx, run, request(method, '/issues'), 0, 'k')).resolves.toMatchObject(
        { ok: false, reason: `tool not in the surface allowlist (${method} issues)` },
      );
    }
    expect(sent.calls).toEqual([]);
    await expect(rung.apply(ctx, run, request('GET', '/issues'), 0, 'k')).resolves.toMatchObject({
      ok: true,
    });
  });

  it('matches a templated operation one segment for one segment', async (): Promise<void> => {
    const sent = fakeFetch(() => Response.json({ id: 'TRK-7' }));
    const rung = adapter(sent, [tracker], 'tracker-key');
    await expect(
      rung.apply(ctx, run, request('GET', '/issues/TRK-7'), 0, 'k'),
    ).resolves.toMatchObject({ ok: true, providerId: 'TRK-7' });
    for (const path of ['/issues/TRK-7/comments', '/issues/', '/issues/TRK-7/../admin']) {
      await expect(rung.apply(ctx, run, request('GET', path), 0, 'k')).resolves.toMatchObject({
        ok: false,
      });
    }
    expect(sent.calls.map((call) => call.url)).toEqual([
      'https://tracker.example.com/api/v2/issues/TRK-7',
    ]);
  });

  it('never puts the credential in a body, a documented field or not, or a path (review M4)', async (): Promise<void> => {
    const sent = fakeFetch(() => Response.json({ ok: true }));
    const rung = adapter(sent, [tracker], 'tracker-key');
    const inBody = await rung.apply(
      ctx,
      run,
      request('POST', '/comments', JSON.stringify({ issue: 'TRK-7', body: 'key: {{secret}}' })),
      0,
      'k',
    );
    expect(inBody).toMatchObject({
      ok: false,
      reason:
        '{{secret}} goes only in a header value, never in the body, so the credential was not sent',
    });
    const inPath = await rung.apply(ctx, run, request('GET', '/issues/{{secret}}'), 0, 'k');
    expect(inPath).toMatchObject({ ok: false });
    expect(inPath.reason).toContain('never in the path');
    const unfilled = await rung.apply(ctx, run, request('GET', '/issues/{{issue}}'), 0, 'k');
    expect(unfilled.reason).toContain('a value was left unfilled');
    expect(sent.calls).toEqual([]);
    // The header is where the key goes.
    await rung.apply(
      ctx,
      run,
      request('POST', '/comments', '{"issue":"TRK-7","body":"Done."}'),
      0,
      'k',
    );
    expect(new Headers(sent.calls[0]!.init.headers).get('x-api-key')).toBe('tracker-key');
    expect(sent.calls[0]!.init.body).toBe('{"issue":"TRK-7","body":"Done."}');
  });
});
