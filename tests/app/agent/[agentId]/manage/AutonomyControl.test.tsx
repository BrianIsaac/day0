/** @vitest-environment jsdom */

import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';
import { AutonomyControl } from '../../../../../app/agent/[agentId]/manage/AutonomyControl';
import { ManagerLine } from '../../../../../app/agent/[agentId]/EmployeeHeader';
import { NotificationModeControl } from '../../../../../app/agent/[agentId]/manage/NotificationModeControl';
import {
  button,
  choose,
  focusedName,
  mount,
  press,
  said,
  typeInto,
} from '../../../../fixtures/dom/press';

const backend = vi.hoisted(() => ({
  /** Mutations and actions that reject, by function name, with the text they reject with. */
  refusals: {} as Record<string, string>,
  /** What a mutation or action resolves with, by function name; undefined otherwise. */
  results: {} as Record<string, unknown>,
  /** Every call made, by function name, with its arguments. */
  calls: [] as Array<{ name: string; args: unknown }>,
  /** What a query answers, by function name; undefined (loading) otherwise. */
  queries: {} as Record<string, unknown>,
}));

vi.mock('convex/react', () => {
  const call =
    (reference: unknown): ((args?: unknown) => Promise<unknown>) =>
    async (args?: unknown): Promise<unknown> => {
      const name = getFunctionName(reference as never);
      backend.calls.push({ name, args });
      const refusal = backend.refusals[name];
      if (refusal !== undefined) throw new Error(refusal);
      return backend.results[name];
    };
  return {
    useQuery: (reference: unknown): unknown => backend.queries[getFunctionName(reference as never)],
    useMutation: call,
    useAction: call,
  };
});

/** A backend refusal as it reaches the browser: the transport's envelope around the sentence. */
function refusal(call: string, sentence: string): Error {
  return new Error(
    `[CONVEX M(${call})] [Request ID: 1] Server Error\nUncaught Error: ${sentence}\n    at handler (../convex/x.ts:1:1)`,
  );
}

describe('the header controls say what each change came to and give focus back (step 45, K D6)', (): void => {
  it('turns autonomy on through the confirmation, says so, and hands focus back to the switch', async (): Promise<void> => {
    const calls: boolean[] = [];
    const view = mount(
      <AutonomyControl
        on={false}
        tone=""
        onChange={async (next) => {
          calls.push(next);
        }}
      />,
    );
    await press(view.container, 'Autonomous actions');
    await press(view.container, 'Turn on');

    expect(calls).toEqual([true]);
    expect(said(view.container)).toEqual([
      'Autonomous actions are on: the employee acts on connected systems without asking.',
    ]);
    expect(focusedName()).toBe('Autonomous actions');
    expect(view.container.querySelector('[role="alertdialog"]')).toBeNull();
    view.unmount();
  });

  it('keeps the confirmation open on a refusal, says why, and gives Cancel focus back to the switch', async (): Promise<void> => {
    const view = mount(
      <AutonomyControl
        on={false}
        tone=""
        onChange={async () => {
          throw refusal('agents:setAutonomousActions', 'Only the owner can change this.');
        }}
      />,
    );
    await press(view.container, 'Autonomous actions');
    await press(view.container, 'Turn on');

    expect(said(view.container)).toEqual(['Only the owner can change this.']);
    expect(focusedName()).toBe('Turn on');
    await press(view.container, 'Cancel');
    expect(focusedName()).toBe('Autonomous actions');
    view.unmount();
  });

  it('gives the switch a 44 px target around its drawn track', (): void => {
    const view = mount(<AutonomyControl on={false} tone="" onChange={async () => undefined} />);
    expect(button(view.container, 'Autonomous actions').className).toMatch(
      /\bmin-h-11\b.*\bmin-w-11\b/,
    );
    view.unmount();
  });

  it('says the manager DM setting it saved, and the refusal when it did not', async (): Promise<void> => {
    const saved = mount(
      <NotificationModeControl mode="per-run" onChange={async () => undefined} />,
    );
    const select = saved.container.querySelector('select');
    if (!select) throw new Error('no select');
    await choose(select, 'digest');
    expect(said(saved.container)).toEqual(['Manager DMs: hourly digest.']);
    expect(document.activeElement).toBe(select);
    saved.unmount();

    const refused = mount(
      <NotificationModeControl
        mode="per-run"
        onChange={async () => {
          throw refusal('agents:setManagerNotifications', 'No manager channel is connected.');
        }}
      />,
    );
    const again = refused.container.querySelector('select');
    if (!again) throw new Error('no select');
    await choose(again, 'digest');
    expect(said(refused.container)).toEqual(['No manager channel is connected.']);
    refused.unmount();
  });

  it('changes the manager, says who the employee reports to now, and gives focus back to Change manager', async (): Promise<void> => {
    const sent: string[] = [];
    const view = mount(
      <ManagerLine
        bossEmail="boss@day0.local"
        onChange={async (next) => {
          sent.push(next);
        }}
      />,
    );
    await press(view.container, 'Change manager');
    const field = view.container.querySelector<HTMLInputElement>('#manager-email');
    if (!field) throw new Error('no field');
    typeInto(field, ' lead@day0.local ');
    await press(view.container, 'Save');

    expect(sent).toEqual(['lead@day0.local']);
    expect(said(view.container)).toEqual(['The employee now reports to lead@day0.local.']);
    expect(focusedName()).toBe('Change manager');
    view.unmount();
  });

  it('keeps the editor open on a refusal and says it without the envelope', async (): Promise<void> => {
    const view = mount(
      <ManagerLine
        bossEmail="boss@day0.local"
        onChange={async () => {
          throw refusal('agents:setBossEmail', 'That is not an e-mail address.');
        }}
      />,
    );
    await press(view.container, 'Change manager');
    await press(view.container, 'Save');

    expect(said(view.container)).toEqual(['That is not an e-mail address.']);
    expect(focusedName()).toBe('Save');
    view.unmount();
  });
});
