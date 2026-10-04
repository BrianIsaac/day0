import { describe, expect, it } from 'vitest';
import {
  decisionButtonsFor,
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
    expect(decisionButtonsFor(ownApp, false)).toEqual({ available: false, why: 'no-bridge' });
  });
});

describe('socketBridgeConfigured', (): void => {
  it('reads a non-blank secret as a configured bridge', (): void => {
    expect(socketBridgeConfigured({ [SOCKET_BRIDGE_SECRET_VAR]: 'abc' })).toBe(true);
    expect(socketBridgeConfigured({ [SOCKET_BRIDGE_SECRET_VAR]: '  ' })).toBe(false);
    expect(socketBridgeConfigured({})).toBe(false);
  });
});
