import { describe, expect, it } from 'vitest';
import type { Id } from '../../../convex/_generated/dataModel';
import {
  isPendingReaderKind,
  mirroredDocSlug,
  type DocPage,
  notReadYet,
  PENDING_READER_NAMES,
} from '../../../src/docs/types';

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

  it('names the five kinds whose readers have not landed, and no kind a reader reads (15-K)', (): void => {
    expect(Object.keys(PENDING_READER_NAMES)).toEqual([
      'sharepoint',
      'confluence-v2',
      'confluence-dc',
      'yuque',
      'drive',
    ]);
    expect(
      (['mcp', 'folder', 'git', 'urls', 'feishu', 'drive'] as const).filter(isPendingReaderKind),
    ).toEqual(['drive']);
    expect(notReadYet('confluence-dc')).toBe(
      'Day0 does not read Confluence Data Center sources yet.',
    );
  });

  it("lets a reader report a page's own status and its revision beside it, both optional (15-K)", (): void => {
    const base: DocPage = {
      sourceId: 'jd7source1234567890' as Id<'docSources'>,
      ref: 'runbook.md',
      title: 'Runbook',
      markdown: '# Runbook',
      updatedAt: 1,
    };
    const reported: DocPage = { ...base, nativeStatus: 'archived', sourceRevision: '7' };
    expect(reported).toMatchObject({ nativeStatus: 'archived', sourceRevision: '7' });
    expect(base).not.toHaveProperty('nativeStatus');
  });
});
