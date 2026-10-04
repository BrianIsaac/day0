import { describe, expect, it } from 'vitest';
import {
  manifestTakesMessages,
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
  const app = { appName: 'Iris (Day0)', organisationConnectionId: 'conn' };

  it('reaches an app the record says takes messages', (): void => {
    const reach = typedCodeReachFor({ provisioning: app }, { opened: true, creatorActive: true });
    expect(reach).toEqual({ state: 'open' });
    expect(typedCodeReaches(reach)).toBe(true);
  });

  it('is Day0’s to open for an app its active configuration connection created', (): void => {
    const reach = typedCodeReachFor({ provisioning: app }, { opened: false, creatorActive: true });
    expect(reach).toEqual({ state: 'day0-opens', appName: 'Iris (Day0)' });
    expect(typedCodeReaches(reach)).toBe(false);
  });

  it('needs a person’s toggle for an app Day0 cannot update', (): void => {
    const reach = typedCodeReachFor(
      { provisioning: { appName: 'Otto (Day0)' } },
      { opened: false, creatorActive: false },
    );
    expect(reach).toEqual({ state: 'needs-toggle', appName: 'Otto (Day0)' });
    expect(typedCodeReaches(reach)).toBe(false);
  });

  it('is unchanged for a card whose app Day0 did not create, which Day0 cannot read', (): void => {
    expect(typedCodeReachFor({}, { opened: false, creatorActive: false })).toEqual({
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
