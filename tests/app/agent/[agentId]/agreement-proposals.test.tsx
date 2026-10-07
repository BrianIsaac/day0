/** @vitest-environment jsdom */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('convex/react', () => ({
  useQuery: (): undefined => undefined,
  useMutation: (): (() => Promise<void>) => async (): Promise<void> => undefined,
}));

import { AgreementProposals } from '../../../../app/agent/[agentId]/corrections-panel';
import {
  PlanApprovalForm,
  planApprovalRequest,
} from '../../../../app/agent/[agentId]/work/PlanApproval';
import type { AgreementView } from '../../../../src/work/agreement-words';
import { CHECK_STALE_MS } from '../../../../src/work/agreement-vocabulary';
import type { Id } from '../../../../convex/_generated/dataModel';
import { axeViolations } from '../../../fixtures/dom/axe';
import { button, mount, press, said, settle, typeInto } from '../../../fixtures/dom/press';
import { underTarget } from '../../../fixtures/dom/targets';

/**
 * The promotion card in the Work tab's corrections panel (13-W; the wave file's section 7): a
 * proposal asks to keep the manager's repeated words for this employee or every employee, a kept
 * one says it waits on its check, and a refused one says why with the clause quoted and offers to
 * amend the charter where the charter settles it. And the plan approval's "Keep this note" tick.
 */

const proposal: AgreementView = {
  _id: 'wa1' as Id<'workingAgreements'>,
  agentId: 'a1' as Id<'agents'>,
  statement: 'Comment on the ticket and let the account team email the customer.',
  status: 'proposed',
  sourceType: 'correction-promotion',
  correctionIds: ['c1' as Id<'corrections'>, 'c2' as Id<'corrections'>],
  createdAt: 1,
};
const checking: AgreementView = {
  ...proposal,
  _id: 'wa2' as Id<'workingAgreements'>,
  approvedAt: 2,
};
const refused: AgreementView = {
  ...proposal,
  _id: 'wa3' as Id<'workingAgreements'>,
  statement: 'Email the customer the new sailing yourself.',
  status: 'refused',
  refusal: { reason: 'contradicts-will-not-do', clause: 'email customers directly' },
};
const credential: AgreementView = {
  ...refused,
  _id: 'wa4' as Id<'workingAgreements'>,
  statement: 'Post with the bot token <redacted>.',
  refusal: { reason: 'names-credential' },
};
const elsewhere: AgreementView = {
  ...checking,
  _id: 'wa5' as Id<'workingAgreements'>,
  sourceType: 'manager-card',
};

beforeEach((): void => {
  // The page's clock decides when a kept agreement's check is stale (W13-R30): pinned just after
  // the fixtures were kept, so a row waits on its check unless a test moves the clock.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(10_000);
});

