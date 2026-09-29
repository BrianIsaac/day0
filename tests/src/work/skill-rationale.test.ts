import { describe, expect, it } from 'vitest';
import { firstNeededSentence, rationaleBesideItem } from '../../../src/work/skill-rationale';

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
