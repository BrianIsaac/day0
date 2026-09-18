import { describe, expect, it } from 'vitest';
import { RecordedSpanModel } from '../../fixtures/redaction-double';
import {
  appliedCorrectionIds,
  CORRECTIONS_HEADING,
  CORRECTIONS_MAX,
  CORRECTIONS_MAX_CHARS,
  correctionEntry,
  correctionSurfaces,
  plannerCorrectionLines,
  executorCorrectionLines,
  scrubbedCorrectionEntries,
  selectCorrections,
  type CorrectionRecord,
} from '../../../src/work/corrections';

const AGENT = 'agent-logistics';

function correction(overrides: Partial<CorrectionRecord> & { _id: string }): CorrectionRecord {
  return {
    agentId: AGENT,
    workItemId: `item-${overrides._id}`,
    kind: 'retry-note',
    text: 'Use the Delay notice B template and follow up in 48 hours.',
    itemTitle: 'Exception: SH-4471 held at customs',
    sourceCategory: 'ticket-queue',
    sourceSystem: 'linear',
    surfaces: ['linear'],
    createdAt: 1_000,
    appliedTo: [],
    ...overrides,
  };
}

const candidate = { agentId: AGENT, sourceCategory: 'ticket-queue', sourceSystem: 'Linear' };

describe('which kept corrections reach a later item', (): void => {
  it('takes only this employee\'s active corrections, never another\'s and never a retired one', (): void => {
    const own = correction({ _id: 'own' });
    const other = correction({ _id: 'other', agentId: 'agent-finance' });
    const retired = correction({ _id: 'retired', retiredAt: 2_000 });
    expect(selectCorrections([own, other, retired], candidate).map((row) => row._id)).toEqual(['own']);
  });

  it('matches on the kind of work: the same source category, or a surface the earlier plan touched', (): void => {
    const sameCategory = correction({ _id: 'category', sourceSystem: 'jira', surfaces: ['jira'] });
    const sameSurface = correction({
      _id: 'surface',
      sourceCategory: 'event-stream',
      sourceSystem: 'slack',
      surfaces: ['slack', 'linear'],
    });
    const unrelated = correction({
      _id: 'unrelated',
      sourceCategory: 'event-stream',
      sourceSystem: 'slack',
      surfaces: ['slack'],
    });
    expect(
      selectCorrections([sameCategory, sameSurface, unrelated], candidate).map((row) => row._id).sort(),
    ).toEqual(['category', 'surface']);
  });

  it('keeps every kind the manager writes: a retry note, a rejection reason and a plan rejection reason', (): void => {
    const rows = [
      correction({ _id: 'note', kind: 'retry-note' }),
      correction({ _id: 'rejection', kind: 'rejection' }),
      correction({ _id: 'plan', kind: 'plan-rejection' }),
    ];
    expect(selectCorrections(rows, candidate)).toHaveLength(3);
  });

  it('orders them newest first and keeps at most five', (): void => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      correction({ _id: `c${index}`, createdAt: 1_000 + index, text: `note ${index}` }),
    );
    const picked = selectCorrections(rows, candidate);
    expect(CORRECTIONS_MAX).toBe(5);
    expect(picked.map((row) => row._id)).toEqual(['c6', 'c5', 'c4', 'c3', 'c2']);
  });

  it('bounds the manager text they carry to 3,000 characters, newest kept first', (): void => {
    const long = (id: string, createdAt: number): CorrectionRecord =>
      correction({ _id: id, createdAt, text: 'x'.repeat(1_000) });
    const rows = [
      long('newest', 10),
      long('second', 9),
      long('third', 8),
      long('fourth', 7),
      correction({ _id: 'short', createdAt: 6, text: 'Short and older.' }),
    ];
    const picked = selectCorrections(rows, candidate);
    expect(CORRECTIONS_MAX_CHARS).toBe(3_000);
    expect(picked.map((row) => row._id)).toEqual(['newest', 'second', 'third']);
    expect(picked.reduce((total, row) => total + row.text.length, 0)).toBeLessThanOrEqual(3_000);

    const withRoom = [
      long('newest', 10),
      long('second', 9),
      correction({ _id: 'middling', createdAt: 8, text: 'y'.repeat(1_200) }),
      correction({ _id: 'short', createdAt: 7, text: 'Short and older.' }),
    ];
    // One that would pass the budget is left out; an older one that fits still reaches the plan.
    expect(selectCorrections(withRoom, candidate).map((row) => row._id)).toEqual([
      'newest',
      'second',
      'short',
    ]);
  });
});

