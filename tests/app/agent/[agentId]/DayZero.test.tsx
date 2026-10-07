/** @vitest-environment jsdom */

import { createRef } from 'react';
import { getFunctionName } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ queries: {} as Record<string, unknown> }));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args: unknown): unknown =>
    args === 'skip' ? undefined : backend.queries[getFunctionName(reference as never)],
  // Every mutation the rooms call answers as `voice.start` does for a one-to-one with no turns.
  useMutation: () => async () => ({ sessionId: 'session-1', turns: [], replyDraft: null }),
  useAction: () => async (): Promise<void> => undefined,
}));

/** The chat's history, one array for every render, as `useChat` keeps it. */
const chat = vi.hoisted(() => ({ messages: [] as unknown[] }));

vi.mock('@ai-sdk/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ai-sdk/react')>()),
  useChat: () => ({
    messages: chat.messages,
    sendMessage: (): void => undefined,
    regenerate: (): void => undefined,
    setMessages: (): void => undefined,
    status: 'ready',
  }),
}));

import { DayZero, ModePicker } from '../../../../app/agent/[agentId]/DayZero';
import { EMPLOYEE_ROW, asEmployee } from '../../../fixtures/dom/employee';
import { button, mount, press, settle } from '../../../fixtures/dom/press';

beforeEach((): void => {
  // jsdom lays nothing out and has no scrollTo; the chat room keeps its newest turn in view with it.
  (globalThis as { Element: typeof Element }).Element.prototype.scrollTo = (): void => undefined;
});

afterEach((): void => {
  backend.queries = {};
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** The voice probe answering that voice is, or is not, configured. */
function probe(configured: boolean): void {
  vi.stubGlobal(
    'fetch',
    async (): Promise<Response> => new Response(JSON.stringify({ configured })),
  );
}

describe('ModePicker', () => {
  it('asks in the first person and offers Voice first where it is configured', async () => {
    probe(true);
    const picked: string[] = [];
    const view = mount(<ModePicker onPick={(mode) => picked.push(mode)} />);
    await settle();
    expect(view.container.textContent).toContain(
      "I'd like a few minutes to understand the role you brought me on for.",
    );
    expect(button(view.container, 'Voice').className).toContain('bg-[var(--color-accent)]');
    await press(view.container, 'Chat');
    expect(picked).toEqual(['chat']);
    view.unmount();
  });

  it('greys Voice out and says why when the deployment has no voice, Chat taking the lead', async () => {
    probe(false);
    const view = mount(<ModePicker onPick={() => undefined} />);
    await settle();
    const voice = [...view.container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Voice',
    );
    expect(voice?.disabled).toBe(true);
    expect(button(view.container, 'Chat').className).toContain('bg-[var(--color-accent)]');
    expect(view.container.textContent).toContain('Voice is off on this deployment');
    view.unmount();
  });
});

describe('ModePicker when the probe fails', () => {
  it('reads an error answer as voice being unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      async (): Promise<Response> => new Response('<html>down</html>', { status: 502 }),
    );
    const view = mount(<ModePicker onPick={() => undefined} />);
    await settle();
    expect(view.container.textContent).toContain('Voice is off on this deployment');
    view.unmount();
  });
});

