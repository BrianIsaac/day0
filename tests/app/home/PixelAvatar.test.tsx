import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { avatarById } from '@/agent/avatar-pets';
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

  it('keeps the face out of the accessibility tree, since its name is always beside it', (): void => {
    const html = renderToStaticMarkup(
      <AgentPixelAvatar avatar={avatarById('face-05')} state="active" label="Mira" />,
    );
    expect(html).toMatch(/^<div[^>]*aria-hidden="true"/);
    expect(html).not.toContain('aria-label="active"');
  });
});
