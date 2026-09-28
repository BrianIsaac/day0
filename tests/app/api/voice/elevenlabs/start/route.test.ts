import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../../src/lib/dev-auth-server', () => ({
  establishCaller: async () => ({ ok: true, userId: 'dev-no-auth-subject' }),
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
});
