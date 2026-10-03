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
    expect(manifest.settings).toEqual({
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
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
    expect(perEmployee.secretLifetime.words).toBe(
      "The configuration token expires 12 hours after it is generated. Day0 renews it with its refresh token before any use in its last half hour and, once it has used it, an hour before it lapses; the refresh token also renews a token that has lapsed. Each renewal returns a new pair. A revoke, or the row's Delete on api.slack.com, ends the access token only. Nothing ends a refresh token but its lapse, so keep the service account's sign-in closed: whoever copies a refresh token while its row is listed can mint a token with it until then.",
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
