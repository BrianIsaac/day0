/** @vitest-environment jsdom */

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { usePreviousValue } from '../../../../app/agent/[agentId]/previous-value';
import { mount } from '../../../fixtures/dom/press';

/** Prints the value before the current one, or "none" before the first change. */
function Shown({ value, tick }: { value: string; tick?: number }) {
  const previous = usePreviousValue(value);
  return <output data-tick={tick}>{previous ?? 'none'}</output>;
}

afterEach((): void => {
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

  it('keeps the last change through a render that changes nothing', (): void => {
    const view = mount(<Shown value="2" />);
    act((): void => view.root.render(<Shown value="3" />));
    act((): void => view.root.render(<Shown value="3" tick={1} />));
    expect(view.container.textContent).toBe('2');
    view.unmount();
  });
});
