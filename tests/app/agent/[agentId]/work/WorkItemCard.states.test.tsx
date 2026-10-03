/** @vitest-environment jsdom */

import { act } from 'react';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Doc } from '../../../../../convex/_generated/dataModel';
import { WorkItemCard } from '../../../../../app/agent/[agentId]/work/WorkItemCard';
import { openQuestionStopReason } from '../../../../../src/work/obligations';
import { EVALUATION_ATTEMPTS_SPENT } from '../../../../../src/work/queue-order';
import { AgentZoneContext } from '../../../../../app/components/time';
import { button, focusedName, mount, press, said, typeInto } from '../../../../fixtures/dom/press';
import {
  DRAWN,
  EMPLOYEE,
  PLAN,
  QUESTION,
  SURFACES,
  THREAD_REPLY,
  ZONE,
} from '../../../../fixtures/work/drawn-states';

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
 * The card for one drawn state, in the employee's zone, served by the real loop as the pages
 * draw it (`loop: false` for the mock gate), with every decision recorded by name.
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
        surfaces={SURFACES}
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
        servedByLoop={options.loop ?? true}
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
    expect(view.text()).toContain('linear · ticket queue · low');
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
      'Approving runs the plan. When it finishes, reads and messages to you apply on their own, and every other write waits for your approval.',
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
      'Kept with the item. Retry drafts a new plan from it, unless you give a note in its place.',
    );
    typeInto(reason, 'Keep it in the thread.');
    await press(view.container, 'Cancel with this reason');
    expect(view.calls).toEqual([['cancelPlan', 'Keep it in the thread.']]);
    expect(focusedName()).toBe('Cancel with this reason');
    expect(said(view.container)).toEqual([
      'Plan cancelled: Draft response for new tier-two RevOps ask.',
    ]);
  });

  it('says a plan approved with autonomous actions on applies what the gate allows', (): void => {
    const view = card(DRAWN.planPending, { autonomous: true });
    expect(view.text()).toContain(
      'Approving runs the plan. When it finishes, the writes the gate allows apply on their own, and any it holds wait for you.',
    );
  });
});

