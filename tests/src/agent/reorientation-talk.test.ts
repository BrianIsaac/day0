import type { UIMessageChunk } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  MAX_KEPT_TURNS,
  MOVED_ON_REFUSAL,
  decideTurn,
  type OneToOneTurn,
} from '../../../src/agent/one-to-one-conversation';
import {
  QUOTES_LIMIT,
  TALK_ANSWER_NOT_KEPT,
  decideTalkTurn,
  keptTalkAnswer,
  managerQuotes,
  talkRefusal,
  type KeepTalkAnswer,
  type TalkAnswer,
} from '../../../src/agent/reorientation-talk';

/*
 * The Discuss conversation's pure rules (16-D; the wave file's 5.3, RM10 (a)): a talk keeps its
 * turns by the one-to-one's own rules (`decideTurn`, `decideAnswer`, the 40-turn bound) and says
 * their refusals in its own words; it ends by putting a proposal on the card, whose evidence is
 * only what the manager said.
 */

/** A turn of a talk, as the store keeps one. */
function turn(id: string, speaker: OneToOneTurn['speaker'], text: string): OneToOneTurn {
  return { id, speaker, text, at: 1 };
}

/** The handover's case: Priya's escalation contact changed, and the manager says who now. */
const TALK: readonly OneToOneTurn[] = [
  turn(
    'e0',
    'employee',
    'Priya now approves committee-deck numbers. Should tier-2 drafts about them go to her first?',
  ),
  turn('m0', 'manager', 'Yes, send committee-deck drafts to Priya first, then to me.'),
  turn('e1', 'employee', 'And everything else still comes to you for review?'),
  turn('m1', 'manager', 'Everything else comes to me.'),
];

describe('a talk turn', (): void => {
  it('takes the opening, a reply and a turn asked again by the one-to-one’s own rules', (): void => {
    expect(decideTalkTurn([], { kind: 'open' }, 5)).toEqual(decideTurn([], { kind: 'open' }, 5));
    const replied = decideTalkTurn(
      TALK.slice(0, 1),
      { kind: 'reply', question: 'e0', replies: [{ id: 'm0', text: TALK[1].text }] },
      5,
    );
    expect(replied).toEqual(
      decideTurn(
        TALK.slice(0, 1),
        { kind: 'reply', question: 'e0', replies: [{ id: 'm0', text: TALK[1].text }] },
        5,
      ),
    );
    expect(replied).toMatchObject({ ok: true, answering: 'm0', replied: true });
  });

  it('says the one-to-one’s refusals as the talk’s', (): void => {
    expect(decideTalkTurn(TALK, { kind: 'open' }, 5)).toEqual({
      ok: false,
      refusal: 'The talk has already begun. Reload to carry on.',
    });
    expect(
      decideTalkTurn(
        TALK,
        { kind: 'reply', question: 'e0', replies: [{ id: 'm9', text: 'No.' }] },
        5,
      ),
    ).toEqual({ ok: false, refusal: 'The talk moved on in another window. Reload to carry on.' });
  });

  it('refuses a reply past the 40-turn bound, and says to put the talk on the card', (): void => {
    const long = Array.from({ length: MAX_KEPT_TURNS - 1 }, (_, index) =>
      turn(`t${index}`, index % 2 === 0 ? 'employee' : 'manager', `Turn ${index}.`),
    );
    expect(
      decideTalkTurn(
        long,
        { kind: 'reply', question: 't38', replies: [{ id: 'm39', text: 'One more.' }] },
        5,
      ),
    ).toEqual({
      ok: false,
      refusal: 'The talk is as long as it can be. Put it on the card from what was said.',
    });
  });

  it('puts a talk in step on the card with nothing new kept', (): void => {
    const answered = [...TALK, turn('e2', 'employee', 'Noted. Shall I put that on the card?')];
    expect(decideTalkTurn(answered, { kind: 'finish', question: 'e2', replies: [] }, 5)).toEqual({
      ok: true,
      turns: answered,
      answering: null,
      replied: false,
    });
  });

  it('keeps the replies a finish carries before it puts the talk on the card', (): void => {
    const decision = decideTalkTurn(
      TALK.slice(0, 3),
      { kind: 'finish', question: 'e1', replies: [{ id: 'm1', text: TALK[3].text }] },
      5,
    );
    expect(decision).toMatchObject({ ok: true, replied: true });
    expect(decision.ok && decision.turns.map((kept) => kept.id)).toEqual(['e0', 'm0', 'e1', 'm1']);
  });

  it('refuses to finish a talk the manager has said nothing in', (): void => {
    expect(
      decideTalkTurn(TALK.slice(0, 1), { kind: 'finish', question: 'e0', replies: [] }, 5),
    ).toEqual({
      ok: false,
      refusal: 'Answer at least once before putting this on the card.',
    });
  });

  it('refuses to finish from a room the talk has moved past', (): void => {
    expect(decideTalkTurn(TALK, { kind: 'finish', question: 'e0', replies: [] }, 5)).toEqual({
      ok: false,
      refusal: talkRefusal(MOVED_ON_REFUSAL),
    });
  });

  it('finishes from the kept turns when the reply it carries no longer fits, naming the reply set aside', (): void => {
    const long = Array.from({ length: MAX_KEPT_TURNS - 1 }, (_, index) =>
      turn(`t${index}`, index % 2 === 0 ? 'employee' : 'manager', `Turn ${index}.`),
    );
    expect(
      decideTalkTurn(
        long,
        { kind: 'finish', question: 't38', replies: [{ id: 'm39', text: 'One more.' }] },
        5,
      ),
    ).toEqual({
      ok: true,
      turns: long,
      answering: null,
      replied: false,
      unkept: [{ id: 'm39', text: 'One more.' }],
    });
  });

  it('finishes a talk at the 40-turn bound, which keeps no turn of its own', (): void => {
    const full = Array.from({ length: MAX_KEPT_TURNS }, (_, index) =>
      turn(`t${index}`, index % 2 === 0 ? 'employee' : 'manager', `Turn ${index}.`),
    );
    expect(
      decideTalkTurn(
        full,
        { kind: 'finish', question: 't38', replies: [{ id: 't39', text: 'x' }] },
        5,
      ),
    ).toMatchObject({ ok: true, replied: false });
  });
});

