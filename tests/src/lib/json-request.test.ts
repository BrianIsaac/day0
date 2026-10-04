import { describe, expect, it } from 'vitest';
import { crossOriginRefusal, readJsonBody } from '../../../src/lib/json-request';

const APP = 'http://localhost:3000';

function post(headers: Record<string, string>, body?: BodyInit): Request {
  return new Request(`${APP}/api/seed`, { method: 'POST', headers, body });
}

describe('the cross-origin check', (): void => {
  it("accepts a request from the app's own page", (): void => {
    expect(crossOriginRefusal(post({ origin: APP }))).toBeUndefined();
  });

  it('refuses a page on another localhost port, which SameSite cannot tell apart', (): void => {
    expect(crossOriginRefusal(post({ origin: 'http://localhost:8080' }))?.status).toBe(403);
  });

  it('refuses an opaque origin', (): void => {
    expect(crossOriginRefusal(post({ origin: 'null' }))?.status).toBe(403);
  });

  it('refuses a cross-site fetch that sent no Origin', (): void => {
    expect(crossOriginRefusal(post({ 'sec-fetch-site': 'same-site' }))?.status).toBe(403);
    expect(crossOriginRefusal(post({ 'sec-fetch-site': 'cross-site' }))?.status).toBe(403);
  });

  it('accepts a request no browser made, which carries neither header', (): void => {
    expect(crossOriginRefusal(post({}))).toBeUndefined();
  });
});

describe('the cross-origin check behind next start and a proxy', (): void => {
  /** Next builds `request.url` on localhost under `next start`, whatever the `Host` says. */
  function served(headers: Record<string, string>): Request {
    return new Request('http://localhost:3630/api/voice/chat', { method: 'POST', headers });
  }

  function env(values: Record<string, string>): (name: string) => string | undefined {
    return (name: string): string | undefined => values[name];
  }

  it('accepts a page served on the public origin while next start builds the URL on localhost', (): void => {
    const read = env({ DAY0_PUBLIC_URL: 'http://127.0.0.1:3630' });
    expect(crossOriginRefusal(served({ origin: 'http://127.0.0.1:3630' }), read)).toBeUndefined();
  });

  it("accepts a page the customer's proxy serves on the public origin", (): void => {
    const read = env({ DAY0_PUBLIC_URL: 'https://day0.acme.test/' });
    const request = served({
      origin: 'https://day0.acme.test',
      host: 'day0.acme.test',
      'x-forwarded-host': 'day0.acme.test',
      'x-forwarded-proto': 'https',
    });
    expect(crossOriginRefusal(request, read)).toBeUndefined();
  });

  it("still accepts the request's own origin when a public one is set, as a tunnel for Slack leaves the page on localhost", (): void => {
    const read = env({ DAY0_PUBLIC_URL: 'https://day0.acme.test' });
    expect(crossOriginRefusal(served({ origin: 'http://localhost:3630' }), read)).toBeUndefined();
  });

  it('never takes the origin from a forwarded header', (): void => {
    const request = served({
      origin: 'https://day0.acme.test',
      host: 'day0.acme.test',
      'x-forwarded-host': 'day0.acme.test',
      'x-forwarded-proto': 'https',
    });
    expect(crossOriginRefusal(request, env({}))?.status).toBe(403);
  });

  it('refuses a page on another localhost port when a public origin is set', (): void => {
    const read = env({ DAY0_PUBLIC_URL: 'http://127.0.0.1:3630' });
    expect(crossOriginRefusal(served({ origin: 'http://127.0.0.1:8080' }), read)?.status).toBe(403);
  });

  it('accepts only its own origin when the public origin is not an origin', (): void => {
    const read = env({ DAY0_PUBLIC_URL: 'https://day0.acme.test/app' });
    expect(crossOriginRefusal(served({ origin: 'https://day0.acme.test' }), read)?.status).toBe(
      403,
    );
    expect(crossOriginRefusal(served({ origin: 'http://localhost:3630' }), read)).toBeUndefined();
  });
});

describe('the bounded JSON body', (): void => {
  it('parses JSON sent as application/json', async (): Promise<void> => {
    const read = await readJsonBody(
      post({ 'content-type': 'application/json; charset=utf-8' }, '{"agentId":"a1"}'),
      64,
    );
    expect(read).toEqual({ ok: true, value: { agentId: 'a1' } });
  });

  it('refuses a body a plain form could send', async (): Promise<void> => {
    const read = await readJsonBody(post({ 'content-type': 'text/plain' }, '{"agentId":"a1"}'), 64);
    expect(read.ok ? 200 : read.refusal.status).toBe(415);
  });

  it('refuses a declared length over the limit without reading it', async (): Promise<void> => {
    const request = post(
      { 'content-type': 'application/json', 'content-length': '65' },
      JSON.stringify({ pad: 'x'.repeat(55) }),
    );
    const read = await readJsonBody(request, 64);
    expect(read.ok ? 200 : read.refusal.status).toBe(413);
    expect(request.bodyUsed).toBe(false);
  });

  it('stops reading a body that grows past the limit with no declared length', async (): Promise<void> => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller): void {
        controller.enqueue(new TextEncoder().encode('x'.repeat(32)));
      },
    });
    const request = new Request(`${APP}/api/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    const read = await readJsonBody(request, 64);
    expect(read.ok ? 200 : read.refusal.status).toBe(413);
  });

  it('refuses a body that is not JSON', async (): Promise<void> => {
    const read = await readJsonBody(post({ 'content-type': 'application/json' }, '{'), 64);
    expect(read.ok ? 200 : read.refusal.status).toBe(400);
  });
});
