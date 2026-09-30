import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { avatarById } from '@/agent/avatar-pets';
import type { OneToOnePhase } from '@/agent/one-to-one-phase';
import { employeeStateWords, type EmployeeState } from '@/work/state-labels';
import { AgentPixelAvatar } from '../../../app/home/PixelAvatar';

describe('AgentPixelAvatar', (): void => {
  it('titles the face with the employee and its state, never a face or a person', (): void => {
    const html = renderToStaticMarkup(
      <AgentPixelAvatar avatar={avatarById('face-05')} state="charter-pending" label="Mira" />,
    );
    expect(html).toContain('title="Mira, charter to review"');
    expect(html).not.toContain('Face 5');
  });

  it('titles the face in the words the employee’s pill uses, never the row’s own (m6)', (): void => {
    const title = (state: 'deployed' | 'day-one-in-progress' | 'active'): string =>
      /title="([^"]*)"/.exec(
        renderToStaticMarkup(
          <AgentPixelAvatar avatar={avatarById('face-05')} state={state} label="Mira" />,
        ),
      )?.[1] ?? '';
    expect(title('deployed')).toBe('Mira, waiting for your one-to-one');
    expect(title('day-one-in-progress')).toBe('Mira, in your one-to-one');
    expect(title('active')).toBe('Mira, active');
  });

  it('titles the face with the phase the pill beside it says, drafting the charter during the draft (review m3)', (): void => {
    const html = renderToStaticMarkup(
      <AgentPixelAvatar
        avatar={avatarById('face-05')}
        state="day-one-in-progress"
        phase="drafting"
        label="Mira"
      />,
    );
    expect(html).toContain('title="Mira, drafting the charter"');
  });

  it('tones the face in the hue of the words it is titled with, on every state (review m17)', (): void => {
    const shown: ReadonlyArray<readonly [EmployeeState, OneToOnePhase['kind'] | undefined]> = [
      ['deployed', undefined],
      ['day-one-in-progress', undefined],
      ['day-one-in-progress', 'drafting'],
      ['charter-pending', undefined],
      ['active', undefined],
    ];
    for (const [state, phase] of shown) {
      const html = renderToStaticMarkup(
        <AgentPixelAvatar
          avatar={avatarById('face-05')}
          state={state}
          phase={phase}
          label="Mira"
        />,
      );
      const hue = employeeStateWords(state, phase).tone;
      expect(html).toMatch(new RegExp(`^<div class="[^"]*border-\\[var\\(--color-${hue}\\)\\]/35`));
    }
  });

  it('keeps the face out of the accessibility tree, since its name is always beside it', (): void => {
    const html = renderToStaticMarkup(
      <AgentPixelAvatar avatar={avatarById('face-05')} state="active" label="Mira" />,
    );
    expect(html).toMatch(/^<div[^>]*aria-hidden="true"/);
    expect(html).not.toContain('aria-label="active"');
  });
});
