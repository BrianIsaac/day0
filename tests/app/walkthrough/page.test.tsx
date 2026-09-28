import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import WalkthroughPage from '../../../app/walkthrough/page';
import { WALKTHROUGH } from '../../../app/walkthrough/copy';
import { HOSTED_DEMO_NOTICE } from '../../../src/demo/hosted-notice';
import {
  RECORDED_RUN,
  isHeaderStrip,
  walkthroughProvenanceLine,
} from '../../../src/demo/walkthrough';

/**
 * Nothing is mocked here on purpose. `/walkthrough` is public, so it must render with no Convex
 * client, no Clerk session and no router: if it ever grew one, this file would fail first.
 */
const html = renderToStaticMarkup(<WalkthroughPage />);

/** The same markup with entities resolved, so copy can be matched as it reads. */
const text = html
  .replace(/&quot;/g, '"')
  .replace(/&#x27;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

describe('what the walkthrough tells a visitor it is', () => {
  it('says it replays a recording, how its clock runs and when it was taken, before any step', () => {
    const firstStep = text.indexOf(RECORDED_RUN.steps[0]!.title);
    for (const notice of [
      WALKTHROUGH.readOnly,
      WALKTHROUGH.clock(RECORDED_RUN),
      walkthroughProvenanceLine(RECORDED_RUN),
    ]) {
      expect(text.indexOf(notice)).toBeGreaterThan(-1);
      expect(text.indexOf(notice)).toBeLessThan(firstStep);
    }
    expect(WALKTHROUGH.clock(RECORDED_RUN)).toContain('from step 2 on');
    expect(text).toContain(WALKTHROUGH.bed);
  });

  it('offers no control that could be mistaken for an approval: links that open or move, no buttons (W D5 (b))', () => {
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('onclick');
    // The README's prose says the manager "pressed Approve"; no link may be named for it. A link's
    // name is its aria-label, or else its text and its images' alt text.
    const names = [...html.matchAll(/<a ([^>]*)>(.*?)<\/a>/g)].map(
      ([, attributes, inner]) =>
        /aria-label="([^"]*)"/.exec(attributes!)?.[1] ??
        `${inner!.replace(/<[^>]+>/g, ' ')} ${[...inner!.matchAll(/alt="([^"]*)"/g)].map(([, alt]) => alt).join(' ')}`,
    );
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => /\bapprov/i.test(name))).toEqual([]);
  });

  it('links each header-strip capture to its full-size file, a plain link that opens the image', () => {
    const strips = RECORDED_RUN.steps.filter((step) => isHeaderStrip(step.capture));
    expect(strips.map((step) => step.number)).toEqual([4, 5, 11, 16]);
    for (const step of strips) {
      const link = new RegExp(`<a href="${step.capture.src}"[^>]*>`).exec(html)?.[0] ?? '';
      expect(link, `step ${step.number}`).toContain(
        `aria-label="${WALKTHROUGH.fullSize(step.number)}"`,
      );
      expect(link).not.toContain('target=');
    }
    expect(html.match(/<a href="\/walkthrough\/full-run-[^"]*\.webp"/g)).toHaveLength(4);
  });

  it('lays the lede’s claims on the README’s own account of the run', () => {
    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
    const intro = readme.slice(readme.indexOf('## One full run'), readme.indexOf('1. **'));
    for (const claim of [
      'It ran on 3 September 2026',
      // "a hosted model": re-recorded on a local one, this fails and the lede must change.
      'OPENAI_MODEL=gpt-5.6-terra',
      'handbook with one team',
      'the counts of cards, candidates and skills below are that run',
      'fresh clone',
      "author's own Linear",
      "author's own Slack",
      'Looker-style',
      'both the manager and the IT approver',
    ]) {
      expect(intro).toContain(claim);
    }
    expect(text).toContain(WALKTHROUGH.lede(RECORDED_RUN));
  });
});

describe('the page as landmarks', () => {
  it('leaves the one main landmark to the layout', () => {
    expect(html).not.toMatch(/<main[\s>]/);
  });
});

