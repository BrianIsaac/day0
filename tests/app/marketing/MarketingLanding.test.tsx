import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarketingLanding } from '../../../app/marketing/MarketingLanding';

/**
 * The signed-out page as the server renders it: the markup a visitor without the script, or
 * before hydration, receives. Everything must be present and settled in it.
 */
const html = renderToStaticMarkup(<MarketingLanding />);

describe('the marketing landing', () => {
  it('runs hero, problem, why, how, evidence, try it, the closing ask and the footer in order', () => {
    const marks = [
      'Day0 is onboarded instead.',
      'id="problem"',
      'id="why"',
      'id="how"',
      'id="evidence"',
      'id="run"',
      'Give one employee a name',
      '<footer',
    ].map((mark) => html.indexOf(mark));
    expect(marks.every((at) => at >= 0)).toBe(true);
    expect([...marks].sort((a, b) => a - b)).toEqual(marks);
  });

  it('stacks the four frames beside the four step copies, the first shown before the script runs', () => {
    const frames = [...html.matchAll(/<div data-frame="(\d)"([^>]*)>/g)];
    expect(frames.map(([, n]) => n)).toEqual(['1', '2', '3', '4']);
    expect(frames.map(([, , attributes]) => /data-on=""/.test(attributes ?? ''))).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(frames.map(([, , attributes]) => /aria-hidden="true"/.test(attributes ?? ''))).toEqual([
      false,
      true,
      true,
      true,
    ]);
    expect([...html.matchAll(/data-step="(\d)"/g)].map(([, n]) => n)).toEqual(['1', '2', '3', '4']);
    expect(html).toContain('data-active="1"');
  });

  it('renders every frame and every card group settled, so nothing is hidden without the script', () => {
    const groups = [...html.matchAll(/data-cards=""( data-seen="([a-z]+)")?/g)];
    expect(groups).toHaveLength(4);
    expect(groups.map((group) => group[2])).toEqual(['edge', 'edge', 'edge', 'edge']);
    expect(
      [...html.matchAll(/data-frame="\d" (?:data-on="" )?data-seen="([a-z]+)"/g)].map((m) => m[1]),
    ).toEqual(['edge', 'edge', 'edge', 'edge']);
    expect(html).not.toMatch(/data-(rise|seen|reveal)="(pending|in|seen|visible)"/);
  });

  it('reveals every section heading on scroll and draws each section’s rule', () => {
    const headings = [...html.matchAll(/<h2 ([^>]*)>/g)];
    expect(headings).toHaveLength(6);
    for (const [, attributes] of headings) expect(attributes).toContain('data-rise=""');
    expect([...html.matchAll(/<section [^>]*data-hairline=""/g)]).toHaveLength(6);
  });

  it('wraps the orbit once so it lags the page, and names it for assistive technology', () => {
    expect(html).toMatch(
      /<div data-orbit-lag=""[^>]*><div [^>]*role="img" aria-label="Day0 at the centre/,
    );
    expect([...html.matchAll(/data-orbit-rings=""/g)]).toHaveLength(1);
  });

  it('links nothing that is not a real route or the repository', () => {
    const hrefs = new Set([...html.matchAll(/href="([^"]*)"/g)].map(([, href]) => href));
    expect([...hrefs].sort()).toEqual([
      '/setup',
      '/sign-in',
      '/walkthrough',
      'https://github.com/BrianIsaac/day0',
      'https://github.com/BrianIsaac/day0#disclosures',
      'https://github.com/BrianIsaac/day0/blob/main/CHANGELOG.md',
      'https://github.com/BrianIsaac/day0/blob/main/evaluation/README.md',
    ]);
  });

  it('underlines each inline link in the link line, turning accent on hover (second review w5)', () => {
    // An inline link is the underlined one; the buttons and the nav draw no underline.
    const inline = [...html.matchAll(/<a [^>]*class="(?:[^"]* )?underline [^"]*"[^>]*>/g)].map(
      ([tag]) => tag,
    );
    expect(inline.length).toBeGreaterThanOrEqual(3);
    for (const tag of inline) {
      expect(tag).toContain('decoration-[var(--color-link-line)]');
      expect(tag).toContain('hover:decoration-[var(--color-accent)]');
    }
  });

  it('gives the footer links a 44 px target (N14)', () => {
    const footer = /<footer[\s\S]*?<\/footer>/.exec(html)?.[0] ?? '';
    const links = [...footer.matchAll(/<a [^>]*>/g)].map(([tag]) => tag);
    expect(links).toHaveLength(3);
    for (const link of links) expect(link).toMatch(/\bmin-h-11\b[^"]*\bmin-w-11\b/);
  });

  it('lets a keyboard reach the command block, which scrolls sideways on a phone', () => {
    expect(html).toMatch(
      /<pre tabindex="0" role="region" aria-label="Commands to run Day0 locally"/,
    );
  });
});
