import { describe, expect, it } from 'vitest';
import { RecordedSpanModel } from '../../fixtures/redaction-double';
import {
  AGREEMENTS_HEADING,
  AGREEMENTS_MAX,
  AGREEMENTS_MAX_CHARS,
  agreementApplies,
  agreementStatement,
  appliedAgreementIds,
  executorAgreementLines,
  plannerAgreementLines,
  redactedStatement,
  refusalJudgementPrompt,
  refusalOf,
  sameGroups,
  samenessJudgementPrompt,
  scrubbedAgreementEntries,
  selectAgreements,
  type AgreementRecord,
  type JudgedCorrection,
} from '../../../src/work/agreements';
import { CORRECTION_RULE } from '../../../src/work/corrections';
import { AGREEMENT_STATEMENT_LIMIT } from '../../../src/work/agreement-vocabulary';

const AGENT = 'agent-priya';

function agreement(overrides: Partial<AgreementRecord> & { _id: string }): AgreementRecord {
  return {
    agentId: AGENT,
    statement: 'Comment on the ticket and let the account team email the customer.',
    scope: 'global',
    status: 'active',
    createdAt: 1_000,
    effectiveFrom: 1_000,
    ...overrides,
  };
}

const candidate = { agentId: AGENT, sourceSystem: 'Linear', operation: 'ticket-close' };

describe('which working agreements reach a candidate', (): void => {
  it("takes this employee's and every employee's active agreements, never another employee's", (): void => {
    const own = agreement({ _id: 'own' });
    const everyone = agreement({ _id: 'everyone', agentId: undefined });
    const other = agreement({ _id: 'other', agentId: 'agent-mateo' });
    expect(selectAgreements([own, everyone, other], candidate).map((row) => row._id)).toEqual([
      'own',
      'everyone',
    ]);
  });

  it('takes only active agreements: never a proposal, a refused, dismissed, superseded or retired one', (): void => {
    const rows = (['proposed', 'refused', 'dismissed', 'superseded', 'retired'] as const).map(
      (status) => agreement({ _id: status, status }),
    );
    expect(selectAgreements([...rows, agreement({ _id: 'active' })], candidate)).toHaveLength(1);
  });

  it("matches a global scope, the candidate's source surface, its operation, or a person it resolves to", (): void => {
    expect(agreementApplies(agreement({ _id: 'g' }), candidate)).toBe(true);
    expect(
      agreementApplies(agreement({ _id: 's', scope: 'surface', scopeRef: 'linear' }), candidate),
    ).toBe(true);
    expect(
      agreementApplies(agreement({ _id: 'x', scope: 'surface', scopeRef: 'slack' }), candidate),
    ).toBe(false);
    expect(
      agreementApplies(
        agreement({ _id: 'o', scope: 'operation', scopeRef: 'ticket-close' }),
        candidate,
      ),
    ).toBe(true);
    expect(
      agreementApplies(agreement({ _id: 'y', scope: 'operation', scopeRef: 'post' }), candidate),
    ).toBe(false);
    expect(
      agreementApplies(agreement({ _id: 'p', scope: 'person', personId: 'person-aiko' }), {
        ...candidate,
        personIds: ['person-aiko'],
      }),
    ).toBe(true);
    expect(
      agreementApplies(
        agreement({ _id: 'q', scope: 'person', personId: 'person-aiko' }),
        candidate,
      ),
    ).toBe(false);
  });

  it('puts the newest kept first, by when each took effect', (): void => {
    const older = agreement({ _id: 'older', createdAt: 1, effectiveFrom: 5_000 });
    const newer = agreement({ _id: 'newer', createdAt: 2, effectiveFrom: 9_000 });
    expect(selectAgreements([older, newer], candidate).map((row) => row._id)).toEqual([
      'newer',
      'older',
    ]);
  });

  it(`carries at most ${AGREEMENTS_MAX} rows and ${AGREEMENTS_MAX_CHARS} characters, an older one that fits following one that does not`, (): void => {
    const many = Array.from({ length: 12 }, (_, at) =>
      agreement({ _id: `a${at}`, statement: 'x'.repeat(10), effectiveFrom: 100 - at }),
    );
    expect(selectAgreements(many, candidate)).toHaveLength(8);
    const big = agreement({ _id: 'big', statement: 'y'.repeat(1_500), effectiveFrom: 300 });
    const tooBig = agreement({ _id: 'too-big', statement: 'z'.repeat(600), effectiveFrom: 200 });
    const small = agreement({ _id: 'small', statement: 'w'.repeat(400), effectiveFrom: 100 });
    const picked = selectAgreements([big, tooBig, small], candidate);
    expect(picked.map((row) => row._id)).toEqual(['big', 'small']);
    expect(picked.reduce((sum, row) => sum + row.statement.length, 0)).toBeLessThanOrEqual(
      AGREEMENTS_MAX_CHARS,
    );
  });
});

