/** @vitest-environment jsdom */

import { Chat } from '@ai-sdk/react';
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const room = vi.hoisted(() => ({
  /** What `voice.start` rejects with on its next calls, when set. */
  startRefusal: undefined as Error | undefined,
  /** The transcript `useChat` hands the room. */
  messages: [] as UIMessage[],
  sent: [] as unknown[],
}));

// The seams are the Convex client and the chat hook; the room's own logic runs. The session
// query answers null: no one-to-one has been held yet.
vi.mock('convex/react', () => ({
  useMutation: () => async (): Promise<{ sessionId: string; turns: never[]; replyDraft: null }> => {
    if (room.startRefusal) throw room.startRefusal;
    return { sessionId: 'session-1', turns: [], replyDraft: null };
  },
  useQuery: (): null => null,
}));
vi.mock('@ai-sdk/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ai-sdk/react')>()),
  useChat: () => ({
    messages: room.messages,
    sendMessage: (message: unknown): void => void room.sent.push(message),
    regenerate: (): void => undefined,
    setMessages: (): void => undefined,
    status: 'ready',
  }),
}));

import { ChatRoom } from '../../../../app/agent/[agentId]/ChatRoom';
import type { Id } from '../../../../convex/_generated/dataModel';
import {
  focusedName,
  mount,
  press,
  said as liveRegions,
  settle,
} from '../../../fixtures/dom/press';
import {
  FinishControl,
  REPLY_HELP,
  ReplyInput,
  TurnFailureNotice,
  askAgain,
  canFinish,
  chatTurnTransport,
  composerLocked,
  errorLine,
  turnFailure,
  turnRequestFor,
} from '../../../../app/agent/[agentId]/ChatRoom';
import { INIT_PROMPT } from '../../../../src/agent/day-one-turn';
import { REPLY_MAX_CHARS } from '../../../../src/agent/one-to-one-conversation';

/** What `useChat` hands `onFinish`, cut down to what the chat room reads. */
function finished(
  parts: UIMessage['parts'],
  finishReason?: 'stop' | 'tool-calls' | 'length' | 'content-filter',
): Parameters<typeof turnFailure>[0] {
  return {
    message: { id: 'a1', role: 'assistant', parts },
    isAbort: false,
    isError: false,
    finishReason,
  };
}

describe('a turn that ends with nothing to answer', (): void => {
  it('is a failure when the stream finished with no text and no tool call', (): void => {
    // The 19 Sep stream: start, start-step, finish-step, finish (stop).
    expect(turnFailure(finished([{ type: 'step-start' }], 'stop'))).toBe('Day0 returned nothing');
  });

  it('is a failure when the text is only whitespace', (): void => {
    expect(
      turnFailure(finished([{ type: 'step-start' }, { type: 'text', text: '\n\n' }], 'stop')),
    ).toBe('Day0 returned nothing');
  });

  it('is a failure when the stream ended without finishing, as the 60-second cut does', (): void => {
    expect(turnFailure(finished([{ type: 'step-start' }, { type: 'text', text: 'Under' }]))).toBe(
      'Day0 was cut off mid-reply',
    );
  });

  it('is not a failure when Day0 said something and finished', (): void => {
    expect(
      turnFailure(finished([{ type: 'text', text: 'Understood. Who should I meet?' }], 'stop')),
    ).toBeNull();
  });

  it('is not a failure when the turn only closes the 1:1', (): void => {
    const close = {
      type: 'tool-dayOneComplete',
      toolCallId: 'call_close',
      state: 'input-available',
      input: { closingLine: 'Drafting the charter.' },
    } as UIMessage['parts'][number];

    expect(turnFailure(finished([close], 'tool-calls'))).toBeNull();
  });

  it('leaves a stream error and a discarded send to their own paths', (): void => {
    expect(turnFailure({ ...finished([]), isError: true })).toBeNull();
    expect(turnFailure({ ...finished([]), isAbort: true })).toBeNull();
  });

  it('is a failure when the output budget ended the reply mid-sentence', (): void => {
    expect(turnFailure(finished([{ type: 'text', text: 'Understood. Who sho' }], 'length'))).toBe(
      'Day0 was cut off mid-reply',
    );
  });
});

