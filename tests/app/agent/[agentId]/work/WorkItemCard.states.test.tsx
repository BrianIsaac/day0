/** @vitest-environment jsdom */

import { act } from 'react';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Doc } from '../../../../../convex/_generated/dataModel';
import { WorkItemCard } from '../../../../../app/agent/[agentId]/work/WorkItemCard';
import { AgentZoneContext } from '../../../../../app/agent/[agentId]/time';
import { button, focusedName, mount, press, said, typeInto } from '../../../../fixtures/dom/press';
import { DRAWN, EMPLOYEE, QUESTION, SLACK, ZONE } from '../../../../fixtures/work/drawn-states';

const backend = vi.hoisted(() => ({
  /** What a query answers, by function name; undefined (loading) otherwise. */
  queries: {} as Record<string, unknown>,
}));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown): unknown => backend.queries[getFunctionName(reference as never)],
  useMutation: (): (() => Promise<void>) => async (): Promise<void> => undefined,
  useAction: (): (() => Promise<void>) => async (): Promise<void> => undefined,
}));

afterEach((): void => {
  backend.queries = {};
  document.body.replaceChildren();
});

/**
 * The card for one drawn state, in the employee's zone, with every decision recorded by name.
 * `refuse` names a decision that is refused with the sentence given.
 */
function card(
  item: Doc<'workItems'>,
  options: { questions?: Doc<'managerQuestions'>[]; autonomous?: boolean; loop?: boolean } = {},
) {
  const calls: Array<[string, unknown]> = [];
  const record =
    (name: string) =>
    async (arg?: unknown): Promise<void> => {
      calls.push([name, arg]);
    };
  const view = mount(
    <AgentZoneContext value={ZONE}>
      <WorkItemCard
        item={item}
        surfaces={[SLACK]}
        autonomousActions={options.autonomous ?? false}
        employeeName={EMPLOYEE}
        questions={options.questions ?? []}
        onApprovePlan={record('approvePlan')}
        onCancelPlan={record('cancelPlan')}
        onRetryFailed={record('retry')}
        onReconcileFailed={record('reconcile')}
        onApproveActions={record('approveActions')}
        onRejectActions={record('rejectActions')}
        onResendDecision={record('resend')}
        onDismiss={record('dismiss')}
        servedByLoop={options.loop ?? false}
      />
    </AgentZoneContext>,
  );
  const text = (): string => view.container.textContent ?? '';
  return { ...view, calls, text };
}

/** The field a visible label names. */
function field(scope: ParentNode, label: string): HTMLInputElement {
  const control = [...scope.querySelectorAll('label')].find(
    (candidate) => candidate.textContent === label,
  )?.control as HTMLInputElement | null;
  if (!control) throw new Error(`no field labelled "${label}"`);
  return control;
}

/** The card's state chip, as the manager reads it. */
function chip(scope: ParentNode): string {
  return scope.querySelector('article > div span span')?.textContent ?? '';
}

describe('discovered, then skipped (work-discovered.html)', (): void => {
  it('cites the clause, says scope and skill are judged apart, and hands the work back on one press', async (): Promise<void> => {
    const view = card(DRAWN.discovered);
    expect(chip(view.container)).toBe('Skipped');
    expect(view.text()).toContain('linear · ticket-queue · low');
    expect(view.text()).toContain('Aman, on REVOPS-30: Please refresh the Q4 pipeline coverage');
    expect(view.text()).toContain(
      'Skipped. This is forecasting work assigned to Aman, which the charter says Mira will not own (“Own forecasting work assigned to Aman.”).',
    );
    expect(view.text()).toContain(
      "Whether this work is within Mira's charter is judged separately from whether Mira has a skill for it.",
    );
    expect(view.text()).toContain(
      "Take it anyway is your decision that this work is Mira's to do: it is evaluated again as in scope, and its plan still waits for your approval.",
    );
    await press(view.container, 'Take it anyway');
    expect(view.calls).toEqual([['retry', '']]);
    expect(said(view.container)).toEqual([
      'Taken: Refresh pipeline coverage view for quarterly forecasting goes back to be evaluated.',
    ]);
    expect(focusedName()).toBe('Take it anyway');
  });
});

