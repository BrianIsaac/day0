/** @vitest-environment jsdom */

import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Id } from '../../../../../convex/_generated/dataModel';
import {
  AdoptionCard,
  type Adoption,
} from '../../../../../app/agent/[agentId]/skills/AdoptionCard';
import { AgentZoneContext } from '../../../../../app/components/time';
import { HANDED_OVER_AUTHOR_NAME } from '../../../../../src/work/skill-library';
import {
  ADOPTION_CARD_STATES,
  type AdoptionCardState,
} from '../../../../../src/work/skill-adoption';
import { axeViolations } from '../../../../fixtures/dom/axe';
import { mount, press, unmountAll } from '../../../../fixtures/dom/press';
import { underTarget } from '../../../../fixtures/dom/targets';

/**
 * The adoption card (A3, 10-A): a sibling's verified skill offered in place of writing one, in
 * every state of the decision, against the accessibility floor (N14). It replaces the adoption
 * row, whose pin (no promise of what the product does not do, no "agent") moves here.
 */

const OFFER: Adoption = {
  skillId: 'skill-1' as Id<'skills'>,
  name: 'kanban-comment-and-close',
  description: 'Ticket comment-and-close on a kanban surface.',
  state: 'offered',
  rowState: 'proposed',
  versionId: 'version-1' as Id<'skillVersions'>,
  version: 2,
  authorName: 'Priya',
  verifiedAt: Date.UTC(2026, 8, 18, 9),
  connection: 'Linear',
  missingScopes: ['linear:write'],
};

const LOG =
  'verification in the local sandbox (local:1) failed - smoke.py exited 1\n\nstderr:\nKeyError';

/** What each press reached. */
const pressed: string[] = [];

function card(
  state: AdoptionCardState,
  adoption: Partial<Adoption> = {},
  writeRefusal?: string,
): ReactNode {
  return (
    <AgentZoneContext value="UTC">
      <AdoptionCard
        adoption={{ ...OFFER, ...adoption }}
        state={state}
        adopterName="Mateo"
        writeRefusal={writeRefusal}
        busy={false}
        onAdopt={() => void pressed.push('adopt')}
        onCheckAgain={() => void pressed.push('check')}
        onWriteNew={() => void pressed.push('write')}
        onDecline={() => void pressed.push('decline')}
      />
    </AgentZoneContext>
  );
}

function buttonNames(root: Element): string[] {
  return [...root.querySelectorAll('button')].map(
    (control) => `${control.textContent?.trim()} | ${control.getAttribute('aria-label')}`,
  );
}

afterEach((): void => {
  pressed.length = 0;
  unmountAll();
});

