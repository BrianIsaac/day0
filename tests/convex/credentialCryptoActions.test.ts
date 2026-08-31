/** @vitest-environment node */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireCredentialKey } from '../../convex/credentialCryptoActions';

afterEach((): void => {
  vi.unstubAllEnvs();
});

describe('credential crypto actions', (): void => {
  it('requires the deployment key before a Node action can handle plaintext', (): void => {
    vi.stubEnv('DAY0_CREDENTIAL_KEY', '');
    expect(() => requireCredentialKey()).toThrow('not configured');
    vi.stubEnv('DAY0_CREDENTIAL_KEY', Buffer.alloc(32, 7).toString('base64'));
    expect(requireCredentialKey()).toBe(Buffer.alloc(32, 7).toString('base64'));
  });
});
