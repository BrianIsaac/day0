import { describe, expect, it } from 'vitest';
import {
  checkAgainstCharter,
  checkStatement,
  judgeSameness,
  type RefusalJudgementCall,
  type SamenessJudgementCall,
} from '../../../src/work/agreement-judgements';

const charters = [
  {
    name: 'Priya',
    willDo: ['shipment exception tickets'],
    willNotDo: ['email customers directly'],
  },
];

describe('checking a statement before it is shown or kept (F11)', (): void => {
  it('keeps a statement the judgement keeps, redacted, and shows the judgement the redacted words', async (): Promise<void> => {
    const seen: string[] = [];
    const call: RefusalJudgementCall = async (user) => {
      seen.push(user);
      return { verdict: 'keep', clause: null };
    };
    const checked = await checkStatement(
      'Comment on the ticket   and let the account team send it.',
      { charters, known: [] },
      call,
    );
    expect(checked).toEqual({
      outcome: 'kept',
      statement: 'Comment on the ticket and let the account team send it.',
      redaction: 'structural-only',
    });
    expect(seen[0]).toContain('[1] email customers directly');
  });

  it('refuses a statement contradicting a kept willNotDo clause, with the clause quoted', async (): Promise<void> => {
    const checked = await checkStatement(
      'Email the customer the new sailing yourself.',
      { charters, known: [] },
      async () => ({ verdict: 'contradicts-will-not-do', clause: 1 }),
    );
    expect(checked).toMatchObject({
      outcome: 'refused',
      refusal: { reason: 'contradicts-will-not-do', clause: 'email customers directly' },
    });
  });

  it('refuses a statement naming a credential and keeps it redacted, without asking the model', async (): Promise<void> => {
    let asked = false;
    const checked = await checkStatement(
      'Sign in to the carrier portal with hunter2 every time.',
      { charters, known: ['hunter2'] },
      async () => {
        asked = true;
        return { verdict: 'keep', clause: null };
      },
    );
    expect(checked).toMatchObject({ outcome: 'refused', refusal: { reason: 'names-credential' } });
    expect(checked.statement).not.toContain('hunter2');
    expect(asked).toBe(false);
  });

  it('answers unavailable when the judgement cannot be had, so nothing is shown or kept unchecked', async (): Promise<void> => {
    const checked = await checkStatement(
      'Comment on the ticket.',
      { charters, known: [] },
      async () => {
        throw new Error('model down');
      },
    );
    expect(checked).toMatchObject({ outcome: 'unavailable', reason: 'model down' });
  });
});

