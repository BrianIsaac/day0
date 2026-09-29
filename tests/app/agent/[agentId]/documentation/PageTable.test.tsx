import { describe, expect, it } from 'vitest';
import { readStateLine } from '../../../../../app/agent/[agentId]/documentation/PageTable';

describe('readStateLine', (): void => {
  const completedAt = Date.UTC(2026, 8, 29, 14, 5);

  it('says a source has not been read before its first sync finishes', (): void => {
    expect(readStateLine(null, 'UTC')).toBe('No sync of this source has finished yet.');
  });

  it('says when the last sync finished and that it read everything it listed', (): void => {
    expect(readStateLine({ completedAt, unreadCount: 0, unreadNamed: 0 }, 'UTC')).toBe(
      'Last sync finished 29 Sep 2026, 14:05. It read every page it listed.',
    );
  });

  it('says how many pages keep an earlier version, and when only the first are marked', (): void => {
    expect(readStateLine({ completedAt, unreadCount: 2, unreadNamed: 2 }, 'UTC')).toBe(
      'Last sync finished 29 Sep 2026, 14:05. 2 pages it listed could not be read, and keep their earlier version, marked below.',
    );
    expect(readStateLine({ completedAt, unreadCount: 14, unreadNamed: 10 }, 'UTC')).toBe(
      'Last sync finished 29 Sep 2026, 14:05. 14 pages it listed could not be read, and keep their earlier version; the first 10 are marked below.',
    );
  });
});
