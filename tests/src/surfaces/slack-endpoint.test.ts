import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  slackApiUrl,
  slackAuthorizeUrl,
} from '../../../src/surfaces/slack-endpoint';

afterEach((): void => {
  vi.unstubAllEnvs();
});

describe('the local Slack proof endpoint', (): void => {
  it('uses Slack unless the explicit local test seam is configured', (): void => {
    expect(slackApiUrl('auth.test').href).toBe('https://slack.com/api/auth.test');
    expect(slackAuthorizeUrl().href).toBe('https://slack.com/oauth/v2/authorize');
  });

  it('admits only the fake service in local no-auth real mode', (): void => {
    vi.stubEnv('DAY0_SURFACE_MODE', 'real');
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('DAY0_TEST_SLACK_API_URL', 'http://fake-slack:8090/api/');
    vi.stubEnv(
      'DAY0_TEST_SLACK_AUTHORIZE_URL',
      'http://127.0.0.1:10092/oauth/v2/authorize',
    );
    expect(slackApiUrl('apps.manifest.create').href).toBe(
      'http://fake-slack:8090/api/apps.manifest.create',
    );
    expect(slackAuthorizeUrl().href).toBe(
      'http://127.0.0.1:10092/oauth/v2/authorize',
    );
  });

  it('refuses the override outside the isolated local proof', (): void => {
    vi.stubEnv('DAY0_TEST_SLACK_API_URL', 'https://evil.example/api/');
    expect(() => slackApiUrl('auth.test')).toThrow('local no-auth real mode');
  });
});