describe('a stream error', (): void => {
  it("shows the route's own sentence, not the JSON it arrived in", (): void => {
    const body = JSON.stringify({
      error: 'employee unavailable',
      detail: 'OPENAI_API_KEY not set',
    });

    expect(errorLine(new Error(body))).toBe('employee unavailable');
  });

  it('shows any other error as it reads, and never an empty line', (): void => {
    expect(errorLine(new Error('Failed to fetch'))).toBe('Failed to fetch');
    expect(errorLine(new Error(''))).toBe('employee unavailable');
  });
});

describe('the composer', (): void => {
  it('is locked while Day0 is answering, before it has opened, and once the 1:1 is done', (): void => {
    expect(composerLocked({ status: 'streaming', done: false, opened: true })).toBe(true);
    expect(composerLocked({ status: 'submitted', done: false, opened: true })).toBe(true);
    expect(composerLocked({ status: 'ready', done: false, opened: false })).toBe(true);
    expect(composerLocked({ status: 'ready', done: true, opened: true })).toBe(true);
  });

  it('is open after a stream error, which the SDK reports as its own status', (): void => {
    expect(composerLocked({ status: 'error', done: false, opened: true })).toBe(false);
  });
});

describe('the failure notice', (): void => {
  it('says what happened and offers Ask again', (): void => {
    const html = renderToStaticMarkup(
      <TurnFailureNotice failure="Day0 returned nothing" onAskAgain={() => undefined} />,
    );

    expect(html).toContain('Day0 returned nothing');
    expect(html).toMatch(/<button[^>]*>Ask again<\/button>/);
  });
});

/** A transport that answers each request with the next scripted chunk list. */
function scriptedTransport(replies: UIMessageChunk[][]): {
  transport: ChatTransport<UIMessage>;
  requests: UIMessage[][];
} {
  const requests: UIMessage[][] = [];
  const transport: ChatTransport<UIMessage> = {
    sendMessages: async ({ messages }) => {
      requests.push(structuredClone(messages));
      const chunks = replies[requests.length - 1];
      return new ReadableStream<UIMessageChunk>({
        start(controller): void {
          chunks.forEach((chunk) => controller.enqueue(chunk));
          controller.close();
        },
      });
    },
    reconnectToStream: async () => null,
  };
  return { transport, requests };
}

const EMPTY_TURN: UIMessageChunk[] = [
  { type: 'start' },
  { type: 'start-step' },
  { type: 'finish-step' },
  { type: 'finish', finishReason: 'stop' },
];

function spoken(text: string): UIMessageChunk[] {
  return [
    { type: 'start' },
    { type: 'start-step' },
    { type: 'text-start', id: '0' },
    { type: 'text-delta', id: '0', delta: text },
    { type: 'text-end', id: '0' },
    { type: 'finish-step' },
    { type: 'finish', finishReason: 'stop' },
  ];
}

const lastText = (messages: UIMessage[]): string =>
  messages
    .at(-1)!
    .parts.filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('');

describe('Ask again, against the SDK chat the room runs on', (): void => {
  it('re-sends the opening prompt after an empty opening turn', async (): Promise<void> => {
    const { transport, requests } = scriptedTransport([
      EMPTY_TURN,
      spoken('Welcome. Why this hire?'),
    ]);
    const failures: (string | null)[] = [];
    const chat = new Chat<UIMessage>({ transport, onFinish: (f) => failures.push(turnFailure(f)) });

    await chat.sendMessage({ text: INIT_PROMPT });

    expect(failures).toEqual(['Day0 returned nothing']);
    expect(chat.messages.some((m) => m.role === 'assistant')).toBe(false);

    await askAgain(chat);

    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(lastText(requests[1])).toBe(INIT_PROMPT);
    expect(failures).toEqual(['Day0 returned nothing', null]);
    expect(lastText(chat.messages)).toBe('Welcome. Why this hire?');
  });

  it('re-sends the last reply, without the half-said answer, after a cut', async (): Promise<void> => {
    const cut: UIMessageChunk[] = [
      { type: 'start' },
      { type: 'start-step' },
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', delta: 'Under' },
      { type: 'abort' },
    ];
    const { transport, requests } = scriptedTransport([
      spoken('Why this hire?'),
      cut,
      spoken('Understood. Who should I meet?'),
    ]);
    const failures: (string | null)[] = [];
    const chat = new Chat<UIMessage>({ transport, onFinish: (f) => failures.push(turnFailure(f)) });

    await chat.sendMessage({ text: INIT_PROMPT });
    await chat.sendMessage({ text: 'The close is drowning the analysts.' });

    expect(failures.at(-1)).toBe('Day0 was cut off mid-reply');

    await askAgain(chat);

    expect(requests[2]).toEqual(requests[1]);
    expect(lastText(requests[2])).toBe('The close is drowning the analysts.');
    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(lastText(chat.messages)).toBe('Understood. Who should I meet?');
  });

  it('sends the opening prompt when nothing was ever sent', async (): Promise<void> => {
    const { transport, requests } = scriptedTransport([spoken('Welcome. Why this hire?')]);
    const chat = new Chat<UIMessage>({ transport });

    await askAgain(chat);

    expect(lastText(requests[0])).toBe(INIT_PROMPT);
  });
});

