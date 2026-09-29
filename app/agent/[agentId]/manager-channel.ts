import type { SurfaceRecord } from '@/surfaces/types';
import { verdictFor } from '@/surfaces/verdict';

/**
 * The chat surface the employee can reach its manager on now: a DM channel and the manager's
 * user resolved, and the connection live by the six-hour rule. The Manager DMs setting and the
 * work card's "ask again" both read this, so neither offers a channel that cannot deliver.
 */
export function connectedManagerChannel(
  surfaces: readonly SurfaceRecord[],
  now: number,
): SurfaceRecord | undefined {
  return surfaces.find(
    (surface) =>
      surface.class === 'chat' &&
      !!surface.managerDmChannelId &&
      !!surface.managerUserId &&
      verdictFor(surface, now) === 'connected',
  );
}
