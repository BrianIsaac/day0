/** @vitest-environment jsdom */

import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@elevenlabs/react', () => ({
  ConversationProvider: ({ children }: { children: ReactNode }): ReactNode => children,
  useConversation: (): Record<string, unknown> => ({
    status: 'disconnected',
    isSpeaking: false,
    isListening: false,
    startSession: (): void => undefined,
    endSession: (): void => undefined,
  }),
}));
const voice = vi.hoisted(() => ({
  /** What `voice.start` rejects with, when set. */
  startRefusal: undefined as Error | undefined,
}));

vi.mock('convex/react', () => ({
  useMutation: (): (() => Promise<unknown>) => async (): Promise<unknown> => {
    if (voice.startRefusal) throw voice.startRefusal;
    return { sessionId: 'session-1', webhookToken: 'token-1' };
  },
}));

import type { Id } from '../../../../convex/_generated/dataModel';
import { VoiceRoom } from '../../../../app/agent/[agentId]/VoiceRoom';
import { ROOM_HEIGHT } from '../../../../app/agent/[agentId]/room-frame';

afterEach((): void => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** Render the voice room against a start route that answers with `start`. */
async function renderVoiceRoom(start: Record<string, unknown>): Promise<HTMLElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('fetch', async (): Promise<Response> => Response.json(start));
  // jsdom lays nothing out and has no element scrolling; the room scrolls its transcript.
  Element.prototype.scrollTo = (): void => undefined;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async (): Promise<void> => {
    root.render(<VoiceRoom agentId={'agent-1' as Id<'agents'>} bossLabel="Sam" />);
  });
  return container;
}

describe('the voice room', (): void => {
  it('occupies the same frame as the chat room and its loading placeholder, the transcript filling it', async (): Promise<void> => {
    const container = await renderVoiceRoom({
      configured: true,
      agentId: 'agent_voice',
      signedUrl: null,
      public: true,
    });

    const room = container.querySelector('section');
    expect(room?.textContent).toContain('Day-1 1:1 · voice mode');
    expect(room?.classList.contains(ROOM_HEIGHT)).toBe(true);
    const transcript = [...(room?.querySelectorAll('div') ?? [])].find((element) =>
      element.textContent?.startsWith('live transcript will appear here'),
    );
    expect(transcript?.classList.contains('flex-1')).toBe(true);
  });
});

describe('a voice 1:1 that could not start (step 45, standard 7.3)', (): void => {
  it("says why in the room's alert instead of dropping the refusal", async (): Promise<void> => {
    voice.startRefusal = new Error(
      '[CONVEX M(voice:start)] [Request ID: 1] Server Error\nUncaught Error: The employee is retired.\n    at handler (../convex/voice.ts:1:1)',
    );
    const container = await renderVoiceRoom({
      configured: true,
      agentId: 'agent_voice',
      signedUrl: null,
      public: true,
    });
    const start = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Start voice 1:1',
    );
    expect(start?.className).toMatch(/\bmin-h-11\b/);
    await act(async (): Promise<void> => {
      start?.click();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'The employee is retired. Switch to chat mode if voice setup is unavailable.',
    );
    expect(container.querySelector('[role="log"]')?.getAttribute('aria-label')).toBe(
      'The 1:1 so far',
    );
    voice.startRefusal = undefined;
  });
});
