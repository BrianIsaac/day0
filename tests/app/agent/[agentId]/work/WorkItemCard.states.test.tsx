/** @vitest-environment jsdom */

import { act } from 'react';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Doc } from '../../../../../convex/_generated/dataModel';
import { WorkItemCard } from '../../../../../app/agent/[agentId]/work/WorkItemCard';
import { openQuestionStopReason } from '../../../../../src/work/obligations';
import { INTERRUPTED_APPLY_REASON } from '../../../../../src/work/reconciliation';
import { EVALUATION_ATTEMPTS_SPENT } from '../../../../../src/work/queue-order';
import { AgentZoneContext } from '../../../../../app/components/time';
import { button, focusedName, mount, press, said, typeInto } from '../../../../fixtures/dom/press';
import { axeViolations } from '../../../../fixtures/dom/axe';
import {
  DRAWN,
  EMPLOYEE,
  PLAN,
  QUESTION,
  SURFACES,
  THREAD_REPLY,
  ZONE,
} from '../../../../fixtures/work/drawn-states';
import { QUILL_COMMENT, ROOK_COMMENT } from '../../../../fixtures/work/work-done-corpora';
import { HELD_CLOSE_AGAINST_WORDS } from '../../../../../src/surfaces/policy';
import { type StopRunAnswer } from '../../../../../src/work/stop';

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
  options: {
    questions?: Doc<'managerQuestions'>[];
    autonomous?: boolean;
    loop?: boolean;
    /** What the server answers a Stop with; it stops the run unless told otherwise. */
    stop?: StopRunAnswer;
  } = {},
) {
  const calls: Array<[string, unknown]> = [];
  const record =
    (name: string) =>
    async (arg?: unknown): Promise<void> => {
      calls.push([name, arg]);
    };
  const stop = async (reason: string): Promise<StopRunAnswer> => {
    calls.push(['stop', reason]);
    return options.stop ?? { ok: true };
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
        onStop={stop}
        onCloseWithoutRetry={record('closeWithoutRetry')}
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
    // Re-pinned in wave 12 (12-W): the server can stop a run under way, so Stop is the one
    // control a working card offers.
    expect([...view.container.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Stop',
    ]);
  });
});

describe('Stop on a working card (wave 12)', (): void => {
  it('asks first, keeps working by default, and stops with the reason given', async (): Promise<void> => {
    const view = card(DRAWN.working);
    expect(view.text()).toContain(
      'Mira, once stopped, sends nothing more, and the item waits for you with Retry.',
    );
    await press(view.container, 'Stop');
    const dialog = document.body.querySelector('[role="alertdialog"]');
    expect(dialog?.querySelector('h2')?.textContent).toBe(
      'Stop work on “Draft response for new tier-two RevOps ask”?',
    );
    expect(dialog?.textContent).toContain(
      'Mira stops now and sends nothing more. Anything already sent stays sent; the item waits for you, stopped, with Retry.',
    );
    expect(focusedName()).toBe('Keep working');
    typeInto(field(document.body, 'Reason (optional)'), 'Wrong ticket.');
    await press(document.body, 'Stop the run');
    expect(view.calls).toEqual([['stop', 'Wrong ticket.']]);
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(said(view.container)).toEqual([
      'Stopped: Draft response for new tier-two RevOps ask. It waits for you with Retry.',
    ]);
  });

  it('closes and says so, in the card, when the item moved on before the Stop arrived (13-FD)', async (): Promise<void> => {
    const view = card(DRAWN.working, { stop: { ok: false, refused: 'moved-on' } });
    await press(view.container, 'Stop');
    await press(document.body, 'Stop the run');
    expect(view.calls).toEqual([['stop', '']]);
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(said(view.container)).toEqual([
      'Not stopped: the item had moved on before your Stop arrived. Its card shows where it is now.',
    ]);
  });

  it('closes with nothing stopped when Keep working is pressed', async (): Promise<void> => {
    const view = card(DRAWN.working);
    await press(view.container, 'Stop');
    await press(document.body, 'Keep working');
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(view.calls).toEqual([]);
  });

  it('does not say writes are being sent while the closing phase is only being written', async (): Promise<void> => {
    const view = card({
      ...DRAWN.working,
      applyAttemptId: 'authoring-1',
    } as unknown as Doc<'workItems'>);
    await press(view.container, 'Stop');
    expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'Mira stops now and sends nothing more.',
    );
  });

  it('says, while the approved writes are being sent, that one may still land and is listed to check', async (): Promise<void> => {
    const view = card({
      ...DRAWN.working,
      applyAttemptId: 'apply-1',
      pendingRunId: 'run-1',
    } as unknown as Doc<'workItems'>);
    await press(view.container, 'Stop');
    expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'Mira is sending the writes you approved. Stopping sends nothing more, but a write in flight may still land: the item lists each one for you to check before any retry.',
    );
  });
});

