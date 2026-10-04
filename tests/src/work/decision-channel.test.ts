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
    expect(decisionsReachOf(undefined, true)).toEqual({ kind: 'dashboard' });
    expect(
      decisionsReachOf(card({ provisioning: { appLevelTokenCredentialId: 'k' } }), true),
    ).toEqual({ kind: 'dm', channel: 'Slack', buttons: true });
    expect(decisionsReachOf(card({ provisioning: {} }), true)).toEqual({
      kind: 'dm',
      channel: 'Slack',
      buttons: false,
    });
    expect(
      decisionsReachOf(card({ provisioning: { appLevelTokenCredentialId: 'k' } }), false),
    ).toEqual({ kind: 'dm', channel: 'Slack', buttons: false });
  });
});