afterEach((): void => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

function proposals(rows: readonly AgreementView[], calls: string[] = []): ReturnType<typeof mount> {
  return mount(
    <AgreementProposals
      agreements={rows}
      employeeName="Priya"
      charterHref="/agent/a1/charter"
      onKeep={async (id, everyone) => {
        calls.push(`keep ${id} ${everyone ? 'every employee' : 'Priya'}`);
      }}
      onDismiss={async (id) => {
        calls.push(`dismiss ${id}`);
      }}
      onRecheck={async (id) => {
        calls.push(`recheck ${id}`);
      }}
    />,
  );
}

describe('the promotion card', (): void => {
  it("asks to keep the manager's repeated words, for this employee or every employee, or not now", async (): Promise<void> => {
    const calls: string[] = [];
    const view = proposals([proposal], calls);
    expect(view.container.textContent).toContain(
      'You have said this twice: “Comment on the ticket and let the account team email the customer.” Keep it as a working agreement?',
    );
    await press(view.container, 'Keep for Priya');
    await press(view.container, 'Keep for every employee');
    await press(view.container, 'Not now');
    expect(calls).toEqual(['keep wa1 Priya', 'keep wa1 every employee', 'dismiss wa1']);
    expect(said(view.container).at(-1)).toBe(
      'Set aside: these corrections are not proposed again.',
    );
    // The card stays while the outcome is said, so the outcome and focus have a home.
    expect(view.container.textContent).toContain('Proposed working agreements');
    view.unmount();
  });

  it('says a kept agreement waits on its check, and lets the manager withdraw it', async (): Promise<void> => {
    const calls: string[] = [];
    const view = proposals([checking], calls);
    expect(view.container.textContent).toContain(
      'Kept. Day0 is checking “Comment on the ticket and let the account team email the customer.” against the charter',
    );
    await press(
      view.container,
      'Withdraw “Comment on the ticket and let the account team email the customer.”',
    );
    expect(calls).toEqual(['dismiss wa2']);
    expect(said(view.container).at(-1)).toBe('Withdrawn: it will not take effect.');
    view.unmount();
  });

  it('says a check that could not be had once it is stale, and offers Try again beside Withdraw (W13-R30)', async (): Promise<void> => {
    vi.setSystemTime(2 + CHECK_STALE_MS + 1);
    const calls: string[] = [];
    const view = proposals([checking], calls);
    expect(view.container.textContent).toContain(
      'Kept, but Day0 could not check “Comment on the ticket and let the account team email the customer.” against the charter yet, so it is not in effect. Try again, or withdraw it.',
    );
    await press(
      view.container,
      'Try the check of “Comment on the ticket and let the account team email the customer.” again',
    );
    expect(calls).toEqual(['recheck wa2']);
    expect(said(view.container).at(-1)).toBe('Day0 is checking it again.');
    expect(await axeViolations(view.container)).toEqual([]);
    view.unmount();
  });

  it('says a refused one was not kept even when the refusal carries no reason', (): void => {
    const bare = { ...refused, refusal: undefined };
    const view = proposals([bare]);
    expect(view.container.textContent).toContain(
      'This would go beyond the charter. It was not kept.',
    );
    expect(view.container.textContent).not.toContain('Keep for Priya');
    view.unmount();
  });

  it('says why a refused one goes beyond the charter, quoting the clause, and offers the amendment', async (): Promise<void> => {
    const calls: string[] = [];
    const view = proposals([refused, credential], calls);
    expect(view.container.textContent).toContain(
      'This would go beyond the charter: it contradicts “email customers directly”. Amend the charter instead?',
    );
    const amend = [...view.container.querySelectorAll('a')].filter(
      (link) => link.textContent === 'Amend the charter',
    );
    expect(amend.map((link) => link.getAttribute('href'))).toEqual(['/agent/a1/charter']);
    expect(view.container.textContent).toContain(
      'This names a credential, which a working agreement never keeps. It was not kept.',
    );
    await press(
      view.container,
      'Dismiss the refused agreement “Email the customer the new sailing yourself.”',
    );
    expect(calls).toEqual(['dismiss wa3']);
    view.unmount();
  });

  it('draws nothing when nothing waits, and leaves what the Charter tab kept to that tab', (): void => {
    const view = proposals([
      elsewhere,
      { ...proposal, _id: 'wa6' as Id<'workingAgreements'>, status: 'active' },
    ]);
    expect(view.container.textContent).toBe('');
    view.unmount();
  });

  it('has no axe violation and 44 px targets in every state', async (): Promise<void> => {
    const view = proposals([proposal, checking, refused, credential]);
    await settle();
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    expect(underTarget(view.container)).toEqual([]);
    view.unmount();
  });
});

describe('the plan approval tick', (): void => {
  it('offers to keep the note, and sends keepNote only when the note is written and ticked', async (): Promise<void> => {
    const decisions: unknown[] = [];
    const view = mount(
      <PlanApprovalForm
        riskNotes="Which template applies to a customs hold?"
        questions={[]}
        onApprove={(decision) => decisions.push(decision)}
        onCancel={(): void => undefined}
        employeeName="Priya"
        gate="real"
      />,
    );
    const tick = [...view.container.querySelectorAll('label')].find((label) =>
      label.textContent?.startsWith('Keep this note for later work of this kind'),
    );
    const box = tick?.control as HTMLInputElement | null;
    if (!tick || !box) throw new Error('no tick');
    expect(tick.className).toMatch(/(^|\s)min-h-11(\s|$)/);
    expect(view.container.textContent).toContain(
      'Your answer above becomes a working agreement for Priya once Day0 checks it against the charter; it is then on the Charter tab, where you can edit or retire it.',
    );
    // With no note written there is nothing to keep, so the tick waits for one.
    expect(box.disabled).toBe(true);
    await press(view.container, 'Approve plan with answers');
    const field = [...view.container.querySelectorAll('label')].find(
      (label) => label.textContent === 'Your answer to the note, for this run (optional)',
    )?.control as HTMLInputElement;
    typeInto(field, 'Template B for customs holds.');
    expect(box.disabled).toBe(false);
    await act(async () => box.click());
    await press(view.container, 'Approve plan with answers');
    expect(decisions).toEqual([
      { answers: [] },
      { answers: [], note: 'Template B for customs holds.', keepNote: true },
    ]);
    const workItemId = 'w1' as Id<'workItems'>;
    expect(
      planApprovalRequest(workItemId, { answers: [], note: 'Template B.', keepNote: true }),
    ).toEqual({ workItemId, note: 'Template B.', keepNote: true });
    expect(planApprovalRequest(workItemId, { answers: [], keepNote: true })).toEqual({
      workItemId,
    });
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    view.unmount();
  });

  it('offers no tick in the mock office, where nothing reads an agreement', (): void => {
    const view = mount(
      <PlanApprovalForm
        riskNotes="Which template?"
        questions={[]}
        onApprove={(): void => undefined}
        onCancel={(): void => undefined}
        gate="mock"
      />,
    );
    expect(view.container.textContent).not.toContain('Keep this note');
    expect(button(view.container, 'Approve plan with answers')).toBeDefined();
    view.unmount();
  });
});
