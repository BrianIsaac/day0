import { describe, expect, it } from 'vitest';
import {
  firstNeededSentence,
  needsSkillReason,
  rationaleBesideItem,
} from '../../../src/work/skill-rationale';

describe('a needs-skill reason beside the skill the card names', (): void => {
  it('says the cause as one sentence, the proposal clause taken out, a row from before N29 included', (): void => {
    for (const reason of [
      'no registered skill covers ticket update on a kanban surface; proposing the skill "linear-update-issue" for your approval',
      'no registered skill covers ticket update on a kanban surface; agent will propose "linear-update-issue"',
    ]) {
      expect(needsSkillReason(reason)).toBe(
        'No registered skill covers ticket update on a kanban surface.',
      );
    }
    expect(needsSkillReason('Needed for the close.')).toBe('Needed for the close.');
  });
});

describe('a proposed skill rationale beside the item that first needed it', (): void => {
  it('takes out the item the page already names, and keeps what the skill is', (): void => {
    const rationale = `No registered skill covers a threaded reply on a chat surface. ${firstNeededSentence('Draft response for new tier-two RevOps ask', 'slack')}`;
    expect(rationaleBesideItem(rationale)).toBe(
      "No registered skill covers a threaded reply on a chat surface. The skill is a reusable procedure for every later work item of this shape, taking each run's values from that item and its runbook.",
    );
  });

  it('leaves a rationale in any other words as it is', (): void => {
    expect(rationaleBesideItem('Needed for the weekly close.')).toBe(
      'Needed for the weekly close.',
    );
  });
});
