/** @vitest-environment jsdom */

import type { UIMessageChunk } from 'ai';
import { getFunctionName } from 'convex/server';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conversationTranscript,
  decideAnswer,
  decideTurn,
  repliesIn,
  type OneToOneTurn,
  type TurnRequest,
} from '../../../../src/agent/one-to-one-conversation';
import { lastKeptReply } from '../../../../src/agent/one-to-one-room';
import { keptAnswer } from '../../../../src/agent/kept-answer';

/**
 * The room against the chat hook it really runs on. Only the Convex client and the network are
 * stand-ins, and both decide as the session does, with the session's own decisions
 * (`decideTurn`, `decideAnswer`, `keptAnswer`): what is asserted is what the session ends up
 * holding, and what a room reopened on it draws (second pass M1; review M1 and M2).
 */
const backend = vi.hoisted(() => ({
  turns: [] as OneToOneTurn[],
  replyDraft: undefined as string | undefined,
  conversation: 0,
  mode: 'chat' as 'chat' | 'elevenlabs',
  pendingTranscript: undefined as string | undefined,
  starts: 0,
  /** What the subscription last told the room, while it has not caught up with the session. */
  lagging: undefined as Record<string, unknown> | undefined,
}));

vi.mock('convex/react', async () => {
  const { ConvexError } = await import('convex/values');
  return {
    useMutation:
      (reference: unknown) =>
      async (args: Record<string, unknown>): Promise<unknown> => {
        const name = getFunctionName(reference as never);
        if (name === 'voice:start') {
          backend.starts += 1;
          return {
            sessionId: 'session-1',
            conversation: backend.conversation,
            turns: backend.turns,
            replyDraft: backend.replyDraft ?? null,
          };
        }
        const stale = backend.mode !== 'chat' || args.conversation !== backend.conversation;
        if (name === 'oneToOne:keepReplyDraft') {
          if (stale || args.after !== lastKeptReply(backend.turns)) return { kept: false };
          backend.replyDraft = String(args.text) || undefined;
          return { kept: true };
        }
        if (name === 'oneToOne:finish') {
          if (stale) throw new ConvexError('The one-to-one started again in another window.');
          if (repliesIn(backend.turns) === 0)
            throw new ConvexError('Answer at least one question.');
          backend.pendingTranscript = conversationTranscript(backend.turns);
          backend.replyDraft = undefined;
          return { ok: true };
        }
        throw new Error(`unexpected mutation ${name}`);
      },
    useQuery: (): unknown =>
      backend.lagging ?? {
        _id: 'session-1',
        state: 'active',
        mode: backend.mode,
        conversation: backend.conversation,
        turns: backend.turns,
        replyDraft: backend.replyDraft,
        pendingTranscript: backend.pendingTranscript,
      },
  };
});

import { ChatRoom } from '../../../../app/agent/[agentId]/ChatRoom';
import type { Id } from '../../../../convex/_generated/dataModel';
import { mount, press, said, settle, typeInto } from '../../../fixtures/dom/press';

const AGENT = 'agent-1' as Id<'agents'>;

/** The bodies the room posted to the chat route, in order. */
let posted: Array<{ request: TurnRequest }> = [];

/**
 * How the chat route answers each post: with a turn's chunks, not at all (a send that never
 * reached the session), or with an answer the session keeps whose stream is then lost.
 */
type Answer = UIMessageChunk[] | 'unreachable' | { readonly lostAfterKeeping: UIMessageChunk[] };
let answers: Answer[] = [];

function spoken(id: string, text: string): UIMessageChunk[] {
  return [
    { type: 'start', messageId: id },
    { type: 'start-step' },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    { type: 'finish-step' },
    { type: 'finish', finishReason: 'stop' },
  ];
}

const EMPTY: UIMessageChunk[] = [
  { type: 'start', messageId: 'empty' },
  { type: 'start-step' },
  { type: 'finish-step' },
  { type: 'finish', finishReason: 'stop' },
];

function kept(id: string, speaker: OneToOneTurn['speaker'], text: string): OneToOneTurn {
  return { id, speaker, text, at: 1, ...(speaker === 'employee' ? { topicIndex: 0 } : {}) };
}

/** A stream of the given chunks, in order. */
function streamOf(chunks: readonly UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller): void {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** Read every chunk of a stream, as the route's response does. */
async function drain(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/** A server-sent event body of the chunks, and an error in place of its end when `lost`. */
function eventStream(chunks: readonly UIMessageChunk[], lost: boolean): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const chunk of chunks)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      if (lost) controller.error(new TypeError('network error'));
      else {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });
}

