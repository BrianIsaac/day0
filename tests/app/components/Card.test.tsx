/** @vitest-environment jsdom */

import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { Card } from '../../../app/components/Card';
import { mount } from '../../fixtures/dom/press';

afterEach((): void => {
  document.body.replaceChildren();
});

describe('Card', () => {
  it('is a section named by its h2 title, with the meta beside it', () => {
    const view = mount(
      <Card title="Needs you" meta="ordered by wait">
        <p>body</p>
      </Card>,
    );
    const section = view.container.querySelector('section');
    const heading = section?.querySelector('h2');
    expect(heading?.textContent).toBe('Needs you');
    expect(section?.getAttribute('aria-labelledby')).toBe(heading?.id);
    expect(section?.textContent).toContain('ordered by wait');
    view.unmount();
  });

  it("takes a tone's line colour for its border, and the page's hairline without one", () => {
    expect(
      renderToStaticMarkup(
        <Card title="Charter" tone="warn">
          x
        </Card>,
      ),
    ).toContain('border-[var(--color-warn-line)]');
    expect(renderToStaticMarkup(<Card title="Record">x</Card>)).toContain(
      'border-[var(--color-border)]',
    );
  });

  it('takes focus when a change removes the control that made it, and only then', () => {
    const fallback = createRef<HTMLElement>();
    const view = mount(
      <Card title="Skills" focusRef={fallback}>
        x
      </Card>,
    );
    expect(fallback.current?.tabIndex).toBe(-1);
    fallback.current?.focus();
    expect(document.activeElement).toBe(fallback.current);
    view.unmount();
    expect(renderToStaticMarkup(<Card title="Plain">x</Card>)).not.toContain('tabindex');
  });
});
