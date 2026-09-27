import { describe, expect, it } from 'vitest';
import { surfaceSlug } from '../../../src/surfaces/slug';

describe('surfaceSlug', () => {
  it('keeps the ASCII slug of a Latin name unchanged', () => {
    expect(surfaceSlug('Northstar CRM')).toBe('northstar-crm');
    expect(surfaceSlug(' Linear / REVOPS ')).toBe('linear-revops');
    expect(surfaceSlug('')).toBe('system');
  });

  it('gives two Chinese system names two slugs, not one `system`', () => {
    const feishu = surfaceSlug('飞书');
    const dingtalk = surfaceSlug('钉钉');
    expect(feishu).not.toBe(dingtalk);
    expect(feishu).toMatch(/^system-[0-9a-z]{7}$/);
  });

  it('keeps a mixed name distinct from its Latin part alone', () => {
    expect(surfaceSlug('金山 Docs')).toMatch(/^docs-[0-9a-z]{7}$/);
    expect(surfaceSlug('金山 Docs')).not.toBe(surfaceSlug('Docs'));
  });

  it('is the same slug for spacing variants of one name', () => {
    expect(surfaceSlug(' 飞书 ')).toBe(surfaceSlug('飞书'));
  });
});
