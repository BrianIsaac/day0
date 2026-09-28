/** @vitest-environment jsdom */

import { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConvexError } from 'convex/values';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  LiveStatus,
  refusalText,
  returnFocus,
  useChange,
} from '../../../../app/agent/[agentId]/live-status';

describe('the live region beside a dashboard control', (): void => {
  it('is in the page before anything is said, so the first outcome is announced', (): void => {
    const markup = renderToStaticMarkup(<LiveStatus outcome={null} />);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toMatch(/<p [^>]*><\/p>/);
  });

  it('says what a change came to, and marks a refusal as one', (): void => {
    expect(
      renderToStaticMarkup(<LiveStatus outcome={{ tone: 'done', text: 'Access renewed.' }} />),
    ).toContain('>Access renewed.</p>');
    expect(
      renderToStaticMarkup(<LiveStatus outcome={{ tone: 'refused', text: 'Not a zone.' }} />),
    ).toContain('text-[var(--color-danger)]');
  });
});

describe('the words of a refusal', (): void => {
  it("reads a ConvexError's data, an error's message, and falls back when there are none", (): void => {
    expect(refusalText(new ConvexError('Mars/Olympus is not a time zone.'), 'x')).toBe(
      'Mars/Olympus is not a time zone.',
    );
    expect(refusalText(new Error('Surface not found.'), 'x')).toBe('Surface not found.');
    expect(refusalText(new Error(''), 'The zone was not changed.')).toBe(
      'The zone was not changed.',
    );
    expect(refusalText('boom', 'The zone was not changed.')).toBe('The zone was not changed.');
  });

  it("says a plain error's sentence without the transport's envelope (wave 3.5 m10)", (): void => {
    const wrapped = new Error(
      '[CONVEX M(surfaces:setAccessDays)] [Request ID: 7c1e] Server Error\nUncaught Error: Surface not found.\n    at handler (../convex/surfaces.ts:2171:11)\n  Called by client',
    );
    expect(refusalText(wrapped, 'The access was not changed.')).toBe('Surface not found.');
  });
});

describe('where focus goes once a change settles', (): void => {
  afterEach((): void => {
    document.body.replaceChildren();
  });

  it('comes back to the control while it is on the page and enabled, and to the fallback otherwise', (): void => {
    const button = document.createElement('button');
    const card = document.createElement('div');
    card.tabIndex = -1;
    document.body.append(button, card);

    returnFocus(button, card);
    expect(document.activeElement).toBe(button);

    button.blur();
    button.disabled = true;
    returnFocus(button, card);
    expect(document.activeElement).toBe(card);

    card.blur();
    button.remove();
    returnFocus(button, card);
    expect(document.activeElement).toBe(card);
  });

  it('leaves focus where the manager moved it while the call ran', (): void => {
    const button = document.createElement('button');
    const elsewhere = document.createElement('input');
    const card = document.createElement('div');
    card.tabIndex = -1;
    document.body.append(button, elsewhere, card);
    elsewhere.focus();

    returnFocus(button, card);
    expect(document.activeElement).toBe(elsewhere);
  });
});

/** A control that moves itself off the page when its change lands, as a decision does. */
function Decision({ call }: { call: () => Promise<string> }) {
  const card = useRef<HTMLDivElement>(null);
  const change = useChange(card);
  const [decided, setDecided] = useState(false);
  return (
    <div ref={card} tabIndex={-1} aria-label="the card">
      {decided ? null : (
        <button
          type="button"
          disabled={change.busy}
          onClick={(): void =>
            change.run(call, {
              done: (result) => `Approved: ${result}.`,
              refused: 'The approval was not sent.',
              after: () => setDecided(true),
            })
          }
        >
          Approve
        </button>
      )}
      <LiveStatus outcome={change.outcome} />
    </div>
  );
}

describe('a dashboard change reported the same way everywhere', (): void => {
  beforeAll((): void => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  async function press(call: () => Promise<string>): Promise<HTMLDivElement> {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act((): void => root.render(<Decision call={call} />));
    const button = container.querySelector('button');
    button?.focus();
    await act(async (): Promise<void> => {
      button?.click();
    });
    return container;
  }

  afterEach((): void => {
    document.body.replaceChildren();
  });

  it('says the result in the live region and gives focus to the card when the control went with the row', async (): Promise<void> => {
    const container = await press(async () => 'the plan');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Approved: the plan.');
    expect(container.querySelector('button')).toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('the card');
  });

  it('says the refusal in the live region and gives focus back to the control that stayed', async (): Promise<void> => {
    const container = await press(async () => {
      throw new Error(
        '[CONVEX M(work:approvePlan)] [Request ID: 1] Server Error\nUncaught Error: The plan changed while this page was open.\n    at handler (../convex/work.ts:1:1)',
      );
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'The plan changed while this page was open.',
    );
    const button = container.querySelector('button');
    expect(button?.disabled).toBe(false);
    expect(document.activeElement).toBe(button);
  });
});

describe('a change that names where focus goes once it lands', (): void => {
  it('gives focus to the named element after the render that re-enables it', async (): Promise<void> => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    function Adder() {
      const field = useRef<HTMLInputElement>(null);
      const change = useChange();
      return (
        <div>
          <input ref={field} aria-label="entry" disabled={change.busy} />
          <button
            type="button"
            disabled={change.busy}
            onClick={(): void =>
              change.run(async () => undefined, {
                done: 'Added.',
                refused: 'Not added.',
                focus: () => field.current,
              })
            }
          >
            Add
          </button>
        </div>
      );
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act((): void => root.render(<Adder />));
    const add = container.querySelector('button');
    add?.focus();
    await act(async (): Promise<void> => {
      add?.click();
    });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('entry');
    act((): void => root.unmount());
    container.remove();
  });
});
