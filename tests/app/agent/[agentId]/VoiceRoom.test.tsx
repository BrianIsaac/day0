/** @vitest-environment jsdom */

import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The conversation the SDK reports, driven by each test; `onMessage` is the room's own. */
const conversation = vi.hoisted(() => ({
  status: 'disconnected',
  isSpeaking: false,
  onMessage: undefined as ((message: { source: string; message: string }) => void) | undefined,
}));

vi.mock('@elevenlabs/react', () => ({
  ConversationProvider: ({ children }: { children: ReactNode }): ReactNode => children,
  useConversation: (options: {
    onMessage?: (message: { source: string; message: string }) => void;
  }): Record<string, unknown> => {
    conversation.onMessage = options.onMessage;
    return {
      status: conversation.status,
      isSpeaking: conversation.isSpeaking,
      isListening: false,
      startSession: (): void => undefined,
      endSession: (): void => undefined,
    };
  },
}));
const voice = vi.hoisted(() => ({
  /** What `voice.start` rejects with, when set. */
  startRefusal: undefined as Error | undefined,
  /** Whether `voice.start` never answers, as on a lost connection. */
  startHangs: false,
  /** What `voice.latest` answers. */
  session: null as Record<string, unknown> | null,
}));

vi.mock('convex/react', () => ({
  useMutation: (): (() => Promise<unknown>) => async (): Promise<unknown> => {
    if (voice.startRefusal) throw voice.startRefusal;
    if (voice.startHangs) return await new Promise(() => undefined);
    return { sessionId: 'session-1', webhookToken: 'token-1' };
  },
  useQuery: (): unknown => voice.session,
}));

import type { Id } from '../../../../convex/_generated/dataModel';
import { VoiceRoom } from '../../../../app/agent/[agentId]/VoiceRoom';
import { ROOM_HEIGHT } from '../../../../app/agent/[agentId]/room-frame';

afterEach((): void => {
  voice.session = null;
  voice.startHangs = false;
  vi.useRealTimers();
  conversation.status = 'disconnected';
  conversation.isSpeaking = false;
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
      element.textContent?.startsWith('The live transcript appears here'),
    );
    expect(transcript?.classList.contains('flex-1')).toBe(true);
  });
});

describe('the voice room in the manager’s words (N29)', (): void => {
  it('says the employee is speaking and labels its turns as the employee’s', async (): Promise<void> => {
    conversation.status = 'connected';
    conversation.isSpeaking = true;
    const container = await renderVoiceRoom({
      configured: true,
      agentId: 'agent_voice',
      signedUrl: null,
      public: true,
    });
    await act(async (): Promise<void> => {
      conversation.onMessage?.({ source: 'ai', message: 'Why did the team hire me?' });
      // The room opens muted; the manager taps to speak, and the pill says who is talking.
      [...container.querySelectorAll('button')]
        .find((b) => b.textContent === 'Tap to speak')
        ?.click();
    });
    const text = container.textContent ?? '';
    expect(text).toContain('employee speaking…');
    expect(text).toContain('employee: Why did the team hire me?');
    expect(text).not.toMatch(/\bagent\b/);
  });
});

describe('a voice 1:1 that could not start (step 45, standard 7.3)', (): void => {
  it('says a refused private call in the manager’s words, none of the provider’s (m24)', async (): Promise<void> => {
    // Silenced: the fallback's provider detail goes to the log, never the room.
    const logged = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    const container = await renderVoiceRoom({
      configured: true,
      agentId: 'agent_voice',
      signedUrl: null,
      public: true,
      warning: 'Voice could not open a private call with this employee',
    });
    const alert = container.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert).toBe(
      'Voice could not open a private call with this employee. The call may still connect. Switch to chat mode if voice setup is unavailable.',
    );
    expect(alert).not.toMatch(/\bagent\b|ElevenLabs|signed URL|public/i);
    logged.mockRestore();
  });

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

describe('the voice room once the call is over (round two section 3.4)', (): void => {
  it('shows a one-to-one already drafting from its stored transcript, with no call to start', async (): Promise<void> => {
    voice.session = {
      _id: 'session-1',
      state: 'synthesising',
      pendingTranscript: 'AGENT: Why this hire?\n\nUSER: The close.',
    };
    const container = await renderVoiceRoom({
      configured: true,
      agentId: 'agent_voice',
      signedUrl: null,
      public: true,
    });
    expect(container.querySelector('[role="log"]')?.textContent).toBe(
      'employee: Why this hire?you: The close.',
    );
    expect(container.textContent).toContain('1 of 7 answered');
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Drafting your charter, usually under a minute.',
    );
    expect(
      [...container.querySelectorAll('button')].some((b) => b.textContent === 'Start voice 1:1'),
    ).toBe(false);
  });

  it('shows the draft of a call held before this deployment lost its voice credentials', async (): Promise<void> => {
    voice.session = {
      _id: 'session-1',
      state: 'synthesising',
      pendingTranscript: 'AGENT: Why this hire?\n\nUSER: The close.',
    };
    const container = await renderVoiceRoom({ configured: false, reason: 'No credentials.' });
    expect(container.textContent).not.toContain('voice unavailable');
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Drafting your charter',
    );
  });

  it('stops waiting for the session after fifteen seconds and says so in the alert', async (): Promise<void> => {
    voice.startHangs = true;
    const container = await renderVoiceRoom({
      configured: true,
      agentId: 'agent_voice',
      signedUrl: null,
      public: true,
    });
    vi.useFakeTimers();
    await act(async (): Promise<void> => {
      [...container.querySelectorAll('button')]
        .find((b) => b.textContent === 'Start voice 1:1')
        ?.click();
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Your employee did not answer within 15 seconds. Switch to chat mode if voice setup is unavailable.',
    );
  });
});