/** The chat route, as it takes a turn and keeps its answer on the session. */
async function route(request: TurnRequest, answer: Answer): Promise<Response> {
  if (answer === 'unreachable') throw new TypeError('Failed to fetch');
  const taken = decideTurn(backend.turns, request, 1);
  if (!taken.ok) return Response.json({ error: taken.refusal }, { status: 409 });
  backend.turns = [...taken.turns];
  if (taken.replied) backend.replyDraft = undefined;
  const lost = !Array.isArray(answer);
  const chunks = Array.isArray(answer) ? answer : answer.lostAfterKeeping;
  const start = chunks[0];
  const messageId = start.type === 'start' ? (start.messageId ?? 'answer') : 'answer';
  const streamed = await drain(
    keptAnswer(streamOf(chunks), {
      messageId,
      topicIndex: 0,
      keep: async (offered) => {
        const decision = decideAnswer(backend.turns, { ...offered, answering: taken.answering }, 2);
        if (!decision.ok) return decision.refusal;
        backend.turns = [...decision.turns];
        return null;
      },
    }),
  );
  // A lost stream stops before its finish: the answer is kept, and the room never hears so.
  return new Response(eventStream(lost ? streamed.slice(0, 4) : streamed, lost), {
    headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
  });
}

beforeEach((): void => {
  (globalThis as { Element: typeof Element }).Element.prototype.scrollTo = (): void => undefined;
  posted = [];
  answers = [];
  backend.turns = [];
  backend.replyDraft = undefined;
  backend.conversation = 0;
  backend.mode = 'chat';
  backend.pendingTranscript = undefined;
  backend.starts = 0;
  backend.lagging = undefined;
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as { request: TurnRequest };
    posted.push(body);
    return await route(body.request, answers.shift() ?? EMPTY);
  });
});

