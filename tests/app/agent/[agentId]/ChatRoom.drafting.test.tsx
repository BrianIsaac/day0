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
  /** The conversation `voice.start` hands back: the turns the session kept, and the reply typed. */
  kept: [] as OneToOneTurn[],
  replyDraft: null as string | null,
  /** What `oneToOne.finish` rejects with, when set. */
  finishRefusal: undefined as Error | undefined,
  /** Every `oneToOne` mutation the room called, by name. */
  calls: [] as { name: string; args: unknown }[],
  messages: [] as UIMessage[],
  status: 'ready' as string,
  sent: [] as unknown[],
  regenerated: 0,
}));

vi.mock('convex/react', () => ({
  useMutation:
    (reference: unknown) =>
    async (args: unknown): Promise<unknown> => {
      const name = getFunctionName(reference as never);
      if (name === 'voice:restart') {
        room.restarts.push(args);
        return { ok: true };
      }
      if (name.startsWith('oneToOne:')) {
        room.calls.push({ name, args });
        if (name === 'oneToOne:finish' && room.finishRefusal) throw room.finishRefusal;
        return name === 'oneToOne:finish' ? { ok: true } : { kept: true };
      }
      room.starts += 1;
      if (room.start === 'never') return await new Promise(() => undefined);
      return { sessionId: 'session-1', turns: room.kept, replyDraft: room.replyDraft };
    },
  useQuery: (): unknown => room.session,
}));
vi.mock('@ai-sdk/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ai-sdk/react')>()),
  useChat: () => ({
    messages: room.messages,
    sendMessage: (message: unknown): void => void room.sent.push(message),
    regenerate: (): void => {
      room.regenerated += 1;
    },
    setMessages: (next: UIMessage[]): void => {
      room.messages = next;
    },
    status: room.status,
  }),
}));

import {
  ChatRoom,
  REPLY_DRAFT_KEEP_MS,
  progressOf,
  sendsReply,
} from '../../../../app/agent/[agentId]/ChatRoom';
import { SYNTHESIS_DEADLINE_MS } from '../../../../app/agent/[agentId]/charter-synthesis';
import type { Id } from '../../../../convex/_generated/dataModel';
import { INIT_PROMPT } from '../../../../src/agent/day-one-turn';
import { MAX_FINALISATION_RECOVERIES } from '../../../../src/agent/one-to-one-phase';
import type { OneToOneTurn } from '../../../../src/agent/one-to-one-conversation';
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
  room.kept = [];
  room.replyDraft = null;
  room.finishRefusal = undefined;
  room.calls = [];
  room.messages = [];
  room.status = 'ready';
  room.sent = [];
  room.regenerated = 0;
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
  it('asks before finishing, then has the session draft from what it kept, the transcript kept on the page (re-pinned)', async (): Promise<void> => {
    room.messages = CONVERSATION.slice(0, 3);
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await settle();
    await press(view.container, 'Finish');
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Finish the one-to-one now?');
    await press(document.body, 'Finish and draft');
    await settle();

    expect(room.calls).toContainEqual({
      name: 'oneToOne:finish',
      args: { sessionId: 'session-1', bossLabel: 'Sam' },
    });
    // The session drafts from the turns it kept; the room posts nothing that a closed tab could lose.
    expect(posts).toEqual([]);
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

  it('says why the one-to-one could not finish, and keeps it open to finish again (re-pinned)', async (): Promise<void> => {
    room.finishRefusal = new Error('Failed to fetch');
    room.messages = [...CONVERSATION.slice(0, 3)];
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await settle();
    await press(view.container, 'Finish');
    await press(document.body, 'Finish and draft');
    await settle();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
      'The one-to-one could not finish: Failed to fetch. Nothing you said is lost.',
    );
    // Finish is what failed, so Finish is what is offered again: Ask again would re-ask the employee.
    expect(view.container.textContent).not.toContain('Ask again');
    expect(view.container.querySelector('textarea')).not.toBeNull();

    room.finishRefusal = undefined;
    await press(view.container, 'Finish');
    await press(document.body, 'Finish and draft');
    await settle();
    expect(room.calls.filter((call) => call.name === 'oneToOne:finish')).toHaveLength(2);
    expect(said(view.container).join(' ')).toContain('Drafting your charter');
    view.unmount();
  });

  it('says the draft is taking longer than usual once the session has drafted past the deadline (re-pinned)', async (): Promise<void> => {
    vi.useFakeTimers();
    room.session = {
      _id: 'session-1',
      state: 'synthesising',
      pendingTranscript: 'ASSISTANT: Why this hire?\n\nUSER: The close.',
    };
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(SYNTHESIS_DEADLINE_MS - 1);
    });
    expect(view.container.querySelector('[role="status"]')?.textContent).not.toContain(
      'longer than usual',
    );
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe(
      'Drafting your charter, usually under a minute. It has taken longer than usual. It carries on, and the charter opens here when it is ready.',
    );
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    view.unmount();
  });
});

/** A kept turn, as the session holds it. */
function keptTurn(
  id: string,
  speaker: OneToOneTurn['speaker'],
  text: string,
  topicIndex?: number,
): OneToOneTurn {
  return { id, speaker, text, at: 1, ...(topicIndex === undefined ? {} : { topicIndex }) };
}

