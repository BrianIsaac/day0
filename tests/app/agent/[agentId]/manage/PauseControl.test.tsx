/** @vitest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PAUSE_CARD_COPY,
  PauseControl,
} from '../../../../../app/agent/[agentId]/manage/PauseControl';
import { AgentZoneContext } from '../../../../../app/components/time';
import { axeViolations } from '../../../../fixtures/dom/axe';
import {
  button,
  focusedName,
  mount,
  press,
  said,
  unmountAll,
} from '../../../../fixtures/dom/press';
import { underTarget } from '../../../../fixtures/dom/targets';

/** A backend refusal as it reaches the browser: the transport's envelope around the sentence. */
function refusal(call: string, sentence: string): Error {
  return new Error(
    `[CONVEX M(${call})] [Request ID: 1] Server Error\nUncaught Error: ${sentence}\n    at handler (../convex/x.ts:1:1)`,
  );
}

const PAUSED_AT = Date.UTC(2026, 9, 4, 9, 30);

describe('PauseControl (12-P)', (): void => {
  afterEach((): void => unmountAll());

  it('says what a pause does and offers Pause by name, then says it was paused and keeps focus on the control', async (): Promise<void> => {
    const onPause = vi.fn(async (): Promise<void> => undefined);
    const view = mount(<PauseControl name="Priya" onPause={onPause} onResume={vi.fn()} />);
    expect(view.container.textContent).toContain(PAUSE_CARD_COPY);
    expect(PAUSE_CARD_COPY).toBe(
      'Stops intake and holds every run at its next gate. Nothing is deleted; resume any time.',
    );

    await press(view.container, 'Pause Priya');
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(said(view.container)).toEqual([
      'Priya is paused: it takes no new work, and each run holds at its next gate.',
    ]);
    expect(focusedName()).toBe('Pause Priya');
  });

  it('says since when and why a paused employee waits, that its decisions still do, and offers Resume by name', async (): Promise<void> => {
    const onResume = vi.fn(async (): Promise<void> => undefined);
    const view = mount(
      <AgentZoneContext.Provider value="Asia/Singapore">
        <PauseControl
          name="Priya"
          pausedAt={PAUSED_AT}
          reason="Quarter close."
          onPause={vi.fn()}
          onResume={onResume}
        />
      </AgentZoneContext.Provider>,
    );
    const text = view.container.textContent ?? '';
    expect(text).toContain('Paused since 4 Oct 2026, 17:30.');
    expect(text).toContain('Your reason: Quarter close.');
    expect(text).toContain(
      'Priya takes no new work and starts no step. Decisions it already asked still wait on you, and what you approve runs once you resume.',
    );
    expect(text).not.toContain(PAUSE_CARD_COPY);

    await press(view.container, 'Resume Priya');
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(said(view.container)).toEqual(['Priya is working again: what was held goes on now.']);
  });

  it('says a refusal in the live region and changes nothing on the card', async (): Promise<void> => {
    const view = mount(
      <PauseControl
        name="Priya"
        onPause={async () => {
          throw refusal('agents:pause', 'This employee is not yours.');
        }}
        onResume={vi.fn()}
      />,
    );
    await press(view.container, 'Pause Priya');
    expect(said(view.container)).toEqual(['This employee is not yours.']);
    expect(button(view.container, 'Pause Priya').disabled).toBe(false);
  });

  it('omits the reason line when the pause has none', (): void => {
    const html = renderToStaticMarkup(
      <PauseControl name="Priya" pausedAt={PAUSED_AT} onPause={vi.fn()} onResume={vi.fn()} />,
    );
    expect(html).not.toContain('Your reason');
  });

  it('passes axe and keeps each control at 44 px, running and paused', async (): Promise<void> => {
    for (const pausedAt of [undefined, PAUSED_AT]) {
      const view = mount(
        <PauseControl
          name="Priya"
          pausedAt={pausedAt}
          reason="Quarter close."
          onPause={vi.fn()}
          onResume={vi.fn()}
        />,
      );
      expect(await axeViolations(view.container)).toEqual([]);
      expect(underTarget(view.container)).toEqual([]);
      view.unmount();
    }
  });
});
