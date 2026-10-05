import { describe, expect, it } from 'vitest';
import {
  bridgeSecretMatches,
  decisionButtonsFor,
  heartbeatWriteDue,
  parseHeartbeat,
  parsePress,
  socketBridgeConfigured,
  socketBridgeStateFor,
  SOCKET_BRIDGE_SECRET_VAR,
  SOCKET_HEARTBEAT_FRESH_MS,
  SOCKET_HEARTBEAT_REFRESH_MS,
} from '../../../src/surfaces/slack-socket';

const ownApp = {
  path: 'documented-api',
  endpoint: 'https://slack.com/api/',
  provisioning: { appLevelTokenCredentialId: 'k1' },
};

describe('decisionButtonsFor', (): void => {
  it('offers buttons on the employee’s own Slack app once its app-level token landed and a bridge runs', (): void => {
    expect(decisionButtonsFor(ownApp, 'live')).toEqual({ available: true });
  });

  it('says why the requests carry the typed code alone', (): void => {
    expect(decisionButtonsFor({ ...ownApp, path: 'mcp' }, 'live')).toEqual({
      available: false,
      why: 'not-slack-api',
    });
    expect(
      decisionButtonsFor({ ...ownApp, endpoint: 'https://chat.example/api/' }, 'live'),
    ).toEqual({
      available: false,
      why: 'not-slack-api',
    });
    expect(decisionButtonsFor({ ...ownApp, provisioning: undefined }, 'live')).toEqual({
      available: false,
      why: 'no-own-app',
    });
    expect(decisionButtonsFor({ ...ownApp, provisioning: {} }, 'live')).toEqual({
      available: false,
      why: 'no-app-level-token',
    });
    // Re-pinned for W12-R18: the bridge is read before the token, and says whether one is stored.
    expect(decisionButtonsFor(ownApp, 'unconfigured')).toEqual({
      available: false,
      why: 'no-bridge',
      tokenStored: true,
    });
  });

  it('reads the bridge before the token, so a card on a deployment with no bridge asks for none (W12-R18)', (): void => {
    expect(decisionButtonsFor({ ...ownApp, provisioning: {} }, 'unconfigured')).toEqual({
      available: false,
      why: 'no-bridge',
      tokenStored: false,
    });
  });
});

describe('decisionButtonsFor and the bridge’s heartbeat (D-6 (b), W12-R16)', (): void => {
  it('offers no buttons while a configured bridge reports no live connection for the app', (): void => {
    expect(decisionButtonsFor(ownApp, 'down')).toEqual({ available: false, why: 'bridge-down' });
  });

  it('asks for the app-level token before it says the bridge is down, since the bridge dials only apps with one', (): void => {
    expect(decisionButtonsFor({ ...ownApp, provisioning: {} }, 'down')).toEqual({
      available: false,
      why: 'no-app-level-token',
    });
  });
});

describe('socketBridgeStateFor', (): void => {
  const NOW = 1_791_000_000_000;
  const report = { appId: 'A_DAY0_FAKE', live: true, reportedAt: NOW - 1_000 };

  it('reads the bridge as live only for the card’s own app, with a live and recent report', (): void => {
    expect(socketBridgeStateFor(true, report, 'A_DAY0_FAKE', NOW)).toBe('live');
    expect(socketBridgeStateFor(true, { ...report, live: false }, 'A_DAY0_FAKE', NOW)).toBe('down');
    expect(socketBridgeStateFor(true, report, 'A_OTHER_APP', NOW)).toBe('down');
    expect(
      socketBridgeStateFor(
        true,
        { ...report, reportedAt: NOW - SOCKET_HEARTBEAT_FRESH_MS - 1 },
        'A_DAY0_FAKE',
        NOW,
      ),
    ).toBe('down');
  });

  it('reads a card no report names, as a bridge from before 0.17.0 leaves it, as down', (): void => {
    expect(socketBridgeStateFor(true, null, 'A_DAY0_FAKE', NOW)).toBe('down');
    expect(socketBridgeStateFor(true, report, undefined, NOW)).toBe('down');
  });

  it('reads a deployment that holds no bridge secret as unconfigured, whatever a row says', (): void => {
    expect(socketBridgeStateFor(false, report, 'A_DAY0_FAKE', NOW)).toBe('unconfigured');
  });

  it('keeps a live report fresh across the refresh and one missed sync', (): void => {
    expect(SOCKET_HEARTBEAT_FRESH_MS).toBeGreaterThanOrEqual(SOCKET_HEARTBEAT_REFRESH_MS + 60_000);
  });
});

