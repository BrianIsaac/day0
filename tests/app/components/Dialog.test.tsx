/** @vitest-environment jsdom */

import { act, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog, DialogFooter } from '../../../app/components/Dialog';
import { focusableIn } from '../../../app/components/use-modal';
import { mount, press } from '../../fixtures/dom/press';

afterEach((): void => {
  document.body.replaceChildren();
});

/** A page with one button that opens a dialog of two buttons and a field. */
function Page({ busy = false, safe = false }: { busy?: boolean; safe?: boolean }) {
  const [open, setOpen] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Retire Mira…
      </button>
      {open ? (
        <Dialog
          title="Retire Mira?"
          onClose={() => setOpen(false)}
          busy={busy}
          initialFocus={safe ? keep : undefined}
        >
          <input aria-label="Confirm" />
          <button ref={keep} type="button" onClick={() => setOpen(false)}>
            Keep Mira
          </button>
          <button type="button">Retire</button>
        </Dialog>
      ) : null}
    </>
  );
}

/** Dispatch a key press on the element that holds focus. */
function key(name: string, shiftKey = false): void {
  act((): void => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true }),
    );
  });
}

describe('Dialog', () => {
  it('is a modal named by its title', async () => {
    const view = mount(<Page />);
    await press(view.container, 'Retire Mira…');
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(
      document.getElementById(dialog?.getAttribute('aria-labelledby') ?? '')?.textContent,
    ).toBe('Retire Mira?');
    view.unmount();
  });

  it('binds its description, so the sentence under the title is said with its name (m2)', () => {
    const view = mount(
      <Dialog
        role="alertdialog"
        title="Retire Mira?"
        description="It cannot be undone."
        onClose={() => undefined}
      >
        <button type="button">Keep Mira</button>
      </Dialog>,
    );
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(
      document.getElementById(dialog?.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('It cannot be undone.');
    view.unmount();
    const plain = mount(
      <Dialog title="t" onClose={() => undefined}>
        <button type="button">Inside</button>
      </Dialog>,
    );
    expect(document.querySelector('[role="dialog"]')?.hasAttribute('aria-describedby')).toBe(false);
    plain.unmount();
  });

  it('moves focus to its first control on open, or to the safe choice it names', async () => {
    const view = mount(<Page />);
    await press(view.container, 'Retire Mira…');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Confirm');
    view.unmount();
    const safe = mount(<Page safe />);
    await press(safe.container, 'Retire Mira…');
    expect(document.activeElement?.textContent).toBe('Keep Mira');
    safe.unmount();
  });

  it('keeps Tab inside it, wrapping at both ends', async () => {
    const view = mount(<Page />);
    await press(view.container, 'Retire Mira…');
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const controls = dialog ? focusableIn(dialog) : [];
    expect(
      controls.map((control) => control.textContent || control.getAttribute('aria-label')),
    ).toEqual(['Confirm', 'Keep Mira', 'Retire']);
    controls[2]?.focus();
    key('Tab');
    expect(document.activeElement).toBe(controls[0]);
    key('Tab', true);
    expect(document.activeElement).toBe(controls[2]);
    view.unmount();
  });

  it('closes on Escape and hands focus back to what opened it', async () => {
    const view = mount(<Page />);
    await press(view.container, 'Retire Mira…');
    key('Escape');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement?.textContent).toBe('Retire Mira…');
    view.unmount();
  });

  it('hands focus back when a control inside closes it', async () => {
    const view = mount(<Page />);
    await press(view.container, 'Retire Mira…');
    await press(document.body, 'Keep Mira');
    expect(document.activeElement?.textContent).toBe('Retire Mira…');
    view.unmount();
  });

  it('cannot be dismissed while a change is in flight', async () => {
    const view = mount(<Page busy />);
    await press(view.container, 'Retire Mira…');
    key('Escape');
    const backdrop = document.querySelector('[data-dialog-backdrop]');
    act((): void => {
      backdrop?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    view.unmount();
  });

  it('keeps focus inside when the dimmed page is pressed while a change is in flight, so Escape still works (m1)', async () => {
    const view = mount(<Page busy />);
    await press(view.container, 'Retire Mira…');
    const pressed = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act((): void => {
      document.querySelector('[data-dialog-backdrop]')?.dispatchEvent(pressed);
    });
    // The browser moves focus to the body on a mousedown nobody prevented.
    expect(pressed.defaultPrevented).toBe(true);
    expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
    view.unmount();
  });

  it('closes on a press on the dimmed page, not on a press inside it', async () => {
    const onClose = vi.fn();
    const view = mount(
      <Dialog title="t" onClose={onClose}>
        <button type="button">Inside</button>
      </Dialog>,
    );
    act((): void => {
      document
        .querySelector('[role="dialog"]')
        ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    act((): void => {
      document
        .querySelector('[data-dialog-backdrop]')
        ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('plays the one dialog motion, the panel and the backdrop marked for it', () => {
    const view = mount(
      <Dialog title="t" onClose={() => undefined}>
        x
      </Dialog>,
    );
    expect(document.querySelector('[data-dialog]')?.getAttribute('role')).toBe('dialog');
    expect(document.querySelector('[data-dialog-backdrop]')).not.toBeNull();
    view.unmount();
  });

  it('renders on the body, out of any transformed card, and makes the page behind it inert', async () => {
    const view = mount(<Page />);
    await press(view.container, 'Retire Mira…');
    const backdrop = document.querySelector('[data-dialog-backdrop]');
    expect(backdrop?.parentElement).toBe(document.body);
    expect(view.container.contains(backdrop)).toBe(false);
    expect(view.container.hasAttribute('inert')).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');
    key('Escape');
    expect(view.container.hasAttribute('inert')).toBe(false);
    expect(document.body.style.overflow).toBe('');
    view.unmount();
  });

  it('leaves a control inside a hidden part of the dialog out of the Tab cycle', () => {
    const view = mount(
      <Dialog title="t" onClose={() => undefined}>
        <button type="button">Shown</button>
        <div hidden>
          <button type="button">Hidden</button>
        </div>
      </Dialog>,
    );
    const panel = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(panel ? focusableIn(panel).map((control) => control.textContent) : []).toEqual([
      'Shown',
    ]);
    view.unmount();
  });
});

describe('a long dialog’s footer (11-AC’s item 13)', (): void => {
  /** A dialog whose body runs long and whose answers sit in its footer. */
  function Long() {
    return (
      <Dialog title="Hand Mira over?" onClose={() => undefined}>
        <form id="hand-over" onSubmit={(event) => event.preventDefault()}>
          <input aria-label="Their address" />
          <ul>
            {Array.from({ length: 30 }, (_, index) => (
              <li key={index}>Its connection to system {index} is cut.</li>
            ))}
          </ul>
        </form>
        <DialogFooter>
          <button type="button">Cancel</button>
          <button type="submit" form="hand-over">
            Ask
          </button>
        </DialogFooter>
      </Dialog>
    );
  }

  it('keeps the answers outside the body that scrolls, so they stay in view, in the tab order after it', async (): Promise<void> => {
    mount(<Long />);
    await act(async (): Promise<void> => {
      await Promise.resolve();
    });
    const dialog = document.querySelector('[role="dialog"]');
    const body = dialog?.querySelector('[data-dialog-body]');
    const footer = dialog?.querySelector('[data-dialog-footer]');
    const ask = [...(dialog?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Ask',
    );
    expect(body?.className).toContain('overflow-y-auto');
    expect(footer?.contains(ask ?? null)).toBe(true);
    expect(body?.contains(ask ?? null)).toBe(false);
    expect(focusableIn(dialog as HTMLElement).map((element) => element.textContent)).toEqual([
      '',
      'Cancel',
      'Ask',
    ]);
  });
});