/** One turn of the 1:1 as `useChat` holds it. */
function turn(id: string, role: UIMessage['role'], parts: UIMessage['parts']): UIMessage {
  return { id, role, parts };
}

const said = (text: string): UIMessage['parts'] => [{ type: 'text', text }];

describe('finishing the 1:1 from the room', (): void => {
  const conversation: UIMessage[] = [
    turn('0', 'user', said(INIT_PROMPT)),
    turn('1', 'assistant', said('Why this hire?')),
    turn('2', 'user', said('To close the books faster.')),
  ];

  it('names a content-filter finish as the provider refusing, even with no text', (): void => {
    expect(turnFailure(finished([], 'content-filter'))).toBe(
      "Day0's model provider refused to answer",
    );
    expect(turnFailure(finished(said('Partial answer'), 'content-filter'))).toBe(
      "Day0's model provider refused to answer",
    );
  });

  it('offers Finish once the manager has answered, and not while Day0 is answering or after the close', (): void => {
    expect(canFinish({ status: 'ready', done: false, messages: conversation })).toBe(true);
    expect(canFinish({ status: 'error', done: false, messages: conversation })).toBe(true);
    expect(canFinish({ status: 'ready', done: false, messages: conversation.slice(0, 2) })).toBe(
      false,
    );
    expect(canFinish({ status: 'streaming', done: false, messages: conversation })).toBe(false);
    expect(canFinish({ status: 'ready', done: true, messages: conversation })).toBe(false);
  });

  it('renders Finish as a labelled button that is disabled until it can run', (): void => {
    const enabled = renderToStaticMarkup(<FinishControl disabled={false} onFinish={() => {}} />);
    const disabled = renderToStaticMarkup(<FinishControl disabled onFinish={() => {}} />);

    expect(enabled).toMatch(/<button[^>]*type="button"[^>]*>Finish<\/button>/);
    expect(enabled).toContain(
      'title="End the 1:1 and draft the charter from what you have said so far"',
    );
    expect(enabled).not.toContain('disabled=""');
    expect(disabled).toContain('disabled=""');
  });
});

describe('the composer', (): void => {
  it('bounds a reply and labels the field for everyone, described by how to send', (): void => {
    const markup = renderToStaticMarkup(
      <ReplyInput
        value=""
        onChange={() => {}}
        onSend={() => {}}
        disabled={false}
        placeholder="type"
        helpId="reply-help"
      />,
    );

    expect(REPLY_MAX_CHARS).toBe(4000);
    expect(markup).toContain(`maxLength="${REPLY_MAX_CHARS}"`);
    const field = /<textarea[^>]*id="([^"]+)"[^>]*aria-describedby="reply-help"/.exec(markup);
    expect(field).not.toBeNull();
    expect(markup).toContain(`<label for="${field![1]}"`);
    expect(markup).toMatch(/<label[^>]*>Your reply<\/label>/);
    expect(REPLY_HELP).toBe(
      'Enter sends. Shift+Enter starts a new line. Short answers are enough.',
    );
  });
});

