import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('convex/react', () => ({
  useQuery: (): undefined => undefined,
  useMutation: (): (() => Promise<void>) => async (): Promise<void> => undefined,
  useAction: (): (() => Promise<void>) => async (): Promise<void> => undefined,
}));

import type { Doc, Id } from '../../../../convex/_generated/dataModel';
import {
  AppliedCorrectionsLine,
  KeptCorrectionsPanel,
  keptCorrectionsTitle,
  type KeptCorrection,
} from '../../../../app/agent/[agentId]/corrections-panel';
import { ManagerFeedbackNote, WorkItemCard } from '../../../../app/agent/[agentId]/AgentDashboard';

/**
 * A kept correction on the employee's dashboard, and the line on a later
 * plan card that says it was applied: the manager sees the note from item
 * one taking effect on item two.
 */

const NOTE = 'Use the Delay notice B template for customs holds and follow up with the carrier in 48 hours.';
const noop = (): void => undefined;
const resolved = async (): Promise<void> => undefined;

const kept: KeptCorrection = {
  _id: 'c1' as Id<'corrections'>,
  workItemId: 'w1' as Id<'workItems'>,
  kind: 'retry-note',
  text: NOTE,
  itemTitle: 'Exception: SH-4471 held at customs',
  createdAt: Date.UTC(2026, 8, 18, 7, 40),
  appliedTo: ['w2' as Id<'workItems'>],
};

const titles = new Map<string, string>([
  ['w1', 'Exception: SH-4471 held at customs'],
  ['w2', 'Exception: SH-4502 held at customs'],
]);

describe('the kept corrections panel', (): void => {
  it('shows each correction, where it came from, when, and the later items it was applied to', (): void => {
    const markup = renderToStaticMarkup(
      <KeptCorrectionsPanel corrections={[kept]} titles={titles} onRetire={resolved} />,
    );
    expect(markup).toContain(NOTE);
    expect(markup).toContain('Retry note');
    expect(markup).toContain('from “Exception: SH-4471 held at customs”');
    expect(markup).toContain('applied to “Exception: SH-4502 held at customs”');
    expect(markup).toContain('>Retire<');
  });

  it('says a correction not yet applied is waiting for later work of its kind', (): void => {
    const markup = renderToStaticMarkup(
      <KeptCorrectionsPanel corrections={[{ ...kept, appliedTo: [] }]} titles={titles} onRetire={resolved} />,
    );
    expect(markup).toContain('not applied yet');
  });

  it('shows a retired correction as retired, with nothing left to retire', (): void => {
    const markup = renderToStaticMarkup(
      <KeptCorrectionsPanel
        corrections={[{ ...kept, appliedTo: [], retiredAt: kept.createdAt + 60_000 }]}
        titles={titles}
        onRetire={resolved}
      />,
    );
    expect(markup).toContain('retired');
    expect(markup).toContain('never applied');
    expect(markup).not.toContain('it reaches the next plan');
    expect(markup).not.toContain('>Retire<');
  });

  it('explains what it will hold before anything is kept', (): void => {
    const markup = renderToStaticMarkup(<KeptCorrectionsPanel corrections={[]} titles={titles} onRetire={resolved} />);
    expect(markup).toContain('No corrections kept yet');
    expect(keptCorrectionsTitle([])).toBe('Kept corrections');
  });

  it('counts the corrections still fed back in its title', (): void => {
    expect(keptCorrectionsTitle([kept, { ...kept, _id: 'c2' as Id<'corrections'>, retiredAt: 5 }])).toBe(
      'Kept corrections · 1 active',
    );
  });
});

describe('the plan card line for an applied correction', (): void => {
  it('names the item the correction came from, when, and quotes it', (): void => {
    const markup = renderToStaticMarkup(
      <AppliedCorrectionsLine ids={['c1']} corrections={[kept]} workItemId={'w2' as Id<'workItems'>} />,
    );
    expect(markup.replace(/<[^>]+>/g, '')).toMatch(
      /Applies the manager&#x27;s correction from Exception: SH-4471 held at customs \(\d{2}:\d{2}[^)]*\): ‘Use the Delay notice B template/,
    );
  });

  it('says so when the correction came from the same item\'s earlier plan', (): void => {
    const markup = renderToStaticMarkup(
      <AppliedCorrectionsLine
        ids={['c1']}
        corrections={[{ ...kept, kind: 'plan-rejection' }]}
        workItemId={'w1' as Id<'workItems'>}
      />,
    );
    expect(markup).toContain('Applies the manager&#x27;s correction from this item&#x27;s earlier plan');
  });

  it('renders nothing for a plan that applied none, or for an id it cannot resolve', (): void => {
    expect(
      renderToStaticMarkup(<AppliedCorrectionsLine ids={[]} corrections={[kept]} workItemId={'w2' as Id<'workItems'>} />),
    ).toBe('');
    expect(
      renderToStaticMarkup(<AppliedCorrectionsLine ids={['gone']} corrections={[kept]} workItemId={'w2' as Id<'workItems'>} />),
    ).toBe('');
  });

  it('shows on the plan card of the item the plan applied it to', (): void => {
    const item = {
      _id: 'w2',
      _creationTime: 1,
      agentId: 'a1',
      state: 'plan-pending',
      title: 'Exception: SH-4502 held at customs',
      contentSummary: 'Notify the customer.',
      sourceSystem: 'linear',
      sourceCategory: 'ticket-queue',
      externalId: 'LOG-2',
      observedAt: 1,
      contentRefs: [],
      plan: {
        summary: 'Send the customs-hold notice.',
        steps: ['Comment the notice.'],
        riskNotes: '',
        reversibility: 'reversible',
        estimatedMinutes: 2,
        expectedOutputType: 'ticket-update',
        appliedCorrections: ['c1'],
      },
    } as unknown as Doc<'workItems'>;
    const markup = renderToStaticMarkup(
      <WorkItemCard
        item={item}
        surfaces={[]}
        autonomousActions={false}
        corrections={[kept]}
        onApprovePlan={noop}
        onCancelPlan={noop}
        onRetryFailed={noop}
        onReconcileFailed={resolved}
        onApproveActions={resolved}
        onRejectActions={resolved}
        onResendDecision={resolved}
      />,
    );
    expect(markup).toContain('Applies the manager&#x27;s correction from Exception: SH-4471 held at customs');
    expect(markup).toContain(NOTE.slice(0, 40));
  });
});

describe('the manager feedback note', (): void => {
  it('labels a plan rejection reason as its own kind of feedback', (): void => {
    const markup = renderToStaticMarkup(
      <ManagerFeedbackNote feedback={{ reason: 'Comment on the ticket instead.', at: 2, kind: 'plan-rejection' }} />,
    );
    expect(markup).toContain('Plan rejection reason');
  });
});
