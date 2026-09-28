import axe from 'axe-core';

/**
 * The WCAG tags the accessibility floor holds the interface to (N14, the
 * floor in `CONTRIBUTING.md`), and the browser job runs the same list.
 */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

/** One axe violation, reduced to what a failing test line needs. */
export interface Violation {
  readonly id: string;
  readonly impact: string | null | undefined;
  readonly targets: string[];
}

/**
 * Run axe over a rendered tree in the document, at the floor's WCAG tags and
 * axe's best practice (the landmark and scroll-region rules the review beds
 * found live there).
 *
 * jsdom lays nothing out, so the rules that need layout (colour contrast,
 * target size, a scroll region's overflow) cannot be answered here; the
 * browser job answers them on the public pages, and every dashboard control's
 * 44 px class is asserted beside the test that presses it.
 *
 * Args:
 *   root: The rendered tree.
 *   disabled: Rules that do not apply to a fragment rendered outside the page's layout.
 *
 * Returns:
 *   The violations, empty when the tree passes.
 */
export async function axeViolations(
  root: Element,
  disabled: readonly string[] = [],
): Promise<Violation[]> {
  const results = await axe.run(root, {
    runOnly: { type: 'tag', values: [...WCAG_TAGS, 'best-practice'] },
    rules: Object.fromEntries(
      ['color-contrast', 'target-size', ...disabled].map((rule) => [rule, { enabled: false }]),
    ),
  });
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.map((node) => node.target.join(' ')),
  }));
}
