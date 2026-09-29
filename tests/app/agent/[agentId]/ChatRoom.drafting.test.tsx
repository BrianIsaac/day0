/** @vitest-environment jsdom */

import type { UIMessage } from 'ai';
import { getFunctionName } from 'convex/server';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const room = vi.hoisted(() => ({
  /** What `voice.latest` answers; undefined while it loads. */
  session: null as Record<string, unknown> | null | undefined,
  /** How `voice.start` answers: at once, never (a lost connection), or with a refusal. */
  start: 'answer' as 'answer' | 'never',
  starts: 0,
  /** What `voice.restart` was asked to set aside. */
  restarts: [] as unknown[],
  messages: [] as UIMessage[],
  status: 'ready' as string,
  sent: [] as unknown[],
}));

vi.mock('convex/react', () => ({
  useMutation:
    (reference: unknown) =>
    async (args: unknown): Promise<unknown> => {
      if (getFunctionName(reference as never) === 'voice:restart') {
        room.restarts.push(args);
        return { ok: true };
      }
      room.starts += 1;
      if (room.start === 'never') return await new Promise(() => undefined);
      return { sessionId: 'session-1' };
    },
  useQuery: (): unknown => room.session,
}));
vi.mock('@ai-sdk/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ai-sdk/react')>()),
  useChat: () => ({
    messages: room.messages,
    sendMessage: (message: unknown): void => void room.sent.push(message),
    regenerate: (): void => undefined,
    setMessages: (next: UIMessage[]): void => {
      room.messages = next;
    },
    status: room.status,
  }),
}));

import { ChatRoom, progressOf, sendsReply } from '../../../../app/agent/[agentId]/ChatRoom';
import type { Id } from '../../../../convex/_generated/dataModel';
import { INIT_PROMPT } from '../../../../src/agent/day-one-turn';
import { MAX_FINALISATION_RECOVERIES } from '../../../../src/agent/one-to-one-phase';
import { axeViolations } from '../../../fixtures/dom/axe';
import { EMPLOYEE_ROW, asEmployee } from '../../../fixtures/dom/employee';
import { mount, press, said, settle, typeInto } from '../../../fixtures/dom/press';
import { underTarget } from '../../../fixtures/dom/targets';

const AGENT = 'agent-1' as Id<'agents'>;

function turn(id: string, role: UIMessage['role'], text: string, topicIndex?: number): UIMessage {
  return {
    id,
    role,
    parts: [{ type: 'text', text }],
    ...(topicIndex === undefined ? {} : { metadata: { topicIndex } }),
  } as UIMessage;
}

/** The synthesis posts the room made, and the route's answer to each. */
let posts: unknown[] = [];

function answerPosts(respond: () => Promise<Response>): void {
  posts = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit): Promise<Response> => {
    posts.push(JSON.parse(String(init.body)));
    return await respond();
  });
}

beforeEach((): void => {
  (globalThis as { Element: typeof Element }).Element.prototype.scrollTo = (): void => undefined;
  room.session = null;
  room.start = 'answer';
  room.starts = 0;
  room.restarts = [];
  room.messages = [];
  room.status = 'ready';
  room.sent = [];
  answerPosts(async () => Response.json({ outcome: 'synthesised' }));
});