describe('plan to approve (work-plan-pending.html)', (): void => {
  it("asks the charter's question with its answer box, carries the planner's note and the minutes, and approves with them", async (): Promise<void> => {
    const view = card(DRAWN.planPending, { questions: [QUESTION] });
    expect(chip(view.container)).toBe('Plan to approve');
    expect(view.text()).toContain('Plan · about 10 minutes · reversible');
    expect(view.container.querySelectorAll('ol.list-decimal > li')).toHaveLength(4);
    expect(view.text()).toContain('A question from your charter');
    expect(view.text()).toContain('Mira does not ask again');
    expect(view.text()).toContain("Planner's note");
    expect(view.text()).toContain(
      'Approving runs the plan. Every write it produces is still held for you.',
    );
    typeInto(
      view.container.querySelector<HTMLInputElement>(
        `input[aria-label="answer: ${QUESTION.question}"]`,
      )!,
      'Ad-hoc asks and the on-call rota.',
    );
    typeInto(field(view.container, 'This would have taken me about'), '25');
    await press(view.container, 'Approve plan with answers');
    expect(view.calls).toEqual([
      [
        'approvePlan',
        {
          answers: [{ questionId: QUESTION._id, text: 'Ad-hoc asks and the on-call rota.' }],
          manualEstimateMinutes: 25,
        },
      ],
    ]);
    expect(said(view.container)).toEqual([
      'Plan approved: Draft response for new tier-two RevOps ask.',
    ]);
    expect(focusedName()).toBe('Approve plan with answers');
  });

  it('cancels with a reason, the field opened by Cancel and focused, the reason kept with the item', async (): Promise<void> => {
    const view = card(DRAWN.planPending);
    await press(view.container, 'Cancel this item');
    const reason = field(view.container, 'Reason for cancelling (optional)');
    expect(document.activeElement).toBe(reason);
    expect(view.text()).toContain(
      'Kept with the item. Retry drafts a new plan and your reason goes with it.',
    );
    typeInto(reason, 'Keep it in the thread.');
    await press(view.container, 'Cancel with this reason');
    expect(view.calls).toEqual([['cancelPlan', 'Keep it in the thread.']]);
    expect(said(view.container)).toEqual([
      'Plan cancelled: Draft response for new tier-two RevOps ask.',
    ]);
  });

  it('says a plan approved with autonomous actions on applies what the gate allows', (): void => {
    const view = card(DRAWN.planPending, { autonomous: true });
    expect(view.text()).toContain(
      'With autonomous actions on, the writes the gate allows apply on their own; any it holds wait for you.',
    );
  });
});

