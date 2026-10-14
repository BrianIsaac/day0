/** @vitest-environment jsdom */

import { act } from 'react';
import type { Id } from '../../../../../convex/_generated/dataModel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgreementsCard } from '../../../../../app/agent/[agentId]/charter/AgreementsCard';
import type { AgreementView } from '../../../../../src/work/agreement-words';
import { CHECK_STALE_MS } from '../../../../../src/work/agreement-vocabulary';
import { AgentZoneContext } from '../../../../../app/components/time';
import { axeViolations } from '../../../../fixtures/dom/axe';
import { button, mount, press, said, settle, typeInto } from '../../../../fixtures/dom/press';
import { underTarget } from '../../../../fixtures/dom/targets';

/**
 * The Agreements card on the Charter tab (A18; the wave file's section 7): the working agreements
 * in force for the employee, its own and every employee's, with Edit as a supersede, Retire, and
 * Keep for every employee (A10); a kept one waiting on its check; a refusal of what was kept here;
 * a proposal pointing to the Work tab; and the empty card. Every state with axe and 44 px.
 */

const own: AgreementView = {
  _id: 'wa1' as Id<'workingAgreements'>,
  agentId: 'a1' as Id<'agents'>,
  statement: 'Name the carrier and the new date in every delay notice.',
  scope: 'global',
  status: 'active',
  sourceType: 'correction-promotion',
  correctionIds: ['c1' as Id<'corrections'>, 'c2' as Id<'corrections'>],
  approvedAt: 2,
  effectiveFrom: Date.UTC(2026, 9, 5, 12),
  createdAt: 1,
};
const everyone: AgreementView = {
  ...own,
  _id: 'wa2' as Id<'workingAgreements'>,
  agentId: undefined,
  statement: 'Thread every reply under the ask.',
  sourceType: 'plan-approval',
};
const checking: AgreementView = {
  ...own,
  _id: 'wa3' as Id<'workingAgreements'>,
  statement: 'Name the carrier first.',
  status: 'proposed',
  sourceType: 'manager-card',
  effectiveFrom: undefined,
};
const refused: AgreementView = {
  ...checking,
  _id: 'wa4' as Id<'workingAgreements'>,
  statement: 'Email the customer yourself.',
  status: 'refused',
  refusal: { reason: 'contradicts-will-not-do', clause: 'email customers directly' },
};
const waiting: AgreementView = {
  ...own,
  _id: 'wa5' as Id<'workingAgreements'>,
  statement: 'Comment, never email.',
  status: 'proposed',
  approvedAt: undefined,
  effectiveFrom: undefined,
};

beforeEach((): void => {
  // The page's clock decides when a kept agreement's check is stale (W13-R30): pinned just after
  // the fixtures were kept.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(10_000);
});

