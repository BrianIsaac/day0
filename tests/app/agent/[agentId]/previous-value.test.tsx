/** @vitest-environment jsdom */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePreviousValue } from '../../../../app/agent/[agentId]/previous-value';
import { mount } from '../../../fixtures/dom/press';

/** How long the moment under test plays. */
const MOMENT_MS = 300;

/** Prints the value before the current one, or "none" when no moment is playing. */
function Shown({ value, tick }: { value: string; tick?: number }) {
  const previous = usePreviousValue(value, MOMENT_MS);
  return <output data-tick={tick}>{previous ?? 'none'}</output>;
}

beforeEach((): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach((): void => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('usePreviousValue', (): void => {
  it('knows nothing before the first change, then the value the page showed before', (): void => {
    const view = mount(<Shown value="planning" />);
    expect(view.container.textContent).toBe('none');
    act((): void => view.root.render(<Shown value="executing" />));
    expect(view.container.textContent).toBe('planning');
    act((): void => view.root.render(<Shown value="completed" />));
    expect(view.container.textContent).toBe('executing');
    view.unmount();
  });

  it('keeps the change through a render that changes nothing, until its moment has played', (): void => {
    const view = mount(<Shown value="2" />);
    act((): void => view.root.render(<Shown value="3" />));
    act((): void => view.root.render(<Shown value="3" tick={1} />));
    expect(view.container.textContent).toBe('2');
    act((): void => {
      vi.advanceTimersByTime(MOMENT_MS);
    });
    expect(view.container.textContent).toBe('none');
    view.unmount();
  });

  it('gives a change that comes mid-moment its own full time', (): void => {
    const view = mount(<Shown value="a" />);
    act((): void => view.root.render(<Shown value="b" />));
    act((): void => {
      vi.advanceTimersByTime(MOMENT_MS - 50);
    });
    act((): void => view.root.render(<Shown value="c" />));
    act((): void => {
      vi.advanceTimersByTime(MOMENT_MS - 1);
    });
    expect(view.container.textContent).toBe('b');
    act((): void => {
      vi.advanceTimersByTime(1);
    });
    expect(view.container.textContent).toBe('none');
    view.unmount();
  });
});
