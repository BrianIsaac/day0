import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BUTTON_VARIANTS, Button, ButtonLink, buttonClass } from '../../../app/components/Button';
import { contrast, over, token } from '../../fixtures/theme-contrast';

describe('Button', () => {
  it('is a plain button unless told otherwise, so it never submits a form by accident', () => {
    expect(renderToStaticMarkup(<Button>Cancel</Button>)).toMatch(/^<button type="button"/);
    expect(renderToStaticMarkup(<Button type="submit">Save</Button>)).toMatch(
      /^<button type="submit"/,
    );
  });

  it.each(BUTTON_VARIANTS)('gives the %s look a 44 px target at every size (N14)', (variant) => {
    for (const size of ['small', 'medium', 'large'] as const) {
      expect(buttonClass(variant, size)).toMatch(/\bmin-h-11\b/);
    }
  });

  it('draws the decisions in their tones: approve in ok, retry in warn, danger outlined', () => {
    expect(buttonClass('approve')).toContain('text-[var(--color-ok)]');
    expect(buttonClass('retry')).toContain('text-[var(--color-warn)]');
    expect(buttonClass('danger')).toContain('border-[var(--color-danger-line)]');
    expect(buttonClass('danger')).toContain('bg-transparent');
    expect(buttonClass('primary')).toContain('bg-[var(--color-accent)]');
  });

  it('presses in only where motion is welcome, and dims when disabled', () => {
    expect(buttonClass()).toContain('motion-safe:active:scale-[0.97]');
    expect(buttonClass()).toContain('disabled:opacity-50');
  });

  it('sets a control inside a line of prose without side padding, underlined', () => {
    expect(buttonClass('text', 'small')).not.toMatch(/\bpx-/);
    expect(buttonClass('text', 'small')).toMatch(/\bunderline\b/);
    expect(buttonClass('secondary', 'small')).toMatch(/\bpx-3\b/);
    expect(buttonClass('secondary', 'small')).toMatch(/\bno-underline\b/);
  });

  it('underlines the text look in the link line, the look a bare link in a sentence takes (C3)', () => {
    // The second hairline (1.7:1 on a card) left the line invisible, so the control read as prose.
    expect(buttonClass('text')).toContain('decoration-[var(--color-link-line)]');
    expect(buttonClass('text')).toContain('underline-offset-4');
    expect(buttonClass('text')).toContain('hover:decoration-[var(--color-accent)]');
  });

  it('keeps a caller class beside its own', () => {
    expect(renderToStaticMarkup(<Button className="w-full">Go</Button>)).toMatch(/ w-full"/);
  });
});

describe('ButtonLink', () => {
  it('is a link that looks like the button it stands for', () => {
    const html = renderToStaticMarkup(
      <ButtonLink href="/agent/a1/work" variant="approve">
        Decide
      </ButtonLink>,
    );
    expect(html).toMatch(/^<a /);
    expect(html).toContain('href="/agent/a1/work"');
    expect(html).toContain(buttonClass('approve'));
  });

  // The grounds a tinted decision is drawn on: the page, a card, an inset, and the tone fills
  // (the held writes and the batch approval sit on warn, a failed draft's Draft again too).
  const GROUNDS = ['bg', 'card', 'inset', 'warn-soft', 'ok-soft', 'accent-soft'] as const;

  it.each([
    ['approve', 'ok'],
    ['retry', 'warn'],
  ] as const)(
    'keeps the text of the %s look at 4.5:1 or more at rest and under the pointer on every ground (the pre-tag walk: 4.47:1)',
    (variant, tone): void => {
      const classes = buttonClass(variant, 'small');
      const tints = [
        ...classes.matchAll(
          new RegExp(`(?:^|\\s)(?:hover:)?bg-\\[var\\(--color-${tone}\\)\\]/(\\d+)`, 'g'),
        ),
      ].map((match) => Number(match[1]) / 100);
      expect(tints.length).toBeGreaterThan(0);
      for (const ground of GROUNDS) {
        for (const alpha of tints) {
          const fill = over(token(tone), alpha, token(ground));
          expect(contrast(token(tone), fill), `${ground} at ${alpha}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    },
  );
});
