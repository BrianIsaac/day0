import { describe, expect, it } from 'vitest';
import type { Id } from '../../../convex/_generated/dataModel';
import { mirroredDocSlug } from '../../../src/docs/types';

describe('documentation types', (): void => {
  it('names mirrored pages by source and stable reference', (): void => {
    const sourceId = 'jd7source1234567890' as Id<'docSources'>;
    expect(mirroredDocSlug(sourceId, 'Runbooks/How to Post Slack.md')).toBe(
      'source-1234567890-runbooks-how-to-post-slack-md',
    );
  });

  it('keeps two Chinese-named runbooks in one source as two pages', (): void => {
    const sourceId = 'jd7source1234567890' as Id<'docSources'>;
    const refresh = mirroredDocSlug(sourceId, '运维/刷新看板.md');
    const rules = mirroredDocSlug(sourceId, '规则.md');
    expect(refresh).not.toBe(rules);
    expect(refresh).toMatch(/^source-1234567890-md-[0-9a-z]{7}$/);
    expect(mirroredDocSlug(sourceId, '运维/刷新看板.md')).toBe(refresh);
  });
});
