import { describe, expect, it } from 'vitest';
import { sourceStatus } from '../../../app/documentation/source-status';

describe('sourceStatus', (): void => {
  const lastSyncAt = Date.UTC(2026, 8, 29, 14, 5);

  it('says each sync state in the manager’s words, with when the source was last read', (): void => {
    expect(sourceStatus({ status: 'synced', lastSyncAt }, 'UTC')).toEqual({
      text: 'Read',
      tone: 'ok',
      lastRead: '29 Sep 2026, 14:05',
    });
    expect(sourceStatus({ status: 'linking' }, 'UTC')).toEqual({ text: 'Reading', tone: 'accent' });
    expect(sourceStatus({ status: 'error', lastSyncAt }, 'UTC')).toMatchObject({
      text: 'Could not read',
      lastRead: '29 Sep 2026, 14:05',
    });
    expect(sourceStatus({ status: 'credential-not-landed' }, 'UTC').text).toBe('Secret not stored');
  });

  it('draws a source that could not be read in warn, never on a danger fill (A D4 (b))', (): void => {
    for (const status of ['error', 'credential-not-landed'] as const) {
      expect(sourceStatus({ status }).tone).toBe('warn');
    }
  });
});
