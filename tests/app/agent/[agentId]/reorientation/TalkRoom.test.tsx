/** @vitest-environment jsdom */

import type { UIMessageChunk } from 'ai';
import { getFunctionName } from 'convex/server';
import { StrictMode, act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_KEPT_TURNS,
  decideAnswer,
  type OneToOneTurn,
} from '../../../../../src/agent/one-to-one-conversation';
import { lastKeptReply } from '../../../../../src/agent/one-to-one-room';
import {
  decideTalkTurn,
  keptTalkAnswer,
  type TalkTurnRequest,
} from '../../../../../src/agent/reorientation-talk';

/*
 * The Discuss room (16-D; the wave file's 5.3 and section 7's words, RM24) on the chat hook it
 * really runs on: only the Convex client and the network are stand-ins, deciding as the card's
 * talk does (`decideTalkTurn`, `decideAnswer`, `keptTalkAnswer`). It opens, carries on from any
 * point, ends on the card by Put this on the card, and says a card decided or gone; with axe and
 * the 44 px floor.
 */

const backend = vi.hoisted(() => ({
  status: 'open' as string,
  proposedKind: 'pending' as string,
  /** Null for a card that is gone. */
  present: true,
  talk: null as null | {
    state: 'active' | 'finished' | 'closed';
    turns: OneToOneTurn[];
    replyDraft?: string;
  },
  drafts: [] as unknown[],
}));

vi.mock('convex/react', () => ({
  useMutation:
    (reference: unknown) =>
    async (args: Record<string, unknown>): Promise<unknown> => {
      const name = getFunctionName(reference as never);
      if (name === 'reorientationTalk:keepReplyDraft') {
        backend.drafts.push(args);
        if (backend.talk === null || args.after !== lastKeptReply(backend.talk.turns)) {
          return { kept: false };
        }
        backend.talk.replyDraft = String(args.text) || undefined;
        return { kept: true };
      }
      throw new Error(`unexpected mutation ${name}`);
    },
  useQuery: (): unknown =>
    backend.present
      ? {
          reorientationId: 'card-1',
          agentId: 'agent-1',
          summary: 'Priya now approves committee-deck numbers',
          status: backend.status,
          proposed: { kind: backend.proposedKind },
          talk:
            backend.talk === null
              ? null
              : {
                  _id: 'talk-1',
                  state: backend.talk.state,
                  turns: backend.talk.turns,
                  conversation: 0,
                  ...(backend.talk.replyDraft === undefined
                    ? {}
                    : { replyDraft: backend.talk.replyDraft }),
                },
        }
      : null,
}));

import { TalkRoom } from '../../../../../app/agent/[agentId]/reorientation/TalkRoom';
import type { Id } from '../../../../../convex/_generated/dataModel';
import { axeViolations } from '../../../../fixtures/dom/axe';
import { mount, press, settle, typeInto } from '../../../../fixtures/dom/press';
import { underTarget } from '../../../../fixtures/dom/targets';

/** The bodies the room posted to the talk's route, in order. */
let posted: Array<{ reorientationId: string; request: TalkTurnRequest }> = [];

/** How the route answers each streamed post: with a turn's chunks. */
let answers: UIMessageChunk[][] = [];

/** How the route answers a finish: ended, or the talk's refusal. */
let finishAnswer: { ended: true } | { error: string } = { ended: true };

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

function kept(id: string, speaker: OneToOneTurn['speaker'], text: string): OneToOneTurn {
  return { id, speaker, text, at: 1 };
}

function streamOf(chunks: readonly UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller): void {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/** The talk's route, as it takes a turn and keeps its answer on the talk. */
async function route(request: TalkTurnRequest): Promise<Response> {
  const talk = backend.talk ?? { state: 'active' as const, turns: [] };
  const taken = decideTalkTurn(talk.turns, request, 1);
  if (!taken.ok) return Response.json({ error: taken.refusal }, { status: 409 });
  backend.talk = { ...talk, state: 'active', turns: [...taken.turns] };
  if (taken.replied) backend.talk.replyDraft = undefined;
  backend.status = 'discussing';
  if (request.kind === 'finish') {
    if ('error' in finishAnswer) return Response.json(finishAnswer, { status: 409 });
    backend.talk.state = 'finished';
    backend.status = 'open';
    backend.proposedKind = 'charter-change';
    const unkept = taken.unkept?.length ?? 0;
    return Response.json({ ...finishAnswer, ...(unkept > 0 ? { unkept } : {}) });
  }
  const chunks = answers.shift() ?? spoken('none', '');
  const start = chunks[0];
  const messageId = start.type === 'start' ? (start.messageId ?? 'answer') : 'answer';
  const streamed = await drain(
    keptTalkAnswer(streamOf(chunks), {
      messageId,
      keep: async (offered) => {
        const decision = decideAnswer(
          backend.talk!.turns,
          { ...offered, answering: taken.answering, topicIndex: -1 },
          2,
        );
        if (!decision.ok) return decision.refusal;
        backend.talk!.turns = [...decision.turns];
        return null;
      },
    }),
  );
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const chunk of streamed) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
  });
}

