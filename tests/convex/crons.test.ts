import { describe, expect, it } from 'vitest';
import crons from '../../convex/crons';

describe('scheduled documentation sync', (): void => {
  it('runs every fifteen minutes', (): void => {
    expect(crons.crons['sync documentation sources']).toMatchObject({
      name: 'docSyncActions:syncAll',
      schedule: { type: 'interval', minutes: 15 },
    });
  });
});
