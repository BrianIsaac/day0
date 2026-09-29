import { describe, expect, it } from 'vitest';
import type { SurfaceRecord } from '../../../../src/surfaces/types';
import { connectedManagerChannel } from '../../../../app/agent/[agentId]/manager-channel';

describe('connectedManagerChannel', (): void => {
  it('counts a manager channel only while it is connected and knows the manager (m1)', (): void => {
    const now = Date.UTC(2026, 8, 29, 9);
    const live = {
      slug: 'slack',
      displayName: 'Slack',
      class: 'chat',
      verdict: 'connected',
      credentialLanded: true,
      lastVerifiedAt: now - 60_000,
      managerDmChannelId: 'D0MANAGER',
      managerUserId: 'UMANAGER',
    } as unknown as SurfaceRecord;
    expect(connectedManagerChannel([live], now)).toBe(live);
    // Past the six-hour liveness window the row still names the channel, but nothing can be sent.
    const lapsed = { ...live, lastVerifiedAt: now - 7 * 60 * 60 * 1_000 } as SurfaceRecord;
    expect(connectedManagerChannel([lapsed], now)).toBeUndefined();
    const noManager = { ...live, managerUserId: undefined } as SurfaceRecord;
    expect(connectedManagerChannel([noManager], now)).toBeUndefined();
  });
});
