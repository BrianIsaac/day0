import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../../convex/_generated/dataModel';
import {
  postCharterSynthesis,
  SYNTHESIS_DEADLINE_MS,
} from '../../../../app/agent/[agentId]/charter-synthesis';

const request = {
  agentId: 'agent-1' as Id<'agents'>,
  bossLabel: 'Sam',
  transcript: 'AGENT: Why this hire?\n\nUSER: The close.',
  voiceSessionId: 'session-1' as Id<'voiceSessions'>,
};

afterEach((): void => {
  vi.unstubAllGlobals();
});

describe('the charter synthesis post', (): void => {
  it('sends the transcript, the manager and the session it ends to the synthesis route', async (): Promise<void> => {
    const sent: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit): Promise<Response> => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return new Response('{}', { status: 200 });
    });

    expect(await postCharterSynthesis(request)).toEqual({ ok: true });

    expect(sent).toEqual([{ url: '/api/onboarding/synthesise', body: request }]);
  });

  it('says the page could not reach Day0 when the post fails in transport, and never rejects', async (): Promise<void> => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', record);
    vi.stubGlobal('fetch', async (): Promise<Response> => {
      throw new TypeError('Failed to fetch');
    });

    try {
      expect(await postCharterSynthesis(request)).toEqual({
        ok: false,
        late: false,
        reason: 'the page could not reach Day0',
      });
    } finally {
      process.off('unhandledRejection', record);
    }

    expect(unhandled).toEqual([]);
  });

  it("says the route's own sentence for a refusal, or its status when it gave none", async (): Promise<void> => {
    vi.stubGlobal(
      'fetch',
      async (): Promise<Response> =>
        Response.json({ error: 'charter synthesis failed' }, { status: 500 }),
    );
    expect(await postCharterSynthesis(request)).toEqual({
      ok: false,
      late: false,
      reason: 'charter synthesis failed',
    });

    vi.stubGlobal('fetch', async (): Promise<Response> => new Response('<html>', { status: 502 }));
    expect(await postCharterSynthesis(request)).toEqual({
      ok: false,
      late: false,
      reason: 'the drafting service answered 502',
    });
  });

  it('stops waiting at the deadline and says drafting is taking longer, the post marked late', async (): Promise<void> => {
    vi.stubGlobal(
      'fetch',
      (_url: string, init: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject): void => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    expect(await postCharterSynthesis(request, 20)).toEqual({
      ok: false,
      late: true,
      reason: 'drafting has taken longer than 0 seconds',
    });
    expect(SYNTHESIS_DEADLINE_MS).toBe(90_000);
  });
});