describe('the evidence the store keeps: the manager’s own words only (managerQuotes)', (): void => {
  it('keeps the manager’s own words', (): void => {
    expect(
      managerQuotes(
        ['send committee-deck drafts to Priya first, then to me', 'Everything else comes to me.'],
        TALK,
      ),
    ).toEqual([
      'send committee-deck drafts to Priya first, then to me',
      'Everything else comes to me.',
    ]);
  });

  it('never keeps an agent-quoted phrase', (): void => {
    expect(
      managerQuotes(
        [
          'Priya now approves committee-deck numbers. Should tier-2 drafts about them go to her first?',
        ],
        TALK,
      ),
    ).toEqual([]);
  });

  it('keeps nothing the manager did not say', (): void => {
    expect(managerQuotes(['Priya owns every tier-2 draft from now on.'], TALK)).toEqual([]);
  });

  it('keeps an employee’s phrase the manager said too, as the manager’s', (): void => {
    const echoed = [
      ...TALK,
      turn('e2', 'employee', 'Committee-deck drafts go to Priya first.'),
      turn('m2', 'manager', 'Right: committee-deck drafts go to Priya first.'),
    ];
    expect(managerQuotes(['committee-deck drafts go to Priya first'], echoed)).toEqual([
      'committee-deck drafts go to Priya first',
    ]);
  });

  it('reads every script’s words: accents, and a script with no spaces between its words', (): void => {
    const said = [
      ...TALK,
      turn('m2', 'manager', '委员会的数字先给普丽娅审批。 Señora Priya décide.'),
    ];
    expect(managerQuotes(['先给普丽娅审批', 'señora priya DÉCIDE', 'Señora Priya'], said)).toEqual([
      '先给普丽娅审批',
      'señora priya DÉCIDE',
      'Señora Priya',
    ]);
    expect(managerQuotes(['普丽娅不审批', 'Priya décide tout'], said)).toEqual([]);
  });

  it('keeps each quote once, trimmed, and at most a few', (): void => {
    const many = Array.from({ length: QUOTES_LIMIT + 2 }, () => '  Everything else comes to me. ');
    expect(managerQuotes([...many, 'Yes'], TALK)).toEqual(['Everything else comes to me.', 'Yes']);
    const words = TALK[1].text.split(' ');
    const distinct = words.map((_, index) => words.slice(index).join(' '));
    expect(managerQuotes(distinct, TALK)).toHaveLength(QUOTES_LIMIT);
  });
});

