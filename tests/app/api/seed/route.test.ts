import { ConvexError } from 'convex/values';
import { EMPLOYEE_NOT_YOURS } from '../../../../src/agent/employee-access';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/nextjs/server', () => ({
  auth: async (): Promise<{ userId: null }> => ({ userId: null }),
}));

let cookieValue: string | undefined;
const seeded: unknown[] = [];
const dialled: string[] = [];
/** What the deployment's seeding throws, when a test needs it to. */
let seedFailure: Error | undefined;

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
    async action(_reference: unknown, args: unknown): Promise<{ seeded: true }> {
      if (seedFailure) throw seedFailure;
      seeded.push(args);
      return { seeded: true };
    }
  },
}));

const APP = 'http://localhost:3000';

async function signingKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
}

async function unlock(): Promise<void> {
  const { mintDevNoAuthSession } = await import('../../../../src/lib/dev-auth-server');
  cookieValue = await mintDevNoAuthSession();
}

async function seed(headers: Record<string, string>, body?: string): Promise<Response> {
  const { POST } = await import('../../../../app/api/seed/route');
  return POST(new Request(`${APP}/api/seed`, { method: 'POST', headers, body }));
}

beforeEach(async (): Promise<void> => {
  vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'http://127.0.0.1:3210');
  vi.stubEnv('DEV_NO_AUTH_SECRET', 'a'.repeat(43));
  vi.stubEnv('DEV_NO_AUTH_SIGNING_KEY', await signingKey());
  vi.resetModules();
  cookieValue = undefined;
  seeded.length = 0;
  dialled.length = 0;
  seedFailure = undefined;
});

afterEach((): void => {
  vi.unstubAllEnvs();
});

const JSON_FROM_APP = { origin: APP, 'content-type': 'application/json' };

describe('the seed route', (): void => {
  it("seeds the agent named in the JSON body of the app's own page", async (): Promise<void> => {
    await unlock();
    const response = await seed(JSON_FROM_APP, JSON.stringify({ agentId: 'agent-1' }));
    expect(response.status).toBe(200);
    expect(seeded).toEqual([{ agentId: 'agent-1' }]);
  });

  it('refuses a page on another localhost port that rides the session', async (): Promise<void> => {
    await unlock();
    const response = await seed(
      { ...JSON_FROM_APP, origin: 'http://localhost:8080' },
      JSON.stringify({ agentId: 'agent-1' }),
    );
    expect(response.status).toBe(403);
    expect(seeded).toEqual([]);
  });

  it('seeds from a page served on the public origin, through a proxy whose Host the URL never shows', async (): Promise<void> => {
    vi.stubEnv('DAY0_PUBLIC_URL', 'https://day0.acme.test');
    await unlock();
    const response = await seed(
      {
        'content-type': 'application/json',
        origin: 'https://day0.acme.test',
        host: 'day0.acme.test',
        'x-forwarded-host': 'day0.acme.test',
        'x-forwarded-proto': 'https',
      },
      JSON.stringify({ agentId: 'agent-1' }),
    );
    expect(response.status).toBe(200);
    expect(seeded).toEqual([{ agentId: 'agent-1' }]);
  });

  it('refuses a proxied page when no public origin is set, since a forwarded header is not believed', async (): Promise<void> => {
    await unlock();
    const response = await seed(
      {
        'content-type': 'application/json',
        origin: 'https://day0.acme.test',
        'x-forwarded-host': 'day0.acme.test',
        'x-forwarded-proto': 'https',
      },
      JSON.stringify({ agentId: 'agent-1' }),
    );
    expect(response.status).toBe(403);
    expect(seeded).toEqual([]);
  });

  it('refuses a body that is not JSON', async (): Promise<void> => {
    await unlock();
    const response = await seed(
      { origin: APP, 'content-type': 'text/plain' },
      JSON.stringify({ agentId: 'agent-1' }),
    );
    expect(response.status).toBe(415);
    expect(seeded).toEqual([]);
  });

  it('refuses a body larger than a seed request', async (): Promise<void> => {
    await unlock();
    const response = await seed(JSON_FROM_APP, JSON.stringify({ agentId: 'x'.repeat(8 * 1024) }));
    expect(response.status).toBe(413);
    expect(seeded).toEqual([]);
  });

  it('refuses a browser with no session', async (): Promise<void> => {
    const response = await seed(JSON_FROM_APP, JSON.stringify({ agentId: 'agent-1' }));
    expect(response.status).toBe(403);
    expect(seeded).toEqual([]);
  });

  it('dials the server-side CONVEX_URL, not the address built into the browser bundle', async (): Promise<void> => {
    vi.stubEnv('CONVEX_URL', 'http://backend:3210');
    await unlock();
    const response = await seed(JSON_FROM_APP, JSON.stringify({ agentId: 'agent-1' }));
    expect(response.status).toBe(200);
    expect(dialled).toEqual(['http://backend:3210']);
  });

  it('falls back to the browser address when no server-side one is set', async (): Promise<void> => {
    await unlock();
    await seed(JSON_FROM_APP, JSON.stringify({ agentId: 'agent-1' }));
    expect(dialled).toEqual(['http://127.0.0.1:3210']);
  });

  it('answers a seeding the deployment refused or failed with a fixed reason, never its error text (C-34)', async (): Promise<void> => {
    await unlock();
    seedFailure = new Error('[CONVEX A(seed:seedDemo)] Server Error Uncaught Error: forbidden');
    const refused = await seed(JSON_FROM_APP, JSON.stringify({ agentId: 'agent-1' }));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'that agent is not yours to seed' });
    seedFailure = new Error('[CONVEX A(seed:seedDemo)] Server Error at /srv/convex/seed.ts:42');
    const failed = await seed(JSON_FROM_APP, JSON.stringify({ agentId: 'agent-1' }));
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'demo seeding failed' });
  });

  it('answers the guard’s refusal of another owner’s employee, a ConvexError in production, with a 403', async (): Promise<void> => {
    await unlock();
    seedFailure = new ConvexError(EMPLOYEE_NOT_YOURS);
    const refused = await seed(JSON_FROM_APP, JSON.stringify({ agentId: 'agent-1' }));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'that agent is not yours to seed' });
  });

  it('answers a signed-out caller outside no-auth mode with a 401 and seeds nothing', async (): Promise<void> => {
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', '');
    const response = await seed(JSON_FROM_APP, JSON.stringify({ agentId: 'agent-1' }));
    expect(response.status).toBe(401);
    expect(seeded).toEqual([]);
  });
});