describe('Stop on an approval that has not started (W12-R14, D-7 (b))', (): void => {
  it('offers Stop on a set you approved that waits, and says the approval is taken back', async (): Promise<void> => {
    const view = card({
      ...DRAWN.held,
      approvedIndexes: [1, 2],
      applyPhase: 'approved',
    } as unknown as Doc<'workItems'>);
    expect(view.text()).toContain(
      'Mira has not sent the writes you approved yet. Stop takes your approval back and sends none of them.',
    );
    await press(view.container, 'Stop');
    expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'Mira has not started sending the writes you approved. Stopping takes your approval back: none of them is sent, and the item waits for you, stopped, with Retry.',
    );
    expect(focusedName()).toBe('Keep the approval');
    await press(document.body, 'Take the approval back');
    expect(view.calls).toEqual([['stop', '']]);
  });

  it('offers no Stop on a held set still waiting for your decision', (): void => {
    const view = card(DRAWN.held);
    expect([...view.container.querySelectorAll('button')].map((b) => b.textContent)).not.toContain(
      'Stop',
    );
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
    // The writes landed, so a send-back first asks for the provider check (U17 D1). Re-pinned
    // for W12V-14: each write the ledger records as landed is shown as landed and asked nothing,
    // so the check is one confirmation, and each stays as Day0 recorded it.
    expect(view.text()).toContain('Provider reconciliation required');
    expect(send()?.disabled).toBe(true);
    expect(view.container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(view.text()).toContain('Each write below landed, as Day0 recorded it from the provider');
    expect(view.text()).not.toContain('answered');
    await press(view.container, 'Confirm reconciliation');
    // Re-pinned for W12X-3: the confirmation sent `landed` for each of the three as if the
    // manager had answered; nobody was asked, so no answer is sent and Day0's record stands.
    expect(view.calls).toEqual([['reconcile', []]]);
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

  it('asks it landed or not sent in a named group per entry, with no axe violation and 44 px answers', async (): Promise<void> => {
    const view = card({
      ...DRAWN.rejected,
      skipReason: 'stopped: stopped by the manager',
      managerFeedback: undefined,
      output: {
        draft: 'd',
        notes: '',
        actions: [THREAD_REPLY],
        applied: [{ tool: 'http.request', ok: false, outcomeUnknown: true, idempotencyKey: 'w:0' }],
      },
    } as unknown as Doc<'workItems'>);
    const group = view.container.querySelector('fieldset');
    // Re-pinned for W12-R9: the group is named by what the write does, then its outcome.
    expect(group?.querySelector('legend')?.textContent).toContain('Reply in #revops-asks thread');
    expect(group?.querySelector('legend')?.textContent).toContain('Outcome unknown');
    expect(group?.querySelector('legend')?.textContent).not.toContain('http.request');
    // The run record's list names the write the same way, with no tool id and no spaced hyphen.
    expect(view.text()).toContain('with an unknown outcome · may have landed');
    expect(view.text()).not.toContain('http.request - ');
    expect(
      [...view.container.querySelectorAll('details > summary')].map(
        (summary) => summary.textContent,
      ),
    ).toContain('Ledger key (for support)');
    for (const radio of group?.querySelectorAll('input[type="radio"]') ?? []) {
      expect(radio.closest('label')?.className).toMatch(/(^|\s)min-h-11(\s|$)/);
    }
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
  });
});

describe('the rows a stopped apply never sent (W12-R11, second pass)', (): void => {
  it('names each by what it would have done and says once that it was not sent', (): void => {
    const view = card({
      ...DRAWN.rejected,
      skipReason: 'stopped: stopped by the manager',
      managerFeedback: undefined,
      output: {
        draft: 'd',
        notes: '',
        actions: [THREAD_REPLY, THREAD_REPLY],
        applied: [
          { tool: 'http.request', ok: false, outcomeUnknown: true, idempotencyKey: 'w:0' },
          {
            tool: 'http.request',
            ok: true,
            held: true,
            reason: 'not sent: the run was stopped before this write went out',
            effect: 'http.request slack · POST /chat.postMessage · body "{...}"',
            idempotencyKey: 'w:1',
          },
        ],
      },
    } as unknown as Doc<'workItems'>);
    expect(view.text()).toContain('1 action held · never sent');
    expect(view.text()).toContain('Reply in #revops-asks thread');
    expect(view.text()).toContain('not sent: the run stopped before it went out');
    expect(view.text()).not.toContain('POST /chat.postMessage');
  });
});

describe('Close without retry (E-8)', (): void => {
  const stoppedByYou = {
    ...DRAWN.rejected,
    skipReason: 'stopped: stopped by the manager: Wrong ticket.',
    managerFeedback: undefined,
    output: { draft: 'd', notes: '', actions: [THREAD_REPLY] },
  } as unknown as Doc<'workItems'>;

  it('closes a stopped item that left nothing to reconcile, in place of Dismiss, Retry kept', async (): Promise<void> => {
    const view = card(stoppedByYou);
    expect(() => button(view.container, 'Dismiss')).toThrow();
    expect(button(view.container, 'Retry').disabled).toBe(false);
    expect(view.text()).toContain(
      'Close without retry takes it out of your inbox and keeps it in the record; Retry is still here if you change your mind.',
    );
    await press(view.container, 'Close without retry');
    expect(view.calls).toEqual([['closeWithoutRetry', undefined]]);
    expect(said(view.container)).toEqual([
      'Closed: Draft response for new tier-two RevOps ask is out of your inbox and stays in the record.',
    ]);
  });

  it('is the one way out of an interrupted apply that names nothing to check', (): void => {
    const view = card({
      ...stoppedByYou,
      skipReason: INTERRUPTED_APPLY_REASON,
      output: { draft: 'd', notes: '', actions: [THREAD_REPLY], applied: [] },
    } as unknown as Doc<'workItems'>);
    const named = (name: string): HTMLButtonElement | undefined =>
      [...view.container.querySelectorAll('button')].find(
        (candidate) => candidate.textContent === name,
      );
    expect(named('Retry')?.disabled).toBe(true);
    expect(named('Close without retry')?.disabled).toBe(false);
  });

  it('keeps Dismiss on an item you rejected', (): void => {
    const view = card(DRAWN.rejected);
    expect(button(view.container, 'Dismiss')).toBeTruthy();
    expect(() => button(view.container, 'Close without retry')).toThrow();
  });
});

describe('what a finished run says it did not do (the 4 October demo)', (): void => {
  it('says on the card, in the run’s own words, what was not done', (): void => {
    const view = card({
      ...DRAWN.landed,
      output: {
        ...(DRAWN.landed.output as object),
        draft:
          "I could not reconcile the three October closed-won deals: I can't find them in the tracker.",
      },
    } as unknown as Doc<'workItems'>);
    expect(view.text()).toContain('Not done, in Mira’s own words');
    expect(view.text()).toContain('I could not reconcile the three October closed-won deals');
    expect(view.text()).toContain('I can’t find them in the tracker.'.replace('’', "'"));
  });

  it('says nothing of the kind for a run whose words say the work was done', (): void => {
    expect(card(DRAWN.landed).text()).not.toContain('Not done, in');
  });
});

describe('what the run answered about its own work (12-D, decision D-1 (b))', (): void => {
  /** A finished row whose run answered, with its comment as its own words. */
  function answered(
    workDone: 'done' | 'partial' | 'not-done',
    words: string,
    why: string,
  ): Doc<'workItems'> {
    return {
      ...DRAWN.landed,
      output: { ...(DRAWN.landed.output as object), draft: words, workDone, workDoneWhy: why },
    } as unknown as Doc<'workItems'>;
  }

  it('reads a finished run as finished when it answered done, whatever the detector reads in its words (Quill)', (): void => {
    const view = card(answered('done', QUILL_COMMENT, 'All three deals match the tracker.'));
    expect(view.text()).not.toContain('Not done, in');
    expect(view.text()).not.toContain('Partly done, in');
  });

  it('says what was left in the run’s one line of why when it answered partial (Pip), and not done when it answered so (Nell)', (): void => {
    const pip = card(
      answered(
        'partial',
        ROOK_COMMENT,
        'One of the three deals is reconciled; two need the CRM export.',
      ),
    ).text();
    expect(pip).toContain('Partly done, in Mira’s own words');
    // The one line of why is a sentence, not a list of one.
    const pipCard = card(
      answered(
        'partial',
        ROOK_COMMENT,
        'One of the three deals is reconciled; two need the CRM export.',
      ),
    );
    const why = [...pipCard.container.querySelectorAll('q')].find((quote) =>
      quote.textContent?.includes('two need the CRM export'),
    );
    expect(why?.closest('li')).toBeNull();
    expect(pip).toContain('One of the three deals is reconciled; two need the CRM export.');
    expect(pip).not.toContain('Not done, in');
    const nell = card(
      answered('not-done', ROOK_COMMENT, 'The October deal list is not in the tracker.'),
    ).text();
    expect(nell).toContain('Not done, in Mira’s own words');
    expect(nell).toContain('The October deal list is not in the tracker.');
  });

  it('says a run was only partly done before what landed, since that is the first thing the manager asks', (): void => {
    const text = card(
      answered(
        'partial',
        ROOK_COMMENT,
        'One of the three deals is reconciled; two need the CRM export.',
      ),
    ).text();
    expect(text.indexOf('Partly done, in Mira’s own words')).toBeGreaterThan(-1);
    expect(text.indexOf('Partly done, in Mira’s own words')).toBeLessThan(
      text.indexOf('reached the work environment'),
    );
  });

  it('reads a row recorded before the release, with no answer, as it read before', (): void => {
    const view = card({
      ...DRAWN.landed,
      output: { ...(DRAWN.landed.output as object), draft: QUILL_COMMENT },
    } as unknown as Doc<'workItems'>);
    expect(view.text()).toContain('Not done, in Mira’s own words');
    expect(view.text()).toContain('I could not find a mismatch');
  });

  it('sets the list of what was not done in a block, never a list inside a paragraph (a hydration error on the bed)', (): void => {
    const view = card({
      ...DRAWN.landed,
      output: {
        ...(DRAWN.landed.output as object),
        draft: `${QUILL_COMMENT} Nothing was reconciled.`,
      },
    } as unknown as Doc<'workItems'>);
    expect(view.container.querySelector('p ul, p li')).toBeNull();
    expect(
      [...view.container.querySelectorAll('div > ul')].some((list) =>
        list.textContent?.includes('I could not find a mismatch'),
      ),
    ).toBe(true);
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

describe('a close Day0 held, after an approval in Slack sent the rest (12-H, R-12D-1)', (): void => {
  const CLOSE = {
    tool: 'mcp.call' as const,
    args: {
      surface: 'linear',
      tool: 'save_issue',
      toolArgsJson: JSON.stringify({ id: 'REVOPS-202', state: 'Done' }),
    },
  };
  const parkedAgain = (): Doc<'workItems'> => {
    const held = DRAWN.held as unknown as {
      output: { actions: unknown[]; draft: string; notes: string };
    };
    return {
      ...DRAWN.held,
      output: {
        ...held.output,
        actions: [THREAD_REPLY, CLOSE],
        closeAgainstWords: 'I could not find the stale tile.',
        applied: [
          {
            tool: 'http.request',
            ok: true,
            effect: 'Replied in #revops-asks: “Draft for Manager Review.”',
            providerId: '1790000000.000300',
            authority: 'manager',
          },
          { tool: 'mcp.call', ok: true, held: true, awaitingApproval: true, reason: 'awaiting' },
        ],
      },
      actionVerdicts: [
        { disposition: 'held', reason: 'public post held for the manager' },
        { disposition: 'held', reason: HELD_CLOSE_AGAINST_WORDS },
      ],
    } as unknown as Doc<'workItems'>;
  };

  it('lists what the approval sent as landed, offers only the close, and finishes without it on a choice of its own', async (): Promise<void> => {
    const view = card(parkedAgain());
    expect(view.text()).toContain('Landed: Replied in #revops-asks');
    expect(view.container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    expect(view.text()).toContain('Close held:');
    expect(view.text()).toContain(
      'Your earlier approval has been applied; only the close is left.',
    );
    expect(view.text()).toContain(
      'Approve all sends the close, so use it only if the work was done.',
    );
    await press(view.container, 'Finish without the close');
    expect(view.calls).toEqual([['approveActions', []]]);
    expect(said(view.container)).toContain(
      'Finished without the ticket close: nothing more is sent on Draft response for new tier-two RevOps ask, and the close stays withheld.',
    );
  });
});