describe('DayZero', () => {
  it('sets the one-to-one beside what the employee knows so far and the first lines of its record', async () => {
    probe(true);
    backend.queries = {
      // A deployed employee with no one-to-one held yet: the backend answers null (re-pinned).
      'voice:latest': null,
      'skills:registered': [{ _id: 's1', name: 'read-docs' }],
      'workspace:read': { 'AGENTS.md': 'x'.repeat(1_500), 'SOUL.md': '' },
      'events:recent': [
        {
          _id: 'e1',
          _creationTime: 1,
          agentId: 'agent-1',
          type: 'agent.deployed',
          payload: {},
          createdAt: Date.UTC(2026, 8, 29, 9, 2),
        },
      ],
    };
    const view = mount(
      asEmployee(<DayZero onboarding={createRef<HTMLDivElement>()} arriving={false} />, {
        agent: { ...EMPLOYEE_ROW, state: 'deployed' },
        charter: null,
        surfaceMode: 'mock',
      }),
    );
    await settle();
    const region = view.container.querySelector('[role="region"]');
    expect(region?.getAttribute('aria-label')).toBe('The 1:1 that drafts the charter');
    expect(view.container.textContent).toContain('What Mira knows so far');
    expect(view.container.textContent).toContain('boss@day0.local');
    expect(view.container.textContent).toContain('the hosted office');
    expect(
      [...view.container.querySelectorAll('a')]
        .find((link) => link.textContent?.includes('hosted office'))
        ?.getAttribute('href'),
    ).toBe('/agent/agent-1/surfaces');
    expect(view.container.textContent).toContain('read-docs');
    expect(view.container.textContent).toContain('1 of 2 written, 1.5 kB');
    expect(view.container.querySelectorAll('li')).toHaveLength(1);
    view.unmount();
  });

  it('goes back into the room a reload left, once the session says which', async () => {
    probe(true);
    backend.queries = { 'voice:latest': { mode: 'chat' } };
    const view = mount(
      asEmployee(<DayZero onboarding={createRef<HTMLDivElement>()} arriving={false} />, {
        agent: { ...EMPLOYEE_ROW, state: 'day-one-in-progress' },
        charter: null,
      }),
    );
    await settle();
    expect(view.container.textContent).not.toContain('voice or chat?');
    view.unmount();
  });

  it('sets the chat room beside what the manager has answered so far and what the one-to-one becomes', async () => {
    probe(true);
    backend.queries = {
      'voice:latest': {
        _id: 'session-1',
        mode: 'chat',
        state: 'active',
        pendingTranscript: 'Employee: Why this hire?\nManager: We close the books every week.',
      },
    };
    const view = mount(
      asEmployee(<DayZero onboarding={createRef<HTMLDivElement>()} arriving={false} />, {
        agent: { ...EMPLOYEE_ROW, state: 'day-one-in-progress' },
        charter: null,
      }),
    );
    // The room is its own chunk: the answers arrive once it has loaded and read the session.
    await vi.waitFor(
      async () => {
        await settle();
        expect(view.container.textContent).toContain('We close the books every week.');
      },
      { timeout: 5_000 },
    );
    const aside = view.container.querySelector('aside') ?? view.container;
    expect(aside.textContent).toContain('We close the books every week.');
    expect(aside.textContent).toContain('What this becomes');
    expect(aside.textContent).toContain('After the seventh answer Mira drafts a charter');
    expect(aside.textContent).not.toContain('What Mira knows so far');
    view.unmount();
  });

  it('keeps what the employee knows beside the voice room, which lists no answers', async () => {
    probe(true);
    backend.queries = { 'voice:latest': { _id: 'session-1', mode: 'voice', state: 'active' } };
    const view = mount(
      asEmployee(<DayZero onboarding={createRef<HTMLDivElement>()} arriving={false} />, {
        agent: { ...EMPLOYEE_ROW, state: 'day-one-in-progress' },
        charter: null,
      }),
    );
    await settle();
    expect(view.container.textContent).toContain('What this becomes');
    expect(view.container.textContent).toContain('What Mira knows so far');
    expect(view.container.textContent).not.toContain('Noted so far');
    view.unmount();
  });
});

describe('DayZero reopened on a one-to-one under way (hosted walk m23)', () => {
  it('never draws the chooser: the frame while the session is read, then the room it was in', async () => {
    probe(true);
    const seen: string[] = [];
    const observer = new MutationObserver((): void => {
      seen.push(document.body.textContent ?? '');
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    const page = <DayZero onboarding={createRef<HTMLDivElement>()} arriving={false} />;
    const employee = {
      agent: { ...EMPLOYEE_ROW, state: 'day-one-in-progress' as const },
      charter: null,
    };
    const view = mount(asEmployee(page, employee));
    await settle();
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe('Loading the 1:1');
    backend.queries = { 'voice:latest': { _id: 'session-1', mode: 'chat', state: 'active' } };
    view.root.render(asEmployee(page, employee));
    await settle();
    observer.disconnect();
    expect(view.container.textContent).toContain('Day-1 1:1 · chat mode');
    expect(
      seen.some((text) => text.includes('Voice is off') || text.includes("I'd like a few minutes")),
    ).toBe(false);
    view.unmount();
  });
});
