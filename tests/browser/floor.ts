import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';

/**
 * The accessibility floor's two browser checks (N14, `CONTRIBUTING.md`), shared by the public and
 * the signed-in pages' specs: axe at the WCAG 2.2 AA tags, colour contrast among them (which only a
 * browser lays out), and the 44 by 44 CSS pixel pointer target.
 */

const require = createRequire(import.meta.url);
const AXE = require.resolve('axe-core/axe.min.js');

/** The tags the floor names, as the jsdom check in the mirrored tests runs them. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * Run axe in the page at the floor's tags.
 *
 * @param page - The loaded page.
 * @returns Each violating node as `rule selector`, empty when the page passes.
 */
export async function axe(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE });
  return await page.evaluate(async (tags: string[]) => {
    const run = (
      window as unknown as {
        axe: {
          run: (
            context: Document,
            options: unknown,
          ) => Promise<{
            violations: Array<{
              id: string;
              impact: string | null;
              nodes: Array<{ target: string[] }>;
            }>;
          }>;
        };
      }
    ).axe.run;
    const results = await run(document, { runOnly: { type: 'tag', values: tags } });
    return results.violations.flatMap((violation) =>
      violation.nodes.map((node) => `${violation.id} ${node.target.join(' ')}`),
    );
  }, WCAG_TAGS);
}

/**
 * The visible controls smaller than 44 by 44 CSS pixels, except a link inside
 * a run of text, which WCAG's inline exception leaves at the text's size.
 *
 * @param page - The loaded page.
 * @returns Each small control, as `tag "name" at selector`.
 */
export async function smallTargets(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    // The node's path from the nearest ancestor with an id, as axe names its own nodes.
    const selectorOf = (element: Element): string => {
      const parts: string[] = [];
      let node: Element | null = element;
      while (node && node !== document.body) {
        if (node.id) {
          parts.unshift(`#${CSS.escape(node.id)}`);
          break;
        }
        const tag = node.tagName.toLowerCase();
        const siblings: Element[] = node.parentElement
          ? [...node.parentElement.children].filter((sibling) => sibling.tagName === node?.tagName)
          : [];
        parts.unshift(
          siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag,
        );
        node = node.parentElement;
      }
      return parts.join(' > ');
    };
    const controls = document.querySelectorAll<HTMLElement>(
      'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="switch"]',
    );
    const small: string[] = [];
    for (const control of controls) {
      // A control inside its label is pressed anywhere on the label, so the label is its target,
      // as the jsdom rule reads it (`tests/fixtures/dom/targets.ts`): a visually hidden radio is
      // one pixel, and the chip that labels it is what a pointer meets.
      const target = control.tagName === 'INPUT' ? (control.closest('label') ?? control) : control;
      const box = target.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (getComputedStyle(control).visibility === 'hidden') continue;
      const inline =
        control.tagName === 'A' &&
        getComputedStyle(control).display === 'inline' &&
        (control.parentElement?.textContent ?? '').trim().length >
          (control.textContent ?? '').trim().length;
      if (inline) continue;
      if (box.width < 44 || box.height < 44) {
        const name = (control.getAttribute('aria-label') ?? control.textContent ?? '')
          .trim()
          .slice(0, 50);
        small.push(`${control.tagName.toLowerCase()} "${name}" at ${selectorOf(control)}`);
      }
    }
    return small;
  });
}
