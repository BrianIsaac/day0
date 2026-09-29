import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../../../convex/_generated/dataModel';
import { EarlierPlan } from '../../../../../app/agent/[agentId]/work/EarlierPlan';

const backend = vi.hoisted(() => ({ queries: {} as Record<string, unknown> }));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown): unknown => backend.queries[getFunctionName(reference as never)],
}));

afterEach((): void => {
  backend.queries = {};
});

const render = (): string =>
  renderToStaticMarkup(
    <EarlierPlan workItemId={'w1' as Id<'workItems'>} employeeName="Mira" zone="Asia/Singapore" />,
  );

describe('the plan a redraft replaced', (): void => {
  it('shows when it was drafted, its summary and its steps', (): void => {
    backend.queries['work:earlierPlan'] = {
      summary: 'Email the customer.',
      steps: ['Draft the email.', 'Send it.'],
      draftedAt: Date.UTC(2026, 8, 29, 6, 38),
    };
    const markup = render();
    expect(markup).toContain('Drafted at <time');
    expect(markup).toContain('29 Sep 2026, 14:38</time> and cancelled by you.');
    expect(markup).toContain('Email the customer.');
    expect(markup.match(/<li>/g)).toHaveLength(2);
  });

  it('says it is reading, and says so when the plan is past the read', (): void => {
    expect(render()).toContain('Reading the earlier plan…');
    backend.queries['work:earlierPlan'] = null;
    expect(render()).toContain('The earlier plan is not among Mira&#x27;s newest drafts.');
  });
});
