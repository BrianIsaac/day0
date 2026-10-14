import { describe, expect, it } from 'vitest';
import { planRestsOn, planRestsOnAny } from '@/agent/reorientation-moved';

/*
 * The narrow test (wave 18, 18-O; D-2 (b), O-1 (a)): a plan an Approve's change reaches by its
 * cites, the people it names or its own words is drafted again; the rest are asked again; where
 * the test cannot tell, the plan is drafted again.
 */

/** Bed 1's plan (`wave17-review-2026-10-14-bed/kit1/seed.py`). */
const BED_ONE_PLAN = {
  summary: 'Review the close ticket within the window the policy sets.',
  steps: ['Read the review window.', 'Review the ticket.', 'Post the review note.'],
  riskNotes: '',
};

/** Bed 1's edge, as Priya's Approve widened it. */
const INES = {
  kind: 'edge' as const,
  person: 'Ines Duarte',
  scopes: ['NetLedger journal changes', 'NetLedger journal changes and REVOPS close plans'],
};

describe('planRestsOn', (): void => {
  it('does not find bed 1’s plan resting on the widened approver, which it never names', (): void => {
    expect(planRestsOn({ plan: BED_ONE_PLAN }, INES)).toBe(false);
  });

  it('finds a plan that names the person, or every word of one phrase of the scope', (): void => {
    expect(
      planRestsOn({ plan: { ...BED_ONE_PLAN, riskNotes: 'Ines Duarte signs off.' } }, INES),
    ).toBe(true);
    expect(
      planRestsOn({ plan: { ...BED_ONE_PLAN, summary: 'Check the REVOPS close plans.' } }, INES),
    ).toBe(true);
    // One word of a phrase is not the phrase: "close" alone is in bed 1's plan.
    expect(planRestsOn({ plan: { ...BED_ONE_PLAN, summary: 'Close the plans.' } }, INES)).toBe(
      false,
    );
  });

  it('reads a clause by half its content words, two at least', (): void => {
    const clause = {
      kind: 'clauses' as const,
      texts: ['Reply to a tier-2 ask without the manager'],
    };
    expect(planRestsOn({ plan: { summary: 'Reply.', steps: ['Reply'] } }, clause)).toBe(false);
    expect(
      planRestsOn({ plan: { summary: 'Reply to the tier-2 ask.', steps: ['Reply'] } }, clause),
    ).toBe(true);
  });

  it('finds a plan that cites the page, or names its title', (): void => {
    const page = {
      kind: 'page' as const,
      sourceId: 'source-1',
      ref: 'policies/close-review-window.md',
      title: 'Close review window',
    };
    const citing = {
      ...BED_ONE_PLAN,
      summary: 'Do it.',
      steps: ['Do it.'],
      cites: [{ sourceId: 'source-1', pageRef: 'policies/close-review-window.md' }],
    };
    expect(planRestsOn({ plan: citing }, page)).toBe(true);
    expect(planRestsOn({ plan: BED_ONE_PLAN }, page)).toBe(true);
    expect(planRestsOn({ plan: { summary: 'Post a note.', steps: ['Post'] } }, page)).toBe(false);
  });

  it('finds a plan by the system an access is for, and every plan that declares no reads and writes', (): void => {
    const slack = { kind: 'access' as const, system: 'slack' };
    const declared = (surface: string) => ({
      summary: 'Post the note.',
      steps: ['Post the note.'],
      obligations: {
        steps: [{ reads: [], writes: [surface], kind: 'write' }],
        transition: 'none',
        transitionStep: null,
        basis: 'planner',
      },
    });
    expect(planRestsOn({ plan: declared('linear'), sourceSystem: 'linear' }, slack)).toBe(false);
    expect(planRestsOn({ plan: declared('slack'), sourceSystem: 'linear' }, slack)).toBe(true);
    expect(planRestsOn({ plan: BED_ONE_PLAN, sourceSystem: 'slack' }, slack)).toBe(true);
    expect(planRestsOn({ plan: BED_ONE_PLAN, sourceSystem: 'linear' }, slack)).toBe(true);
  });

  it('finds a plan by the skill it runs, or the skill’s name in its words', (): void => {
    const skill = { kind: 'skill' as const, skillId: 'skill-1', name: 'kanban-comment-and-close' };
    expect(planRestsOn({ plan: BED_ONE_PLAN, skillId: 'skill-1' }, skill)).toBe(true);
    expect(planRestsOn({ plan: BED_ONE_PLAN, skillId: 'skill-2' }, skill)).toBe(false);
    expect(
      planRestsOn({ plan: { summary: 'Kanban comment, then close.', steps: ['Go'] } }, skill),
    ).toBe(true);
  });

  it('drafts again where it cannot tell: a change it does not read, or a plan with no words', (): void => {
    expect(planRestsOn({ plan: BED_ONE_PLAN }, { kind: 'everything' })).toBe(true);
    expect(planRestsOn({}, INES)).toBe(true);
    expect(planRestsOn({ plan: { summary: '', steps: [] } }, INES)).toBe(true);
  });
});

describe('planRestsOnAny', (): void => {
  it('finds a plan resting on any one change, and none on no change', (): void => {
    expect(planRestsOnAny({ plan: BED_ONE_PLAN }, [])).toBe(false);
    expect(planRestsOnAny({ plan: BED_ONE_PLAN }, [INES, { kind: 'everything' }])).toBe(true);
  });
});
