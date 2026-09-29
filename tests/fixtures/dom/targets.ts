/**
 * The controls and standalone links of a rendered tree whose own box, or the label wrapping them,
 * is not at least 44 px tall by class (N14: 44 by 44 CSS pixels). jsdom lays nothing out, so the
 * class is what can be read here; the browser job measures the public pages. The rule is the one
 * the employee page's own check applies (`EmployeeShell.axe.test.tsx`).
 *
 * @param root - The rendered tree.
 * @returns Each control under the floor, named for the failing line.
 */
export function underTarget(root: Element): string[] {
  // `min-h-11` or `h-11` only: padding alone gives 40 px on a `text-xs` line.
  const tall = /(^|\s)(min-h-11|h-11)(\s|$)/;
  // A link in a sentence is exempt (WCAG 2.5.8's inline exception); every other link is a target.
  const standalone = (control: Element): boolean =>
    control.tagName !== 'A' || control.closest('p, li, dd, td') === null;
  return [...root.querySelectorAll('button, input, select, textarea, summary, a[href]')]
    .filter((control) => (control as HTMLInputElement).type !== 'hidden')
    .filter(standalone)
    .filter(
      (control) =>
        !tall.test(control.getAttribute('class') ?? '') &&
        !tall.test(control.closest('label')?.getAttribute('class') ?? ''),
    )
    .map(
      (control) =>
        `${control.tagName.toLowerCase()} "${(control.getAttribute('aria-label') ?? control.textContent ?? '').trim().slice(0, 60)}"`,
    );
}
