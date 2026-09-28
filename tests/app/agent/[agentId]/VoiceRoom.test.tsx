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
vi.mock('convex/react', () => ({
  useMutation: (): (() => Promise<void>) => async (): Promise<void> => undefined,
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