afterEach((): void => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** Let the room open, stream and settle. */
async function streamed(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await act(async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  await settle();
}

async function reply(view: ReturnType<typeof mount>, text: string): Promise<void> {
  await typeInto(view.container.querySelector('textarea')!, text);
  await press(view.container, 'Send');
  await streamed();
}

/** Draw the room again, as a subscription answering with the session's new state does. */
async function redraw(view: ReturnType<typeof mount>): Promise<void> {
  act((): void => view.root.render(<ChatRoom agentId={AGENT} bossLabel="Sam" />));
  await streamed();
}

function logOf(view: ReturnType<typeof mount>): string {
  return view.container.querySelector('[role="log"]')?.textContent ?? '';
}

function keptTexts(): string[] {
  return backend.turns.map((turn) => `${turn.speaker}:${turn.text}`);
}

describe('the room on the chat hook it runs on (second pass M1)', (): void => {
  it('asks for the answer it is owed on reopen by the reply it answers, and draws it', async (): Promise<void> => {
    backend.turns = [kept('e0', 'employee', 'Why this hire?'), kept('m0', 'manager', 'The close.')];
    answers = [spoken('e1', 'Who should I meet?')];
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await streamed();
    expect(posted.map((body) => body.request)).toEqual([
      {
        kind: 'ask-again',
        question: 'e0',
        replies: [{ id: 'm0', text: 'The close.' }],
        discarding: null,
      },
    ]);
    expect(logOf(view)).toContain('You: The close.');
    expect(logOf(view)).toContain('Who should I meet?');
    view.unmount();
  });

  it('asks again after a send that never reached the session by naming that reply, not by dropping an answer', async (): Promise<void> => {
    backend.turns = [kept('e0', 'employee', 'Why this hire?')];
    answers = ['unreachable'];
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await streamed();
    await reply(view, 'Tier-2 asks swamp the close.');
    const sent = posted[0].request;
    expect(sent).toMatchObject({
      kind: 'reply',
      question: 'e0',
      replies: [{ text: 'Tier-2 asks swamp the close.' }],
    });

    answers = [spoken('e1', 'What does month one look like?')];
    await press(view.container, 'Ask again');
    await streamed();
    expect(posted[1].request).toEqual({
      kind: 'ask-again',
      question: 'e0',
      replies: sent.kind === 'reply' ? sent.replies : [],
      discarding: null,
    });
    expect(logOf(view)).toContain('What does month one look like?');
    expect(keptTexts()).toEqual([
      'employee:Why this hire?',
      'manager:Tier-2 asks swamp the close.',
      'employee:What does month one look like?',
    ]);
    view.unmount();
  });

  it('names the answer it set aside when a turn failed, and sends a reply typed after it to the question before it', async (): Promise<void> => {
    backend.turns = [kept('e0', 'employee', 'Why this hire?')];
    answers = [EMPTY];
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await streamed();
    await reply(view, 'The close.');
    expect(view.container.textContent).toContain('Day0 returned nothing');

    answers = [EMPTY];
    await press(view.container, 'Ask again');
    await streamed();
    expect(posted[1].request).toMatchObject({ kind: 'ask-again', discarding: 'empty' });

    answers = [spoken('e1', 'Noted. Who should I meet?')];
    await reply(view, 'And Omar owns the rota.');
    expect(posted[2].request).toMatchObject({
      kind: 'reply',
      question: 'e0',
      replies: [{ text: 'The close.' }, { text: 'And Omar owns the rota.' }],
    });
    expect(keptTexts().slice(-3)).toEqual([
      'manager:The close.',
      'manager:And Omar owns the rota.',
      'employee:Noted. Who should I meet?',
    ]);
    view.unmount();
  });
});

describe('an opening that failed (second pass A1)', (): void => {
  it('keeps the composer shut until the session holds a question, and asks the opening again', async (): Promise<void> => {
    answers = [EMPTY];
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await streamed();
    expect(view.container.textContent).toContain('Day0 returned nothing');
    // Nothing can be typed ahead of a question the session never kept.
    expect(view.container.querySelector('textarea')?.disabled).toBe(true);

    answers = [spoken('e0', 'Why was I hired?')];
    await press(view.container, 'Ask again');
    await streamed();
    expect(posted.at(-1)?.request).toMatchObject({
      kind: 'ask-again',
      question: null,
      replies: [],
    });
    expect(keptTexts()).toEqual(['employee:Why was I hired?']);
    expect(view.container.querySelector('textarea')?.disabled).toBe(false);
    view.unmount();
  });
});

describe('a reply the room shows that never reached the session (review M2)', (): void => {
  const ASKED = [
    kept('e0', 'employee', 'Why this hire?'),
    kept('m0', 'manager', 'The close.'),
    kept('e1', 'employee', 'Any constraints?'),
  ];

  it('is named by Finish, and Send it first delivers it before the charter is drafted from it', async (): Promise<void> => {
    backend.turns = ASKED;
    answers = ['unreachable'];
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await streamed();
    await reply(view, 'Never contact customers directly.');
    expect(logOf(view)).toContain('Never contact customers directly.');

    await press(view.container, 'Finish');
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Your last reply has not reached Your employee');
    expect(dialog?.textContent).toContain('Never contact customers directly.');

    answers = [spoken('e2', 'Understood. Anything else?')];
    await press(document.body, 'Send it first');
    await streamed();
    expect(posted[1].request).toMatchObject({
      kind: 'ask-again',
      question: 'e1',
      replies: [{ text: 'Never contact customers directly.' }],
    });

    await press(view.container, 'Finish');
    await press(document.body, 'Finish and draft');
    await streamed();
    expect(backend.pendingTranscript).toContain('USER: Never contact customers directly.');

    view.unmount();
    const reopened = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await streamed();
    expect(logOf(reopened)).toContain('You: Never contact customers directly.');
    reopened.unmount();
  });

  it('leaves the page and the charter together when the manager finishes without it', async (): Promise<void> => {
    backend.turns = ASKED;
    answers = ['unreachable'];
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await streamed();
    await reply(view, 'Never contact customers directly.');

    await press(view.container, 'Finish');
    await press(document.body, 'Finish without it');
    await streamed();
    expect(backend.pendingTranscript).toBeDefined();
    expect(backend.pendingTranscript).not.toContain('Never contact customers');
    // The room does not show words the charter was not drafted from.
    expect(logOf(view)).not.toContain('Never contact customers');

    view.unmount();
    const reopened = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await streamed();
    expect(logOf(reopened)).not.toContain('Never contact customers');
    reopened.unmount();
  });

  it('is delivered before a second Send, in the order written, and a reopened room draws both', async (): Promise<void> => {
    backend.turns = ASKED;
    answers = ['unreachable', spoken('e2', 'Noted both. Anything else?')];
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await streamed();
    await reply(view, 'FIRST: escalate anything over 50k to me.');
    await reply(view, 'SECOND: and report weekly on Mondays.');
    expect(posted[1].request).toMatchObject({
      kind: 'reply',
      question: 'e1',
      replies: [
        { text: 'FIRST: escalate anything over 50k to me.' },
        { text: 'SECOND: and report weekly on Mondays.' },
      ],
    });
    expect(keptTexts().slice(-3)).toEqual([
      'manager:FIRST: escalate anything over 50k to me.',
      'manager:SECOND: and report weekly on Mondays.',
      'employee:Noted both. Anything else?',
    ]);

    view.unmount();
    const reopened = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await streamed();
    expect(logOf(reopened)).toContain('You: FIRST: escalate anything over 50k to me.');
    expect(logOf(reopened)).toContain('You: SECOND: and report weekly on Mondays.');
    reopened.unmount();
  });

  it('is kept with the reply being typed, so a room closed before it is delivered reopens with both', async (): Promise<void> => {
    backend.turns = ASKED;
    answers = ['unreachable'];
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await streamed();
    await reply(view, 'Never contact customers directly.');
    vi.useFakeTimers();
    await typeInto(view.container.querySelector('textarea')!, 'And report weekly.');
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(800);
    });
    vi.useRealTimers();
    expect(backend.replyDraft).toBe('Never contact customers directly.\n\nAnd report weekly.');

    view.unmount();
    const reopened = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await streamed();
    expect(reopened.container.querySelector('textarea')?.value).toBe(
      'Never contact customers directly.\n\nAnd report weekly.',
    );
    reopened.unmount();
  });
});

