/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest';
import {
  StopDialog,
  stopDialogDescription,
  stoppedOutcome,
  stopWhy,
  type StopMoment,
} from '../../../../../app/agent/[agentId]/work/StopDialog';
import { STOP_MOVED_ON, type StopRunAnswer } from '../../../../../src/work/stop';
import { axeViolations } from '../../../../fixtures/dom/axe';
import { focusedName, mount, press, said, typeInto } from '../../../../fixtures/dom/press';

/** The dialog over an empty page, with every call it makes recorded. */
function opened(options: { moment?: StopMoment; refuse?: boolean; answer?: StopRunAnswer } = {}) {
  const calls: Array<[string, unknown]> = [];
  const view = mount(
    <StopDialog
      title="Close the Q3 audit note"
      employeeName="Mira"
      moment={options.moment ?? 'working'}
      onStop={async (reason): Promise<StopRunAnswer> => {
        calls.push(['stop', reason]);
        if (options.refuse) throw new Error('The connection to the server was lost.');
        return options.answer ?? { ok: true };
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
    expect(dialog?.textContent).toContain(stopDialogDescription('Mira', 'working'));
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

  it('says an error inside the dialog and stays open', async (): Promise<void> => {
    const view = opened({ refuse: true });
    await press(document.body, 'Stop the run');
    expect(said(document.body)).toEqual(['The connection to the server was lost.']);
    expect(view.calls.map(([name]) => name)).toEqual(['stop']);
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull();
    view.unmount();
  });

  it('hands the card what happened when the item moved on before the Stop arrived (13-FD)', async (): Promise<void> => {
    const view = opened({ answer: { ok: false, refused: 'moved-on' } });
    await press(document.body, 'Stop the run');
    expect(view.calls).toEqual([
      ['stop', ''],
      ['done', STOP_MOVED_ON],
    ]);
    expect(said(document.body)).toEqual([STOP_MOVED_ON]);
    view.unmount();
  });

  it('has no axe violation and gives every control a 44 px target', async (): Promise<void> => {
    const view = opened({ moment: 'applying' });
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

  it('says an approval not yet started is taken back and none of its writes is sent (W12-R14, D-7 (b))', async (): Promise<void> => {
    const view = opened({ moment: 'approved' });
    const dialog = document.body.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain(
      'Mira has not started sending the writes you approved. Stopping takes your approval back: none of them is sent, and the item waits for you, stopped, with Retry.',
    );
    expect(focusedName()).toBe('Keep the approval');
    expect(dialog?.querySelector('h2')?.textContent).toBe(
      'Take back your approval for “Close the Q3 audit note”?',
    );
    await press(document.body, 'Take the approval back');
    expect(view.calls).toEqual([
      ['stop', ''],
      ['done', 'Approval taken back: Close the Q3 audit note. It waits for you with Retry.'],
    ]);
    view.unmount();
    expect(stopWhy('Mira', 'approved')).toBe(
      'Mira has not sent the writes you approved yet. Stop takes your approval back and sends none of them.',
    );
  });
});