describe('working (work-working.html)', (): void => {
  it('shows progress by part and the answer given at approval, and offers no control it cannot honour', (): void => {
    const view = card(DRAWN.working);
    expect(chip(view.container)).toBe('Working');
    expect(view.text()).toContain('Reading and drafting');
    const now = view.container.querySelector('[aria-current="step"]');
    expect(now?.textContent).toBe('Read and draft, under way');
    expect(view.text()).toContain(
      'Nothing reaches a surface until the run finishes; then every write it produces is held for you.',
    );
    expect(view.text()).toContain('Answered at approval');
    expect(view.text()).toContain('Ad-hoc asks and anything about the on-call rota.');
    expect(view.text()).toContain("Your answers to the charter's questions were written into it.");
    // No Stop: nothing on the server can stop a run under way (recorded for the work-loop unit).
    expect(view.container.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('write held for you (work-held.html, work-held-withheld.html)', (): void => {
  it('ticks every held write, withholds one, counts the ticks on Approve and sends only what is ticked', async (): Promise<void> => {
    const view = card(DRAWN.held);
    expect(chip(view.container)).toBe('Write held for you');
    expect(view.text()).toContain(
      '2 actions awaiting your approval · nothing has reached a surface',
    );
    const summaries = [...view.container.querySelectorAll('input[type="checkbox"]')].map(
      (box) => (box as HTMLInputElement).checked,
    );
    expect(summaries).toEqual([true, true]);
    expect(button(view.container, 'Approve selected (2)')).toBeTruthy();
    expect(view.container.querySelectorAll('details summary')[0]?.textContent).toBe(
      'Exact payload',
    );

    const dm = [...view.container.querySelectorAll('button')].find((candidate) =>
      candidate.getAttribute('aria-label')?.startsWith('Withhold this one: Send Sam a Slack DM'),
    );
    if (!dm) throw new Error('the DM has no Withhold this one');
    await act(async (): Promise<void> => dm.click());
    expect(view.text()).toContain('· 1 withheld by you');
    expect(view.text()).toContain('Withheld by you: it will not be sent, and stays in the record.');
    expect(
      [...view.container.querySelectorAll('button')].some((candidate) =>
        candidate.getAttribute('aria-label')?.startsWith('Include it again: Send Sam a Slack DM'),
      ),
    ).toBe(true);

    await press(view.container, 'Approve selected (1)');
    expect(view.calls).toEqual([['approveActions', [0]]]);
    expect(said(view.container)).toEqual(['Approved 1 action: they apply now.']);
    expect(focusedName()).toBe('Approve selected (1)');
  });

  it('rejects the run with a reason, which Reject opens and focuses', async (): Promise<void> => {
    const view = card(DRAWN.held);
    await press(view.container, 'Reject the run');
    const reason = field(view.container, 'Reason for rejecting');
    expect(document.activeElement).toBe(reason);
    expect(view.text()).toContain('Kept with the item and shown to Mira on a retry.');
    typeInto(reason, 'Do not DM me about drafts; keep it in the thread.');
    await press(view.container, 'Reject with this reason');
    expect(view.calls).toEqual([
      ['rejectActions', 'Do not DM me about drafts; keep it in the thread.'],
    ]);
    expect(said(view.container)).toEqual([
      'Run rejected: nothing held on Draft response for new tier-two RevOps ask is sent.',
    ]);
  });
});

describe('landed (work-landed.html)', (): void => {
  it('leads with the green line and who approved it when, lists the ledger and sends back only with a note', async (): Promise<void> => {
    const view = card(DRAWN.landed);
    expect(chip(view.container)).toBe('Landed');
    expect(view.text()).toContain(
      '2 changes reached the work environment · approved from the day0 dashboard at 29 Sep 2026, 15:02',
    );
    expect(view.text()).toContain('Landed: Replied in #revops-asks');
    const send = (): HTMLButtonElement | undefined =>
      [...view.container.querySelectorAll('button')].find(
        (candidate) => candidate.textContent === 'Send back with a note',
      );
    expect(send()?.disabled).toBe(true);
    expect(view.text()).not.toContain('Provider reconciliation required');
    typeInto(
      field(
        view.container,
        'Note for the retry: say what to change or answer what the employee asked',
      ),
      'Add the escalation note.',
    );
    // The writes landed, so a send-back first asks for the provider check (U17 D1), one tick each.
    expect(view.text()).toContain('Provider reconciliation required');
    expect(send()?.disabled).toBe(true);
    const ticks = [...view.container.querySelectorAll('label input[type="checkbox"]')];
    expect(ticks).toHaveLength(2);
    expect(() => button(view.container, 'Confirm reconciliation')).toThrow();
    for (const tick of ticks)
      await act(async (): Promise<void> => (tick as HTMLInputElement).click());
    await press(view.container, 'Confirm reconciliation');
    expect(view.calls).toEqual([['reconcile', true]]);
    expect(said(view.container)).toEqual(['Reconciliation recorded: Retry is enabled.']);
    view.unmount();

    const reconciled = card({
      ...DRAWN.landed,
      providerReconciliation: {
        actor: 'owner',
        confirmedAt: DRAWN.landed.decision!.decidedAt! + 60_000,
        entries: [],
      },
    });
    typeInto(
      field(
        reconciled.container,
        'Note for the retry: say what to change or answer what the employee asked',
      ),
      'Add the escalation note.',
    );
    await press(reconciled.container, 'Send back with a note');
    expect(reconciled.calls).toEqual([['retry', 'Add the escalation note.']]);
    expect(said(reconciled.container)).toEqual([
      'Sent back: Draft response for new tier-two RevOps ask.',
    ]);
  });
});

describe('landed partial (work-landed-partial.html)', (): void => {
  it('keeps the withheld action in the record beside what landed', (): void => {
    const view = card(DRAWN.landedPartial);
    expect(view.text()).toContain('1 change reached the work environment');
    expect(view.text()).toContain('Not sent: Send you a DM in Slack');
    expect(view.text()).toContain('withheld by you; never sent, kept in the record');
  });
});

describe('rejected by you (work-rejected.html)', (): void => {
  it('says the reason with its time and that nothing was sent, never in danger red, and retries with a note', async (): Promise<void> => {
    const view = card(DRAWN.rejected);
    expect(chip(view.container)).toBe('Rejected by you');
    expect(view.text()).toContain('You rejected the run at 29 Sep 2026, 14:57. Nothing was sent.');
    expect(view.text()).toContain(
      'Do not DM me about drafts; keep it in the thread. · your reason, kept with the item',
    );
    expect(view.text()).toContain('What was held and not sent');
    expect(view.container.innerHTML).not.toContain('color-danger');
    expect(view.text()).toContain('It can change what is proposed; it cannot approve anything.');
    typeInto(
      field(
        view.container,
        'Note for the retry (optional): answer what the employee asked, or say what to change',
      ),
      'Reply only in the #revops-asks thread. No DM.',
    );
    await press(view.container, 'Retry with this note');
    expect(view.calls).toEqual([['retry', 'Reply only in the #revops-asks thread. No DM.']]);
    expect(said(view.container)).toEqual([
      'Sent back: Draft response for new tier-two RevOps ask.',
    ]);
    expect(focusedName()).toBe('Retry with this note');
  });

  it('dismisses it (N7), saying where it goes, and then says it was dismissed with Retry kept', async (): Promise<void> => {
    const view = card(DRAWN.rejected);
    expect(view.text()).toContain(
      'Dismiss files it at the foot of the queue and keeps it in the record.',
    );
    await press(view.container, 'Dismiss');
    expect(view.calls).toEqual([['dismiss', undefined]]);
    expect(said(view.container)).toEqual([
      'Dismissed: Draft response for new tier-two RevOps ask is out of your inbox and stays in the record.',
    ]);
    view.unmount();

    const dismissed = card({
      ...DRAWN.rejected,
      dismissedAt: DRAWN.rejected.managerFeedback!.at + 120_000,
    });
    expect(dismissed.text()).toContain('You dismissed this at 29 Sep 2026, 14:59.');
    expect(dismissed.text()).toContain('Retry still sends it back.');
    expect(() => button(dismissed.container, 'Dismiss')).toThrow();
    expect(button(dismissed.container, 'Retry')).toBeTruthy();
  });
});

describe('plan to approve, attempt two (work-retried.html)', (): void => {
  it('says the plan was redrafted from the note, and keeps the earlier plan behind a disclosure', (): void => {
    const view = card(DRAWN.retried, { autonomous: true });
    expect(chip(view.container)).toBe('Plan to approve');
    expect(view.text()).toContain(
      'This plan was redrafted after you cancelled an earlier plan from your retry note, given at 29 Sep 2026, 14:58.',
    );
    expect(view.text()).toContain('Reply only in the #revops-asks thread. No DM.');
    expect(view.text()).toContain(
      'It waits for your approval even while autonomous actions are on.',
    );
    const earlier = [...view.container.querySelectorAll('details')].find(
      (details) => details.querySelector('summary')?.textContent === 'The earlier plan',
    );
    expect(earlier?.open).toBe(false);
    expect(view.container.querySelectorAll('ol.list-decimal > li')).toHaveLength(3);
    expect(button(view.container, 'Approve plan with answers')).toBeTruthy();
  });
});

describe('every drawn card is an anchor the inbox lands on (U17 D13, A D8)', (): void => {
  it.each(Object.entries(DRAWN))(
    'carries id="item-<id>" on the %s card, named by its title',
    (_state, item): void => {
      const view = card(item);
      const article = view.container.querySelector('article');
      expect(article?.id).toBe(`item-${item._id}`);
      expect(article?.getAttribute('tabindex')).toBe('-1');
      expect(
        document.getElementById(article?.getAttribute('aria-labelledby') ?? '')?.textContent,
      ).toBe(item.title);
    },
  );
});
