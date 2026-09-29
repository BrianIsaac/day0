/** @vitest-environment jsdom */

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROLL_MS, RollingCount } from '../../../app/components/RollingCount';
import { mount } from '../../fixtures/dom/press';

afterEach((): void => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('RollingCount', () => {
  it('shows its first figure still, rolls the old one out as the new one rolls in, then settles', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const view = mount(<RollingCount value={2} />);
    expect(view.container.innerHTML).toBe('2');
    act((): void => view.root.render(<RollingCount value={3} />));
    const roll = view.container.querySelector('.roll');
    expect(roll?.querySelector('.from')?.textContent).toBe('2');
    expect(roll?.querySelector('.from')?.getAttribute('aria-hidden')).toBe('true');
    expect(roll?.querySelector('.to')?.textContent).toBe('3');
    act((): void => {
      vi.advanceTimersByTime(ROLL_MS);
    });
    expect(view.container.innerHTML).toBe('3');
    view.unmount();
  });
});
