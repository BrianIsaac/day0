import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Rendered-component helpers for the jsdom tests that press a dashboard
 * control: mount a tree, press a button by its name, type into a field, pick
 * an option, and read what the live regions said. Every interaction runs
 * inside `act`, so the settled render (and the focus it moves) is what the
 * test reads.
 */

/** A mounted tree and the way to take it down. */
export interface Mounted {
  readonly container: HTMLDivElement;
  readonly root: Root;
  /** Unmount the tree and remove its container. */
  readonly unmount: () => void;
}

/**
 * Mount a tree into a fresh container on the document.
 *
 * Args:
 *   node: What to render.
 *
 * Returns:
 *   The mounted tree.
 */
export function mount(node: ReactNode): Mounted {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act((): void => root.render(node));
  return {
    container,
    root,
    unmount: (): void => {
      act((): void => root.unmount());
      container.remove();
    },
  };
}

/**
 * The enabled button whose accessible name (its `aria-label`, else its text)
 * is the one given.
 *
 * Args:
 *   scope: Where to look.
 *   name: The name, exactly.
 *
 * Returns:
 *   The button.
 *
 * @throws When no enabled button has that name.
 */
export function button(scope: ParentNode, name: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find(
    (candidate) =>
      !candidate.disabled &&
      (candidate.getAttribute('aria-label') ?? candidate.textContent?.trim()) === name,
  );
  if (!found) throw new Error(`no enabled button named "${name}"`);
  return found;
}

/**
 * Focus a button and press it, then let every promise the press started settle.
 *
 * Args:
 *   scope: Where to look.
 *   name: The button's accessible name.
 */
export async function press(scope: ParentNode, name: string): Promise<void> {
  const target = button(scope, name);
  target.focus();
  await act(async (): Promise<void> => {
    target.click();
  });
  await settle();
}

/** Let the microtasks and the effects a settled change schedules run. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await act(async (): Promise<void> => {
      await Promise.resolve();
    });
  }
}

/**
 * Type a value into a field the way a person does, so React's own change
 * handler sees it.
 *
 * Args:
 *   field: An input or text area.
 *   value: The value it ends with.
 */
export function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = Object.getPrototypeOf(field) as object;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  act((): void => {
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/**
 * Pick an option of a select, then let the change it starts settle.
 *
 * Args:
 *   select: The select.
 *   value: The option's value.
 */
export async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  select.focus();
  await act(async (): Promise<void> => {
    setter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

/**
 * What the live regions in a scope say, in document order, empty ones left out.
 *
 * Args:
 *   scope: Where to look.
 *
 * Returns:
 *   Each region's text.
 */
export function said(scope: ParentNode): string[] {
  return [...scope.querySelectorAll('[aria-live], [role="status"], [role="alert"]')]
    .map((region) => region.textContent?.trim() ?? '')
    .filter((text) => text !== '');
}

/**
 * The accessible name of whatever holds focus: its `aria-label`, the text of
 * what `aria-labelledby` names, or its own text.
 *
 * Returns:
 *   The name, or `BODY` when focus fell to the page.
 */
export function focusedName(): string {
  const active = document.activeElement;
  if (!active || active === document.body) return 'BODY';
  const labelledBy = active.getAttribute('aria-labelledby');
  if (labelledBy) return document.getElementById(labelledBy)?.textContent?.trim() ?? '';
  return active.getAttribute('aria-label') ?? active.textContent?.trim() ?? '';
}