beforeEach((): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  (globalThis as { Element: typeof Element }).Element.prototype.scrollTo = (): void => undefined;
  posted = [];
  answers = [];
  finishAnswer = { ended: true };
  backend.status = 'open';
  backend.proposedKind = 'pending';
  backend.present = true;
  backend.talk = null;
  backend.drafts = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit): Promise<Response> => {
    expect(url).toBe('/api/reorientation/chat');
    const body = JSON.parse(String(init.body)) as (typeof posted)[number];
    posted.push(body);
    return await route(body.request);
  });
});

afterEach((): void => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const SETTLE_ROUNDS = 60;

/** Let the room open, stream and settle on the fake clock, round after round. */
async function streamed(): Promise<void> {
  let seen = '';
  let quiet = 0;
  for (let round = 0; round < SETTLE_ROUNDS; round += 1) {
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const now = `${posted.length}|${JSON.stringify(backend.talk)}|${document.body.innerHTML}`;
    quiet = now === seen ? quiet + 1 : 0;
    seen = now;
    if (quiet === 2) {
      await settle();
      return;
    }
  }
  throw new Error(`the room was still changing after ${SETTLE_ROUNDS} rounds`);
}

function room(): ReturnType<typeof mount> {
  return mount(
    <TalkRoom reorientationId="card-1" agentId={'agent-1' as Id<'agents'>} name="Mira" />,
  );
}

function logOf(view: ReturnType<typeof mount>): string {
  return view.container.querySelector('[role="log"]')?.textContent ?? '';
}

/** axe and the 44 px floor over the settled room; axe runs on the real clock. */
async function floor(root: Element): Promise<void> {
  vi.useRealTimers();
  expect(await axeViolations(root, ['region'])).toEqual([]);
  expect(underTarget(root)).toEqual([]);
}

describe('the Discuss room', (): void => {
  it('opens a talk on a card that has none, under section 7’s title', async (): Promise<void> => {
    answers = [spoken('e0', 'Should committee-deck drafts go to Priya first?')];
    const view = room();
    await streamed();
    expect(posted.map((body) => body.request)).toEqual([{ kind: 'open' }]);
    expect(posted[0].reorientationId).toBe('card-1');
    expect(view.container.querySelector('h2')?.textContent).toBe(
      'Talking through: Priya now approves committee-deck numbers',
    );
    expect(logOf(view)).toContain('Should committee-deck drafts go to Priya first?');
    expect(logOf(view)).not.toContain('__init__');
    expect(
      view.container.querySelector('a[href="/agent/agent-1/reorientation#card-card-1"]')
        ?.textContent,
    ).toBe('Back to the card');
    await floor(view.container);
    view.unmount();
  });

  it('carries a reopened talk on from where it stood: the reply typed back, the answer owed asked again', async (): Promise<void> => {
    backend.status = 'discussing';
    backend.talk = {
      state: 'active',
      turns: [
        kept('e0', 'employee', 'Should committee-deck drafts go to Priya first?'),
        kept('m0', 'manager', 'Yes, send committee-deck drafts to Priya first, then to me.'),
      ],
      replyDraft: 'And copy',
    };
    answers = [spoken('e1', 'And everything else to you?')];
    const view = room();
    await streamed();
    expect(posted.map((body) => body.request)).toEqual([
      {
        kind: 'ask-again',
        question: 'e0',
        replies: [
          { id: 'm0', text: 'Yes, send committee-deck drafts to Priya first, then to me.' },
        ],
        discarding: null,
      },
    ]);
    expect(logOf(view)).toContain(
      'You: Yes, send committee-deck drafts to Priya first, then to me.',
    );
    expect(logOf(view)).toContain('And everything else to you?');
    expect(view.container.querySelector('textarea')?.value).toBe('And copy');
    view.unmount();
  });

  it('sends a reply under the question it answers, and draws the answer', async (): Promise<void> => {
    backend.talk = {
      state: 'active',
      turns: [kept('e0', 'employee', 'Should committee-deck drafts go to Priya first?')],
    };
    answers = [spoken('e1', 'And everything else to you?')];
    const view = room();
    await streamed();
    await typeInto(view.container.querySelector('textarea')!, 'Yes, Priya first.');
    await press(view.container, 'Send');
    await streamed();
    expect(posted.at(-1)?.request).toMatchObject({ kind: 'reply', question: 'e0' });
    expect(backend.talk?.turns.map((turn) => turn.text)).toEqual([
      'Should committee-deck drafts go to Priya first?',
      'Yes, Priya first.',
      'And everything else to you?',
    ]);
    view.unmount();
  });

  it('puts the talk on the card by Put this on the card, and says the card has the new proposal', async (): Promise<void> => {
    backend.status = 'discussing';
    backend.talk = {
      state: 'active',
      turns: [
        kept('e0', 'employee', 'Should committee-deck drafts go to Priya first?'),
        kept('m0', 'manager', 'Yes.'),
        kept('e1', 'employee', 'Shall I put that on the card?'),
      ],
    };
    const view = room();
    await streamed();
    await press(view.container, 'Put this on the card');
    await streamed();
    expect(posted.at(-1)?.request).toEqual({ kind: 'finish', question: 'e1', replies: [] });
    expect(view.container.textContent).toContain(
      'Mira put a new proposal on the card. Nothing changes until you approve it there.',
    );
    await floor(view.container);
    view.unmount();
  });

  it('says why a talk could not be put on the card, and keeps the composer', async (): Promise<void> => {
    backend.talk = {
      state: 'active',
      turns: [
        kept('e0', 'employee', 'Should committee-deck drafts go to Priya first?'),
        kept('m0', 'manager', 'Yes.'),
        kept('e1', 'employee', 'Shall I put that on the card?'),
      ],
    };
    finishAnswer = { error: 'The card changed while you talked. Ask again.' };
    const view = room();
    await streamed();
    await press(view.container, 'Put this on the card');
    await streamed();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'The card changed while you talked',
    );
    expect(view.container.querySelector('textarea')?.disabled).toBe(false);
    view.unmount();
  });

  it('says only that the talk is on the card once it is, whatever an earlier press was told (the v0.20.0 hosted walk’s finding 5)', async (): Promise<void> => {
    // The walk's shot `signedin-B-Pip-talk-transfer`: a press was answered 503 while the proposal
    // reached the card, and the page read "Pip put a new proposal on the card. Nothing changes
    // until you approve it there." above "Pip put nothing on the card. Try again."
    backend.status = 'discussing';
    backend.talk = {
      state: 'active',
      turns: [
        kept('e0', 'employee', 'Should committee-deck drafts go to Priya first?'),
        kept('m0', 'manager', 'Yes.'),
        kept('e1', 'employee', 'Shall I put that on the card?'),
      ],
    };
    finishAnswer = { error: 'Mira put nothing on the card. Try again.' };
    const view = room();
    await streamed();
    await press(view.container, 'Put this on the card');
    await streamed();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'Mira put nothing on the card',
    );
    // The proposal reached the card all the same, and the room reads the talk again.
    backend.talk.state = 'finished';
    backend.status = 'open';
    backend.proposedKind = 'charter-change';
    act((): void =>
      view.root.render(
        <TalkRoom reorientationId="card-1" agentId={'agent-1' as Id<'agents'>} name="Mira" />,
      ),
    );
    await streamed();
    expect(view.container.textContent).toContain('Mira put a new proposal on the card.');
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(view.container.textContent).not.toContain('put nothing on the card');
    view.unmount();
  });

  it('offers Put this on the card only once the manager has answered', async (): Promise<void> => {
    answers = [spoken('e0', 'Should committee-deck drafts go to Priya first?')];
    const view = room();
    await streamed();
    const finish = [...view.container.querySelectorAll('button')].find(
      (control) => control.textContent === 'Put this on the card',
    );
    expect(finish?.disabled).toBe(true);
    view.unmount();
  });

  it('draws a decided card’s talk as it stood, closed, with no composer', async (): Promise<void> => {
    backend.status = 'applied';
    backend.talk = {
      state: 'closed',
      turns: [kept('e0', 'employee', 'Should committee-deck drafts go to Priya first?')],
    };
    const view = room();
    await streamed();
    expect(posted).toEqual([]);
    expect(view.container.textContent).toContain(
      'The card was decided, so the talk about it is closed.',
    );
    expect(logOf(view)).toContain('Should committee-deck drafts go to Priya first?');
    expect(view.container.querySelector('textarea')).toBeNull();
    await floor(view.container);
    view.unmount();
  });

  it('says a card that is gone, with the way back to the cards', async (): Promise<void> => {
    backend.present = false;
    const view = room();
    await streamed();
    expect(posted).toEqual([]);
    expect(view.container.textContent).toContain('This card is gone.');
    expect(view.container.querySelector('a[href="/agent/agent-1/reorientation"]')).not.toBeNull();
    view.unmount();
  });

  it('offers no second Put this on the card once the talk is on the card (the second pass’s m4)', async (): Promise<void> => {
    backend.status = 'discussing';
    backend.talk = {
      state: 'active',
      turns: [
        kept('e0', 'employee', 'Should committee-deck drafts go to Priya first?'),
        kept('m0', 'manager', 'Yes.'),
        kept('e1', 'employee', 'Shall I put that on the card?'),
      ],
    };
    const view = room();
    await streamed();
    await press(view.container, 'Put this on the card');
    await streamed();
    const finish = [...view.container.querySelectorAll('button')].find(
      (control) => control.textContent === 'Put this on the card',
    );
    expect(finish?.disabled).toBe(true);
    view.unmount();
  });

  it('puts a reply the talk had no room for back in the composer, and says so (the second pass’s M3)', async (): Promise<void> => {
    const turns = Array.from({ length: MAX_KEPT_TURNS - 1 }, (_, index) =>
      kept(`t${index}`, index % 2 === 0 ? 'employee' : 'manager', `Turn ${index}.`),
    );
    backend.status = 'discussing';
    backend.talk = { state: 'active', turns };
    const view = room();
    await streamed();
    await typeInto(view.container.querySelector('textarea')!, 'One more thing.');
    await press(view.container, 'Send');
    await streamed();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'The talk is as long as it can be',
    );
    await press(view.container, 'Put this on the card');
    await streamed();
    expect(posted.at(-1)?.request).toEqual({
      kind: 'finish',
      question: 't38',
      replies: [{ id: expect.any(String), text: 'One more thing.' }],
    });
    expect(view.container.textContent).toContain(
      'Mira put a new proposal on the card. Nothing changes until you approve it there.',
    );
    expect(view.container.textContent).toContain(
      'The talk was as long as it can be, so your last reply was not kept. It is back in your reply.',
    );
    expect(view.container.querySelector('textarea')?.value).toBe('One more thing.');
    expect(logOf(view)).not.toContain('One more thing.');
    view.unmount();
  });

  it('opens the talk once under Strict Mode, the card already read (the second pass’s m10)', async (): Promise<void> => {
    answers = [spoken('e0', 'Should committee-deck drafts go to Priya first?')];
    const view = mount(
      <StrictMode>
        <TalkRoom reorientationId="card-1" agentId={'agent-1' as Id<'agents'>} name="Mira" />
      </StrictMode>,
    );
    await streamed();
    expect(posted.map((body) => body.request)).toEqual([{ kind: 'open' }]);
    view.unmount();
  });

  it('draws the talk again when another window set aside the answer this room drew (the second pass’s m9)', async (): Promise<void> => {
    backend.status = 'discussing';
    backend.talk = {
      state: 'active',
      turns: [
        kept('e0', 'employee', 'Should committee-deck drafts go to Priya first?'),
        kept('m0', 'manager', 'Yes.'),
        kept('e1', 'employee', 'And everything else to you?'),
      ],
    };
    const view = room();
    await streamed();
    // Another window asked again: its new answer has not come, and the answer drawn here is gone.
    backend.talk = { ...backend.talk, turns: backend.talk.turns.slice(0, 2) };
    act((): void =>
      view.root.render(
        <TalkRoom reorientationId="card-1" agentId={'agent-1' as Id<'agents'>} name="Mira" />,
      ),
    );
    await streamed();
    expect(logOf(view)).not.toContain('And everything else to you?');
    view.unmount();
  });
});
