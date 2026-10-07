import { describe, expect, it } from 'vitest';
import {
  channelAllowlist,
  holdsOwnSlackApp,
  SLACK_CHANNEL_METHODS,
  withChannelMethods,
} from '../../../src/surfaces/slack-own-channel';
import type { SurfaceRecord } from '../../../src/surfaces/types';

const ownAppCard = {
  class: 'chat',
  path: 'documented-api',
  endpoint: 'https://slack.com/api/',
  credentialId: 'cred-bot',
  credentialKind: 'oauth',
  provisioning: { installedAt: 2 },
};

const record: SurfaceRecord = {
  slug: 'team-chat',
  displayName: 'Slack',
  class: 'chat',
  verdict: 'connected',
  credentialLanded: true,
  path: 'documented-api',
  endpoint: 'https://slack.com/api/',
  toolAllowlist: ['conversations.history', 'chat.postMessage'],
  credentialId: 'cred-bot',
  credentialKind: 'oauth',
  managerDmChannelId: 'D0MANAGER',
};

describe('the Slack methods Day0’s own manager channel calls (13-FS’s design 1 (b))', (): void => {
  it('are who the bot is, who the manager is, the DM, Day0’s posts there and the edit of its own request', (): void => {
    expect(SLACK_CHANNEL_METHODS).toEqual([
      'auth.test',
      'users.lookupByEmail',
      'conversations.open',
      'chat.postMessage',
      'chat.update',
    ]);
  });

  it('are allowed beside the page’s on an app Day0 created, each once, in the page’s order first', (): void => {
    expect(channelAllowlist({ ...record, ownSlackApp: true })).toEqual([
      'conversations.history',
      'chat.postMessage',
      'auth.test',
      'users.lookupByEmail',
      'conversations.open',
      'chat.update',
    ]);
  });

  it('are the page’s alone on a shared token, and the record is handed on as it is', (): void => {
    expect(channelAllowlist(record)).toEqual(['conversations.history', 'chat.postMessage']);
    expect(withChannelMethods(record)).toBe(record);
    expect(withChannelMethods({ ...record, ownSlackApp: true }).toolAllowlist).toContain(
      'chat.update',
    );
  });
});

describe('a card on an app Day0 created', (): void => {
  it('is an installed app whose own token the Slack card holds', (): void => {
    expect(holdsOwnSlackApp(ownAppCard)).toBe(true);
  });

  it('is not a pasted token, an app awaiting its install, a card with no token, or another host', (): void => {
    expect(holdsOwnSlackApp({ ...ownAppCard, credentialKind: 'value' })).toBe(false);
    expect(holdsOwnSlackApp({ ...ownAppCard, provisioning: {} })).toBe(false);
    expect(holdsOwnSlackApp({ ...ownAppCard, credentialId: undefined })).toBe(false);
    expect(holdsOwnSlackApp({ ...ownAppCard, endpoint: 'https://chat.example.com/api/' })).toBe(
      false,
    );
    expect(holdsOwnSlackApp({ ...ownAppCard, path: 'mcp' })).toBe(false);
    expect(holdsOwnSlackApp({ ...ownAppCard, class: 'kanban' })).toBe(false);
  });
});
