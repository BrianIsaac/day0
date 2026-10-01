import { afterEach, describe, expect, it, vi } from 'vitest';

// The caller is the seam every server route establishes; its own tests cover how
// (`tests/src/lib/convex-caller.test.ts`, and the profile in `route.customer-local.test.ts`).
vi.mock('../../../../../../src/lib/convex-caller', () => ({
  establishConvexCaller: async () => ({ ok: true, client: {} }),
}));

/** The route, loaded with voice configured and ElevenLabs answered by `answer`. */
async function loadStart(
  answer: (input: string, init: RequestInit) => Promise<Response>,
): Promise<{ get: () => Promise<Response>; calls: RequestInit[] }> {
  vi.resetModules();
  vi.stubEnv('ELEVENLABS_API_KEY', 'xi-key-not-for-the-page');
  vi.stubEnv('ELEVENLABS_AGENT_ID', 'agent_voice');
  const calls: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit): Promise<Response> => {
      calls.push(init);
      return await answer(input, init);
    }),
  );
  const { GET } = await import('../../../../../../app/api/voice/elevenlabs/start/route');
  return {
    get: async (): Promise<Response> =>
      await GET(new Request('http://localhost:3000/api/voice/elevenlabs/start')),
    calls,
  };
}

afterEach((): void => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the ElevenLabs start route (C-34)', (): void => {
  it('bounds the signed-URL request, so a stalled ElevenLabs cannot hold the page', async (): Promise<void> => {
    const start = await loadStart(async () => Response.json({ signed_url: 'wss://signed' }));
    const response = await start.get();
    expect(await response.json()).toMatchObject({ configured: true, signedUrl: 'wss://signed' });
    expect(start.calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('answers an unreachable ElevenLabs with a fixed reason, never the transport error text', async (): Promise<void> => {
    const start = await loadStart(async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.7:443 via proxy user:secret@proxy');
    });
    const response = await start.get();
    expect(response.status).toBe(502);
    const body = JSON.stringify(await response.json());
    expect(body).toContain('the voice service could not be reached');
    expect(body).not.toContain('ECONNREFUSED');
    expect(body).not.toContain('secret');
  });

  it('answers a refused signed URL with fixed text on the page and sends the provider body to the log (N26)', async (): Promise<void> => {
    const providerBody =
      '{"detail":{"status":"invalid_api_key","message":"Invalid API key xi-key-not-for-the-page"}}';
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown): void => {
      logged.push(String(line));
    });
    const start = await loadStart(
      async () => new Response(providerBody, { status: 401, statusText: 'Unauthorized' }),
    );

    const response = await start.get();

    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page).toEqual({
      configured: true,
      agentId: 'agent_voice',
      signedUrl: null,
      public: true,
      // Re-pinned (unit S, m24): the manager's words, no provider and no "agent" (N29).
      warning: 'Voice could not open a private call with this employee',
    });
    const entries = logged.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        status: 401,
        statusText: 'Unauthorized',
        body: providerBody,
      }),
    );
  });
});
