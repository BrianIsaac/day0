import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Field, INPUT_CLASS } from '../../../app/components/Field';

/** The value of an attribute on the first element that carries it. */
const attribute = (html: string, name: string): string | undefined =>
  new RegExp(`${name}="([^"]*)"`).exec(html)?.[1];

describe('Field', () => {
  it('labels the control visibly and binds the label to it', () => {
    const html = renderToStaticMarkup(
      <Field label="Zone">{(control) => <input {...control} className={INPUT_CLASS} />}</Field>,
    );
    expect(html).toMatch(/<label for="([^"]+)"[^>]*>Zone<\/label><input id="\1"/);
  });

  it('describes the control by its hint', () => {
    const html = renderToStaticMarkup(
      <Field label="Zone" hint="A zone name such as Europe/London.">
        {(control) => <input {...control} />}
      </Field>,
    );
    const describedBy = attribute(html, 'aria-describedby');
    expect(html).toContain(`<p id="${describedBy}"`);
    expect(html).toContain('A zone name such as Europe/London.');
    expect(html).not.toContain('aria-invalid');
  });

  it('replaces the hint with the error and marks the control invalid', () => {
    const html = renderToStaticMarkup(
      <Field label="Zone" hint="A zone name." error="Mars is not a zone.">
        {(control) => <input {...control} />}
      </Field>,
    );
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('Mars is not a zone.');
    expect(html).not.toContain('A zone name.');
    expect(html).toContain('text-[var(--color-danger)]');
  });

  it('gives an input a 44 px target on the page’s own ground', () => {
    expect(INPUT_CLASS).toMatch(/\bmin-h-11\b/);
    expect(INPUT_CLASS).toContain('bg-[var(--color-bg)]');
  });
});
