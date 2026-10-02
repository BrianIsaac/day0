/** @vitest-environment jsdom */

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DisconnectDialog } from '../../../../../app/agent/[agentId]/surfaces/DisconnectDialog';
import { disconnectLines } from '../../../../../app/agent/[agentId]/surfaces/card-words';
import { axeViolations } from '../../../../fixtures/dom/axe';
import {
  focusedName,
  mount,
  press,
  said,
  settle,
  unmountAll,
} from '../../../../fixtures/dom/press';
import { underTarget } from '../../../../fixtures/dom/targets';

afterEach((): void => {
  unmountAll();
  document.body.replaceChildren();
});

/** The dialog on the document, as a portal draws it. */
function dialog(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[role="alertdialog"]');
  if (!found) throw new Error('no dialog open');
  return found;
}

describe("what a Disconnect does at the vendor, in the dialog's words", (): void => {
  const names = { employee: 'Maya', system: 'Linear' };

  it("says an employee's own app is revoked at the vendor and the app stays", (): void => {
    expect(disconnectLines({ kind: 'own-app', planned: false }, names, { slack: false })).toEqual([
      "Maya's own Linear app: its token is revoked at Linear. The app stays, so Connect brings it back.",
    ]);
  });

  it("says a Slack own-app card's bot is switched off and leaves its channels, and what renewing restores (RM4)", (): void => {
    expect(
      disconnectLines(
        { kind: 'own-app', label: 'Maya (Day0)', planned: false },
        { employee: 'Maya', system: 'Slack' },
        { slack: true },
      ),
    ).toEqual([
      "Maya's own Slack app stays installed, but its token is revoked at Slack and its bot leaves every channel.",
      'Connect brings it back: it re-joins its public channels itself, and someone adds it to each private one.',
    ]);
  });

  it('says a shared app is not revoked, since the other employees use it', (): void => {
    expect(
      disconnectLines({ kind: 'shared-app', planned: false }, names, { slack: false }),
    ).toEqual([
      'The Day0 app your employees share is not revoked at Linear: the others still use it. Day0 stops using it for Maya.',
    ]);
  });

  it("says a manager's delegated grant is revoked where the system offers it", (): void => {
    expect(disconnectLines({ kind: 'delegated', planned: false }, names, { slack: false })).toEqual(
      ['Your authorisation for Maya is revoked at Linear, where Linear offers a way to.'],
    );
  });

  it('says a pasted key is left as it is at the vendor, for a key and a browser sign-in alike', (): void => {
    const left = [
      'The key someone pasted is left as it is at Linear: Day0 deletes its copy and never revokes a pasted key. Revoke it there if it should end.',
    ];
    expect(
      disconnectLines({ kind: 'shared-key', planned: false }, names, { slack: false }),
    ).toEqual(left);
    expect(
      disconnectLines({ kind: 'browser-seat', planned: false }, names, { slack: false }),
    ).toEqual(left);
  });
});

describe('the Disconnect dialog (11-AR `surfaces.disconnect`, confirmed first)', (): void => {
  /** Mount the dialog over a page control that held focus before it opened. */
  function open(onConfirm: () => Promise<void>) {
    const onClose = vi.fn();
    const opener = document.createElement('button');
    opener.textContent = 'Disconnect';
    document.body.append(opener);
    opener.focus();
    const view = mount(
      <DisconnectDialog
        system="Linear"
        lines={['The key someone pasted is left as it is at Linear.']}
        employee="Maya"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    return { view, onClose, opener };
  }

  it('opens on the safe choice, names what happens, and keeps every control at 44 px with axe clean', async (): Promise<void> => {
    open(async (): Promise<void> => undefined);
    await settle();
    expect(focusedName()).toBe('Keep it connected');
    expect(dialog().getAttribute('aria-labelledby')).not.toBeNull();
    expect(dialog().textContent).toContain('Disconnect Linear?');
    expect(dialog().textContent).toContain('The key someone pasted is left as it is at Linear.');
    expect(underTarget(dialog())).toEqual([]);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('disconnects once confirmed, says so and closes', async (): Promise<void> => {
    const onConfirm = vi.fn(async (): Promise<void> => undefined);
    const { onClose } = open(onConfirm);
    await press(dialog(), 'Disconnect Linear');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says a refusal inside the dialog and stays open, with the safe choice still there', async (): Promise<void> => {
    const { onClose } = open(async (): Promise<void> => {
      throw new Error('This connection holds no credential to disconnect.');
    });
    await press(dialog(), 'Disconnect Linear');
    expect(said(dialog())).toContain('This connection holds no credential to disconnect.');
    expect(onClose).not.toHaveBeenCalled();
    await press(dialog(), 'Keep it connected');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape without disconnecting', async (): Promise<void> => {
    const onConfirm = vi.fn(async (): Promise<void> => undefined);
    const { onClose } = open(onConfirm);
    await settle();
    act((): void => {
      dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