afterEach((): void => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

function card(
  rows: readonly AgreementView[],
  calls: string[] = [],
  when: 'now' | 'after-pause' = 'now',
): ReturnType<typeof mount> {
  return mount(
    <AgentZoneContext.Provider value="UTC">
      <AgreementsCard
        agreements={rows}
        employeeName="Priya"
        workHref="/agent/a1/work"
        onKeepForEveryEmployee={async (id) => {
          calls.push(`every ${id}`);
        }}
        onKeepForOne={async (id) => {
          calls.push(`one ${id}`);
        }}
        onEdit={async (id, statement) => {
          calls.push(`edit ${id} ${statement}`);
        }}
        onRetire={async (id) => {
          calls.push(`retire ${id}`);
        }}
        onDismiss={async (id) => {
          calls.push(`dismiss ${id}`);
        }}
        onRecheck={async (id) => {
          calls.push(`recheck ${id}`);
          return { ok: true, when } as const;
        }}
      />
    </AgentZoneContext.Provider>,
  );
}

describe('the Agreements card', (): void => {
  it('is titled as the wave file draws it and says where agreements come from when it holds none', (): void => {
    const view = card([]);
    expect(view.container.querySelector('h2')?.textContent).toBe('Working agreements');
    expect(view.container.textContent).toContain('revise, never override the charter');
    expect(view.container.textContent).toContain(
      'No working agreements yet. They come from corrections you give twice, or from a note you keep when you approve a plan.',
    );
    view.unmount();
  });

  it("lists the employee's own and every employee's, whom each binds and where it came from", (): void => {
    const view = card([own, everyone]);
    const text = view.container.textContent ?? '';
    expect(text).toContain('Name the carrier and the new date in every delay notice.');
    expect(text).toContain('for Priya · from your corrections · since 5 Oct 2026');
    expect(text).toContain('for every employee · from a note you kept at a plan approval');
    // Only the employee's own can be kept for every employee.
    expect(
      [...view.container.querySelectorAll('button')].filter((control) =>
        control.textContent?.startsWith('Keep for every employee'),
      ),
    ).toHaveLength(1);
    view.unmount();
  });

  it('retires, keeps for every employee, and edits as a new version checked before it takes effect', async (): Promise<void> => {
    const calls: string[] = [];
    const view = card([own], calls);
    await press(
      view.container,
      'Retire “Name the carrier and the new date in every delay notice.”',
    );
    await press(
      view.container,
      'Keep for every employee: “Name the carrier and the new date in every delay notice.”',
    );
    await press(view.container, 'Edit “Name the carrier and the new date in every delay notice.”');
    const field = [...view.container.querySelectorAll('label')].find(
      (label) => label.textContent === 'The agreement, in your words',
    )?.control as HTMLInputElement | null;
    if (!field) throw new Error('the edit has no visible label');
    expect(field.value).toBe(own.statement);
    expect(document.activeElement).toBe(field);
    typeInto(field, 'Name the carrier, the new date and the vessel.');
    await press(view.container, 'Save');
    expect(calls).toEqual([
      'retire wa1',
      'every wa1',
      'edit wa1 Name the carrier, the new date and the vessel.',
    ]);
    expect(said(view.container).at(-1)).toBe(
      'Saved. Day0 checks the new words against the charter; until then the old ones stay in effect.',
    );
    view.unmount();
  });

  it('closes an edit with Cancel and gives focus back to Edit', async (): Promise<void> => {
    const view = card([own]);
    await press(view.container, 'Edit “Name the carrier and the new date in every delay notice.”');
    await press(view.container, 'Cancel');
    expect(view.container.querySelector('input')).toBeNull();
    expect(document.activeElement).toBe(
      button(view.container, 'Edit “Name the carrier and the new date in every delay notice.”'),
    );
    view.unmount();
  });

  it('says a kept one waits on its check, a refused one why, and a proposal where it is decided', async (): Promise<void> => {
    const calls: string[] = [];
    const view = card([checking, refused, waiting], calls);
    const text = view.container.textContent ?? '';
    expect(text).toContain(
      'Kept. Day0 is checking “Name the carrier first.” against the charter; it takes effect once the check passes.',
    );
    expect(text).toContain('Not kept');
    expect(text).toContain(
      'This would go beyond the charter: it contradicts “email customers directly”. To allow it, amend the charter above.',
    );
    expect(text).toContain('Waiting for you on the Work tab: “Comment, never email.” Open Work');
    expect(
      [...view.container.querySelectorAll('a')].map((link) => link.getAttribute('href')),
    ).toEqual(['/agent/a1/work']);
    await press(view.container, 'Dismiss the refused agreement “Email the customer yourself.”');
    await press(view.container, 'Withdraw “Name the carrier first.”');
    expect(calls).toEqual(['dismiss wa4', 'dismiss wa3']);
    view.unmount();
  });

  it('shows an agreement for every employee held for this one, whatever card kept it, and offers no Dismiss (second pass on W14-R15)', (): void => {
    const held: AgreementView = {
      ...refused,
      _id: 'wa6' as Id<'workingAgreements'>,
      statement: 'Name the vessel in every customer comment.',
      sourceType: 'correction-promotion',
      refusal: { reason: 'unchecked-for-employee' },
    };
    const view = card([held]);
    const text = view.container.textContent ?? '';
    expect(text).toContain('“Name the vessel in every customer comment.”');
    expect(text).toContain('It stays in effect for your other employees.');
    // A hold is in effect for the others: its row is headed Held, not Not kept (14-FX's M2).
    expect(text).toContain('Held');
    expect(text).not.toContain('Not kept');
    expect(view.container.querySelector('[aria-label^="Dismiss"]')).toBeNull();
    // Past the bound nothing can check it, so the row offers no control (15-FX).
    expect(view.container.querySelector('button')).toBeNull();
    view.unmount();
  });

  it('offers Check now on a hold once the owner is back within the bound, and checks it (W14-R15, the lift)', async (): Promise<void> => {
    const held: AgreementView = {
      ...refused,
      _id: 'wa6' as Id<'workingAgreements'>,
      statement: 'Name the vessel in every customer comment.',
      sourceType: 'correction-promotion',
      refusal: { reason: 'unchecked-for-employee', checkable: true },
    };
    const calls: string[] = [];
    const view = card([held], calls);
    // Re-pinned for W15-R37: the sweep checks a hold within half an hour, which the line omitted.
    expect(view.container.textContent).toContain(
      "Not in effect for Priya yet: Day0 has not checked it against Priya's charter. It checks within half an hour, or now with Check now. It stays in effect for your other employees.",
    );
    await press(
      view.container,
      "Check “Name the vessel in every customer comment.” against Priya's charter now",
    );
    expect(calls).toEqual(['recheck wa6']);
    expect(view.container.textContent).toContain("Day0 is checking it against Priya's charter.");
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    expect(underTarget(view.container)).toEqual([]);
    view.unmount();
  });

  it('says a hold two judgements disagreed on, what the one found, and that Check now checks it twice again (RM32 (a); 16-FX’s F1)', async (): Promise<void> => {
    const disputed: AgreementView = {
      ...refused,
      _id: 'wa6' as Id<'workingAgreements'>,
      statement: 'Name the vessel in every customer comment.',
      sourceType: 'correction-promotion',
      refusal: {
        reason: 'unchecked-for-employee',
        checkable: true,
        refusedOnce: { reason: 'widens-scope' },
      },
    };
    const calls: string[] = [];
    const view = card([disputed], calls);
    const text = view.container.textContent ?? '';
    expect(text).toContain('Held');
    expect(text).toContain(
      "Not in effect for Priya: Day0 checked it against Priya's charter twice and the two checks disagreed. One found that it widens the work the charter gives Priya; the other allowed it. It stays in effect for your other employees. Check now checks it twice again: it ends for every employee only if both checks refuse it.",
    );
    // Not checked again by itself, so the row promises no check within the half hour.
    expect(text).not.toContain('within half an hour');
    expect(text).not.toContain('has not checked');
    expect(view.container.querySelector('[aria-label^="Dismiss"]')).toBeNull();
    await press(
      view.container,
      "Check “Name the vessel in every customer comment.” against Priya's charter now",
    );
    expect(calls).toEqual(['recheck wa6']);
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    expect(underTarget(view.container)).toEqual([]);
    view.unmount();
  });

  it('puts a control behind “You can keep it for a single employee instead”, once (W14-R15)', async (): Promise<void> => {
    const tooMany: AgreementView = {
      ...refused,
      _id: 'wa7' as Id<'workingAgreements'>,
      agentId: undefined,
      statement: 'Quote the carrier reference.',
      refusal: { reason: 'every-employee-too-many' },
    };
    const calls: string[] = [];
    const view = card([tooMany], calls);
    expect(view.container.textContent).toContain('You can keep it for a single employee instead.');
    await press(view.container, 'Keep for Priya: “Quote the carrier reference.”');
    expect(calls).toEqual(['one wa7']);
    expect(view.container.textContent).toContain(
      "Kept for Priya once Day0 checks it against Priya's charter.",
    );
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    expect(underTarget(view.container)).toEqual([]);
    view.unmount();
    // Kept for this employee already (in force or waiting on its check): no second keep is offered.
    const kept = card([tooMany, { ...checking, statement: 'Quote the carrier reference.' }]);
    expect(kept.container.querySelector('[aria-label^="Keep for Priya"]')).toBeNull();
    expect(kept.container.querySelector('[aria-label^="Dismiss the refused"]')).not.toBeNull();
    kept.unmount();
  });

  it('says a Check now a pause holds is held until the work resumes, not under way (W15-R37)', async (): Promise<void> => {
    const held: AgreementView = {
      ...refused,
      _id: 'wa6' as Id<'workingAgreements'>,
      statement: 'Name the vessel in every customer comment.',
      sourceType: 'correction-promotion',
      refusal: { reason: 'unchecked-for-employee', checkable: true },
    };
    const view = card([held], [], 'after-pause');
    await press(
      view.container,
      "Check “Name the vessel in every customer comment.” against Priya's charter now",
    );
    expect(said(view.container)).toEqual([
      // The second pass: the check is tried for a quarter of an hour, so a longer pause needs a
      // press after it; the line says so rather than promising the check at the resume.
      "The work is paused, so the check waits: Day0 tries it against Priya's charter after the pause, and if the pause runs long, press Check now again then.",
    ]);
    view.unmount();
  });

  it('offers the keep for this employee when its own agreement in the same words is for other work (W15-R37)', (): void => {
    const tooMany: AgreementView = {
      ...refused,
      _id: 'wa7' as Id<'workingAgreements'>,
      agentId: undefined,
      statement: 'Quote the carrier reference.',
      refusal: { reason: 'every-employee-too-many' },
    };
    const linearOnly: AgreementView = {
      ...own,
      _id: 'wa8' as Id<'workingAgreements'>,
      statement: 'Quote the carrier reference.',
      scope: 'surface',
      scopeRef: 'linear',
    };
    const view = card([tooMany, linearOnly]);
    expect(view.container.querySelector('[aria-label^="Keep for Priya"]')).not.toBeNull();
    view.unmount();
  });

  it('says an owed check on an agreement for every employee it keeps in effect, with Check now (RM28)', async (): Promise<void> => {
    const owed: AgreementView = {
      ...everyone,
      checkOwed: { since: Date.UTC(2026, 9, 3, 9), checkable: true },
    };
    const calls: string[] = [];
    const view = card([owed], calls);
    expect(view.container.textContent).toContain(
      "Not checked since 3 Oct 2026, 09:00 against Priya's amended charter. It stays in effect meanwhile.",
    );
    await press(
      view.container,
      "Check “Thread every reply under the ask.” against Priya's charter now",
    );
    expect(calls).toEqual(['recheck wa2']);
    expect(said(view.container)).toEqual(["Day0 is checking it against Priya's charter."]);
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    expect(underTarget(view.container)).toEqual([]);
    view.unmount();
    // Past the bound nothing can check it, so the line says the bound and offers no Check now.
    const past = card([
      { ...owed, checkOwed: { since: Date.UTC(2026, 9, 3, 9), checkable: false } },
    ]);
    expect(past.container.textContent).toContain(
      "Not checked since 3 Oct 2026, 09:00 against Priya's amended charter: Day0 checks an agreement for every employee only while you have 60 employees or fewer. It stays in effect meanwhile.",
    );
    expect(past.container.querySelector('[aria-label^="Check “"]')).toBeNull();
    past.unmount();
  });

  it('says a check that could not be had once it is stale, and offers Try again (W13-R30)', async (): Promise<void> => {
    vi.setSystemTime((checking.approvedAt ?? 0) + CHECK_STALE_MS + 1);
    const calls: string[] = [];
    const view = card([checking], calls);
    expect(view.container.textContent).toContain(
      'Kept, but Day0 could not check “Name the carrier first.” against the charter yet, so it is not in effect. Try again, or withdraw it.',
    );
    await press(view.container, 'Try the check of “Name the carrier first.” again');
    expect(calls).toEqual(['recheck wa3']);
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    expect(underTarget(view.container)).toEqual([]);
    view.unmount();
  });

  it.each([
    ['empty', []],
    ['in force', [own, everyone]],
    ['waiting and refused', [checking, refused, waiting]],
  ] as const)('has no axe violation and 44 px targets %s', async (_state, rows) => {
    const view = card(rows);
    await settle();
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    expect(underTarget(view.container)).toEqual([]);
    view.unmount();
  });

  it('has no axe violation and 44 px targets while editing', async (): Promise<void> => {
    const view = card([own]);
    await press(view.container, 'Edit “Name the carrier and the new date in every delay notice.”');
    await act(async (): Promise<void> => undefined);
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    expect(underTarget(view.container)).toEqual([]);
    view.unmount();
  });
});
