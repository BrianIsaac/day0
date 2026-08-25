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
});
