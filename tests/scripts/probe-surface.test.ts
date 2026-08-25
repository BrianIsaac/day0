import { afterEach, describe, expect, it, vi } from 'vitest';
import { redactProbeOutput } from '../../scripts/probe-surface';

afterEach((): void => {
  vi.unstubAllEnvs();
});

describe('surface probe shell output', (): void => {
  it('redacts administrator keys and provider token shapes', (): void => {
    const slackToken = ['xoxb', '123-secret'].join('-');
    const linearToken = ['lin', 'api', '456-value'].join('_');
    vi.stubEnv('CONVEX_SELF_HOSTED_ADMIN_KEY', 'convex-self-hosted|local-admin-value');
    const output = redactProbeOutput(
      `convex-self-hosted|local-admin-value Bearer ${slackToken} ${linearToken}`,
    );
    expect(output).not.toContain('local-admin-value');
    expect(output).not.toContain(slackToken);
    expect(output).not.toContain(linearToken);
    expect(output.match(/<redacted>/g)).toHaveLength(3);
  });
});
