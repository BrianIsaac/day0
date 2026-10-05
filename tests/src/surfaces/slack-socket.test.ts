import { describe, expect, it } from 'vitest';
import {
  bridgeSecretMatches,
  decisionButtonsFor,
  parsePress,
  socketBridgeConfigured,
  SOCKET_BRIDGE_SECRET_VAR,
} from '../../../src/surfaces/slack-socket';

const ownApp = {
  path: 'documented-api',
  endpoint: 'https://slack.com/api/',
  provisioning: { appLevelTokenCredentialId: 'k1' },
};

describe('decisionButtonsFor', (): void => {
  it('offers buttons on the employee’s own Slack app once its app-level token landed and a bridge runs', (): void => {
    expect(decisionButtonsFor(ownApp, true)).toEqual({ available: true });
  });

  it('says why the requests carry the typed code alone', (): void => {
    expect(decisionButtonsFor({ ...ownApp, path: 'mcp' }, true)).toEqual({
      available: false,
      why: 'not-slack-api',
    });
    expect(decisionButtonsFor({ ...ownApp, endpoint: 'https://chat.example/api/' }, true)).toEqual({
      available: false,
      why: 'not-slack-api',
    });
    expect(decisionButtonsFor({ ...ownApp, provisioning: undefined }, true)).toEqual({
      available: false,
      why: 'no-own-app',
    });
    expect(decisionButtonsFor({ ...ownApp, provisioning: {} }, true)).toEqual({
      available: false,
      why: 'no-app-level-token',
    });
    // Re-pinned for W12-R18: the bridge is read before the token, and says whether one is stored.
    expect(decisionButtonsFor(ownApp, false)).toEqual({
      available: false,
      why: 'no-bridge',
      tokenStored: true,
    });
  });

  it('reads the bridge before the token, so a card on a deployment with no bridge asks for none (W12-R18)', (): void => {
    expect(decisionButtonsFor({ ...ownApp, provisioning: {} }, false)).toEqual({
      available: false,
      why: 'no-bridge',
      tokenStored: false,
    });
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