describe('heartbeatWriteDue', (): void => {
  const NOW = 1_791_000_000_000;
  const kept = { appId: 'A_DAY0_FAKE', live: true, reportedAt: NOW - 60_000 };

  it('writes a card’s first report, and one whose liveness or app changed', (): void => {
    expect(heartbeatWriteDue(null, { appId: 'A_DAY0_FAKE', live: true }, NOW)).toBe(true);
    expect(heartbeatWriteDue(kept, { appId: 'A_DAY0_FAKE', live: false }, NOW)).toBe(true);
    expect(heartbeatWriteDue(kept, { appId: 'A_OTHER_APP', live: true }, NOW)).toBe(true);
  });

  it('leaves an unchanged report younger than about two minutes alone, so the table is not rewritten every sync', (): void => {
    expect(heartbeatWriteDue(kept, { appId: 'A_DAY0_FAKE', live: true }, NOW)).toBe(false);
    expect(
      heartbeatWriteDue(
        { ...kept, reportedAt: NOW - SOCKET_HEARTBEAT_REFRESH_MS },
        { appId: 'A_DAY0_FAKE', live: true },
        NOW,
      ),
    ).toBe(true);
  });
});

describe('parseHeartbeat', (): void => {
  it('reads the apps a bridge reports, each with its card, app and liveness', (): void => {
    expect(
      parseHeartbeat({
        apps: [
          { surfaceId: 's1', appId: 'A1', live: true, liveSince: 5 },
          { surfaceId: 's2', appId: 'A2', live: false, failure: 'no connection URL: invalid_auth' },
        ],
      }),
    ).toEqual([
      { surfaceId: 's1', appId: 'A1', live: true, liveSince: 5 },
      { surfaceId: 's2', appId: 'A2', live: false, failure: 'no connection URL: invalid_auth' },
    ]);
  });

  it('refuses a body that is not a report, and drops an entry missing its card, app or liveness', (): void => {
    expect(parseHeartbeat(undefined)).toBeUndefined();
    expect(parseHeartbeat({ apps: 'none' })).toBeUndefined();
    expect(
      parseHeartbeat({
        apps: [
          { surfaceId: 's1', appId: 'A1' },
          { appId: 'A2', live: true },
        ],
      }),
    ).toEqual([]);
  });

  it('bounds a failure’s words, which the backend stores', (): void => {
    const [one] =
      parseHeartbeat({
        apps: [{ surfaceId: 's1', appId: 'A1', live: false, failure: 'x'.repeat(2_000) }],
      }) ?? [];
    expect(one?.failure?.length).toBeLessThanOrEqual(300);
  });
});

describe('socketBridgeConfigured', (): void => {
  it('reads a non-blank secret as a configured bridge', (): void => {
    expect(socketBridgeConfigured({ [SOCKET_BRIDGE_SECRET_VAR]: 'abc' })).toBe(true);
    expect(socketBridgeConfigured({ [SOCKET_BRIDGE_SECRET_VAR]: '  ' })).toBe(false);
    expect(socketBridgeConfigured({})).toBe(false);
  });
});

describe('parsePress', (): void => {
  const payload = {
    type: 'block_actions',
    user: { id: 'UMANAGER' },
    team: { id: 'T0DAY0' },
    api_app_id: 'A0OPS',
    container: { type: 'message', message_ts: '1787768406.604379', channel_id: 'D0MANAGER' },
    channel: { id: 'D0MANAGER' },
    actions: [
      {
        action_id: 'day0.decision.approve',
        block_id: 'day0-decision-ab3xyz',
        value: 'ab3xyz',
        type: 'button',
        action_ts: '1787768500.000200',
      },
    ],
  };

  it('reads who pressed what on which message from a block_actions payload', (): void => {
    expect(parsePress(payload)).toEqual({
      userId: 'UMANAGER',
      teamId: 'T0DAY0',
      appId: 'A0OPS',
      channelId: 'D0MANAGER',
      messageTs: '1787768406.604379',
      actionTs: '1787768500.000200',
      action: { action_id: 'day0.decision.approve', value: 'ab3xyz' },
    });
  });

  it('reads nothing from another payload type, or one missing who, where or what', (): void => {
    expect(parsePress({ ...payload, type: 'view_submission' })).toBeUndefined();
    expect(parsePress({ ...payload, user: {} })).toBeUndefined();
    expect(parsePress({ ...payload, container: { type: 'message' } })).toBeUndefined();
    expect(parsePress({ ...payload, actions: [] })).toBeUndefined();
    expect(parsePress('block_actions')).toBeUndefined();
    expect(parsePress(null)).toBeUndefined();
  });

  it('takes the channel from the payload when the container does not name it', (): void => {
    expect(
      parsePress({ ...payload, container: { type: 'message', message_ts: '1.2' } })?.channelId,
    ).toBe('D0MANAGER');
  });
});

describe('bridgeSecretMatches', (): void => {
  it('accepts only the exact secret as a bearer token', async (): Promise<void> => {
    expect(await bridgeSecretMatches('Bearer s3cret-value', 's3cret-value')).toBe(true);
    expect(await bridgeSecretMatches('Bearer s3cret-valuf', 's3cret-value')).toBe(false);
    expect(await bridgeSecretMatches('s3cret-value', 's3cret-value')).toBe(false);
    expect(await bridgeSecretMatches(null, 's3cret-value')).toBe(false);
    expect(await bridgeSecretMatches('Bearer ', '')).toBe(false);
  });
});
