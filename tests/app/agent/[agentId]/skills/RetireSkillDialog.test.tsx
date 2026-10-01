/** @vitest-environment jsdom */

import { act } from 'react';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Doc } from '../../../../../convex/_generated/dataModel';
import { RetireSkillDialog } from '../../../../../app/agent/[agentId]/skills/RetireSkillDialog';
import { axeViolations } from '../../../../fixtures/dom/axe';
import { focusedName, mount, press, said, settle, typeInto } from '../../../../fixtures/dom/press';
import { underTarget } from '../../../../fixtures/dom/targets';

const backend = vi.hoisted(() => ({
  refusals: {} as Record<string, string>,
  results: {} as Record<string, unknown>,
  calls: [] as Array<{ name: string; args: unknown }>,
  queries: {} as Record<string, unknown>,
}));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args: unknown): unknown =>
    args === 'skip' ? undefined : backend.queries[getFunctionName(reference as never)],
  useMutation:
    (reference: unknown) =>
    async (args?: unknown): Promise<unknown> => {
      const name = getFunctionName(reference as never);
      backend.calls.push({ name, args });
      const refusal = backend.refusals[name];
      if (refusal !== undefined) throw new Error(refusal);
      return backend.results[name];
    },
}));

const SKILL = {
  _id: 'skill-1',
  _creationTime: 1,
  agentId: 'agent-1',
  name: 'kanban-comment-and-close',
  description: 'Comment on a ticket and close it.',
  body: '# Close',
  sourceType: 'agent-authored',
  state: 'registered',
  versionId: 'version-1',
  createdAt: 1,
} as unknown as Doc<'skills'>;

const VERSION = { _id: 'version-1', version: 2, name: 'kanban-comment-and-close' };

/** What `skillVersions.forSkill` answers for a version held by the given employees. */
function heldBy(...holders: Array<[string, string, string]>): unknown {
  return {
    held: {
      version: VERSION,
      holders: holders.map(([skillId, agentName, state]) => ({
        skillId,
        agentId: `agent-of-${agentName}`,
        agentName,
        state,
      })),
    },
    offered: null,
  };
}

afterEach((): void => {
  backend.refusals = {};
  backend.results = {};
  backend.calls = [];
  backend.queries = {};
  document.body.replaceChildren();
});

function open(onDone = vi.fn(), onClose = vi.fn()) {
  const view = mount(
    <RetireSkillDialog skill={SKILL} employee="Mira" onClose={onClose} onDone={onDone} />,
  );
  return { view, onDone, onClose };
}

describe('RetireSkillDialog', (): void => {
  it('retires the skill from one employee with the reason, keeping focus on the safe choice first', async (): Promise<void> => {
    backend.queries = { 'skillVersions:forSkill': heldBy(['skill-1', 'Mira', 'registered']) };
    backend.results = { 'skillControls:retire': { retired: true, returnedItems: 1 } };
    const { view, onDone } = open();
    await settle();

    expect(focusedName()).toBe('Keep it');
    expect(document.body.textContent).toContain(
      'Retire Comment on a ticket and close it from Mira?',
    );
    // One holder: nothing to withdraw from anyone else.
    expect(document.body.querySelector('input[type="radio"]')).toBeNull();
    const reason = document.body.querySelector('input[name="reason"]') as HTMLInputElement;
    typeInto(reason, 'it closes the wrong tickets');
    await press(document.body, 'Retire from Mira');

    expect(backend.calls).toEqual([
      {
        name: 'skillControls:retire',
        args: { skillId: 'skill-1', reason: 'it closes the wrong tickets' },
      },
    ]);
    expect(onDone).toHaveBeenCalledWith(
      'kanban-comment-and-close is retired from Mira. 1 approved item waits for a skill again.',
    );
    view.unmount();
  });

  it('offers Withdraw for every employee when the version has more than one holder (A12)', async (): Promise<void> => {
    backend.queries = {
      'skillVersions:forSkill': heldBy(
        ['skill-1', 'Mira', 'registered'],
        ['skill-2', 'Tomas', 'registered'],
        ['skill-3', 'Aiko', 'retired'],
      ),
    };
    backend.results = {
      'skillControls:withdraw': { withdrawn: true, holders: 2, returnedItems: 1 },
    };
    const { view, onDone } = open();
    await settle();

    const choices = [...document.body.querySelectorAll('input[type="radio"]')].map((input) =>
      (input.closest('label')?.textContent ?? '').trim(),
    );
    expect(choices).toEqual([
      'Only MiraTomas keeps running version 2.',
      'Every employee who runs it: Mira and TomasVersion 2 is withdrawn: nobody runs it and it is offered to nobody.',
    ]);
    const every = document.body.querySelectorAll('input[type="radio"]')[1] as HTMLInputElement;
    await act(async (): Promise<void> => {
      every.click();
    });
    // The question follows the choice.
    expect(document.body.querySelector('h2')?.textContent).toBe(
      'Withdraw Comment on a ticket and close it from every employee?',
    );
    expect(document.body.textContent).toContain('Mira and Tomas stop running this skill now.');
    await press(document.body, 'Withdraw from 2 employees');

    expect(backend.calls).toEqual([
      { name: 'skillControls:withdraw', args: { skillId: 'skill-1' } },
    ]);
    expect(onDone).toHaveBeenCalledWith(
      'kanban-comment-and-close is withdrawn from 2 employees. 1 approved item waits for a skill again.',
    );
    view.unmount();
  });

  it('says a revision being written ends with the retire', async (): Promise<void> => {
    backend.queries = { 'skillVersions:forSkill': heldBy(['skill-1', 'Mira', 'registered']) };
    const view = mount(
      <RetireSkillDialog
        skill={SKILL}
        employee="Mira"
        revisionOpen
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    await settle();
    expect(document.body.textContent).toContain('The revision being written for it ends too.');
    view.unmount();
  });

  it('says a refusal inside the dialog and leaves it open', async (): Promise<void> => {
    backend.queries = { 'skillVersions:forSkill': heldBy(['skill-1', 'Mira', 'registered']) };
    backend.refusals = {
      'skillControls:retire':
        'Only a callable skill is retired; kanban-comment-and-close is failed.',
    };
    const { view, onDone } = open();
    await settle();

    await press(document.body, 'Retire from Mira');

    expect(said(document.body)).toContain(
      'Only a callable skill is retired; kanban-comment-and-close is failed.',
    );
    expect(onDone).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull();
    view.unmount();
  });

  it('waits for the holders before it offers anything to press', async (): Promise<void> => {
    const { view } = open();
    await settle();

    expect(document.body.textContent).toContain('Finding who runs this skill');
    const submit = [...document.body.querySelectorAll('button')].find(
      (control) => control.textContent === 'Retire from Mira',
    );
    expect(submit?.disabled).toBe(true);
    view.unmount();
  });

  it('has no axe violation and a 44 px target on every control, with one holder and with two', async (): Promise<void> => {
    for (const held of [
      heldBy(['skill-1', 'Mira', 'registered']),
      heldBy(['skill-1', 'Mira', 'registered'], ['skill-2', 'Tomas', 'registered']),
    ]) {
      backend.queries = { 'skillVersions:forSkill': held };
      const { view } = open();
      await settle();
      expect(await axeViolations(document.body, ['region'])).toEqual([]);
      expect(underTarget(document.body)).toEqual([]);
      view.unmount();
      document.body.replaceChildren();
    }
  }, 30_000);
});
