/** @vitest-environment jsdom */

import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfficeWorld } from '../../../app/home/OfficeWorld';
import type { RosterRow } from '../../../app/home/types';
import { mount, unmountAll } from '../../fixtures/dom/press';

vi.mock('next/link', () => ({
  default: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a>,
}));

const base = {
  avatarId: 'face-05',
  state: 'active',
  autonomous: false,
  roleLine: 'Owns triage',
  openCount: 0,
  parkedCount: 0,
  stoppedCount: 0,
  needsYou: 0,
  docSourceCount: 1,
};

/** An employee, idle unless it has work open. */
function employee(agentId: string, name: string, openCount = 0): RosterRow {
  return { ...base, agentId, name, openCount } as unknown as RosterRow;
}

/** Each figure's inline place, by the name its title gives. */
function placesIn(root: ParentNode): Record<string, string> {
  return Object.fromEntries(
    [...root.querySelectorAll<HTMLElement>('.day0-office-agent')].map((figure) => [
      figure.getAttribute('title')?.split(',')[0] ?? '',
      ['--x', '--y', '--px', '--py']
        .map((name) => `${name}:${figure.style.getPropertyValue(name).trim()}`)
        .join(';'),
    ]),
  );
}

/** Where a fresh office stands each figure for a roster, before any roaming. */
function opening(agents: readonly RosterRow[]): Record<string, string> {
  const holder = document.createElement('div');
  holder.innerHTML = renderToStaticMarkup(<OfficeWorld agents={agents} settled />);
  return placesIn(holder);
}

beforeEach((): void => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.99);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined }));
});

afterEach((): void => {
  unmountAll();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the office’s roaming when the roster changes (second review x9)', (): void => {
  it('stands the idle employees where the new seating opens them at once, not a tick later', (): void => {
    const before = [employee('a', 'Ada'), employee('b', 'Ben'), employee('c', 'Cleo')];
    const view = mount(<OfficeWorld agents={before} settled />);
    act((): void => {
      vi.advanceTimersByTime(3400);
    });
    // The tick moved the idle figures on from where they opened.
    expect(placesIn(view.container)).not.toEqual(opening(before));

    // Ada sits down to work: the seating changed, and the others' roaming places were chosen
    // against the old one.
    const after = [employee('a', 'Ada', 1), employee('b', 'Ben'), employee('c', 'Cleo')];
    act((): void => view.root.render(<OfficeWorld agents={after} settled />));
    expect(placesIn(view.container)).toEqual(opening(after));
    view.unmount();
  });
});