describe('the working agreements block', (): void => {
  const entries = [{ id: 'wa1', since: '2026-10-05T12:00Z', text: 'Comment, never email.' }];

  it("puts the planner's block under its heading with the corrections' rule and asks for the ids applied", (): void => {
    const lines = plannerAgreementLines(entries);
    expect(lines[1]).toBe(AGREEMENTS_HEADING);
    expect(AGREEMENTS_HEADING).toBe('--- Working agreements ---');
    expect(lines[2]).toContain(CORRECTION_RULE);
    expect(lines[2]).toContain('`appliedAgreements`');
    expect(JSON.parse(lines[3]!)).toEqual(entries);
  });

  it("puts the executor's block under the same heading, as directions and never evidence", (): void => {
    const lines = executorAgreementLines(entries);
    expect(lines[1]).toBe(AGREEMENTS_HEADING);
    expect(lines[2]).toContain(CORRECTION_RULE);
    expect(lines[2]).toContain('not evidence of anything on this work item');
  });

  it('is empty when nothing is carried', (): void => {
    expect(plannerAgreementLines([])).toEqual([]);
    expect(executorAgreementLines([])).toEqual([]);
  });

  it('keeps only ids it offered, once each', (): void => {
    expect(appliedAgreementIds(['wa1', 'forged', 'wa1'], entries)).toEqual(['wa1']);
    expect(appliedAgreementIds(null, entries)).toEqual([]);
  });

  it('scrubs a stored value out of the statement at prompt assembly and says when the model was not asked', async (): Promise<void> => {
    const row = agreement({ _id: 'wa1', statement: 'Sign in with hunter2 before posting.' });
    const scrubbed = await scrubbedAgreementEntries([row], { known: ['hunter2'] });
    expect(scrubbed.redaction).toBe('structural-only');
    expect(scrubbed.entries[0]).toMatchObject({ id: 'wa1', since: '1970-01-01T00:00Z' });
    expect(scrubbed.entries[0]?.text).not.toContain('hunter2');
  });
});

describe('a statement as an agreement keeps it', (): void => {
  it('collapses whitespace and cuts at a word within the limit', (): void => {
    expect(agreementStatement('  Comment   on\nthe ticket. ')).toBe('Comment on the ticket.');
    const long = `${'word '.repeat(200)}end`;
    const kept = agreementStatement(long);
    expect(kept.length).toBeLessThanOrEqual(AGREEMENT_STATEMENT_LIMIT);
    expect(kept.endsWith('word')).toBe(true);
  });

  it('removes a stored credential and says a credential was named', async (): Promise<void> => {
    const redacted = await redactedStatement('Use the portal password hunter2 for every claim.', {
      known: ['hunter2'],
    });
    expect(redacted.statement).not.toContain('hunter2');
    expect(redacted.namesCredential).toBe(true);
  });

  it('removes a credential the span model finds and keeps a colleague named', async (): Promise<void> => {
    const redacted = await redactedStatement(
      'The carrier portal password is Tr0ub4dor&3, ask Priya.',
      { model: new RecordedSpanModel() },
    );
    expect(redacted.statement).not.toContain('Tr0ub4dor&3');
    expect(redacted.statement).toContain('Priya');
    expect(redacted.namesCredential).toBe(true);
  });

  it('leaves a plain preference as written', async (): Promise<void> => {
    const redacted = await redactedStatement('Comment on the ticket, never email the customer.', {
      known: [],
    });
    expect(redacted).toMatchObject({
      statement: 'Comment on the ticket, never email the customer.',
      namesCredential: false,
    });
  });
});

