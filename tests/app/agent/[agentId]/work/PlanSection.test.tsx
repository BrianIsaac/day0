import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Doc } from '../../../../../convex/_generated/dataModel';
import { type ItemPlan, PlanSection } from '../../../../../app/agent/[agentId]/work/PlanSection';
import { DRAWN, PLAN, SLACK } from '../../../../fixtures/work/drawn-states';

function section(item: Doc<'workItems'>, plan: ItemPlan = PLAN): string {
  return renderToStaticMarkup(
    <PlanSection item={item} plan={plan} surfaces={[SLACK]} corrections={[]} />,
  );
}

describe("a work item's plan", (): void => {
  it('heads the plan with its estimate and reversibility, then the summary and the numbered steps', (): void => {
    const markup = section(DRAWN.planPending);
    expect(markup).toContain('>Plan · about 10 minutes · reversible</h4>');
    expect(markup).toContain(PLAN.summary);
    expect(markup.match(/<li>/g)).toHaveLength(PLAN.steps.length);
    expect(section(DRAWN.planPending, { ...PLAN, estimatedMinutes: 1 })).toContain(
      'about 1 minute ·',
    );
  });

  it('writes in the answers given at approval once the plan runs, and says which went into the charter', (): void => {
    const markup = section(DRAWN.working);
    expect(markup).toContain('Answered at approval');
    expect(markup).toContain('Ad-hoc asks and anything about the on-call rota.');
    expect(markup).toContain('Your answers to the charter&#x27;s questions were written into it.');
    const noteOnly = {
      ...DRAWN.working,
      managerAnswers: [{ question: 'The planner asked.', answer: 'Yes.', answeredAt: 1 }],
    } as Doc<'workItems'>;
    expect(section(noteOnly)).not.toContain('written into it');
    expect(section(DRAWN.planPending)).not.toContain('Answered at approval');
  });

  it('says a pending plan was drafted without its ticket, naming the system', (): void => {
    const drafted = {
      ...DRAWN.planPending,
      planDraftedWithout: { surfaceSlug: 'slack', subject: 'the thread', cause: 'unreachable' },
    } as unknown as Doc<'workItems'>;
    expect(section(drafted)).toContain('Slack');
  });
});
