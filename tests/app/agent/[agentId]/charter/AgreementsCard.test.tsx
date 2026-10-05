/** @vitest-environment jsdom */

import { act } from 'react';
import type { Id } from '../../../../../convex/_generated/dataModel';
import { afterEach, describe, expect, it } from 'vitest';
import { AgreementsCard } from '../../../../../app/agent/[agentId]/charter/AgreementsCard';
import type { AgreementView } from '../../../../../src/work/agreement-words';
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

afterEach((): void => {
  document.body.replaceChildren();
});

function card(rows: readonly AgreementView[], calls: string[] = []): ReturnType<typeof mount> {
  return mount(
    <AgentZoneContext.Provider value="UTC">
      <AgreementsCard
        agreements={rows}
        employeeName="Priya"
        workHref="/agent/a1/work"
        onKeepForEveryEmployee={async (id) => {
          calls.push(`every ${id}`);
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