describe('the refusal before a proposal is shown (F11)', (): void => {
  const charters = [
    {
      name: 'Priya',
      willDo: ['shipment exception tickets'],
      willNotDo: ['email customers directly', 'change carrier contracts'],
    },
  ];

  it('numbers every willNotDo clause and fences the statement', (): void => {
    const prompt = refusalJudgementPrompt('Email the customer the new sailing.', charters);
    expect(prompt).toContain('[1] email customers directly');
    expect(prompt).toContain('[2] change carrier contracts');
    expect(prompt).toContain('--- Statement ---\nEmail the customer the new sailing.');
  });

  it('quotes the clause the judgement names, word for word from the charter', (): void => {
    expect(refusalOf({ verdict: 'contradicts-will-not-do', clause: 1 }, charters)).toEqual({
      reason: 'contradicts-will-not-do',
      clause: 'email customers directly',
    });
  });

  it('keeps no clause a reply numbered outside the list, and keeps a statement the judgement keeps', (): void => {
    expect(refusalOf({ verdict: 'contradicts-will-not-do', clause: 9 }, charters)).toEqual({
      reason: 'contradicts-will-not-do',
    });
    expect(refusalOf({ verdict: 'widens-scope', clause: null }, charters)).toEqual({
      reason: 'widens-scope',
    });
    expect(refusalOf({ verdict: 'keep', clause: null }, charters)).toBeUndefined();
  });
});

describe('two corrections that say the same thing (F10)', (): void => {
  const corrections: JudgedCorrection[] = [
    { id: 'c1', text: 'Do not email the customer.', itemTitle: 'SH-1', createdAt: 1, isNew: false },
    { id: 'c2', text: 'Never email customers.', itemTitle: 'SH-2', createdAt: 2, isNew: true },
    { id: 'c3', text: 'Use template B.', itemTitle: 'SH-3', createdAt: 3, isNew: false },
  ];

  it('lists every correction with its id and marks the new ones', (): void => {
    const prompt = samenessJudgementPrompt(corrections);
    expect(prompt).toContain('"id":"c2"');
    expect(prompt).toContain('"new":true');
  });

  it('keeps a group of known ids holding a new correction, oldest first', (): void => {
    expect(sameGroups({ groups: [{ ids: ['c2', 'c1'] }] }, corrections)).toEqual([['c1', 'c2']]);
  });

  it('breaks a tie of times by the prompt order, which lists the newest first', (): void => {
    const tied = [
      { id: 'later', text: 'b', itemTitle: 'SH-2', createdAt: 5, isNew: true },
      { id: 'earlier', text: 'a', itemTitle: 'SH-1', createdAt: 5, isNew: false },
    ];
    expect(sameGroups({ groups: [{ ids: ['later', 'earlier'] }] }, tied)).toEqual([
      ['earlier', 'later'],
    ]);
  });

  it('drops a group of one, a group with no new correction, an unknown id and an id already grouped', (): void => {
    expect(
      sameGroups(
        {
          groups: [
            { ids: ['c2'] },
            { ids: ['c1', 'c3'] },
            { ids: ['c2', 'forged'] },
            { ids: ['c1', 'c2'] },
            { ids: ['c2', 'c3'] },
          ],
        },
        corrections,
      ),
    ).toEqual([['c1', 'c2']]);
  });
});
