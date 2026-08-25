/** @vitest-environment node */

import { describe, expect, it } from 'vitest';
import { categoryForPage, safeSyncError } from '../../convex/docSyncActions';

describe('documentation sync action helpers', (): void => {
  it('classifies runbooks from the title or first heading', (): void => {
    expect(categoryForPage({ title: 'How to update tickets', markdown: 'Body' })).toBe(
      'how-to-guide',
    );
    expect(categoryForPage({ title: 'Ticketing', markdown: '# Runbook for tickets\nBody' })).toBe(
      'how-to-guide',
    );
    expect(categoryForPage({ title: 'Team overview', markdown: '# Team overview' })).toBe(
      'team-doc',
    );
  });

  it('redacts explicit and recognisable credential values', (): void => {
    const tokenShape = ['xoxb', 'secret-value'].join('-');
    expect(safeSyncError(new Error('failed token-value'), 'token-value')).toBe('failed <redacted>');
    expect(safeSyncError(new Error(`failed ${tokenShape}`))).toBe('failed <redacted>');
  });
});
