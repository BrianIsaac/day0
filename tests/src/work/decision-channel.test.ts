import { describe, expect, it } from 'vitest';
import { decisionChannelOf, decisionsReachOf } from '../../../src/work/decision-channel';

const card = (fields: Partial<Parameters<typeof decisionsReachOf>[0] & object>) => ({
  displayName: 'Slack',
  createdAt: 1,
  path: 'documented-api',
  endpoint: 'https://slack.com/api/',
  ...fields,
});

describe('decisionChannelOf', (): void => {
  it('takes the first channel in the documented order, then the oldest', (): void => {
    const later = card({ displayName: 'Later', waterfallPosition: 2, createdAt: 1 });
    const first = card({ displayName: 'First', waterfallPosition: 1, createdAt: 5 });
    const unordered = card({ displayName: 'Unordered', createdAt: 0 });
    expect(decisionChannelOf([later, unordered, first])?.displayName).toBe('First');
    expect(
      decisionChannelOf([unordered, card({ displayName: 'Older', createdAt: -1 })])?.displayName,
    ).toBe('Older');
    expect(decisionChannelOf([])).toBeUndefined();
  });
});

describe('decisionsReachOf', (): void => {
  it('says here alone without a channel, and the DM with or without buttons otherwise', (): void => {
    // Re-pinned for W12V-7: the DM says whether the manager's typed code reaches the app.
    expect(decisionsReachOf(undefined, true, true)).toEqual({ kind: 'dashboard' });
    expect(
      decisionsReachOf(card({ provisioning: { appLevelTokenCredentialId: 'k' } }), true, true),
    ).toEqual({ kind: 'dm', channel: 'Slack', buttons: true, typedCode: true });
    expect(decisionsReachOf(card({ provisioning: {} }), true, true)).toEqual({
      kind: 'dm',
      channel: 'Slack',
      buttons: false,
      typedCode: true,
    });
    expect(
      decisionsReachOf(card({ provisioning: { appLevelTokenCredentialId: 'k' } }), false, true),
    ).toEqual({ kind: 'dm', channel: 'Slack', buttons: false, typedCode: true });
  });

  it('says no typed code reaches an app that takes no messages (W12V-7)', (): void => {
    expect(
      decisionsReachOf(card({ provisioning: { appLevelTokenCredentialId: 'k' } }), true, false),
    ).toEqual({ kind: 'dm', channel: 'Slack', buttons: true, typedCode: false });
  });
});
