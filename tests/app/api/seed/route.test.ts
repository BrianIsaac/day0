import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/nextjs/server', () => ({
  auth: async (): Promise<{ userId: null }> => ({ userId: null }),
}));

let cookieValue: string | undefined;
const seeded: unknown[] = [];

vi.mock('next/headers', () => ({
  cookies: async (): Promise<{ get: () => { value: string } | undefined }> => ({
    get: (): { value: string } | undefined => (cookieValue ? { value: cookieValue } : undefined),
  }),
}));

/** The Convex HTTP transport: records what the route asks the deployment to run. */
vi.mock('convex/browser', () => ({
  ConvexHttpClient: class {
    setAuth(): void {}
    async action(_reference: unknown, args: unknown): Promise<{ seeded: true }> {
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
});
