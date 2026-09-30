import { describe, expect, it } from 'vitest';
import {
  MAX_KEPT_TURNS,
  REPLY_MAX_CHARS,
  TURN_ID_MAX_CHARS,
  ANSWER_MAX_CHARS,
  answerFailure,
  closeEarned,
  conversationTranscript,
  MOVED_ON_REFUSAL,
  conversationOf,
  decideAnswer,
  decideTurn,
  isKeptAnswer,
  withKeptMark,
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
        metadata: { topicIndex: 0, kept: true },
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
        metadata: { kept: true },
      },
    ]);
    // Every employee turn drawn from the session is one the session holds.
    expect(messages.filter(isKeptAnswer).map((message) => message.id)).toEqual(['e0', 'e1']);
  });

  it('marks a kept answer whatever else its metadata carried, and reads the mark only there', (): void => {
    expect(withKeptMark({ topicIndex: 3 })).toEqual({ topicIndex: 3, kept: true });
    expect(withKeptMark(undefined)).toEqual({ kept: true });
    expect(isKeptAnswer({ role: 'assistant', metadata: { topicIndex: 3 } })).toBe(false);
    expect(isKeptAnswer({ role: 'assistant', metadata: { kept: 'yes' } })).toBe(false);
    expect(isKeptAnswer({ role: 'user', metadata: { kept: true } })).toBe(false);
  });

  it('reads the conversation a session holds, the first for a session from before the stamp', (): void => {
    expect(conversationOf({})).toBe(0);
    expect(conversationOf({ conversation: 3 })).toBe(3);
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

/** A reply to `question`, with the replies drawn since it, as a room sends one. */
function reply(question: string | null, ...replies: Array<[string, string]>) {
  return {
    kind: 'reply' as const,
    question,
    replies: replies.map(([id, text]) => ({ id, text })),
  };
}

describe('deciding a turn against the kept conversation', (): void => {
  it('opens only a conversation with nothing kept', (): void => {
    expect(decideTurn([], { kind: 'open' }, 5)).toEqual({
      ok: true,
      turns: [],
      answering: null,
      replied: false,
    });
    expect(decideTurn(answered(0), { kind: 'open' }, 5)).toMatchObject({ ok: false });
  });

  it('keeps a reply to the last question, and takes the same reply sent again as it stands', (): void => {
    const decision = decideTurn(answered(1), reply('e1', ['m1', '  Priya. ']), 5);
    expect(decision).toMatchObject({ ok: true, answering: 'm1', replied: true });
    if (!decision.ok) throw new Error(decision.refusal);
    expect(decision.turns.at(-1)).toEqual({ id: 'm1', speaker: 'manager', text: 'Priya.', at: 5 });
    expect(decideTurn(decision.turns, reply('e1', ['m1', 'Priya.']), 6)).toEqual({
      ok: true,
      turns: decision.turns,
      answering: 'm1',
      replied: false,
    });
  });

  it('refuses a reply to a question the conversation has moved past, from a second window (review F1)', (): void => {
    // Window A answered question 1 and was asked question 2; window B still draws question 1.
    const moved = [
      ...answered(0),
      manager('a1', 'Window A on question 1.'),
      employee('e1', 'Q2?', 1),
    ];
    expect(decideTurn(moved, reply('e0', ['b1', 'Window B, also on question 1.']), 5)).toEqual({
      ok: false,
      refusal: MOVED_ON_REFUSAL,
    });
    // A question the conversation never held, as after the one-to-one started again.
    expect(decideTurn(answered(1), reply('e-old', ['m1', 'Stale.']), 5)).toMatchObject({
      ok: false,
    });
  });

  it('refuses replies whose first the session does not hold where the room drew it', (): void => {
    const owed = [...answered(1), manager('m1', 'Priya.')];
    // Another window replied after the same question; this room never drew that reply.
    expect(decideTurn(owed, reply('e1', ['m-mine', 'Omar.']), 5)).toEqual({
      ok: false,
      refusal: MOVED_ON_REFUSAL,
    });
  });

  it('keeps a reply whose send failed before the one sent after it, in the order they were written (review M2)', (): void => {
    const decision = decideTurn(
      answered(1),
      reply(
        'e1',
        ['m1', 'FIRST: escalate anything over 50k.'],
        ['m2', 'SECOND: report on Mondays.'],
      ),
      5,
    );
    expect(decision).toMatchObject({ ok: true, answering: 'm2', replied: true });
    if (!decision.ok) throw new Error(decision.refusal);
    expect(decision.turns.slice(-2).map((turn) => turn.text)).toEqual([
      'FIRST: escalate anything over 50k.',
      'SECOND: report on Mondays.',
    ]);
    // The close gate counts them once, as it counted the room's history before.
    expect(repliesIn(decision.turns)).toBe(2);
  });

  it('keeps a second reply in a row, after an answer that never came, and answers both (second pass H2)', (): void => {
    const owed = [...answered(1), manager('m1', 'Priya.')];
    const decision = decideTurn(owed, reply('e1', ['m1', 'Priya.'], ['m2', 'And Omar.']), 5);
    expect(decision).toMatchObject({ ok: true, answering: 'm2' });
    if (!decision.ok) throw new Error(decision.refusal);
    expect(decision.turns.slice(-2).map((turn) => turn.id)).toEqual(['m1', 'm2']);
  });

  it('refuses a reply before the opening, an empty or over-long one, and an id past its bound', (): void => {
    expect(decideTurn([], reply(null, ['m0', 'Yes.']), 5)).toMatchObject({ ok: false });
    expect(decideTurn(answered(1), reply('e1'), 5)).toMatchObject({ ok: false });
    expect(decideTurn(answered(1), reply('e1', ['m1', '   ']), 5)).toMatchObject({ ok: false });
    expect(
      decideTurn(answered(1), reply('e1', ['m1', 'x'.repeat(REPLY_MAX_CHARS + 1)]), 5),
    ).toMatchObject({ ok: false });
    expect(
      decideTurn(answered(1), reply('e1', ['m'.repeat(TURN_ID_MAX_CHARS + 1), 'Yes.']), 5),
    ).toMatchObject({ ok: false });
  });

  it('refuses a reply whose id the conversation already holds', (): void => {
    expect(decideTurn(answered(2), reply('e2', ['m0', 'Again.']), 5)).toEqual({
      ok: false,
      refusal: MOVED_ON_REFUSAL,
    });
  });

  it('keeps a reply only while there is room for the answer it is owed (first review m1: 39, 40, 41)', (): void => {
    const thirtySeven = answered(18);
    expect(thirtySeven).toHaveLength(37);
    const replied = decideTurn(thirtySeven, reply('e18', ['m18', 'Yes.']), 5);
    expect(replied).toMatchObject({ ok: true });
    if (!replied.ok) throw new Error(replied.refusal);
    const answeredLast = decideAnswer(
      replied.turns,
      { answering: 'm18', id: 'e19', text: 'More?', topicIndex: 6 },
      6,
    );
    if (!answeredLast.ok) throw new Error(answeredLast.refusal);
    // 39 kept: a reply would be the 40th, with nowhere to keep its answer.
    expect(answeredLast.turns).toHaveLength(MAX_KEPT_TURNS - 1);
    expect(decideTurn(answeredLast.turns, reply('e19', ['m19', 'Yes.']), 7)).toMatchObject({
      ok: false,
    });
    // Two replies in a row at 37 make 39, and their answer is the 40th.
    const two = decideTurn(thirtySeven, reply('e18', ['m18', 'a'], ['m18b', 'b']), 5);
    if (!two.ok) throw new Error(two.refusal);
    expect(
      decideAnswer(two.turns, { answering: 'm18b', id: 'e19', text: 'More?', topicIndex: 6 }, 6),
    ).toMatchObject({ ok: true });
  });
});

describe('asking a turn again against the kept conversation', (): void => {
  const again = (
    question: string | null,
    replies: Array<[string, string]>,
    discarding: string | null = null,
  ) => ({
    kind: 'ask-again' as const,
    question,
    replies: replies.map(([id, text]) => ({ id, text })),
    discarding,
  });

  it('answers the reply the manager is owed an answer to, as a reopened room asks', (): void => {
    const owed = [...answered(2), manager('m2', 'Third.')];
    expect(decideTurn(owed, again('e2', [['m2', 'Third.']]), 5)).toEqual({
      ok: true,
      turns: owed,
      answering: 'm2',
      replied: false,
    });
  });

  it('sets aside the answer the room set aside, and only that one', (): void => {
    const decision = decideTurn(answered(2), again('e1', [['m1', 'Answer 2.']], 'e2'), 5);
    expect(decision).toMatchObject({ ok: true, answering: 'm1' });
    if (!decision.ok) throw new Error(decision.refusal);
    expect(decision.turns.at(-1)?.id).toBe('m1');
    // An answer kept since, which this room never saw, is not dropped by its Ask again.
    expect(decideTurn(answered(2), again('e1', [['m1', 'Answer 2.']], 'e-other'), 5)).toEqual(
      expect.objectContaining({ ok: false }),
    );
  });

  it('keeps a reply whose send never reached the session, and keeps the answer before it (second pass H1)', (): void => {
    const decision = decideTurn(answered(2), again('e2', [['m2', 'Third.']]), 5);
    expect(decision).toMatchObject({ ok: true, answering: 'm2', replied: true });
    if (!decision.ok) throw new Error(decision.refusal);
    expect(decision.turns.slice(-2).map((turn) => turn.id)).toEqual(['e2', 'm2']);
  });

  it('refuses to ask again a reply to a question the conversation has moved past', (): void => {
    expect(decideTurn(answered(2), again('e1', [['m-late', 'Late.']]), 5)).toEqual({
      ok: false,
      refusal: MOVED_ON_REFUSAL,
    });
  });

  it('asks the opening again only while nothing but it was kept', (): void => {
    expect(decideTurn([], again(null, []), 5)).toEqual({
      ok: true,
      turns: [],
      answering: null,
      replied: false,
    });
    expect(decideTurn(answered(0), again(null, [], 'e0'), 5)).toEqual({
      ok: true,
      turns: [],
      answering: null,
      replied: false,
    });
    expect(decideTurn(answered(1), again(null, []), 5)).toMatchObject({ ok: false });
  });

  it('refuses every turn once the conversation is closed', (): void => {
    const closed = [...answered(7), { ...employee('e8', ''), closingLine: 'Thanks.' }];
    expect(decideTurn(closed, again('e6', [['m6', 'Answer 7.']], 'e8'), 5)).toMatchObject({
      ok: false,
    });
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

  it('refuses an answer past its bounds, so the row stays inside its size', (): void => {
    const owed = [...answered(1), manager('m1', 'Priya.')];
    expect(
      decideAnswer(
        owed,
        { ...offered, answering: 'm1', text: 'x'.repeat(ANSWER_MAX_CHARS + 1) },
        9,
      ),
    ).toMatchObject({ ok: false });
    expect(
      decideAnswer(owed, { ...offered, answering: 'm1', id: 'e'.repeat(TURN_ID_MAX_CHARS + 1) }, 9),
    ).toMatchObject({ ok: false });
  });

  it('refuses an answer under the id of a turn the conversation already holds (review m8)', (): void => {
    const owed = [...answered(1), manager('m1', 'Priya.')];
    expect(decideAnswer(owed, { ...offered, answering: 'm1', id: 'e0' }, 9)).toMatchObject({
      ok: false,
    });
    expect(decideAnswer(owed, { ...offered, answering: 'm1', id: 'm1' }, 9)).toMatchObject({
      ok: false,
    });
  });

  it('refuses an answer that would keep more than the bound: 40 kept stays 40 (first review m1)', (): void => {
    const forty = [...answered(19), manager('m19', 'a')];
    expect(forty).toHaveLength(MAX_KEPT_TURNS);
    expect(
      decideAnswer(forty, { answering: 'm19', id: 'e20', text: 'More?', topicIndex: 6 }, 9),
    ).toMatchObject({ ok: false });
  });

  it('keeps a closing line only on an earned close, and drops a question number out of range', (): void => {
    const six = [...answered(5), manager('m5', 'Sixth.')];
    const early = decideAnswer(
      six,
      { ...offered, id: 'e6', answering: 'm5', closingLine: 'Bye.' },
      9,
    );
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