describe('closing a reason form without deciding', (): void => {
  it('gives focus back to the control that opened it', async (): Promise<void> => {
    const plan = card(DRAWN.planPending);
    await press(plan.container, 'Cancel this item');
    await press(plan.container, 'Keep the plan');
    expect(focusedName()).toBe('Cancel this item');
    plan.unmount();
    const held = card(DRAWN.held);
    await press(held.container, 'Reject the run');
    await press(held.container, 'Keep it held');
    expect(focusedName()).toBe('Reject the run');
    expect(held.calls).toEqual([]);
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
      'Nothing reaches a surface while it reads and drafts; then reads and messages to you apply on their own, and every other write waits for your approval.',
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
    // Supervised, the real gate applied the DM to the manager and holds the other two.
    expect(view.text()).toContain('1 applied automatically · 2 actions awaiting your approval');
    expect(view.text()).toContain('Landed: Sent you a DM in Slack');
    // What applied on its own reads before the writes still to decide.
    expect(view.text().indexOf('Landed: Sent you a DM')).toBeLessThan(
      view.text().indexOf('Approve selected'),
    );
    expect(view.text()).toContain('Public post held for you.');
    expect(view.text()).toContain('System-of-record mutation held for you.');
    // The whole reply is read in words, not only in the payload.
    expect(view.text()).toContain('the Looker tile is stale (REVOPS-202).');
    const summaries = [...view.container.querySelectorAll('input[type="checkbox"]')].map(
      (box) => (box as HTMLInputElement).checked,
    );
    expect(summaries).toEqual([true, true]);
    expect(button(view.container, 'Approve selected (2)')).toBeTruthy();
    expect(view.container.querySelectorAll('details summary')[0]?.textContent).toBe(
      'Exact payload',
    );

    const comment = [...view.container.querySelectorAll('button')].find((candidate) =>
      candidate.getAttribute('aria-label')?.startsWith('Withhold this one: Comment on REVOPS-202'),
    );
    if (!comment) throw new Error('the comment has no Withhold this one');
    await act(async (): Promise<void> => comment.click());
    expect(view.text()).toContain('· 1 withheld by you');
    expect(view.text()).toContain('Withheld by you: it will not be sent, and stays in the record.');
    expect(
      [...view.container.querySelectorAll('button')].some((candidate) =>
        candidate.getAttribute('aria-label')?.startsWith('Include it again: Comment on REVOPS-202'),
      ),
    ).toBe(true);

    await press(view.container, 'Approve selected (1)');
    expect(view.calls).toEqual([['approveActions', [0]]]);
    expect(said(view.container)).toEqual(['Approved 1 action: it applies now.']);
    expect(focusedName()).toBe('Approve selected (1)');
  });

  it('offers no Approve selected once every held write is withheld, Reject being how nothing is sent (D5)', async (): Promise<void> => {
    const view = card(DRAWN.held);
    for (const withhold of [...view.container.querySelectorAll('button')].filter((candidate) =>
      candidate.getAttribute('aria-label')?.startsWith('Withhold this one'),
    )) {
      await act(async (): Promise<void> => (withhold as HTMLButtonElement).click());
    }
    const approve = [...view.container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Approve selected (0)',
    );
    expect(approve?.disabled).toBe(true);
    expect(button(view.container, 'Reject the run')).toBeTruthy();
  });

  it('ticks every held write again when Approve all sends them, a withheld one included', async (): Promise<void> => {
    const view = card(DRAWN.held);
    const withhold = [...view.container.querySelectorAll('button')].find((candidate) =>
      candidate.getAttribute('aria-label')?.startsWith('Withhold this one'),
    );
    await act(async (): Promise<void> => withhold?.click());
    await press(view.container, 'Approve all');
    expect(view.calls).toEqual([['approveActions', [0, 2]]]);
    expect(
      [...view.container.querySelectorAll('input[type="checkbox"]')].map(
        (box) => (box as HTMLInputElement).checked,
      ),
    ).toEqual([true, true]);
  });

  it('rejects the run with a reason, which Reject opens and focuses', async (): Promise<void> => {
    const view = card(DRAWN.held);
    await press(view.container, 'Reject the run');
    const reason = field(view.container, 'Reason for rejecting');
    expect(document.activeElement).toBe(reason);
    expect(view.text()).toContain(
      "Kept with the item. A retry reads it as Mira's direction, unless you give a note in its place.",
    );
    typeInto(reason, 'Do not DM me about drafts; keep it in the thread.');
    await press(view.container, 'Reject with this reason');
    expect(view.calls).toEqual([
      ['rejectActions', 'Do not DM me about drafts; keep it in the thread.'],
    ]);
    expect(focusedName()).toBe('Reject with this reason');
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
      '3 actions reached the work environment · approved from the day0 dashboard at 29 Sep 2026, 15:02',
    );
    expect(view.text()).toContain('Landed: Replied in #revops-asks');
    const send = (): HTMLButtonElement | undefined =>
      [...view.container.querySelectorAll('button')].find(
        (candidate) => candidate.textContent === 'Send back with a note',
      );
    expect(send()?.disabled).toBe(true);
    expect(view.text()).not.toContain('Provider reconciliation required');
    typeInto(
      field(view.container, 'Note for the retry: say what to change or answer what Mira asked'),
      'Add the escalation note.',
    );
    // The writes landed, so a send-back first asks for the provider check (U17 D1), one tick each.
    expect(view.text()).toContain('Provider reconciliation required');
    expect(send()?.disabled).toBe(true);
    const ticks = [...view.container.querySelectorAll('label input[type="checkbox"]')];
    expect(ticks).toHaveLength(3);
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
        'Note for the retry: say what to change or answer what Mira asked',
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
    expect(view.text()).toContain('2 actions reached the work environment · 1 withheld by you');
    expect(view.text()).toContain('Not sent: Comment on REVOPS-202');
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
        'Note for the retry (optional): answer what Mira asked, or say what to change',
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

describe('stopped with a write that may have landed', (): void => {
  it('offers no Dismiss until the provider is reconciled, so the one prompt that something landed stays', (): void => {
    const view = card({
      ...DRAWN.rejected,
      skipReason: 'stopped: a write may have landed',
      managerFeedback: undefined,
      output: {
        draft: 'd',
        notes: '',
        actions: [THREAD_REPLY],
        applied: [{ tool: 'http.request', ok: false, outcomeUnknown: true, idempotencyKey: 'w:0' }],
      },
    } as unknown as Doc<'workItems'>);
    expect(view.text()).toContain('Provider reconciliation required');
    expect(view.container.textContent).not.toContain('Dismiss');
  });
});

describe('plan to approve, attempt two (work-retried.html)', (): void => {
  it('says the plan was redrafted from the note, opens onto the earlier plan, and approves the redraft', async (): Promise<void> => {
    backend.queries['work:earlierPlan'] = {
      summary: PLAN.summary,
      steps: PLAN.steps,
      draftedAt: DRAWN.planPending.planPendingAt,
    };
    const view = card(DRAWN.retried, { autonomous: true });
    expect(chip(view.container)).toBe('Plan to approve');
    expect(view.text()).toContain(
      'You cancelled an earlier plan, and this one was redrafted from your retry note, given at 29 Sep 2026, 14:58.',
    );
    expect(view.text()).toContain('Reply only in the #revops-asks thread. No DM.');
    expect(view.text()).toContain(
      'It waits for your approval even while autonomous actions are on.',
    );
    const earlier = [...view.container.querySelectorAll('details')].find(
      (details) => details.querySelector('summary')?.textContent === 'The earlier plan',
    );
    expect(earlier?.open).toBe(false);
    expect(earlier?.textContent).toContain('Drafted at 29 Sep 2026, 14:38 and cancelled by you.');
    expect(earlier?.querySelectorAll('li')).toHaveLength(PLAN.steps.length);
    expect(view.container.querySelectorAll('ol.list-decimal > li')).toHaveLength(
      3 + PLAN.steps.length,
    );
    await press(view.container, 'Approve plan with answers');
    expect(view.calls).toEqual([['approvePlan', { answers: [] }]]);
    expect(said(view.container)).toEqual([
      'Plan approved: Draft response for new tier-two RevOps ask.',
    ]);
  });
});

describe('the states round two does not page, pressed the same way', (): void => {
  const base = DRAWN.planPending;

  it('retries a stopped run that landed nothing, the reason in words above Retry', async (): Promise<void> => {
    const view = card({
      ...base,
      state: 'failed',
      skipReason: 'stopped: the read did not land',
    } as Doc<'workItems'>);
    expect(chip(view.container)).toBe('Stopped');
    expect(view.text()).toContain(
      'stopped, nothing landed and nothing to decide: the read did not land',
    );
    await press(view.container, 'Retry');
    expect(view.calls).toEqual([['retry', '']]);
    expect(said(view.container)).toEqual([
      'Sent back: Draft response for new tier-two RevOps ask.',
    ]);
    expect(focusedName()).toBe('Retry');
  });

  it('asks for the answer to the question a run stopped on, and sends it', async (): Promise<void> => {
    const question = 'Which template should the reply use?';
    const view = card({
      ...base,
      state: 'failed',
      skipReason: `stopped: ${openQuestionStopReason({ question, steps: [2] })}`,
      output: {
        draft: '',
        notes: '',
        actions: [],
        applied: [],
        openQuestion: { question, steps: [2] },
      },
    } as unknown as Doc<'workItems'>);
    expect(view.text()).toContain('answer it below with Answer and retry');
    expect(() => button(view.container, 'Answer and retry')).toThrow();
    typeInto(
      field(view.container, `Your answer to: \u201c${question}\u201d`),
      'The exception template.',
    );
    await press(view.container, 'Answer and retry');
    expect(view.calls).toEqual([['retry', 'The exception template.']]);
    expect(said(view.container)).toEqual([
      'Answer sent: Draft response for new tier-two RevOps ask runs again with it.',
    ]);
  });

  it('drafts a new plan for a cancelled one from the note given', async (): Promise<void> => {
    const view = card({
      ...base,
      state: 'cancelled',
      skipReason: 'plan cancelled by the manager: keep it in the thread',
    } as Doc<'workItems'>);
    expect(chip(view.container)).toBe('Cancelled');
    expect(view.text()).toContain(
      'Cancelled. plan cancelled by the manager: keep it in the thread',
    );
    typeInto(field(view.container, 'Note for the new plan (optional)'), 'Thread only.');
    await press(view.container, 'Retry with this note');
    expect(view.calls).toEqual([['retry', 'Thread only.']]);
    expect(focusedName()).toBe('Retry with this note');
  });

  it('sends back a row parked after its evaluations kept dying, and nothing else does', async (): Promise<void> => {
    const view = card({
      ...base,
      state: 'deferred',
      plan: undefined,
      verdict: { decision: 'defer', reason: EVALUATION_ATTEMPTS_SPENT, attempts: 3 },
    } as unknown as Doc<'workItems'>);
    expect(chip(view.container)).toBe('Parked');
    expect(view.text()).toContain('3 evaluations of this item stopped without a verdict');
    await press(view.container, 'Retry');
    expect(view.calls).toEqual([['retry', '']]);
  });

  it('points an item waiting on a skill at the Skills tab and offers no control of its own', (): void => {
    const view = card({
      ...base,
      state: 'needs-skill',
      plan: undefined,
      verdict: { decision: 'needs-skill', suggestedSkillName: 'draft-tier-two-reply' },
    } as unknown as Doc<'workItems'>);
    expect(chip(view.container)).toBe('Waiting on a skill');
    expect(view.container.querySelector('a[href="/agent/a-mira/skills"]')).not.toBeNull();
    expect(view.container.querySelectorAll('button')).toHaveLength(0);
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