describe('AdoptionCard', (): void => {
  it("says whose skill does this, that it is checked again under the employee's own connection, and the scope it would gain", (): void => {
    const view = mount(card('offered'));
    const text = view.container.textContent ?? '';
    expect(text).toContain(
      "Priya's skill kanban-comment-and-close, verified on 18 September 2026, does this. Mateo can adopt it. It would be re-verified in the sandbox under Mateo's Linear connection before Mateo can use it.",
    );
    expect(text).toContain('Scopes Mateo would gain: linear:write');
    expect(buttonNames(view.container)).toEqual([
      'Adopt for Mateo | Adopt for Mateo: kanban-comment-and-close',
      'Write a new one instead | Write a new one instead of kanban-comment-and-close',
      'Decline | Decline kanban-comment-and-close',
    ]);
    // The adoption row's pin, re-pinned: no promise of what the product does not do, no "agent".
    expect(text).not.toMatch(/\byet\b/);
    expect(text).not.toMatch(/\bagent\b/i);
  });

  it('presses through to Adopt, Write a new one instead and Decline', async (): Promise<void> => {
    const view = mount(card('offered'));
    await press(view.container, 'Adopt for Mateo: kanban-comment-and-close');
    await press(view.container, 'Write a new one instead of kanban-comment-and-close');
    await press(view.container, 'Decline kanban-comment-and-close');
    expect(pressed).toEqual(['adopt', 'write', 'decline']);
  });

  it('says when the employee already holds every scope, and the sandbox alone where no connection is named', (): void => {
    const view = mount(card('offered', { missingScopes: [], connection: undefined }));
    const text = view.container.textContent ?? '';
    expect(text).toContain('Mateo already holds every scope the skill needs.');
    expect(text).toContain('It would be re-verified in the sandbox before Mateo can use it.');
  });

  it('withholds Adopt with the reason when the offer no longer stands, and Write a new one instead too when the approval would be refused', (): void => {
    const refused = mount(
      card('offered', { refusal: 'the approved tools of Linear do not include save_comment' }),
    );
    expect(refused.container.textContent).toContain(
      'Cannot adopt now: the approved tools of Linear do not include save_comment',
    );
    const [adopt, write] = refused.container.querySelectorAll('button');
    expect(adopt?.disabled).toBe(true);
    expect(adopt?.title).toBe('the approved tools of Linear do not include save_comment');
    expect(write?.disabled).toBe(false);
    const unconnected = mount(card('offered', {}, 'surface linear is listed-dead'));
    const controls = [...unconnected.container.querySelectorAll('button')];
    expect(controls.map((control) => control.disabled)).toEqual([true, true, false]);
    expect(unconnected.container.textContent).toContain(
      'Cannot approve yet: surface linear is listed-dead Surfaces tab',
    );
    expect(unconnected.container.querySelector('a[href="#surfaces"]')).not.toBeNull();
    expect(unconnected.container.textContent).not.toContain('Cannot adopt now');
  });

  it('words a copy handed over from another manager as its own case', (): void => {
    const view = mount(card('offered', { authorName: HANDED_OVER_AUTHOR_NAME }));
    const text = view.container.textContent ?? '';
    expect(text).toContain(
      'The skill kanban-comment-and-close, which came with an employee handed over to you and was verified on 18 September 2026, does this.',
    );
    expect(text).not.toContain(HANDED_OVER_AUTHOR_NAME);
  });

  it('offers nothing to press while the sandbox checks it again', (): void => {
    const view = mount(card('verifying', { state: 'verifying', missingScopes: [] }));
    expect(view.container.textContent).toContain(
      "Adopting Priya's skill kanban-comment-and-close for Mateo. It is being re-verified in the sandbox under Mateo's Linear connection. Mateo can use it once the check passes; there is nothing to press until then.",
    );
    expect(view.container.querySelectorAll('button')).toHaveLength(0);
  });

  it('says a check that stopped short with why, and offers Check it again, Write a new one instead and Decline', async (): Promise<void> => {
    const stopped =
      'the stored skill was not verified: no sandbox backend answered; Retry runs its check';
    const view = mount(
      card('stalled', {
        state: 'verifying',
        rowState: 'authoring',
        missingScopes: [],
        log: stopped,
      }),
    );
    expect(view.container.textContent).toContain(
      "Adopting Priya's skill kanban-comment-and-close for Mateo stopped before the sandbox finished checking it. Mateo cannot use it yet.",
    );
    expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(buttonNames(view.container)).toEqual([
      'Check it again | Check it again: kanban-comment-and-close',
      'Write a new one instead | Write a new one instead of kanban-comment-and-close',
      'Decline | Decline kanban-comment-and-close',
    ]);
    await press(view.container, 'Check it again: kanban-comment-and-close');
    expect(pressed).toEqual(['check']);
    const withdrawn = mount(
      card('stalled', {
        state: 'verifying',
        rowState: 'approved',
        refusal: 'the offered skill was withdrawn from every employee',
      }),
    );
    expect(withdrawn.container.textContent).toContain(
      'Cannot check it again: the offered skill was withdrawn from every employee',
    );
    expect(withdrawn.container.querySelector('button')?.disabled).toBe(true);
  });

  it('shows a failed check with its log, and offers Write a new one instead and Decline', (): void => {
    const view = mount(card('failed', { state: 'failed', missingScopes: [], log: LOG }));
    expect(view.container.textContent).toContain(
      "Priya's skill kanban-comment-and-close failed its re-verification for Mateo. Mateo cannot use it, and keeps the scopes the adoption granted.",
    );
    const log = view.container.querySelector('[role="region"]');
    expect(log?.getAttribute('aria-label')).toBe('Verification log: kanban-comment-and-close');
    expect(log?.textContent).toBe(LOG);
    expect(buttonNames(view.container)).toEqual([
      'Write a new one instead | Write a new one instead of kanban-comment-and-close',
      'Decline | Decline kanban-comment-and-close',
    ]);
  });

  it('says a declined adoption and offers nothing more', (): void => {
    const view = mount(card('declined'));
    expect(view.container.textContent).toContain(
      "You declined Priya's skill kanban-comment-and-close for Mateo. Mateo will not adopt it, and the work waiting for it was cancelled.",
    );
    expect(view.container.querySelectorAll('button')).toHaveLength(0);
  });

  for (const state of ADOPTION_CARD_STATES) {
    it(`has no axe violation and a 44 px target on every control when ${state}`, async (): Promise<void> => {
      const view = mount(card(state, { log: LOG }));
      expect(await axeViolations(view.container, ['region'])).toEqual([]);
      expect(underTarget(view.container)).toEqual([]);
    }, 30_000);
  }
});
