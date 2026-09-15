import { describe, expect, it } from 'vitest';
import {
  bedEnvValues,
  COPIED_KEYS,
  envRefusal,
  NEVER_COPIED_KEYS,
  parseSecrets,
  secretsRefusal,
} from '../../../scripts/rehearsal/env';

const ports = { backend: 45210, site: 45211, dashboard: 45791, app: 45300 };

describe('the bed environment', (): void => {
  it('writes real mode, the project, the ports and the documentation mount', (): void => {
    const values = bedEnvValues({
      project: 'day0-rehearsal-abc123',
      ports,
      docsHostDir: '/home/op/day0/docs-local',
      source: { OPENAI_API_KEY: 'sk-test', NEXT_PUBLIC_DEMO_BOSS_EMAIL: 'boss@example.com' },
    });
    expect(values).toMatchObject({
      COMPOSE_PROJECT_NAME: 'day0-rehearsal-abc123',
      CONVEX_PORT: '45210',
      CONVEX_SITE_PROXY_PORT: '45211',
      CONVEX_DASHBOARD_PORT: '45791',
      CONVEX_SELF_HOSTED_URL: 'http://127.0.0.1:45210',
      NEXT_PUBLIC_CONVEX_URL: 'http://127.0.0.1:45210',
      NEXT_PUBLIC_CONVEX_SITE_URL: 'http://127.0.0.1:45211',
      CONVEX_DEPLOYMENT: '',
      NEXT_PUBLIC_DEV_NO_AUTH: 'true',
      DAY0_SURFACE_MODE: 'real',
      DAY0_DOCS_HOST_DIR: '/home/op/day0/docs-local',
      DAY0_DOCS_ROOT: '/docs',
      DAY0_BROWSER_MCP_URL: 'http://playwright-mcp:8931/mcp',
      DAY0_REDACTOR_URL: 'http://redactor:8000',
      OPENAI_API_KEY: 'sk-test',
      NEXT_PUBLIC_DEMO_BOSS_EMAIL: 'boss@example.com',
    });
    expect(values.DAY0_TEST_SLACK_API_URL).toBe('');
    expect(values.DAY0_TEST_SLACK_AUTHORIZE_URL).toBe('');
  });

  it('copies only the allowlisted application values from the source file', (): void => {
    const source: Record<string, string> = {
      OPENAI_API_KEY: 'sk-test',
      OPENAI_MODEL: 'gpt-5.6-terra',
      EXA_API_KEY: 'exa',
      DAYTONA_API_KEY: 'dt',
      NEXT_PUBLIC_DEMO_BOSS_EMAIL: 'boss@example.com',
      CONVEX_SELF_HOSTED_ADMIN_KEY: 'convex-self-hosted|old',
      DEV_NO_AUTH_SECRET: 'old-secret',
      DAY0_CREDENTIAL_KEY: 'old-key',
      COMPOSE_PROJECT_NAME: 'day0',
      LINEAR_API_KEY: 'lin_api_x',
      SLACK_BOT_TOKEN: 'xoxb-x',
      CONVEX_DEPLOYMENT: 'dev:something',
      ELEVENLABS_API_KEY: 'el',
    };
    const values = bedEnvValues({ project: 'day0-rehearsal-1', ports, docsHostDir: '/d', source });
    expect(values.OPENAI_MODEL).toBe('gpt-5.6-terra');
    expect(values.EXA_API_KEY).toBe('exa');
    expect(values.DAYTONA_API_KEY).toBe('dt');
    for (const key of NEVER_COPIED_KEYS) expect(values[key] ?? '').toBe('');
    expect(values.COMPOSE_PROJECT_NAME).toBe('day0-rehearsal-1');
    expect(values.ELEVENLABS_API_KEY).toBeUndefined();
    expect(COPIED_KEYS).not.toContain('LINEAR_API_KEY');
    expect(COPIED_KEYS).not.toContain('SLACK_BOT_TOKEN');
  });

  it('refuses a source with no model route or no boss email', (): void => {
    expect(envRefusal({ NEXT_PUBLIC_DEMO_BOSS_EMAIL: 'b@x.com' })).toContain('OPENAI_API_KEY');
    expect(envRefusal({ OPENAI_BASE_URL: 'http://model:11434/v1' })).toContain(
      'NEXT_PUBLIC_DEMO_BOSS_EMAIL',
    );
    expect(
      envRefusal({ OPENAI_API_KEY: 'sk', NEXT_PUBLIC_DEMO_BOSS_EMAIL: 'b@x.com' }),
    ).toBeUndefined();
  });
});

describe('the rehearsal secrets file', (): void => {
  it('reads the two provider tokens and ignores everything else', (): void => {
    const secrets = parseSecrets('LINEAR_API_KEY=lin_api_abc\nSLACK_BOT_TOKEN="xoxb-1-2"\nOTHER=x\n');
    expect(secrets).toEqual({ linearApiKey: 'lin_api_abc', slackBotToken: 'xoxb-1-2' });
    expect(parseSecrets('# nothing\n')).toEqual({});
  });

  it('refuses without the Linear key and tolerates a missing Slack token', (): void => {
    expect(secretsRefusal({})).toContain('LINEAR_API_KEY');
    expect(secretsRefusal({ linearApiKey: 'lin_api_abc' })).toBeUndefined();
  });
});
