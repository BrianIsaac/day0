/** @vitest-environment jsdom */

import { getFunctionName } from 'convex/server';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AUTONOMY_TITLES,
  AutonomyConfirm,
  AutonomyControl,
} from '../../../../../app/agent/[agentId]/manage/AutonomyControl';
import { AUTONOMY_WARNING } from '../../../../../src/work/autonomy';
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

/** Press Escape on whatever holds focus, as a person does. */
function escape(): void {
  act((): void => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
}

describe('the header controls say what each change came to and give focus back (step 45, K D6)', (): void => {
  it('turns autonomy on through the confirmation, says so, and hands focus back to the switch', async (): Promise<void> => {
    const calls: boolean[] = [];
    const view = mount(
      <AutonomyControl
        on={false}
        onChange={async (next) => {
          calls.push(next);
        }}
      />,
    );
    await press(view.container, 'Autonomous actions');
    await press(document.body, 'Turn on');

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
        onChange={async () => {
          throw refusal('agents:setAutonomousActions', 'Only the owner can change this.');
        }}
      />,
    );
    await press(view.container, 'Autonomous actions');
    await press(document.body, 'Turn on');

    expect(said(view.container)).toEqual(['Only the owner can change this.']);
    expect(focusedName()).toBe('Turn on');
    await press(document.body, 'Cancel');
    expect(focusedName()).toBe('Autonomous actions');
    view.unmount();
  });

  it('gives the switch a 44 px target around its track, drawn 24 by 44', (): void => {
    const view = mount(<AutonomyControl on={false} onChange={async () => undefined} />);
    const toggle = button(view.container, 'Autonomous actions');
    expect(toggle.className).toMatch(/\bmin-h-11\b.*\bmin-w-11\b/);
    expect(toggle.querySelector('[aria-hidden="true"]')?.className).toMatch(/\bh-6\b.*\bw-11\b/);
    view.unmount();
  });

  it('cancels the confirmation on Escape and hands focus back to the switch, unless the change is in flight', async (): Promise<void> => {
    const calls: boolean[] = [];
    const view = mount(
      <AutonomyControl
        on={false}
        onChange={async (next) => {
          calls.push(next);
        }}
      />,
    );
    await press(view.container, 'Autonomous actions');
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
    if (!dialog) throw new Error('no confirmation');
    expect(focusedName()).toBe('Cancel');
    escape();

    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(focusedName()).toBe('Autonomous actions');
    expect(calls).toEqual([]);
    view.unmount();

    const busy = mount(
      <AutonomyConfirm busy onConfirm={() => undefined} onCancel={() => calls.push(false)} />,
    );
    const held = document.querySelector<HTMLElement>('[role="alertdialog"]');
    if (!held) throw new Error('no confirmation');
    act((): void => {
      held.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(calls).toEqual([]);
    expect(held.isConnected).toBe(true);
    busy.unmount();
  });

  it('names the state the switch is in, off and on, and keeps the warning for the confirmation', (): void => {
    const off = renderToStaticMarkup(
      <AutonomyControl on={false} onChange={async (): Promise<void> => undefined} />,
    );
    expect(off).toContain('Autonomous actions');
    expect(off).toContain(AUTONOMY_TITLES.off);
    expect(off).toMatch(
      /<button[^>]*role="switch"[^>]*aria-checked="false"[^>]*aria-label="Autonomous actions"/,
    );
    expect(off).not.toContain(AUTONOMY_WARNING);
    expect(off).not.toContain('supervised posture');
    const on = renderToStaticMarkup(
      <AutonomyControl on onChange={async (): Promise<void> => undefined} />,
    );
    expect(on).toContain(AUTONOMY_TITLES.on);
    expect(on).toMatch(/<button[^>]*role="switch"[^>]*aria-checked="true"/);
    expect(on).not.toContain(AUTONOMY_WARNING);
  });

  it("confirms in the product's one dialog, the warning in the operator's words and Cancel first", (): void => {
    const view = mount(<AutonomyConfirm onConfirm={() => undefined} onCancel={() => undefined} />);
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
    if (!dialog) throw new Error('no confirmation');
    // The shared dialog carries M's scale-in moment and is named by its heading.
    expect(dialog.hasAttribute('data-dialog')).toBe(true);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const heading = document.getElementById(dialog.getAttribute('aria-labelledby') ?? '');
    expect(heading?.textContent).toBe('Turn on autonomous actions?');
    expect(dialog.textContent).toContain(
      'The digital employee will act on connected systems without asking - post, comment, change status - within the connections and skills you have approved.',
    );
    expect(dialog.textContent).toContain(
      'Turn this on only after its behaviour has been what you want.',
    );
    expect(dialog.textContent).toContain(
      'Skills and connections still need your approval either way.',
    );
    expect(focusedName()).toBe('Cancel');
    expect([...dialog.querySelectorAll('button')].map((control) => control.textContent)).toEqual([
      'Cancel',
      'Turn on',
    ]);
    view.unmount();

    const busy = mount(
      <AutonomyConfirm busy onConfirm={() => undefined} onCancel={() => undefined} />,
    );
    const turnOn = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Turn on',
    );
    expect(turnOn?.disabled).toBe(true);
    busy.unmount();
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