describe('judging whether two corrections say the same thing (F10)', (): void => {
  const corrections = [
    { id: 'c1', text: 'Do not email the customer.', itemTitle: 'SH-1', createdAt: 1, isNew: false },
    { id: 'c2', text: 'Never email customers.', itemTitle: 'SH-2', createdAt: 2, isNew: true },
  ];

  it('answers the groups the judgement found', async (): Promise<void> => {
    const call: SamenessJudgementCall = async () => ({ groups: [{ ids: ['c2', 'c1'] }] });
    await expect(judgeSameness(corrections, { known: [] }, call)).resolves.toEqual({
      outcome: 'judged',
      groups: [['c1', 'c2']],
    });
  });

  it('asks nothing with fewer than two corrections or no new one', async (): Promise<void> => {
    let asked = 0;
    const call: SamenessJudgementCall = async () => {
      asked += 1;
      return { groups: [] };
    };
    await expect(judgeSameness([corrections[1]!], { known: [] }, call)).resolves.toEqual({
      outcome: 'judged',
      groups: [],
    });
    await expect(
      judgeSameness(
        corrections.map((correction) => ({ ...correction, isNew: false })),
        { known: [] },
        call,
      ),
    ).resolves.toEqual({ outcome: 'judged', groups: [] });
    expect(asked).toBe(0);
  });

  it("shows the judgement each correction's words and item redacted, the owner's values first (W13-R4)", async (): Promise<void> => {
    const seen: string[] = [];
    const call: SamenessJudgementCall = async (user) => {
      seen.push(user);
      return { groups: [] };
    };
    await judgeSameness(
      [
        {
          ...corrections[0]!,
          text: 'Use token: xoxb-1234567890-abcdefghij for the carrier post.',
          itemTitle: 'SH-1 portal login hunter2',
        },
        { ...corrections[1]!, text: 'The carrier password is hunter2, use it.' },
      ],
      { known: ['hunter2'] },
      call,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain('xoxb-1234567890-abcdefghij');
    expect(seen[0]).not.toContain('hunter2');
    expect(seen[0]).toContain('"text":"Use token: <redacted> for the carrier post."');
    expect(seen[0]).toContain('"from":"SH-1 portal login <redacted>"');
  });

  it('answers unavailable when the judgement cannot be had', async (): Promise<void> => {
    await expect(
      judgeSameness(corrections, { known: [] }, async () => {
        throw new Error('model down');
      }),
    ).resolves.toEqual({ outcome: 'unavailable', reason: 'model down' });
  });
});

/**
 * RM32 (a), wave 17: 16-FX's F1, on its bed. "Name the vessel in every customer comment." was
 * allowed against Mateo's charter and refused, `widens-scope`, against Ines's, the same run-through
 * body, and the one refusal ended the agreement for every employee. The two answers below are the
 * bed's own, in the order a second judgement of the same statement can meet them.
 */
describe('a charter’s check of an agreement for every employee, judged twice (RM32 (a); 16-FX’s F1)', (): void => {
  const STATEMENT = 'Name the vessel in every customer comment.';
  const runThrough = {
    willDo: [
      'Handle owned, prioritized Linear tickets in the Q3 close project.',
      'Draft replies to asks in #revops-asks.',
    ],
    willNotDo: ['Post to public Slack channels.'],
  };
  const ines = [{ name: 'Ines', ...runThrough }];

  /** A model that answers each call with the next of the scripted verdicts. */
  function scripted(
    verdicts: ReadonlyArray<'keep' | 'widens-scope' | 'contradicts-will-not-do' | Error>,
  ): { call: RefusalJudgementCall; seen: string[] } {
    const seen: string[] = [];
    const call: RefusalJudgementCall = async (user) => {
      const verdict = verdicts[seen.length];
      seen.push(user);
      if (verdict === undefined) throw new Error('asked more often than scripted');
      if (verdict instanceof Error) throw verdict;
      return { verdict, clause: verdict === 'contradicts-will-not-do' ? 1 : null };
    };
    return { call, seen };
  }

  it('asks once for a statement the first judgement keeps', async (): Promise<void> => {
    const { call, seen } = scripted(['keep']);
    expect(await checkAgainstCharter(STATEMENT, { charters: ines, known: [] }, call)).toMatchObject(
      { outcome: 'kept', statement: STATEMENT },
    );
    expect(seen).toHaveLength(1);
  });

  it('judges a refusal a second time, with the same prompt, and refuses only when both judgements refuse', async (): Promise<void> => {
    const { call, seen } = scripted(['widens-scope', 'widens-scope']);
    expect(await checkAgainstCharter(STATEMENT, { charters: ines, known: [] }, call)).toMatchObject(
      { outcome: 'refused', statement: STATEMENT, refusal: { reason: 'widens-scope' } },
    );
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
  });

  it('answers disputed, with the one refusal, when the second judgement keeps what the first refused', async (): Promise<void> => {
    const { call, seen } = scripted(['widens-scope', 'keep']);
    expect(await checkAgainstCharter(STATEMENT, { charters: ines, known: [] }, call)).toEqual({
      outcome: 'disputed',
      statement: STATEMENT,
      refusal: { reason: 'widens-scope' },
      redaction: 'structural-only',
    });
    expect(seen).toHaveLength(2);
  });

  it('keeps the clause the refusing judgement quoted on a disputed check', async (): Promise<void> => {
    const { call } = scripted(['contradicts-will-not-do', 'keep']);
    expect(await checkAgainstCharter(STATEMENT, { charters: ines, known: [] }, call)).toMatchObject(
      {
        outcome: 'disputed',
        refusal: { reason: 'contradicts-will-not-do', clause: 'Post to public Slack channels.' },
      },
    );
  });

  it('answers unavailable when the second judgement cannot be had, so the check is tried again rather than settled on one', async (): Promise<void> => {
    const { call } = scripted(['widens-scope', new Error('model down')]);
    expect(await checkAgainstCharter(STATEMENT, { charters: ines, known: [] }, call)).toEqual({
      outcome: 'unavailable',
      statement: STATEMENT,
      reason: 'model down',
    });
  });

  it('refuses a statement naming a credential at once, with no judgement: the redaction found it', async (): Promise<void> => {
    const { call, seen } = scripted([]);
    const checked = await checkAgainstCharter(
      'Sign in to the carrier portal with hunter2 every time.',
      { charters: ines, known: ['hunter2'] },
      call,
    );
    expect(checked).toMatchObject({ outcome: 'refused', refusal: { reason: 'names-credential' } });
    expect(seen).toEqual([]);
  });
});
