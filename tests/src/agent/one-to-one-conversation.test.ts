import { describe, expect, it } from 'vitest';
import {
  MAX_KEPT_TURNS,
  REPLY_MAX_CHARS,
  answerFailure,
  closeEarned,
  conversationTranscript,
  decideAnswer,
  decideTurn,
  isClosed,
  owesAnswer,
  repliesIn,
  uiMessagesOf,
  type OneToOneTurn,
} from '../../../src/agent/one-to-one-conversation';

function employee(id: string, text: string, topicIndex?: number): OneToOneTurn {
  return {
    id,
    speaker: 'employee',
    text,
    at: 1,
    ...(topicIndex === undefined ? {} : { topicIndex }),
  };
}

function manager(id: string, text: string): OneToOneTurn {
  return { id, speaker: 'manager', text, at: 1 };
}

/** A conversation of `replies` answered questions, the next question asked. */
function answered(replies: number): OneToOneTurn[] {
  const turns: OneToOneTurn[] = [employee('e0', 'Why this hire?', 0)];
  for (let index = 0; index < replies; index += 1) {
    turns.push(manager(`m${index}`, `Answer ${index + 1}.`));
    turns.push(employee(`e${index + 1}`, `Question ${index + 2}?`, Math.min(index + 1, 6)));
  }
  return turns;
}

describe('reading a kept conversation', (): void => {
  it("counts the manager's replies as the close gate does: a reply needs a spoken turn before it", (): void => {
    expect(repliesIn([])).toBe(0);
    expect(repliesIn(answered(3))).toBe(3);
    expect(repliesIn([employee('e0', ''), manager('m0', 'Hello?')])).toBe(0);
    expect(repliesIn([...answered(1), manager('m1', 'a'), manager('m2', 'b')])).toBe(2);
  });

  it('owes an answer while the manager has the last word, and is closed by a kept closing line', (): void => {
    expect(owesAnswer(answered(2))).toBe(false);
    expect(owesAnswer([...answered(2), manager('m2', 'Third.')])).toBe(true);
    expect(isClosed(answered(7))).toBe(false);
    expect(isClosed([...answered(7), { ...employee('e8', ''), closingLine: 'Thanks.' }])).toBe(
      true,
    );
    expect(closeEarned(answered(6))).toBe(false);
    expect(closeEarned([...answered(6), manager('m6', 'Seventh.')])).toBe(true);
  });

  it('writes the transcript the charter is drafted from, closing line kept, empty turns left out (re-pinned from the room)', (): void => {
    const turns: OneToOneTurn[] = [
      employee('e0', 'Why this hire?', 0),
      manager('m0', 'The close.'),
      { ...employee('e1', 'Understood.'), closingLine: 'Drafting your charter now.' },
      employee('e2', ''),
    ];
    expect(conversationTranscript(turns)).toBe(
      'ASSISTANT: Why this hire?\n\nUSER: The close.\n\nASSISTANT: Understood. Drafting your charter now.',
    );
  });

  it('draws the kept turns as the live room drew them: the question number and the close', (): void => {
    const messages = uiMessagesOf([
      employee('e0', 'Why this hire?', 0),
      manager('m0', 'The close.'),
      { ...employee('e1', ''), closingLine: 'Thanks.' },
    ]);
    expect(messages).toEqual([
      {
        id: 'e0',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Why this hire?' }],
        metadata: { topicIndex: 0 },
      },
      { id: 'm0', role: 'user', parts: [{ type: 'text', text: 'The close.' }] },
      {
        id: 'e1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-dayOneComplete',
            toolCallId: 'e1-close',
            state: 'input-available',
            input: { closingLine: 'Thanks.' },
          },
        ],
      },
    ]);
  });
});

describe('a turn that ends with nothing to answer', (): void => {
  it('stands only when it said something or closed, and finished for a reason other than the budget', (): void => {
    expect(answerFailure({ text: 'Who should I meet?', closed: false, finishReason: 'stop' })).toBe(
      null,
    );
    expect(answerFailure({ text: '', closed: true, finishReason: 'tool-calls' })).toBe(null);
    expect(answerFailure({ text: ' \n', closed: false, finishReason: 'stop' })).toBe(
      'Day0 returned nothing',
    );
    expect(answerFailure({ text: 'Who sho', closed: false, finishReason: 'length' })).toBe(
      'Day0 was cut off mid-reply',
    );
    expect(answerFailure({ text: 'Who', closed: false })).toBe('Day0 was cut off mid-reply');
    expect(answerFailure({ text: 'Hi', closed: false, finishReason: 'content-filter' })).toBe(
      "Day0's model provider refused to answer",
    );
  });
});

