import { describe, expect, it } from 'vitest';
import {
  documentStrikes,
  goalIsGap,
  systemsLine,
} from '../../../../../app/agent/[agentId]/charter/charter-document';
import { strikeRefusalBody } from '../../../../fixtures/charter-strike-refusal-2026-09-15';

describe('the charter document', (): void => {
  it('draws a checkpoint the manager named nothing for as a gap, and a goal as a goal', (): void => {
    expect(goalIsGap('No day-60 milestone was stated. Tier-2 triage and drafting continue.')).toBe(
      true,
    );
    expect(goalIsGap('No milestone given.')).toBe(true);
    expect(goalIsGap('  ')).toBe(true);
    expect(goalIsGap('TBD')).toBe(true);
    expect(goalIsGap('Cover close-week tracker maintenance in the Q4 Revenue Tracker.')).toBe(
      false,
    );
    expect(goalIsGap('No backlog older than a week.')).toBe(false);
  });

  it('names each system once, with its kind, on one line', (): void => {
    expect(
      systemsLine([
        { name: 'Salesforce', class: 'crm' },
        { name: 'Linear', class: 'kanban' },
      ]),
    ).toBe('Salesforce (crm), Linear (kanban)');
  });

  it("shows a draft's strikes as approval will apply them, and the record's as approval kept them", (): void => {
    const drafted = strikeRefusalBody(false);
    expect(documentStrikes(drafted, false)).toEqual({ pending: true, changes: [] });

    const struck = strikeRefusalBody(false);
    struck.constraints![0] = { ...struck.constraints![0]!, struck: true };
    const pending = documentStrikes(struck, false);
    expect(pending.pending).toBe(true);
    expect(pending.changes.length).toBeGreaterThan(0);
    expect(pending.changes.every((change) => change.text !== '')).toBe(true);

    const kept = [{ field: 'willNotDo' as const, text: 'Edit Salesforce records.' }];
    expect(documentStrikes({ ...drafted, struckClauses: kept }, true)).toEqual({
      pending: false,
      changes: kept,
    });
    expect(documentStrikes(drafted, true)).toEqual({ pending: false, changes: [] });
  });
});
