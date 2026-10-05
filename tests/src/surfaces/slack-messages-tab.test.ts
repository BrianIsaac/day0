import { describe, expect, it } from 'vitest';
import {
  manifestTakesMessages,
  slackRefusalIsDefinite,
  typedCodeReachFor,
  typedCodeReaches,
  withMessagesTabOpen,
} from '../../../src/surfaces/slack-messages-tab';

/** Iris's export on the walk (20:46:00Z): an app the kit made before this release, no App Home. */
const IRIS_EXPORT = {
  display_information: { name: 'Iris (Day0)' },
  features: { bot_user: { display_name: 'Iris (Day0)', always_online: false } },
  oauth_config: {
    redirect_urls: ['https://127.0.0.1:3580/api/oauth/slack'],
    scopes: { bot: ['chat:write', 'channels:read'] },
  },
  settings: {
    interactivity: { is_enabled: true },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
    app_level_token_rotation_enabled: false,
    is_mcp_enabled: false,
  },
};

describe('the typed code’s reach', (): void => {
  // Re-pinned for 13-FS (W12V-7): the reach reads the card's own `provisioning.messagesTab`, which
  // every writer of the opening now writes, in place of the employee's record.
  const app = { appName: 'Iris (Day0)', organisationConnectionId: 'conn' };
  const open = { state: 'open', how: 'created', at: 1 } as const;
  const refused = {
    state: 'refused',
    reason: 'Slack apps.manifest.update failed: invalid_manifest',
    at: 2,
    attempts: 1,
  } as const;

  it('reaches an app the card says takes messages', (): void => {
    const reach = typedCodeReachFor(
      { provisioning: { ...app, messagesTab: open } },
      { creatorActive: true },
    );
    expect(reach).toEqual({ state: 'open' });
    expect(typedCodeReaches(reach)).toBe(true);
  });

  it('is Day0’s to open for an app its active configuration connection created', (): void => {
    const reach = typedCodeReachFor({ provisioning: app }, { creatorActive: true });
    expect(reach).toEqual({ state: 'day0-opens', appName: 'Iris (Day0)' });
    expect(typedCodeReaches(reach)).toBe(false);
  });

  it('says Slack refused Day0’s opening, with Slack’s words, so no probe tries it again unasked', (): void => {
    const reach = typedCodeReachFor(
      { provisioning: { ...app, messagesTab: refused } },
      { creatorActive: true },
    );
    expect(reach).toEqual({
      state: 'refused',
      appName: 'Iris (Day0)',
      reason: 'Slack apps.manifest.update failed: invalid_manifest',
    });
    expect(typedCodeReaches(reach)).toBe(false);
  });

  it('needs a person’s toggle for an app Day0 cannot update, refused before or not', (): void => {
    for (const messagesTab of [undefined, refused]) {
      const reach = typedCodeReachFor(
        { provisioning: { appName: 'Otto (Day0)', ...(messagesTab ? { messagesTab } : {}) } },
        { creatorActive: false },
      );
      expect(reach).toEqual({ state: 'needs-toggle', appName: 'Otto (Day0)' });
      expect(typedCodeReaches(reach)).toBe(false);
    }
  });

  it('is unchanged for a card whose app Day0 did not create, which Day0 cannot read', (): void => {
    expect(typedCodeReachFor({}, { creatorActive: false })).toEqual({
      state: 'open',
    });
  });
});

describe('an exported manifest', (): void => {
  it('takes no messages without an App Home, as Iris’s export on the walk', (): void => {
    expect(manifestTakesMessages(IRIS_EXPORT)).toBe(false);
  });

  it('takes no messages with the tab read-only, the setting the walk found off', (): void => {
    expect(
      manifestTakesMessages({
        features: {
          app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: true },
        },
      }),
    ).toBe(false);
  });

  it('takes messages with the tab on and writable, as the walk validated', (): void => {
    expect(
      manifestTakesMessages({
        features: {
          app_home: {
            home_tab_enabled: false,
            messages_tab_enabled: true,
            messages_tab_read_only_enabled: false,
          },
        },
      }),
    ).toBe(true);
  });

  it('is opened for writing with nothing else changed, so no reinstall is asked for', (): void => {
    const opened = withMessagesTabOpen(IRIS_EXPORT);
    expect(opened).toEqual({
      ...IRIS_EXPORT,
      features: {
        bot_user: { display_name: 'Iris (Day0)', always_online: false },
        app_home: {
          home_tab_enabled: false,
          messages_tab_enabled: true,
          messages_tab_read_only_enabled: false,
        },
      },
    });
    expect(manifestTakesMessages(opened)).toBe(true);
  });

  it('keeps a home tab someone turned on', (): void => {
    const opened = withMessagesTabOpen({
      ...IRIS_EXPORT,
      features: { ...IRIS_EXPORT.features, app_home: { home_tab_enabled: true } },
    });
    expect((opened.features as { app_home: unknown }).app_home).toEqual({
      home_tab_enabled: true,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    });
  });
});

describe('slackRefusalIsDefinite (13-FS second pass)', (): void => {
  it('reads Slack’s own refusal of the call as definite, and a failure it may not repeat as not', (): void => {
    for (const error of [
      'invalid_manifest',
      'not_allowed_token_type',
      'app_not_found',
      'no_permission',
    ]) {
      expect(slackRefusalIsDefinite(error), error).toBe(true);
    }
    for (const error of [
      undefined,
      'ratelimited',
      'internal_error',
      'fatal_error',
      'service_unavailable',
      'request_timeout',
    ]) {
      expect(slackRefusalIsDefinite(error), String(error)).toBe(false);
    }
  });
});
