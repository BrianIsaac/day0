import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSlackManifest,
  dedicatedAppName,
  extractManifestTemplate,
  ManifestTemplateError,
  publicOrigin,
  slackInstallUrl,
  type SlackManifest,
} from '../../../src/surfaces/slack-manifest';

const POLICY = readFileSync(
  resolve(__dirname, '../../fixtures/notion-pages/slack-day0-app.md'),
  'utf8',
);

const PUBLIC_URL = 'https://day0.example.com';

function template(): string {
  const found = extractManifestTemplate(POLICY);
  if (!found) throw new Error('the fixture policy page carries no manifest template');
  return found;
}

describe('the manifest template on the policy page', (): void => {
  it('is found in the page the operator publishes', (): void => {
    const parsed = JSON.parse(template()) as SlackManifest;
    expect(parsed.display_information.name).toBe('<employee name> (Day0)');
    expect(parsed.oauth_config.redirect_urls).toEqual(['<Day0 public URL>/api/oauth/slack']);
    expect(parsed.oauth_config.scopes.bot).toEqual([
      'chat:write',
      'channels:read',
      'channels:history',
      'im:read',
      'im:write',
      'im:history',
      'users:read',
      'users:read.email',
    ]);
  });

  it('ignores a fenced block that is not a manifest', (): void => {
    const page = ['```json', '{ "tool": "http.request" }', '```'].join('\n');
    expect(extractManifestTemplate(page)).toBeUndefined();
  });

  it('ignores a fenced block that is not JSON at all', (): void => {
    expect(extractManifestTemplate('```\nnot json\n```')).toBeUndefined();
  });

  it('is absent from a page that documents no procedure', (): void => {
    expect(extractManifestTemplate('# Linear automation\n\nEndpoint: https://mcp.linear.app/mcp')).toBeUndefined();
  });
});

describe('building one employee\'s manifest', (): void => {
  it('takes the name from the agent and the redirect from the public URL', (): void => {
    const built = buildSlackManifest({
      agentName: 'ops worker',
      publicUrl: PUBLIC_URL,
      template: template(),
    });
    expect(built.appName).toBe('ops worker (Day0)');
    expect(built.manifest.display_information.name).toBe('ops worker (Day0)');
    expect(built.manifest.features?.bot_user?.display_name).toBe('ops worker (Day0)');
    expect(built.redirectUrl).toBe('https://day0.example.com/api/oauth/slack');
    expect(built.manifest.oauth_config.redirect_urls).toEqual([
      'https://day0.example.com/api/oauth/slack',
    ]);
    expect(built.scopes).toHaveLength(8);
  });

  it('keeps the description the team wrote rather than one of its own', (): void => {
    const built = buildSlackManifest({
      agentName: 'Priya',
      publicUrl: PUBLIC_URL,
      template: template(),
    });
    expect(built.manifest.display_information.description).toBe(
      'RevOps digital employee. Drafts first, sends to the manager, holds public posts.',
    );
    expect(built.manifest.settings).toEqual({
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    });
  });

  it('drops a trailing slash so the declared redirect matches the route', (): void => {
    const built = buildSlackManifest({
      agentName: 'Priya',
      publicUrl: 'https://day0.example.com/',
      template: template(),
    });
    expect(built.redirectUrl).toBe('https://day0.example.com/api/oauth/slack');
  });

  it('cannot be broken out of by a name carrying a quote', (): void => {
    const built = buildSlackManifest({
      agentName: 'a" , "x": "y',
      publicUrl: PUBLIC_URL,
      template: template(),
    });
    expect(built.manifest.display_information.name).toBe('a" , "x": "y (Day0)');
    expect(Object.keys(built.manifest)).toEqual([
      'display_information',
      'features',
      'oauth_config',
      'settings',
    ]);
  });

  it('clips a name Slack would refuse for length', (): void => {
    const built = buildSlackManifest({
      agentName: 'an employee with a really quite long name',
      publicUrl: PUBLIC_URL,
      template: template(),
    });
    expect(built.appName.length).toBeLessThanOrEqual(35);
    expect(built.appName).toBe('an employee with a really quite lon');
  });

  it('refuses a template whose redirect is not this deployment', (): void => {
    const other = template().replace('<Day0 public URL>', 'https://elsewhere.example');
    expect(() =>
      buildSlackManifest({ agentName: 'Priya', publicUrl: PUBLIC_URL, template: other }),
    ).toThrow(ManifestTemplateError);
  });

  it('refuses a template with no bot scopes', (): void => {
    const stripped = JSON.parse(template()) as SlackManifest;
    stripped.oauth_config.scopes.bot = [];
    expect(() =>
      buildSlackManifest({
        agentName: 'Priya',
        publicUrl: PUBLIC_URL,
        template: JSON.stringify(stripped),
      }),
    ).toThrow('requests no bot scopes');
  });

  it('refuses an employee with no name', (): void => {
    expect(() =>
      buildSlackManifest({ agentName: '  ', publicUrl: PUBLIC_URL, template: template() }),
    ).toThrow('no name');
  });

  it('refuses a template that is not valid JSON', (): void => {
    expect(() =>
      buildSlackManifest({ agentName: 'Priya', publicUrl: PUBLIC_URL, template: '{' }),
    ).toThrow('not valid JSON');
  });
});

describe('the public origin', (): void => {
  it('refuses plain http, which Slack will not redirect to', (): void => {
    expect(() => publicOrigin('http://localhost:3000')).toThrow('must be https');
  });

  it('refuses a value that is not a URL', (): void => {
    expect(() => publicOrigin('day0.example.com')).toThrow('is not a URL');
  });
});

describe('the install link', (): void => {
  it('carries the client id, the scopes, the redirect and the state', (): void => {
    const url = new URL(
      slackInstallUrl({
        clientId: '123.456',
        redirectUrl: 'https://day0.example.com/api/oauth/slack',
        scopes: ['chat:write', 'users:read'],
        state: 'v1.surface.nonce.1.sig',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(url.searchParams.get('client_id')).toBe('123.456');
    expect(url.searchParams.get('scope')).toBe('chat:write,users:read');
    expect(url.searchParams.get('redirect_uri')).toBe('https://day0.example.com/api/oauth/slack');
    expect(url.searchParams.get('state')).toBe('v1.surface.nonce.1.sig');
  });
});

describe('the name placeholder', (): void => {
  it('substitutes wherever the template puts it', (): void => {
    expect(dedicatedAppName('Priya', '<employee name> (Day0)')).toBe('Priya (Day0)');
    expect(dedicatedAppName('Priya', 'Day0 for <employee name>')).toBe('Day0 for Priya');
  });
});
