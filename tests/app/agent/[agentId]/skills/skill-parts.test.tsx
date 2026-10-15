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

  // Re-pinned (W17-R30): the scopes were drawn as `system:verb` code chips ("needs boss:message
  // ticket:read ticket:write" on the hosted walk); they are said as an employee's access is.
  it('says the access a skill needs in words after its lead, and nothing for a skill that needs none', (): void => {
    const html = renderToStaticMarkup(
      <ScopeChips scopes={['boss:message', 'ticket:read', 'ticket:write']} lead="needs:" />,
    );
    expect(html).toBe('<span>needs: messages to you; reading and writing tickets</span>');
    expect(html).not.toContain('<code');
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
