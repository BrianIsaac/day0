/** @vitest-environment jsdom */

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
import { AgentZoneContext } from '../../../../app/agent/[agentId]/time';
import { act } from 'react';
import {
  button,
  focusedName,
  mount,
  press,
  said,
  settle,
  typeInto,
} from '../../../fixtures/dom/press';
import { cancelPlanRequest } from '../../../../app/agent/[agentId]/work/WorkQueue';
import { ManagerFeedbackNote } from '../../../../app/agent/[agentId]/work/RunDetails';
import { PlanApprovalForm } from '../../../../app/agent/[agentId]/work/PlanApproval';
import { WorkItemCard } from '../../../../app/agent/[agentId]/work/WorkItemCard';

/**
 * A kept correction on the employee's dashboard, and the line on a later
 * plan card that says it was applied: the manager sees the note from item
 * one taking effect on item two.
 */

const NOTE =
  'Use the Delay notice B template for customs holds and follow up with the carrier in 48 hours.';
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
      <KeptCorrectionsPanel
        corrections={[{ ...kept, appliedTo: [] }]}
        titles={titles}
        onRetire={resolved}
      />,
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
    const markup = renderToStaticMarkup(
      <KeptCorrectionsPanel corrections={[]} titles={titles} onRetire={resolved} />,
    );
    expect(markup).toContain('No corrections kept yet');
    expect(keptCorrectionsTitle([])).toBe('Kept corrections');
  });

  it('counts the corrections still fed back in its title', (): void => {
    expect(
      keptCorrectionsTitle([kept, { ...kept, _id: 'c2' as Id<'corrections'>, retiredAt: 5 }]),
    ).toBe('Kept corrections · 1 active');
  });
});

