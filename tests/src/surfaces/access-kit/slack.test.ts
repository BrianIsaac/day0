import { describe, expect, it } from 'vitest';
import {
  SLACK_KIT_BOT_SCOPES,
  SLACK_RECIPE,
  slackKitManifest,
  slackKitManifestTemplate,
} from '../../../../src/surfaces/access-kit/slack';
import {
  ManifestTemplateError,
  SLACK_REDIRECT_PATH,
  buildSlackManifest,
  extractManifestTemplate,
} from '../../../../src/surfaces/slack-manifest';

const PUBLIC_URL = 'https://day0.acme.test';

describe('the Slack recipe', (): void => {
  it('prints the same manifest the issuer builds from the kit’s template', (): void => {
    const kit = slackKitManifest({ employeeName: 'Maya', publicUrl: PUBLIC_URL });
    const issuer = buildSlackManifest({
      agentName: 'Maya',
      publicUrl: PUBLIC_URL,
      template: slackKitManifestTemplate(),
    });
    expect(kit).toEqual(issuer);
  });

  it('names the employee’s own app, returns to Day0’s Slack redirect and asks for the kit’s scopes only', (): void => {
    const { appName, manifest, redirectUrl, scopes } = slackKitManifest({
      employeeName: 'Maya',
      publicUrl: `${PUBLIC_URL}/`,
    });
    expect(appName).toBe('Maya (Day0)');
    expect(redirectUrl).toBe(`${PUBLIC_URL}${SLACK_REDIRECT_PATH}`);
    expect(manifest.oauth_config).toEqual({
      redirect_urls: [`${PUBLIC_URL}/api/oauth/slack`],
      scopes: { bot: [...SLACK_KIT_BOT_SCOPES] },
    });
    expect(scopes).toEqual([...SLACK_KIT_BOT_SCOPES]);
    // Re-pinned for 12-M: the kit's apps turn on Socket Mode and interactivity with no request URL,
    // so Approve and Reject presses reach Day0 over the bridge's outbound socket (RM7, Q13).
    expect(manifest.settings).toEqual({
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
      interactivity: { is_enabled: true },
    });
  });

  it('lets a manager send the app a message, so the typed code can be replied in its DM (W12V-7)', (): void => {
    // The walk on real Slack (5 October): without the App Home messages tab Slack answers the DM
    // with "Sending messages to this app has been turned off." and offers no composer; the kit's
    // manifest with exactly this `app_home` was accepted by `apps.manifest.validate`
    // (`HTTP 200 {"ok":true,"errors":[]}`) and the typed code then decided in 56 s.
    const { manifest } = slackKitManifest({ employeeName: 'Maya', publicUrl: PUBLIC_URL });
    expect(manifest.features).toEqual({
      bot_user: { display_name: 'Maya (Day0)', always_online: false },
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
    });
    expect(JSON.parse(slackKitManifestTemplate()).features.app_home).toEqual({
      home_tab_enabled: false,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    });
  });

  it('asks for users:read beside users:read.email, as Slack requires the pair', (): void => {
    expect(SLACK_KIT_BOT_SCOPES).toContain('users:read.email');
    expect(SLACK_KIT_BOT_SCOPES).toContain('users:read');
    expect(new Set(SLACK_KIT_BOT_SCOPES).size).toBe(SLACK_KIT_BOT_SCOPES.length);
  });

  it('asks for channels:join, so a renewed employee re-joins its public channels itself, and for no private channel (RM4)', (): void => {
    expect(SLACK_KIT_BOT_SCOPES).toContain('channels:join');
    expect(SLACK_KIT_BOT_SCOPES.filter((scope) => scope.startsWith('groups:'))).toEqual([]);
  });

  it('refuses a public origin Slack would refuse, as the issuer does', (): void => {
    expect(() =>
      slackKitManifest({ employeeName: 'Maya', publicUrl: 'http://day0.acme.test' }),
    ).toThrow(ManifestTemplateError);
  });

  it('writes a template the documentation reader finds, so a page that carries it provisions the same app', (): void => {
    const page = `# Slack\n\n\`\`\`json\n${slackKitManifestTemplate()}\n\`\`\`\n`;
    expect(extractManifestTemplate(page)).toBe(slackKitManifestTemplate());
  });

  it('connects per employee only, from the configuration token and its refresh token, both secrets', (): void => {
    expect(SLACK_RECIPE.modes.map((mode) => mode.mode)).toEqual(['per-employee']);
    const [perEmployee] = SLACK_RECIPE.modes;
    expect(perEmployee.kind).toBe('slack-configuration');
    expect(perEmployee.scopes).toEqual(SLACK_KIT_BOT_SCOPES);
    expect(perEmployee.asks.map((ask) => [ask.field, ask.secret, ask.optional])).toEqual([
      ['secret', true, false],
      ['refreshToken', true, false],
    ]);
    expect(perEmployee.secretLifetime.words).toContain('12 hours');
    // The renewal as the code makes it (the wave 11 review's M12 d): an hour before the token
    // lapses, before any use in its last half hour, and after a lapse through the refresh token.
    // Re-pinned for the re-walk on real Slack: a pair IT lands is of unknown age to Day0, so its
    // first use renews it whatever its age (`configurationRenewal`), and the landing queues a
    // renewal a quarter of an hour on (`keepConfigurationCurrentFrom`), deferred while the jobs
    // are paused; the words said neither.
    expect(perEmployee.secretLifetime.words).toBe(
      "The configuration token expires 12 hours after it is generated. Day0 cannot tell how old a pair you hand it is, so it renews the pair with its refresh token at its first use or a quarter of an hour after it lands, whichever comes first (later while the deployment's scheduled jobs are paused); from then on it renews it before any use in its last half hour and an hour before it lapses, and the refresh token also renews a token that has lapsed. Each renewal returns a new pair. A revoke, or the row's Delete on api.slack.com, ends the access token only. Nothing ends a refresh token but its lapse, so keep the service account's sign-in closed: whoever copies a refresh token while its row is listed can mint a token with it until then.",
    );
    expect(perEmployee.secretLifetime.words).not.toContain('each time it creates an app');
    expect(perEmployee.landsAtInstall).toBe(true);
    expect(SLACK_RECIPE.redirectPath).toBe(SLACK_REDIRECT_PATH);
    expect(SLACK_RECIPE.guide).toBe('docs/running/access-slack.md');
  });

  it('says nothing IT can click ends a configuration refresh token, which ends only by lapsing (R41X-8)', (): void => {
    const [perEmployee] = SLACK_RECIPE.modes;
    expect(perEmployee.secretLifetime.words).toContain(
      'Nothing ends a refresh token but its lapse',
    );
    expect(perEmployee.secretLifetime.words).not.toMatch(/ends the pair/);
  });
});