describe('what a correction is on the prompt', (): void => {
  it('names its id, where it came from, when, and the text', (): void => {
    const entry = correctionEntry(correction({ _id: 'c1', createdAt: Date.UTC(2026, 8, 18, 7, 40) }));
    expect(entry).toEqual({
      id: 'c1',
      from: 'Retry note on "Exception: SH-4471 held at customs"',
      when: '2026-09-18T07:40Z',
      text: 'Use the Delay notice B template and follow up in 48 hours.',
    });
  });

  it('puts the list under its heading with the rule that feedback revises and never overrides', (): void => {
    const entries = [correctionEntry(correction({ _id: 'c1' }))];
    const lines = plannerCorrectionLines(entries);
    expect(lines).toContain(CORRECTIONS_HEADING);
    const text = lines.join('\n');
    expect(text).toContain('apply those that fit this candidate');
    expect(text).toContain('none overrides the charter, an approval requirement, a grant or the exact-action gate');
    expect(text).toContain('`appliedCorrections`');
    expect(text).toContain(JSON.stringify(entries));
    expect(plannerCorrectionLines([])).toEqual([]);
  });

  it('gives the executor the corrections the approved plan applied, as directions and not evidence', (): void => {
    const entries = [correctionEntry(correction({ _id: 'c1' }))];
    const text = executorCorrectionLines(entries).join('\n');
    expect(text).toContain('none overrides the charter, an approval requirement, a grant or the exact-action gate');
    expect(text).toContain('not evidence');
    expect(text).toContain(JSON.stringify(entries));
    expect(executorCorrectionLines([])).toEqual([]);
  });
});

describe('the corrections a plan says it applied', (): void => {
  it('keeps only ids the planner was offered, once each, in the order given', (): void => {
    const offered = [correctionEntry(correction({ _id: 'c1' })), correctionEntry(correction({ _id: 'c2' }))];
    expect(appliedCorrectionIds(['c2', 'forged', 'c2', 'c1'], offered)).toEqual(['c2', 'c1']);
    expect(appliedCorrectionIds(null, offered)).toEqual([]);
    expect(appliedCorrectionIds(['c1'], [])).toEqual([]);
  });
});

describe('the surfaces a correction is kept against', (): void => {
  it('is the item\'s own source surface and every surface its plan declared it reads or writes', (): void => {
    expect(correctionSurfaces('Linear', undefined)).toEqual(['linear']);
    expect(
      correctionSurfaces('Linear', {
        obligations: {
          steps: [
            { kind: 'read', reads: ['looker-pipeline-tile'], writes: [] },
            { kind: 'write', reads: [], writes: ['slack', 'linear'] },
          ],
          transition: 'none',
          transitionStep: null,
          basis: 'planner',
        },
      }),
    ).toEqual(['linear', 'looker-pipeline-tile', 'slack']);
  });
});

describe('the scrub at prompt assembly', (): void => {
  it('removes a stored value and a credential shape from the text and the title, and says the model was not consulted', async (): Promise<void> => {
    const row = correction({
      _id: 'c1',
      text: 'Use portal password hunter2 and token xoxb-1234567890-abcdefghij for the carrier.',
      itemTitle: 'Exception: SH-4471 (portal hunter2)',
    });
    const scrubbed = await scrubbedCorrectionEntries([row], { known: ['hunter2'] });
    expect(scrubbed.redaction).toBe('structural-only');
    expect(scrubbed.entries[0]?.text).not.toContain('hunter2');
    expect(scrubbed.entries[0]?.text).not.toContain('xoxb-1234567890-abcdefghij');
    expect(scrubbed.entries[0]?.from).not.toContain('hunter2');
    expect(row.text).toContain('hunter2');
  });

  it('consults the span model when one is configured', async (): Promise<void> => {
    const scrubbed = await scrubbedCorrectionEntries(
      [correction({ _id: 'c1', text: 'The carrier portal password is Tr0ub4dor&3, ask Priya.' })],
      { model: new RecordedSpanModel() },
    );
    expect(scrubbed.redaction).toBeUndefined();
    expect(scrubbed.entries[0]?.text).not.toContain('Tr0ub4dor&3');
    expect(scrubbed.entries[0]?.text).toContain('Priya');
  });
});