describe('deciding a turn against the kept conversation', (): void => {
  it('opens only a conversation with nothing kept', (): void => {
    expect(decideTurn([], { kind: 'open' }, 5)).toEqual({ ok: true, turns: [], answering: null });
    expect(decideTurn(answered(0), { kind: 'open' }, 5)).toMatchObject({ ok: false });
  });

  it('keeps a reply after a spoken question, and takes the same reply sent again as it stands', (): void => {
    const decision = decideTurn(answered(1), { kind: 'reply', id: 'm1', text: '  Priya. ' }, 5);
    expect(decision).toMatchObject({ ok: true, answering: 'm1' });
    if (!decision.ok) throw new Error(decision.refusal);
    expect(decision.turns.at(-1)).toEqual({ id: 'm1', speaker: 'manager', text: 'Priya.', at: 5 });
    expect(decideTurn(decision.turns, { kind: 'reply', id: 'm1', text: 'Priya.' }, 6)).toEqual({
      ok: true,
      turns: decision.turns,
      answering: 'm1',
    });
  });

  it('refuses a reply before the opening, a second reply in a row, an empty or over-long one, and one past the bound', (): void => {
    const reply = (id: string, text = 'Yes.') => ({ kind: 'reply' as const, id, text });
    expect(decideTurn([], reply('m0'), 5)).toMatchObject({ ok: false });
    expect(decideTurn([...answered(1), manager('m1', 'a')], reply('m2'), 5)).toMatchObject({
      ok: false,
      refusal: 'Day0 has not answered your last reply yet.',
    });
    expect(decideTurn(answered(1), reply('m1', '   '), 5)).toMatchObject({ ok: false });
    expect(decideTurn(answered(1), reply('m1', 'x'.repeat(REPLY_MAX_CHARS + 1)), 5)).toMatchObject({
      ok: false,
    });
    const atBound = answered((MAX_KEPT_TURNS - 2) / 2);
    expect(atBound).toHaveLength(MAX_KEPT_TURNS - 1);
    expect(decideTurn(atBound, reply('mX'), 5)).toMatchObject({ ok: true });
    expect(
      decideTurn([...atBound, manager('mX', 'a'), employee('eX', 'More?')], reply('mY'), 5),
    ).toMatchObject({
      ok: false,
    });
  });

  it('asks again for the answer the manager is owed, setting aside one the room set aside', (): void => {
    const owed = [...answered(2), manager('m2', 'Third.')];
    expect(decideTurn(owed, { kind: 'ask-again' }, 5)).toEqual({
      ok: true,
      turns: owed,
      answering: 'm2',
    });
    expect(decideTurn(answered(2), { kind: 'ask-again' }, 5)).toMatchObject({
      ok: true,
      answering: 'm1',
    });
    expect(decideTurn(answered(0), { kind: 'ask-again' }, 5)).toEqual({
      ok: true,
      turns: [],
      answering: null,
    });
  });

  it('refuses every turn once the conversation is closed', (): void => {
    const closed = [...answered(7), { ...employee('e8', ''), closingLine: 'Thanks.' }];
    expect(decideTurn(closed, { kind: 'ask-again' }, 5)).toMatchObject({ ok: false });
  });
});

describe('deciding an answer against the kept conversation', (): void => {
  const offered = { id: 'e2', text: 'Who should I meet?', topicIndex: 2 };

  it('keeps an answer where the conversation still ends, and the same answer once', (): void => {
    const owed = [...answered(1), manager('m1', 'Priya.')];
    const decision = decideAnswer(owed, { ...offered, answering: 'm1' }, 9);
    expect(decision).toMatchObject({ ok: true, closed: false });
    if (!decision.ok) throw new Error(decision.refusal);
    expect(decision.turns.at(-1)).toEqual({
      id: 'e2',
      speaker: 'employee',
      text: 'Who should I meet?',
      topicIndex: 2,
      at: 9,
    });
    expect(decideAnswer(decision.turns, { ...offered, answering: 'm1' }, 10)).toEqual({
      ok: true,
      turns: decision.turns,
      closed: false,
    });
  });

  it('refuses an answer to a reply the conversation has moved past, and a second opening', (): void => {
    const owed = [...answered(2), manager('m2', 'Third.')];
    expect(decideAnswer(owed, { ...offered, answering: 'm1' }, 9)).toMatchObject({ ok: false });
    expect(decideAnswer(answered(0), { ...offered, answering: null }, 9)).toMatchObject({
      ok: false,
    });
    expect(decideAnswer([], { ...offered, answering: null }, 9)).toMatchObject({ ok: true });
  });

  it('keeps a closing line only on an earned close, and drops a question number out of range', (): void => {
    const six = [...answered(5), manager('m5', 'Sixth.')];
    const early = decideAnswer(six, { ...offered, answering: 'm5', closingLine: 'Bye.' }, 9);
    expect(early).toMatchObject({ ok: true, closed: false });
    if (!early.ok) throw new Error(early.refusal);
    expect(early.turns.at(-1)?.closingLine).toBeUndefined();

    const seven = [...answered(6), manager('m6', 'Seventh.')];
    const earned = decideAnswer(
      seven,
      { id: 'e7', text: '', topicIndex: 9, answering: 'm6', closingLine: 'Bye.' },
      9,
    );
    expect(earned).toMatchObject({ ok: true, closed: true });
    if (!earned.ok) throw new Error(earned.refusal);
    expect(earned.turns.at(-1)).toEqual({
      id: 'e7',
      speaker: 'employee',
      text: '',
      closingLine: 'Bye.',
      at: 9,
    });
  });
});
