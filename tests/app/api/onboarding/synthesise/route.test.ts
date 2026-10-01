import { ConvexError } from 'convex/values';
import { EMPLOYEE_NOT_YOURS } from '../../../../../src/agent/employee-access';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/nextjs/server', () => ({
  auth: async (): Promise<{ userId: null }> => ({ userId: null }),
}));

let cookieValue: string | undefined;
const synthesised: unknown[] = [];
const dialled: string[] = [];
/** What the deployment's synthesis rejects with, when a test needs it to. */
let synthesisFailure: { readonly value: unknown } | undefined;

vi.mock('next/headers', () => ({
  cookies: async (): Promise<{ get: () => { value: string } | undefined }> => ({
    get: (): { value: string } | undefined => (cookieValue ? { value: cookieValue } : undefined),
  }),
}));

/** The Convex HTTP transport: records what the route asks the deployment to run. */
vi.mock('convex/browser', () => ({
  ConvexHttpClient: class {
    constructor(address: string) {
      dialled.push(address);
    }
    setAuth(): void {}
    async action(_reference: unknown, args: unknown): Promise<{ charterId: string }> {
      if (synthesisFailure) throw synthesisFailure.value;
      synthesised.push(args);
      return { charterId: 'charter-1' };
    }
  },
}));

const APP = 'http://localhost:3000';
const BODY = JSON.stringify({
  agentId: 'agent-1',
  bossLabel: 'Aiko',
  transcript: 'We close the month.',
});

async function signingKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
}

async function unlock(): Promise<void> {
  const { mintDevNoAuthSession } = await import('../../../../../src/lib/dev-auth-server');
  cookieValue = await mintDevNoAuthSession();
}

function request(headers: Record<string, string>, body: string = BODY): Request {
  return new Request(`${APP}/api/onboarding/synthesise`, { method: 'POST', headers, body });
}

async function synthesise(incoming: Request): Promise<Response> {
  const { POST } = await import('../../../../../app/api/onboarding/synthesise/route');
  return POST(incoming);
}

beforeEach(async (): Promise<void> => {
  vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'http://127.0.0.1:3210');
  vi.stubEnv('DEV_NO_AUTH_SECRET', 'a'.repeat(43));
  vi.stubEnv('DEV_NO_AUTH_SIGNING_KEY', await signingKey());
  vi.resetModules();
  cookieValue = undefined;
  synthesised.length = 0;
  dialled.length = 0;
  synthesisFailure = undefined;
});

afterEach((): void => {
  vi.unstubAllEnvs();
});

const JSON_FROM_APP = { origin: APP, 'content-type': 'application/json' };

describe('the charter synthesis route', (): void => {
  it("synthesises from the app's own page", async (): Promise<void> => {
    await unlock();
    const response = await synthesise(request(JSON_FROM_APP));
    expect(response.status).toBe(200);
    expect(synthesised).toEqual([
      { agentId: 'agent-1', bossLabel: 'Aiko', transcript: 'We close the month.' },
    ]);
  });

  it('refuses a page on another localhost port that rides the session', async (): Promise<void> => {
    await unlock();
    const response = await synthesise(
      request({ ...JSON_FROM_APP, origin: 'http://localhost:8080' }),
    );
    expect(response.status).toBe(403);
    expect(synthesised).toEqual([]);
  });

  it('refuses a cross-site request that sent no Origin', async (): Promise<void> => {
    await unlock();
    const response = await synthesise(
      request({ 'content-type': 'application/json', 'sec-fetch-site': 'same-site' }),
    );
    expect(response.status).toBe(403);
    expect(synthesised).toEqual([]);
  });

  it('refuses a body a plain form could send', async (): Promise<void> => {
    await unlock();
    const response = await synthesise(request({ origin: APP, 'content-type': 'text/plain' }));
    expect(response.status).toBe(415);
    expect(synthesised).toEqual([]);
  });

  it('refuses a body over the limit', async (): Promise<void> => {
    await unlock();
    const huge = JSON.stringify({
      agentId: 'agent-1',
      bossLabel: 'Aiko',
      transcript: 'x'.repeat(1024 * 1024),
    });
    const response = await synthesise(request(JSON_FROM_APP, huge));
    expect(response.status).toBe(413);
    expect(synthesised).toEqual([]);
  });

  it('establishes the caller before reading the body', async (): Promise<void> => {
    const incoming = request(JSON_FROM_APP);
    const response = await synthesise(incoming);
    expect(response.status).toBe(403);
    expect(incoming.bodyUsed).toBe(false);
  });

  it('dials the server-side CONVEX_URL, not the address built into the browser bundle', async (): Promise<void> => {
    vi.stubEnv('CONVEX_URL', 'http://backend:3210');
    await unlock();
    const response = await synthesise(request({ origin: APP, 'content-type': 'application/json' }));
    expect(response.status).toBe(200);
    expect(dialled).toEqual(['http://backend:3210']);
  });

  it("answers a failed synthesis with a fixed reason, never the deployment's text", async (): Promise<void> => {
    await unlock();
    synthesisFailure = {
      value: new Error('[CONVEX A(onboarding:synthesiseFromTranscript)] Uncaught Error: forbidden'),
    };
    const refused = await synthesise(request(JSON_FROM_APP));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: 'that voice session does not belong to this agent',
    });
    synthesisFailure = { value: new Error('Server Error at /srv/convex/onboarding.ts:88') };
    const failed = await synthesise(request(JSON_FROM_APP));
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'charter synthesis failed' });
  });

  it('answers the guard’s refusal of another owner’s employee, a ConvexError in production, with a 403', async (): Promise<void> => {
    await unlock();
    synthesisFailure = { value: new ConvexError(EMPLOYEE_NOT_YOURS) };
    const refused = await synthesise(request(JSON_FROM_APP));
    expect(refused.status).toBe(403);
  });

  it('answers a rejection that is not an Error with the same fixed reason', async (): Promise<void> => {
    await unlock();
    synthesisFailure = { value: null };
    const failed = await synthesise(request(JSON_FROM_APP));
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'charter synthesis failed' });
  });

  it('answers a signed-out caller outside no-auth mode with a 401 and synthesises nothing', async (): Promise<void> => {
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', '');
    const response = await synthesise(request({ origin: APP, 'content-type': 'application/json' }));
    expect(response.status).toBe(401);
    expect(synthesised).toEqual([]);
  });
});
