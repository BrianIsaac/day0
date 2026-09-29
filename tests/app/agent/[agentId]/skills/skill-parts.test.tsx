import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  plainSkillName,
  ScopeChips,
  SkillStatusLine,
} from '../../../../../app/agent/[agentId]/skills/skill-parts';

describe('skill-parts', (): void => {
  it('names a skill by the sentence it was proposed with, without its stop, or by its name when it has none', (): void => {
    expect(
      plainSkillName({
        name: 'kanban-comment-and-close',
        description: 'Comment on a ticket and close it.',
      }),
    ).toBe('Comment on a ticket and close it');
    expect(plainSkillName({ name: 'refresh', description: '   ' })).toBe('refresh');
  });

  it('draws each scope as a code chip after its word, and nothing for a skill that needs none', (): void => {
    const html = renderToStaticMarkup(
      <ScopeChips scopes={['linear:read', 'linear:write']} lead="needs" />,
    );
    expect(html.match(/<code[^>]*>linear:(read|write)<\/code>/g)).toHaveLength(2);
    expect(html).toMatch(/^<span>needs /);
    expect(renderToStaticMarkup(<ScopeChips scopes={[]} lead="needs" />)).toBe('');
    expect(renderToStaticMarkup(<ScopeChips lead="needs" />)).toBe('');
  });

  it('keeps a one-line reason as prose and a log in a named scroll box', (): void => {
    expect(renderToStaticMarkup(<SkillStatusLine skill="refresh" text="refused" />)).toMatch(
      /^<p /,
    );
    expect(renderToStaticMarkup(<SkillStatusLine skill="refresh" text={'a\nb'} />)).toContain(
      'aria-label="Verification log: refresh"',
    );
  });
});