describe('the run', () => {
  it('tells all sixteen steps from the generated file, in order, each paragraph whole', () => {
    const offsets = RECORDED_RUN.steps.map((step) => text.indexOf(step.title));
    expect(offsets.every((offset) => offset > -1)).toBe(true);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
    for (const step of RECORDED_RUN.steps) {
      for (const span of step.body) expect(text).toContain(span.text);
    }
  });

  it('gives every step an anchor, linked from its own number, a keyboard can reach', () => {
    for (const step of RECORDED_RUN.steps) {
      expect(html).toContain(`id="step-${step.number}"`);
      expect(html).toContain(`href="#step-${step.number}"`);
    }
  });

  it('makes each step link a 44 px target without moving the line it sits on', () => {
    const links = [...html.matchAll(/<a href="#step-\d+" class="([^"]*)"/g)].map(([, c]) => c);
    expect(links).toHaveLength(16);
    for (const classes of links) expect(classes).toMatch(/(?=.*min-h-11)(?=.*min-w-11)(?=.*-my-3)/);
  });

  it('stacks every capture in the frame with its README alt text and measured size, the first shown', () => {
    for (const step of RECORDED_RUN.steps) {
      expect(text).toContain(`alt="${step.capture.alt}"`);
      expect(html).toContain(`width="${step.capture.width}"`);
    }
    expect(html).toMatch(/data-frame="1" data-on=""/);
    expect(html.match(/data-on=""/g)).toHaveLength(1);
  });

  it('reads as the first step without script: one ledger line and the clock caption', () => {
    const ledger = /<ol aria-label="The record so far"[^>]*>(.*?)<\/ol>/.exec(html)?.[1] ?? '';
    expect(ledger.match(/<li/g)).toHaveLength(1);
    expect(text).toContain('timed from step 2');
  });

  it('marks the pinned sequence for the tracker L built, starting at the first step', () => {
    expect(html).toMatch(/data-pin="" data-active="1"/);
    expect(html).toContain('data-pin-side=""');
    expect(html).toContain('data-pin-copy=""');
    expect(html.match(/data-step="/g)).toHaveLength(16);
  });
});

describe('after the run', () => {
  it('shows the numbers the run ended on beside every deviation the README lists', () => {
    expect(text).toContain(WALKTHROUGH.numbers.heading);
    expect(text).toContain('100% (41 of 41)');
    for (const deviation of RECORDED_RUN.deviations) expect(text).toContain(deviation.lead);
  });

  it('carries the hosted-demo notice (N6) in the closing section only, beside the way in', () => {
    const closing = html.slice(html.indexOf(WALKTHROUGH.tryHeading));
    expect(closing).toContain(HOSTED_DEMO_NOTICE.heading);
    expect(html.split(HOSTED_DEMO_NOTICE.heading)).toHaveLength(2);
    expect(closing.indexOf('href="/sign-in"')).toBeGreaterThan(
      closing.indexOf(HOSTED_DEMO_NOTICE.heading),
    );
  });

  it('links on to the demo, the setup guide and the landing page', () => {
    for (const href of ['/sign-in', '/setup', '/']) expect(html).toContain(`href="${href}"`);
  });
});

describe('the page module', () => {
  const source = (path: string): string =>
    readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

  it('is a server module that imports its one client component', () => {
    const page = source('app/walkthrough/page.tsx');
    expect(page).not.toContain('use client');
    expect(page).not.toContain('useEffect');
    expect(page).toContain("from './RunStory'");
    expect(source('app/walkthrough/RunStory.tsx')).toMatch(/^'use client';/);
  });

  it('is built out of tracked data and nothing live', () => {
    for (const path of [
      'app/walkthrough/page.tsx',
      'app/walkthrough/RunStory.tsx',
      'app/walkthrough/RunClock.tsx',
      'app/walkthrough/RunParagraph.tsx',
      'app/walkthrough/copy.ts',
    ]) {
      const text = source(path);
      expect(text).not.toContain('convex/react');
      expect(text).not.toContain('@clerk/nextjs');
      expect(text).not.toContain('fetch(');
    }
  });
});
