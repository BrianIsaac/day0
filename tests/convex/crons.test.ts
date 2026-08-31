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

describe('scheduled surface maintenance', (): void => {
  it('re-probes connected surfaces every hour', (): void => {
    expect(crons.crons['re-probe connected surfaces']).toMatchObject({
      name: 'surfaceActions:reprobeAll',
      schedule: { type: 'interval', hours: 1 },
    });
  });

  it('polls connected surfaces for work every five minutes', (): void => {
    expect(crons.crons['poll connected surfaces for work']).toMatchObject({
      name: 'intakeActions:pollAll',
      schedule: { type: 'interval', minutes: 5 },
    });
  });

  it('polls manager decision replies every minute', (): void => {
    expect(crons.crons['poll manager decision replies']).toMatchObject({
      name: 'intakeActions:pollDecisions',
      schedule: { type: 'interval', seconds: 60 },
    });
  });
});