describe('a room the session has moved past (review M1)', (): void => {
  it('has a reply to a question another window answered refused, then draws the session and hands the reply back', async (): Promise<void> => {
    backend.turns = [kept('e0', 'employee', 'Question 1?')];
    const tabB = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await streamed();
    // Window A answers question 1 and is asked question 2 before window B hears of it.
    backend.lagging = { _id: 'session-1', state: 'active', mode: 'chat', turns: backend.turns };
    backend.turns = [
      ...backend.turns,
      kept('a1', 'manager', 'Window A on question 1.'),
      kept('e1', 'employee', 'Question 2?'),
    ];
    await typeInto(tabB.container.querySelector('textarea')!, 'Window B, also on question 1.');
    await press(tabB.container, 'Send');
    await streamed();
    expect(posted.at(-1)?.request).toMatchObject({ kind: 'reply', question: 'e0' });
    expect(keptTexts()).toEqual([
      'employee:Question 1?',
      'manager:Window A on question 1.',
      'employee:Question 2?',
    ]);

    // The subscription catches up.
    backend.lagging = undefined;
    await redraw(tabB);
    expect(logOf(tabB)).toContain('You: Window A on question 1.');
    expect(logOf(tabB)).toContain('Question 2?');
    expect(logOf(tabB)).not.toContain('Window B');
    expect(tabB.container.querySelector('textarea')?.value).toBe('Window B, also on question 1.');
    expect(said(tabB.container).join(' ')).toContain('moved on in another window');
    tabB.unmount();
  });

  it('draws an answer the session kept whose stream the room lost, with no Ask again (review m7)', async (): Promise<void> => {
    backend.turns = [kept('e0', 'employee', 'Why this hire?')];
    answers = [{ lostAfterKeeping: spoken('e1', 'Who should I meet first?') }];
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await streamed();
    await reply(view, 'The close.');
    expect(keptTexts().at(-1)).toBe('employee:Who should I meet first?');

    await redraw(view);
    expect(logOf(view)).toContain('Who should I meet first?');
    expect(view.container.textContent).not.toContain('Ask again');
    view.unmount();
  });

  it('opens the conversation the session holds once another window started it again', async (): Promise<void> => {
    backend.turns = [kept('e0', 'employee', 'Why this hire?'), kept('m0', 'manager', 'Old.')];
    answers = [spoken('e1', 'Anything else?')];
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await streamed();
    expect(backend.starts).toBe(1);

    backend.conversation = 1;
    backend.turns = [];
    answers = [spoken('n0', 'Welcome again. Why this hire?')];
    await redraw(view);
    await redraw(view);
    expect(backend.starts).toBe(2);
    expect(posted.at(-1)?.request).toEqual({ kind: 'open' });
    expect(logOf(view)).not.toContain('Old.');
    expect(logOf(view)).toContain('Welcome again.');
    view.unmount();
  });

  it('writes nothing once another window moved the one-to-one to a call', async (): Promise<void> => {
    backend.turns = [kept('e0', 'employee', 'Why this hire?')];
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await streamed();

    backend.mode = 'elevenlabs';
    backend.conversation = 1;
    backend.turns = [];
    await redraw(view);
    expect(said(view.container).join(' ')).toContain('moved to a call in another window');
    expect(view.container.querySelector('textarea')?.disabled).toBe(true);
    expect(backend.starts).toBe(1);
    view.unmount();
  });
});
