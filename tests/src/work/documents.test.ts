import { describe, expect, it } from 'vitest';
import { renderHowTos, renderTeamDocs } from '../../../src/work/documents';

describe('the documentation blocks of a prompt', (): void => {
  it('render each guide and document as a titled block, in order', (): void => {
    expect(
      renderHowTos([
        { slug: 'refresh', title: 'Refresh the tile', body: 'Sign in, set, save.' },
        { slug: 'post', title: 'Post to Slack', body: 'One message per action.' },
      ]),
    ).toBe(
      '--- Refresh the tile ---\nSign in, set, save.\n\n--- Post to Slack ---\nOne message per action.',
    );
    expect(renderTeamDocs([{ slug: 'team', title: 'Team overview', body: 'Who does what.' }])).toBe(
      '--- Team overview ---\nWho does what.',
    );
  });

  it('say so when nothing is loaded, rather than rendering an empty block', (): void => {
    expect(renderHowTos([])).toBe('(no how-to guides loaded)');
    expect(renderTeamDocs([])).toBe('(no team docs loaded)');
  });
});
