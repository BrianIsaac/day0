import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../../convex/_generated/dataModel';
import { postCharterSynthesis } from '../../../../app/agent/[agentId]/charter-synthesis';

const request = {
  agentId: 'agent-1' as Id<'agents'>,
  bossLabel: 'Sam',
  transcript: 'AGENT: Why this hire?\n\nUSER: The close.',
  voiceSessionId: 'session-1' as Id<'voiceSessions'>,
};

/** Let the post's promise chain settle, and any rejection it leaves surface. */
async function settled(): Promise<void> {
  await new Promise((resolve): void => {
    setTimeout(resolve, 0);
  });
}

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

    postCharterSynthesis(request);
    await settled();

    expect(sent).toEqual([{ url: '/api/onboarding/synthesise', body: request }]);
  });

  it('leaves no unhandled rejection when the post fails in transport', async (): Promise<void> => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', record);
    vi.stubGlobal('fetch', async (): Promise<Response> => {
      throw new TypeError('Failed to fetch');
    });

    try {
      postCharterSynthesis(request);
      await settled();
    } finally {
      process.off('unhandledRejection', record);
    }

    expect(unhandled).toEqual([]);
  });
});
