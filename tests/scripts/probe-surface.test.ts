import { afterEach, describe, expect, it, vi } from 'vitest';
import { redactProbeOutput } from '../../scripts/probe-surface';

afterEach((): void => {
  vi.unstubAllEnvs();
});

describe('surface probe shell output', (): void => {
  it('redacts administrator keys and provider token shapes', (): void => {
    vi.stubEnv('CONVEX_SELF_HOSTED_ADMIN_KEY', 'convex-self-hosted|local-admin-value');
    const output = redactProbeOutput(
      'convex-self-hosted|local-admin-value Bearer xoxb-123-secret lin_api_456-value',
    );
    expect(output).not.toContain('local-admin-value');
    expect(output).not.toContain('xoxb-123-secret');
    expect(output).not.toContain('lin_api_456-value');
    expect(output.match(/<redacted>/g)).toHaveLength(3);
  });
});
