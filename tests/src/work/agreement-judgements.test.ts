import { describe, expect, it } from 'vitest';
import {
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