function streamOf(chunks: readonly UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller): void {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function read(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/** A keeper that records what it kept. */
function keeper(answer: (kept: TalkAnswer) => Promise<string | null> = async () => null): {
  keep: KeepTalkAnswer;
  kept: TalkAnswer[];
} {
  const kept: TalkAnswer[] = [];
  return {
    kept,
    keep: async (offered) => {
      kept.push(offered);
      return await answer(offered);
    },
  };
}

/** The outcome a `reorientationComplete` call carries. */
const OUTCOME = {
  change: 'edit-clause',
  candidate: 1,
  action: null,
  text: 'Surface tier-2 drafts about committee-deck numbers to Priya first, then to the manager',
  rationale: 'Priya approves committee-deck numbers now.',
  quotes: ['send committee-deck drafts to Priya first, then to me'],
  closingLine: 'I will put that on the card.',
};

describe('a talk answer as it streams', (): void => {
  it('keeps the words, then finishes with the kept mark', async (): Promise<void> => {
    const { keep, kept } = keeper();
    const chunks = await read(
      keptTalkAnswer(
        streamOf([
          { type: 'start' },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'Who approves the rest?' },
          { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: 'stop' },
        ]),
        { messageId: 'e1', keep },
      ),
    );
    expect(kept).toEqual([{ id: 'e1', text: 'Who approves the rest?' }]);
    expect(chunks[0]).toEqual({ type: 'start', messageId: 'e1' });
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      finishReason: 'stop',
      messageMetadata: { kept: true },
    });
  });

  it('keeps the outcome a reorientationComplete call carries, its closing line as the words when nothing else was said', async (): Promise<void> => {
    const { keep, kept } = keeper();
    await read(
      keptTalkAnswer(
        streamOf([
          { type: 'start' },
          {
            type: 'tool-input-available',
            toolCallId: 'c1',
            toolName: 'reorientationComplete',
            input: OUTCOME,
          },
          { type: 'finish', finishReason: 'tool-calls' },
        ]),
        { messageId: 'e2', keep },
      ),
    );
    expect(kept).toEqual([
      {
        id: 'e2',
        text: 'I will put that on the card.',
        outcome: {
          reply: {
            change: 'edit-clause',
            candidate: 1,
            action: null,
            text: OUTCOME.text,
            rationale: OUTCOME.rationale,
          },
          quotes: OUTCOME.quotes,
        },
      },
    ]);
  });

  it('keeps no outcome a call carried in a shape it cannot read', async (): Promise<void> => {
    const { keep, kept } = keeper();
    await read(
      keptTalkAnswer(
        streamOf([
          { type: 'start' },
          { type: 'text-delta', id: 't', delta: 'Done.' },
          {
            type: 'tool-input-available',
            toolCallId: 'c1',
            toolName: 'reorientationComplete',
            input: { change: 'rewrite-everything' },
          },
          { type: 'finish', finishReason: 'tool-calls' },
        ]),
        { messageId: 'e2', keep },
      ),
    );
    expect(kept).toEqual([]);
  });

  it('keeps nothing of a turn that said nothing or was cut off', async (): Promise<void> => {
    const { keep, kept } = keeper();
    const empty = await read(
      keptTalkAnswer(streamOf([{ type: 'start' }, { type: 'finish', finishReason: 'stop' }]), {
        messageId: 'e1',
        keep,
      }),
    );
    await read(
      keptTalkAnswer(
        streamOf([
          { type: 'start' },
          { type: 'text-delta', id: 't', delta: 'Half a' },
          { type: 'finish', finishReason: 'length' },
        ]),
        { messageId: 'e1', keep },
      ),
    );
    expect(kept).toEqual([]);
    expect(empty.at(-1)).toEqual({ type: 'finish', finishReason: 'stop' });
  });

  it('says a refusal to keep as an error before the finish', async (): Promise<void> => {
    const { keep } = keeper(async () => 'The card was decided; the talk is closed.');
    const chunks = await read(
      keptTalkAnswer(
        streamOf([
          { type: 'start' },
          { type: 'text-delta', id: 't', delta: 'Noted.' },
          { type: 'finish', finishReason: 'stop' },
        ]),
        { messageId: 'e1', keep },
      ),
    );
    expect(chunks.slice(-2)).toEqual([
      { type: 'error', errorText: 'The card was decided; the talk is closed.' },
      { type: 'finish', finishReason: 'stop' },
    ]);
  });

  it('says a keeper that throws as the answer not kept', async (): Promise<void> => {
    const chunks = await read(
      keptTalkAnswer(
        streamOf([
          { type: 'start' },
          { type: 'text-delta', id: 't', delta: 'Noted.' },
          { type: 'finish', finishReason: 'stop' },
        ]),
        {
          messageId: 'e1',
          keep: async () => {
            throw new Error('connection reset');
          },
        },
      ),
    );
    expect(chunks.at(-2)).toEqual({ type: 'error', errorText: TALK_ANSWER_NOT_KEPT });
  });
});