afterEach((): void => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const CONVERSATION: UIMessage[] = [
  turn('0', 'user', INIT_PROMPT),
  turn('1', 'assistant', 'Why this hire?', 0),
  turn('2', 'user', 'Tier-2 asks swamp the close.'),
  turn('3', 'assistant', 'What does month one look like?', 1),
];

describe('the one-to-one progress (round two section 3.4)', (): void => {
  it('says the question the route numbered and draws seven segments, the current one lit', async (): Promise<void> => {
    room.messages = CONVERSATION;
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await settle();
    expect(view.container.textContent).toContain('Question 2 of 7 · The role itself');
    const segments = [
      ...view.container.querySelectorAll('[data-topic-progress] [data-segment]'),
    ].map((segment) => segment.getAttribute('data-segment'));
    expect(segments).toEqual(['done', 'now', 'next', 'next', 'next', 'next', 'next']);
    expect(view.container.querySelector('[data-topic-progress]')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(view.container.querySelector('[role="log"]')?.textContent).toContain(
      '2 of 7 · The role itselfWhat does month one look like?',
    );
    view.unmount();
  });

  it('waits on the first question before a turn has been numbered', (): void => {
    expect(progressOf([])).toEqual({ kind: 'waiting' });
    expect(progressOf([turn('1', 'assistant', 'Hello')])).toEqual({ kind: 'waiting' });
    expect(progressOf(CONVERSATION)).toEqual({ kind: 'asking', topicIndex: 1 });
  });

  it('tells the page what the manager has answered so far, under each question', async (): Promise<void> => {
    room.messages = CONVERSATION;
    const noted: unknown[] = [];
    const view = mount(
      <ChatRoom agentId={AGENT} bossLabel="Sam" onNoted={(answers) => noted.push(answers)} />,
    );
    await settle();
    expect(noted.at(-1)).toEqual([
      { topic: 'Why this hire', text: 'Tier-2 asks swamp the close.' },
    ]);
    view.unmount();
  });
});

describe('the composer and an input method', (): void => {
  it('sends on Enter, and never on the Enter that confirms a composition or starts a line', (): void => {
    const key = { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 };
    expect(sendsReply(key)).toBe(true);
    expect(sendsReply({ ...key, shiftKey: true })).toBe(false);
    expect(sendsReply({ ...key, isComposing: true })).toBe(false);
    expect(sendsReply({ ...key, keyCode: 229 })).toBe(false);
    expect(sendsReply({ ...key, key: 'a' })).toBe(false);
  });

  it('keeps a reply being composed in the field when Enter confirms the composition', async (): Promise<void> => {
    room.messages = CONVERSATION;
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await settle();
    const field = view.container.querySelector('textarea')!;
    typeInto(field, 'The close, mostly');
    const enter = (isComposing: boolean): KeyboardEvent =>
      new KeyboardEvent('keydown', { key: 'Enter', isComposing, bubbles: true, cancelable: true });
    const composing = enter(true);
    act((): void => {
      field.dispatchEvent(composing);
    });
    expect(composing.defaultPrevented).toBe(false);
    expect(room.sent).toEqual([{ text: INIT_PROMPT }]);

    act((): void => {
      field.dispatchEvent(enter(false));
    });
    expect(room.sent).toEqual([{ text: INIT_PROMPT }, { text: 'The close, mostly' }]);
    view.unmount();
  });
});

describe('finishing and drafting (round two section 3.4)', (): void => {
  it('asks before finishing, then says what happens and how long it takes, the transcript kept', async (): Promise<void> => {
    room.messages = CONVERSATION.slice(0, 3);
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await settle();
    await press(view.container, 'Finish');
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Finish the one-to-one now?');
    await press(document.body, 'Finish and draft');
    await settle();

    expect(posts).toEqual([
      {
        agentId: AGENT,
        bossLabel: 'Sam',
        transcript: 'ASSISTANT: Why this hire?\n\nUSER: Tier-2 asks swamp the close.',
        voiceSessionId: 'session-1',
      },
    ]);
    expect(said(view.container)).toContain(
      'Drafting your charter, usually under a minute. Your answers are kept beside it, so you can re-read what you said while you review.',
    );
    expect(view.container.querySelector('textarea')).toBeNull();
    expect(view.container.textContent).toContain('1 of 7 answered');
    expect(view.container.querySelector('[role="log"]')?.textContent).toContain(
      'You: Tier-2 asks swamp the close.',
    );
    view.unmount();
  });

  it('says why the draft failed when the post never reached a session, and posts again on Draft again', async (): Promise<void> => {
    answerPosts(async () => {
      throw new TypeError('Failed to fetch');
    });
    room.messages = [...CONVERSATION.slice(0, 3)];
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await settle();
    await press(view.container, 'Finish');
    await press(document.body, 'Finish and draft');
    await settle();
    expect(said(view.container).join(' ')).toContain(
      'The charter could not be drafted: the page could not reach Day0.',
    );
    // Finish left the page with its form; focus is on what took its place.
    expect(document.activeElement?.getAttribute('data-drafting')).toBe('failed');

    answerPosts(async () => Response.json({ outcome: 'synthesised' }));
    await press(view.container, 'Draft again');
    expect(posts).toHaveLength(1);
    expect(view.container.querySelector('[data-drafting="failed"]')).toBeNull();
    expect(document.activeElement?.getAttribute('data-drafting')).toBe('drafting');
    expect(said(view.container).join(' ')).toContain('Drafting your charter');
    view.unmount();
  });

  it('says the draft is taking longer than usual once the post outlasts its deadline', async (): Promise<void> => {
    answerPosts(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    room.messages = CONVERSATION.slice(0, 3);
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await settle();
    await press(view.container, 'Finish');
    await press(document.body, 'Finish and draft');
    await settle();
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe(
      'Drafting your charter, usually under a minute. It has taken longer than usual. It carries on, and the charter opens here when it is ready.',
    );
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    view.unmount();
  });
});

describe('a room over a session that already produced a charter', (): void => {
  const DONE = { _id: 'session-1', state: 'done', transcriptText: 'USER: x' };

  it('opens the next one-to-one once a draft was sent back with nothing to redraft from', async (): Promise<void> => {
    room.session = DONE;
    const view = mount(
      asEmployee(<ChatRoom agentId={AGENT} bossLabel="Sam" />, {
        agent: { ...EMPLOYEE_ROW, state: 'deployed' },
        charter: null,
      }),
    );
    await settle();
    expect(room.starts).toBe(1);
    expect(room.sent).toEqual([{ text: INIT_PROMPT }]);
    expect(view.container.textContent).not.toContain('Drafting your charter');
    view.unmount();
  });

  it('opens nothing while the charter it produced is on its way to the page', async (): Promise<void> => {
    room.session = DONE;
    const view = mount(
      asEmployee(<ChatRoom agentId={AGENT} bossLabel="Sam" />, {
        agent: { ...EMPLOYEE_ROW, state: 'charter-pending' },
        charter: null,
      }),
    );
    await settle();
    expect(room.starts).toBe(0);
    view.unmount();
  });
});

describe('a room that comes back to a one-to-one already over', (): void => {
  const STORED = 'ASSISTANT: Why this hire?\n\nUSER: The close.\n\nASSISTANT: Thanks.';

  it('shows the stored transcript drafting, and neither opens the session nor asks again', async (): Promise<void> => {
    room.session = { _id: 'session-1', state: 'synthesising', pendingTranscript: STORED };
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await settle();
    expect(room.starts).toBe(0);
    expect(room.sent).toEqual([]);
    expect(view.container.querySelector('[role="log"]')?.textContent).toBe(
      'Employee: Why this hire?You: The close.Employee: Thanks.',
    );
    expect(view.container.textContent).toContain('1 of 7 answered');
    expect(said(view.container).join(' ')).toContain('Drafting your charter');
    view.unmount();
  });

  it('waits for the session before deciding, rather than opening one it might not need', async (): Promise<void> => {
    room.session = undefined;
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await settle();
    expect(room.starts).toBe(0);
    view.unmount();
  });

  it('names the retry while the deployment tries a failed draft again', async (): Promise<void> => {
    room.session = {
      _id: 'session-1',
      state: 'active',
      pendingTranscript: STORED,
      finalisationError: 'the model timed out',
      recoveryAttempts: 1,
    };
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await settle();
    expect(said(view.container).join(' ')).toContain(
      'The last attempt did not finish, so Your employee is trying again.',
    );
    // The provider's own text is for the log, not the page (C-34).
    expect(view.container.textContent).not.toContain('the model timed out');
    view.unmount();
  });

  it('offers to draft again or hold the one-to-one again once every retry is spent', async (): Promise<void> => {
    room.session = {
      _id: 'session-1',
      state: 'active',
      pendingTranscript: STORED,
      finalisationError: 'the model timed out',
      recoveryAttempts: MAX_FINALISATION_RECOVERIES,
    };
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await settle();
    expect(said(view.container).join(' ')).toContain(
      'The charter could not be drafted: every attempt ended without a usable draft.',
    );
    expect(view.container.textContent).not.toContain('the model timed out');
    await press(view.container, 'Draft again');
    expect(posts).toEqual([
      { agentId: AGENT, bossLabel: 'Sam', transcript: STORED, voiceSessionId: 'session-1' },
    ]);

    await press(view.container, 'Hold the one-to-one again');
    expect(room.restarts).toEqual([{ sessionId: 'session-1' }]);
    // The session set the failed conversation aside; the room opens a new one on it.
    room.session = { _id: 'session-1', state: 'active' };
    act((): void => view.root.render(<ChatRoom agentId={AGENT} bossLabel="Sam" />));
    await settle();
    expect(room.starts).toBe(1);
    expect(room.sent).toEqual([{ text: INIT_PROMPT }]);
    view.unmount();
  });
});

describe('a session that does not open', (): void => {
  it('stops waiting after fifteen seconds and says so, with Ask again', async (): Promise<void> => {
    vi.useFakeTimers();
    room.start = 'never';
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(said(view.container)).toEqual([
      'Your employee did not answer within 15 seconds.Ask again',
    ]);
    room.start = 'answer';
    await act(async (): Promise<void> => {
      view.container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(room.sent).toEqual([{ text: INIT_PROMPT }]);
    view.unmount();
  });
});

describe('the chat room against the accessibility floor (N14)', (): void => {
  it.each([
    ['in conversation', null],
    ['drafting', { _id: 'session-1', state: 'synthesising', pendingTranscript: 'USER: x' }],
    [
      'after the draft failed for good',
      {
        _id: 'session-1',
        state: 'active',
        pendingTranscript: 'ASSISTANT: Why?\n\nUSER: x',
        finalisationError: 'the model timed out',
        recoveryAttempts: MAX_FINALISATION_RECOVERIES,
      },
    ],
  ] as const)('has no axe violation and 44 px targets %s', async (_state, session) => {
    room.messages = session ? [] : CONVERSATION;
    room.session = session;
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" onSwitchMode={() => undefined} />);
    await settle();
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    expect(underTarget(view.container)).toEqual([]);
    view.unmount();
  });
});