/** The one-to-one as the session kept it after `answers` replies, the next question asked. */
function keptThrough(answers: number): OneToOneTurn[] {
  const turns = [keptTurn('e0', 'employee', 'Why this hire?', 0)];
  for (let index = 0; index < answers; index += 1) {
    turns.push(keptTurn(`m${index}`, 'manager', `Answer ${index + 1}.`));
    if (index < 6)
      turns.push(keptTurn(`e${index + 1}`, 'employee', `Question ${index + 2}?`, index + 1));
  }
  return turns;
}

describe('a room reopened on a one-to-one under way (30 Sep, a one-to-one lost to a closed tab)', (): void => {
  /** Mount the room, let it open, and draw what it seeded (the chat hook here is a stand-in). */
  async function reopen(): Promise<ReturnType<typeof mount>> {
    room.session = { _id: 'session-1', state: 'active', turns: room.kept };
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await settle();
    act((): void => view.root.render(<ChatRoom agentId={AGENT} bossLabel="Sam" />));
    await settle();
    return view;
  }

  it('draws every kept turn and carries on at the question it stood at, never question 1', async (): Promise<void> => {
    room.kept = keptThrough(3);
    const view = await reopen();
    expect(room.sent).toEqual([]);
    expect(room.regenerated).toBe(0);
    const log = view.container.querySelector('[role="log"]')?.textContent ?? '';
    for (const answer of ['Answer 1.', 'Answer 2.', 'Answer 3.'])
      expect(log).toContain(`You: ${answer}`);
    expect(view.container.textContent).toContain('Question 4 of 7');
    expect(view.container.querySelector('textarea')?.disabled).toBe(false);
    view.unmount();
  });

  it('asks again for the answer the employee owed when the room closed as it answered, the seventh included', async (): Promise<void> => {
    room.kept = keptThrough(7);
    const view = await reopen();
    expect(room.sent).toEqual([]);
    expect(room.regenerated).toBe(1);
    expect(view.container.querySelector('[role="log"]')?.textContent?.match(/You: /g)).toHaveLength(
      7,
    );
    view.unmount();
  });

  it('puts the reply the manager was typing back in the composer', async (): Promise<void> => {
    room.kept = keptThrough(2);
    room.replyDraft = 'Half of my ans';
    const view = await reopen();
    expect(view.container.querySelector('textarea')?.value).toBe('Half of my ans');
    view.unmount();
  });

  it('keeps the reply being typed on the session once the composer rests', async (): Promise<void> => {
    room.kept = keptThrough(1);
    const view = await reopen();
    vi.useFakeTimers();
    await typeInto(view.container.querySelector('textarea')!, 'Priya in fin');
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(REPLY_DRAFT_KEEP_MS);
    });
    expect(room.calls.at(-1)).toEqual({
      name: 'oneToOne:keepReplyDraft',
      args: { sessionId: 'session-1', text: 'Priya in fin', after: 'm0' },
    });
    view.unmount();
  });

  it('does not end the one-to-one on a close the session never kept, once a reply follows it (second pass)', async (): Promise<void> => {
    room.messages = [
      ...CONVERSATION.slice(1, 3),
      {
        id: 'closing',
        role: 'assistant',
        parts: [
          {
            type: 'tool-dayOneComplete',
            toolCallId: 'c1',
            state: 'input-available',
            input: { closingLine: 'Thanks.' },
          },
        ],
      } as UIMessage,
      turn('4', 'user', 'One more thing: Omar owns the rota.'),
    ];
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await settle();
    expect(view.container.querySelector('[data-drafting]')).toBeNull();
    expect(view.container.querySelector('textarea')).not.toBeNull();
    view.unmount();
  });

  it('draws a conversation that closed as drafting, and posts nothing of its own', async (): Promise<void> => {
    room.kept = [
      ...keptThrough(7),
      { ...keptTurn('e7', 'employee', ''), closingLine: 'Thanks, drafting now.' },
    ];
    room.session = {
      _id: 'session-1',
      state: 'synthesising',
      turns: room.kept,
      pendingTranscript: 'ASSISTANT: Why this hire?',
    };
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await settle();
    act((): void => view.root.render(<ChatRoom agentId={AGENT} bossLabel="Sam" />));
    await settle();
    expect(room.starts).toBe(0);
    expect(posts).toEqual([]);
    const log = view.container.querySelector('[role="log"]')?.textContent ?? '';
    expect(log.match(/You: /g)).toHaveLength(7);
    expect(log).toContain('Thanks, drafting now.');
    expect(said(view.container).join(' ')).toContain('Drafting your charter');
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

  it('draws a stored turn as the live one was drawn: its emphasis bold, never its marks (m21)', async (): Promise<void> => {
    room.session = {
      _id: 'session-1',
      state: 'synthesising',
      pendingTranscript:
        'ASSISTANT: **Topic 1 - Why this hire:** what changed?\n\nUSER: The **close**, mostly.',
    };
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await settle();
    const log = view.container.querySelector('[role="log"]');
    expect(log?.querySelector('strong')?.textContent).toBe('Topic 1 - Why this hire:');
    expect(log?.textContent).not.toContain('**Topic');
    // The manager's own words are drawn as typed.
    expect(log?.textContent).toContain('The **close**, mostly.');
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
