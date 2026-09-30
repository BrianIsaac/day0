/** @vitest-environment jsdom */

import type { UIMessageChunk } from 'ai';
import { getFunctionName } from 'convex/server';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OneToOneTurn } from '../../../../src/agent/one-to-one-conversation';

/**
 * The room against the chat hook it really runs on: only the Convex client is a stand-in, and
 * the chat route is answered at the network. What is asserted is what the room posts, which is
 * what the session decides from (second pass M1).
 */
const backend = vi.hoisted(() => ({
  /** The conversation `voice.start` hands back. */
  kept: [] as OneToOneTurn[],
  session: { _id: 'session-1', state: 'active' } as Record<string, unknown>,
}));

vi.mock('convex/react', () => ({
  useMutation: (reference: unknown) => async (): Promise<unknown> =>
    getFunctionName(reference as never) === 'voice:start'
      ? { sessionId: 'session-1', turns: backend.kept, replyDraft: null }
      : { kept: true },
  useQuery: (): unknown => ({ ...backend.session, turns: backend.kept }),
}));

import { ChatRoom } from '../../../../app/agent/[agentId]/ChatRoom';
import type { Id } from '../../../../convex/_generated/dataModel';
import { mount, press, settle, typeInto } from '../../../fixtures/dom/press';

const AGENT = 'agent-1' as Id<'agents'>;

/** The bodies the room posted to the chat route, in order. */
let posted: Array<{ request: unknown }> = [];

/** How the chat route answers each post: with a turn's chunks, or not at all (a lost send). */
let answers: Array<UIMessageChunk[] | 'unreachable'> = [];

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

beforeEach((): void => {
  (globalThis as { Element: typeof Element }).Element.prototype.scrollTo = (): void => undefined;
  posted = [];
  answers = [];
  backend.kept = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit): Promise<Response> => {
    posted.push(JSON.parse(String(init.body)) as { request: unknown });
    const answer = answers.shift() ?? EMPTY;
    if (answer === 'unreachable') throw new TypeError('Failed to fetch');
    const body = answer.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('');
    return new Response(`${body}data: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
    });
  });
});

afterEach((): void => {
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

describe('the room on the chat hook it runs on (second pass M1)', (): void => {
  it('asks for the answer it is owed on reopen by the reply it answers, and draws it', async (): Promise<void> => {
    backend.kept = [kept('e0', 'employee', 'Why this hire?'), kept('m0', 'manager', 'The close.')];
    answers = [spoken('e1', 'Who should I meet?')];
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await streamed();
    expect(posted.map((body) => body.request)).toEqual([
      { kind: 'ask-again', reply: { id: 'm0', text: 'The close.' }, discarding: null },
    ]);
    const log = view.container.querySelector('[role="log"]')?.textContent ?? '';
    expect(log).toContain('You: The close.');
    expect(log).toContain('Who should I meet?');
    view.unmount();
  });

  it('asks again after a send that never reached the session by naming that reply, not by dropping an answer', async (): Promise<void> => {
    backend.kept = [kept('e0', 'employee', 'Why this hire?')];
    answers = ['unreachable'];
    const view = mount(<ChatRoom agentId={AGENT} bossLabel="Sam" />);
    await streamed();
    await reply(view, 'Tier-2 asks swamp the close.');
    const sent = posted[0].request as { kind: string; id: string; text: string };
    expect(sent).toMatchObject({ kind: 'reply', text: 'Tier-2 asks swamp the close.' });

    answers = [spoken('e1', 'What does month one look like?')];
    await press(view.container, 'Ask again');
    await streamed();
    expect(posted[1].request).toEqual({
      kind: 'ask-again',
      reply: { id: sent.id, text: 'Tier-2 asks swamp the close.' },
      discarding: null,
    });
    expect(view.container.querySelector('[role="log"]')?.textContent).toContain(
      'What does month one look like?',
    );
    view.unmount();
  });

  it('names the answer it set aside when a turn failed, and sends a reply typed after it as a reply', async (): Promise<void> => {
    backend.kept = [kept('e0', 'employee', 'Why this hire?')];
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
    expect(posted[2].request).toMatchObject({ kind: 'reply', text: 'And Omar owns the rota.' });
    view.unmount();
  });
});
