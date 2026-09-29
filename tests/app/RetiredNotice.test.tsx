/** @vitest-environment jsdom */

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { RetiredNotice, RetiredNoticeProvider, useAnnounceRetired } from '../../app/RetiredNotice';
import { focusedName, mount, press, said, settle, unmountAll } from '../fixtures/dom/press';

/** The employee's page's half: a Retire that announces before it leaves. */
function Retire() {
  const announce = useAnnounceRetired();
  return (
    <button type="button" onClick={() => announce('Mira')}>
      Retire Mira
    </button>
  );
}

/** The layout with the employee's page, then the home in its place. */
function App({ home }: { home: boolean }) {
  return <RetiredNoticeProvider>{home ? <RetiredNotice /> : <Retire />}</RetiredNoticeProvider>;
}

afterEach((): void => {
  unmountAll();
  document.body.replaceChildren();
});

describe('the retired notice', (): void => {
  it('says once, on the page the retire lands on, that the employee is retired, and takes focus', async (): Promise<void> => {
    const view = mount(<App home={false} />);
    await press(view.container, 'Retire Mira');
    act((): void => view.root.render(<App home />));
    await settle();
    expect(said(view.container)).toEqual(['Mira is retired.']);
    expect(focusedName()).toBe('Mira is retired.');

    // Back to the page and home again: the notice was taken, so nothing is said.
    act((): void => view.root.render(<App home={false} />));
    act((): void => view.root.render(<App home />));
    await settle();
    expect(said(view.container)).toEqual([]);
  });

  it('says nothing on a home no retire sent the manager to', async (): Promise<void> => {
    const view = mount(<App home />);
    await settle();
    expect(view.container.textContent).toBe('');
  });

  it('announces nowhere, and draws nothing, outside the layout that carries it', async (): Promise<void> => {
    const view = mount(
      <>
        <Retire />
        <RetiredNotice />
      </>,
    );
    await press(view.container, 'Retire Mira');
    expect(said(view.container)).toEqual([]);
  });
});
