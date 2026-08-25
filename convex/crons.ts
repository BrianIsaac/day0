import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

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

export default crons;
