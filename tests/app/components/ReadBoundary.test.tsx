/** @vitest-environment jsdom */

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReadBoundary } from '../../../app/components/ReadBoundary';
import { mount, type Mounted } from '../../fixtures/dom/press';

/** A read's place: throws what the read failed with, or draws what it answered. */
function Figures({ read }: { read: string | Error }) {
  if (read instanceof Error) throw read;
  return <p>{read}</p>;
}

/** The boundary over one read, held above it and given as its reset key. */
function drawn(view: Mounted, read: string | Error): string {
  act((): void =>
    view.root.render(
      <ReadBoundary what="metrics.forAgent" fallback={<p>unread</p>} resetKey={read}>
        <Figures read={read} />
      </ReadBoundary>,
    ),
  );
  return view.container.textContent ?? '';
}

afterEach((): void => {
  vi.restoreAllMocks();
});

describe('ReadBoundary (W17-R28)', (): void => {
  it('draws the figures once its read answers again, where it kept its fallback for good', (): void => {
    // The boundary logs what it caught, and React reports the throw: neither is this test's.
    vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
    const view = mount(<p />);
    expect(drawn(view, new Error('Read too much data in a single function execution'))).toBe(
      'unread',
    );
    expect(drawn(view, '24 approved')).toBe('24 approved');
    view.unmount();
  });

  it('keeps its fallback while the read stands where it failed', (): void => {
    vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
    const failed = new Error('Read too much data in a single function execution');
    const view = mount(<p />);
    expect(drawn(view, failed)).toBe('unread');
    expect(drawn(view, failed)).toBe('unread');
    view.unmount();
  });
});
