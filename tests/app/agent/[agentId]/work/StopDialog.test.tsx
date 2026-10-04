/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest';
import {
  StopDialog,
  stopDialogDescription,
  stoppedOutcome,
  stopWhy,
} from '../../../../../app/agent/[agentId]/work/StopDialog';
import { axeViolations } from '../../../../fixtures/dom/axe';
import { focusedName, mount, press, said, typeInto } from '../../../../fixtures/dom/press';

/** The dialog over an empty page, with every call it makes recorded. */
function opened(options: { applying?: boolean; refuse?: boolean } = {}) {
  const calls: Array<[string, unknown]> = [];
  const view = mount(
    <StopDialog
      title="Close the Q3 audit note"
      employeeName="Mira"
      applying={options.applying ?? false}
      onStop={async (reason): Promise<void> => {
        calls.push(['stop', reason]);
        if (options.refuse) throw new Error('Only work under way can be stopped.');
      }}
      onClose={(): void => {
        calls.push(['close', undefined]);
      }}
      onDone={(words): void => {
        calls.push(['done', words]);
      }}
    />,
  );
  return { ...view, calls };
}

describe('StopDialog', (): void => {
  it('names what it stops, says what stopping does, and holds focus on Keep working', (): void => {
    const view = opened();
    const dialog = document.body.querySelector('[role="alertdialog"]');
    expect(dialog?.querySelector('h2')?.textContent).toBe(
      'Stop work on “Close the Q3 audit note”?',
    );
    expect(dialog?.textContent).toContain(stopDialogDescription('Mira', false));
    expect(focusedName()).toBe('Keep working');
    view.unmount();
  });

  it('stops with the reason trimmed, then hands the card its words', async (): Promise<void> => {
    const view = opened();
    typeInto(
      document.body.querySelector<HTMLInputElement>('input[name="reason"]')!,
      '  Wrong ticket.  ',
    );
    await press(document.body, 'Stop the run');
    expect(view.calls).toEqual([
      ['stop', 'Wrong ticket.'],
      ['done', stoppedOutcome('Close the Q3 audit note')],
    ]);
    view.unmount();
  });

  it('says a refusal inside the dialog and stays open', async (): Promise<void> => {
    const view = opened({ refuse: true });
    await press(document.body, 'Stop the run');
    expect(said(document.body)).toEqual(['Only work under way can be stopped.']);
    expect(view.calls.map(([name]) => name)).toEqual(['stop']);
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull();
    view.unmount();
  });

  it('has no axe violation and gives every control a 44 px target', async (): Promise<void> => {
    const view = opened({ applying: true });
    const dialog = document.body.querySelector('[role="alertdialog"]')!;
    expect(await axeViolations(dialog, ['region'])).toEqual([]);
    for (const control of dialog.querySelectorAll('button, input')) {
      const box = `${control.getAttribute('class') ?? ''} ${control.closest('label')?.getAttribute('class') ?? ''}`;
      expect(box, control.outerHTML.slice(0, 80)).toMatch(/(^|\s)(min-h-11|h-11)(\s|$)/);
    }
    view.unmount();
  });

  it('says what the Stop control does and what a stop came to, in words for the card', (): void => {
    expect(stopWhy('the employee')).toBe(
      'The employee, once stopped, sends nothing more, and the item waits for you with Retry.',
    );
    expect(stoppedOutcome('Close the Q3 audit note')).toBe(
      'Stopped: Close the Q3 audit note. It waits for you with Retry.',
    );
  });
});
