/** @vitest-environment node */

import { describe, expect, it } from 'vitest';
import { markdownTitle, normaliseToolNames, resolveDocsDirectory } from '../../convex/probeActions';

describe('probeActions pure helpers', (): void => {
  it('returns raw provider tool names in stable order', (): void => {
    expect(normaliseToolNames(['probe_save_issue', 'probe_list_issues'], 'probe')).toEqual([
      'list_issues',
      'save_issue',
    ]);
  });

  it('reads the first level-one Markdown heading', (): void => {
    expect(markdownTitle('intro\n# Team onboarding\nbody', 'onboarding')).toBe('Team onboarding');
    expect(markdownTitle('intro only', 'onboarding')).toBe('onboarding');
  });

  it('refuses paths outside the configured documentation root', (): void => {
    expect(resolveDocsDirectory('/docs', 'runbooks')).toBe('/docs/runbooks');
    expect((): string => resolveDocsDirectory('/docs', '../secret')).toThrow(
      'Folder probe root must stay inside DAY0_DOCS_ROOT.',
    );
  });
});