describe('the plan card line for an applied correction', (): void => {
  it('names the item the correction came from, when, and quotes it', (): void => {
    const markup = renderToStaticMarkup(
      <AppliedCorrectionsLine
        ids={['c1']}
        corrections={[kept]}
        workItemId={'w2' as Id<'workItems'>}
      />,
    );
    expect(markup.replace(/<[^>]+>/g, '')).toMatch(
      /Applies the manager&#x27;s correction from Exception: SH-4471 held at customs \(\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}\): ‘Use the Delay notice B template/,
    );
  });

  it("says so when the correction came from the same item's earlier plan", (): void => {
    const markup = renderToStaticMarkup(
      <AppliedCorrectionsLine
        ids={['c1']}
        corrections={[{ ...kept, kind: 'plan-rejection' }]}
        workItemId={'w1' as Id<'workItems'>}
      />,
    );
    expect(markup).toContain(
      'Applies the manager&#x27;s correction from this item&#x27;s earlier plan',
    );
  });

  it('renders nothing for a plan that applied none, or for an id it cannot resolve', (): void => {
    expect(
      renderToStaticMarkup(
        <AppliedCorrectionsLine
          ids={[]}
          corrections={[kept]}
          workItemId={'w2' as Id<'workItems'>}
        />,
      ),
    ).toBe('');
    expect(
      renderToStaticMarkup(
        <AppliedCorrectionsLine
          ids={['gone']}
          corrections={[kept]}
          workItemId={'w2' as Id<'workItems'>}
        />,
      ),
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
    expect(markup).toContain(
      'Applies the manager&#x27;s correction from Exception: SH-4471 held at customs',
    );
    expect(markup).toContain(NOTE.slice(0, 40));
  });
});

describe('cancelling a plan with a reason, and retrying it', (): void => {
  it("gives the plan card's cancel a reason field, and sends the reason only when one is written", async (): Promise<void> => {
    const cancelled: string[] = [];
    const view = mount(
      <PlanApprovalForm
        riskNotes=""
        questions={[]}
        onApprove={noop}
        onCancel={(reason) => cancelled.push(reason)}
      />,
    );
    // Cancel opens the reason; the field is named by its visible label, which an aria-label would override.
    expect(view.container.textContent).not.toContain('Reason for cancelling');
    await press(view.container, 'Cancel this item');
    const field = [...view.container.querySelectorAll('label')].find(
      (label) => label.textContent === 'Reason for cancelling (optional)',
    )?.control as HTMLInputElement | null;
    if (!field) throw new Error('the reason field has no visible label');
    expect(field.getAttribute('aria-label')).toBeNull();
    typeInto(field, 'Comment instead.');
    await press(view.container, 'Cancel with this reason');
    expect(cancelled).toEqual(['Comment instead.']);
    view.unmount();
    const workItemId = 'w5' as Id<'workItems'>;
    expect(cancelPlanRequest(workItemId, 'Comment instead.')).toEqual({
      workItemId,
      reason: 'Comment instead.',
    });
    expect(cancelPlanRequest(workItemId, '   ')).toEqual({ workItemId });
  });

  it('offers Retry on a cancelled plan, saying a new plan comes back to the manager', (): void => {
    const item = {
      _id: 'w5',
      _creationTime: 1,
      agentId: 'a1',
      state: 'cancelled',
      title: 'Exception: SH-4533 missed the vessel',
      contentSummary: 'Notify the customer of the new sailing.',
      sourceSystem: 'linear',
      sourceCategory: 'ticket-queue',
      externalId: 'LOG-5',
      observedAt: 1,
      contentRefs: [],
      skipReason: 'plan cancelled by the manager: comment on the ticket instead',
      managerFeedback: { reason: 'Comment on the ticket instead.', at: 2, kind: 'plan-rejection' },
      plan: {
        summary: 'Email the customer the new sailing directly.',
        steps: ['Email the customer.'],
        riskNotes: '',
        reversibility: 'reversible',
        estimatedMinutes: 2,
        expectedOutputType: 'message',
      },
    } as unknown as Doc<'workItems'>;
    const markup = renderToStaticMarkup(
      <WorkItemCard
        item={item}
        surfaces={[]}
        autonomousActions={false}
        onApprovePlan={noop}
        onCancelPlan={noop}
        onRetryFailed={noop}
        onReconcileFailed={resolved}
        onApproveActions={resolved}
        onRejectActions={resolved}
        onResendDecision={resolved}
      />,
    );
    expect(markup).toContain('>Retry<');
    expect(markup).toContain('the plan comes back to you before anything runs');
    expect(markup).not.toContain('even while autonomous actions are on');
    expect(markup).toMatch(/<label for="[^"]+"[^>]*>Note for the new plan \(optional\)<\/label>/);
    expect(markup).not.toContain('aria-label="note for the retry"');
    expect(markup).toContain('Plan cancel reason');
  });

  it('shows that a rejected plan redraft waits for approval with autonomy on', (): void => {
    const item = {
      _id: 'w5',
      _creationTime: 1,
      agentId: 'a1',
      state: 'plan-pending',
      title: 'Exception: SH-4533 missed the vessel',
      contentSummary: 'Notify the customer of the new sailing.',
      sourceSystem: 'linear',
      sourceCategory: 'ticket-queue',
      externalId: 'LOG-5',
      observedAt: 1,
      contentRefs: [],
      planRejectedAt: 2,
      plan: {
        summary: 'Comment on the ticket instead.',
        steps: ['Comment on the ticket.'],
        riskNotes: '',
        reversibility: 'reversible',
        estimatedMinutes: 2,
        expectedOutputType: 'message',
      },
    } as unknown as Doc<'workItems'>;
    const markup = renderToStaticMarkup(
      <WorkItemCard
        item={item}
        surfaces={[]}
        autonomousActions={true}
        onApprovePlan={noop}
        onCancelPlan={noop}
        onRetryFailed={noop}
        onReconcileFailed={resolved}
        onApproveActions={resolved}
        onRejectActions={resolved}
        onResendDecision={resolved}
      />,
    );
    expect(markup).toContain('It waits for your approval even while autonomous actions are on.');
    expect(markup).toContain('>Approve plan<');
  });

  it('labels a plan rejection reason as its own kind of feedback', (): void => {
    const markup = renderToStaticMarkup(
      <ManagerFeedbackNote
        feedback={{ reason: 'Comment on the ticket instead.', at: 2, kind: 'plan-rejection' }}
      />,
    );
    expect(markup).toContain('Plan cancel reason');
  });
});

describe("the corrections' stamps (N12)", (): void => {
  it("print the agent's day on the kept list and on the plan line", (): void => {
    const at = Date.UTC(2026, 8, 27, 16, 5, 9);
    const correction: KeptCorrection = { ...kept, createdAt: at };
    const panel = renderToStaticMarkup(
      <AgentZoneContext value="Asia/Singapore">
        <KeptCorrectionsPanel corrections={[correction]} titles={new Map()} onRetire={resolved} />
      </AgentZoneContext>,
    );
    expect(panel).toContain('28 Sep 2026, 00:05');
    const line = renderToStaticMarkup(
      <AgentZoneContext value="Asia/Singapore">
        <AppliedCorrectionsLine
          ids={[correction._id]}
          corrections={[correction]}
          workItemId={'w2' as Id<'workItems'>}
        />
      </AgentZoneContext>,
    );
    expect(line).toContain('28 Sep 2026, 00:05');
    expect(line).not.toContain('27 Sep 2026, 16:05');
  });
});

describe('retiring a kept correction (step 45)', (): void => {
  it('says the retirement in a live region and gives focus to the list when Retire leaves the row', async (): Promise<void> => {
    const retired: string[] = [];
    const panel = (rows: readonly KeptCorrection[]) => (
      <KeptCorrectionsPanel
        corrections={rows}
        titles={new Map()}
        onRetire={async (id) => {
          retired.push(id);
        }}
      />
    );
    const view = mount(panel([kept]));
    const name = `Retire the correction from “${kept.itemTitle}”`;
    expect(button(view.container, name).className).toMatch(/\bmin-h-11\b/);
    const retire = button(view.container, name);
    retire.focus();
    await act(async (): Promise<void> => {
      retire.click();
      // The query answers with the row retired, and Retire leaves it.
      view.root.render(panel([{ ...kept, retiredAt: 5 }]));
    });
    await settle();

    expect(retired).toEqual(['c1']);
    expect(said(view.container)).toEqual([
      `Retired the correction from “${kept.itemTitle}”: no later plan reads it.`,
    ]);
    expect(focusedName()).toBe('Kept corrections');
    view.unmount();
  });

  it('says a refused retirement and keeps focus on Retire', async (): Promise<void> => {
    const view = mount(
      <KeptCorrectionsPanel
        corrections={[kept]}
        titles={new Map()}
        onRetire={async () => {
          throw new Error(
            '[CONVEX M(corrections:retire)] [Request ID: 1] Server Error\nUncaught Error: That correction is already retired.\n    at handler (../convex/corrections.ts:1:1)',
          );
        }}
      />,
    );
    await press(view.container, `Retire the correction from “${kept.itemTitle}”`);
    expect(said(view.container)).toEqual(['That correction is already retired.']);
    expect(focusedName()).toBe(`Retire the correction from “${kept.itemTitle}”`);
    view.unmount();
  });
});