describe('the chat room for a screen reader, and a 1:1 that could not start (step 45)', (): void => {
  it('says who spoke on every turn inside a focusable, named log', (): void => {
    room.messages = [
      { id: 'u0', role: 'user', parts: [{ type: 'text', text: INIT_PROMPT }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Why this hire?' }] },
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Close week is heavy.' }] },
    ] as UIMessage[];
    const view = mount(<ChatRoom agentId={'agent-1' as Id<'agents'>} bossLabel="Sam" />);
    const log = view.container.querySelector('[role="log"]');
    expect(log?.getAttribute('aria-label')).toBe('The 1:1 so far');
    expect(log?.getAttribute('tabindex')).toBe('0');
    expect(log?.getAttribute('aria-busy')).toBe('false');
    expect(log?.textContent).toContain('Employee: Why this hire?');
    expect(log?.textContent).toContain('You: Close week is heavy.');
    view.unmount();
    room.messages = [];
  });

  it('says why the session could not start and starts it again on Ask again', async (): Promise<void> => {
    (globalThis as { Element: typeof Element }).Element.prototype.scrollTo = (): void => undefined;
    room.startRefusal = new Error(
      '[CONVEX M(voice:start)] [Request ID: 1] Server Error\nUncaught Error: The employee is retired.\n    at handler (../convex/voice.ts:1:1)',
    );
    room.sent = [];
    const view = mount(<ChatRoom agentId={'agent-1' as Id<'agents'>} bossLabel="Sam" />);
    await settle();
    expect(liveRegions(view.container)).toEqual(['The employee is retired.Ask again']);

    room.startRefusal = undefined;
    await press(view.container, 'Ask again');
    expect(room.sent).toEqual([{ text: INIT_PROMPT }]);
    expect(liveRegions(view.container)).toEqual([]);
    expect(focusedName()).not.toBe('Ask again');
    view.unmount();
  });
});

describe('the turns arriving in the 1:1 (v3 section 5.2)', (): void => {
  /** The text of each turn the log marks as arriving, in order. */
  const arriving = (root: ParentNode): string[] =>
    [...root.querySelectorAll('[role="log"] [data-arrive]')].map(
      (bubble) => bubble.textContent ?? '',
    );

  it('rises in only the two newest turns, and moves the mark on as the next one lands', async (): Promise<void> => {
    room.messages = [
      turn('0', 'user', said(INIT_PROMPT)),
      turn('1', 'assistant', said('Why this hire?')),
      turn('2', 'user', said('To close the books faster.')),
      turn('3', 'assistant', said('Who signs off a close?')),
    ];
    const view = mount(<ChatRoom agentId={'agent-1' as Id<'agents'>} bossLabel="Sam" />);
    await settle();
    expect(arriving(view.container)).toEqual([
      'You: To close the books faster.',
      'Employee: Who signs off a close?',
    ]);

    room.messages = [...room.messages, turn('4', 'user', said('The controller.'))];
    act((): void =>
      view.root.render(<ChatRoom agentId={'agent-1' as Id<'agents'>} bossLabel="Sam" />),
    );
    await settle();
    expect(arriving(view.container)).toEqual([
      'Employee: Who signs off a close?',
      'You: The controller.',
    ]);
    view.unmount();
    room.messages = [];
  });
});

describe('a turn as the room sends it (30 Sep, a one-to-one lost to a closed tab)', (): void => {
  const opening: UIMessage[] = [turn('0', 'user', said(INIT_PROMPT))];
  const replied: UIMessage[] = [
    turn('1', 'assistant', said('Why this hire?')),
    turn('2', 'user', said('To close the books faster.')),
  ];

  it('names the turn it wants: the opening, the reply by its id, or the reply to answer again', (): void => {
    expect(turnRequestFor(opening, 'submit-message', null)).toEqual({ kind: 'open' });
    expect(turnRequestFor(replied, 'submit-message', null)).toEqual({
      kind: 'reply',
      id: '2',
      text: 'To close the books faster.',
    });
    expect(turnRequestFor(replied, 'regenerate-message', 'a9')).toEqual({
      kind: 'ask-again',
      reply: { id: '2', text: 'To close the books faster.' },
      discarding: 'a9',
    });
    expect(turnRequestFor(opening, 'regenerate-message', null)).toEqual({
      kind: 'ask-again',
      reply: null,
      discarding: null,
    });
  });

  it('posts the employee and the turn, and never the history, which the session keeps', async (): Promise<void> => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    });
    try {
      await chatTurnTransport('agent-1' as Id<'agents'>, 'Sam').sendMessages({
        chatId: 'room',
        messages: replied,
        trigger: 'submit-message',
        messageId: undefined,
        abortSignal: undefined,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(bodies).toEqual([
      {
        agentId: 'agent-1',
        bossLabel: 'Sam',
        request: { kind: 'reply', id: '2', text: 'To close the books faster.' },
      },
    ]);
  });
});
