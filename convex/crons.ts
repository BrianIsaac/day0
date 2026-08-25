import { cronJobs } from 'convex/server';
import type { FunctionReference } from 'convex/server';
import { internal } from './_generated/api';

const intakeInternal = internal as unknown as {
  intakeActions: {
    pollAll: FunctionReference<'action', 'internal', Record<string, never>, unknown>;
  };
};

/**
 * Scheduled maintenance the deployment owes itself.
 *
 * A failed voice finalisation schedules its own retry in the transaction that
 * releases the session, so this is not the ordinary recovery path. It exists
 * for the failure that transaction cannot cover: a finisher whose process died
 * before it could release anything, leaving a claim nobody will ever come back
 * to clear. The interval is well under the lease it is looking for expired
 * claims past.
 */
const crons = cronJobs();

crons.interval(
  'recover stalled voice finalisations',
  { minutes: 5 },
  internal.voice.sweepStalledFinalisations,
  {},
);

crons.interval('sync documentation sources', { minutes: 15 }, internal.docSyncActions.syncAll, {});

// Phase 2 Lane B surface maintenance.
crons.interval('re-probe connected surfaces', { hours: 1 }, internal.surfaceActions.reprobeAll, {});

crons.interval(
  'poll connected surfaces for work',
  { minutes: 5 },
  intakeInternal.intakeActions.pollAll,
  {},
);

export default crons;
