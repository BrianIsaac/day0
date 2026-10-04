import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_VALUE_REDACTION,
  isCredentialKey,
  withCredentialValuesBlanked,
} from '../../../src/lib/credential-keys';

describe('credential-class key names', () => {
  it('names a key by its words, whatever its case or separator', () => {
    for (const key of [
      'apiKey',
      'api_key',
      'API-KEY',
      'token',
      'accessToken',
      'refresh_token',
      'clientSecret',
      'password',
      'Authorization',
      'botToken',
      'appLevelToken',
      'privateKey',
      'cookie',
      'webhookToken',
      'signingSecret',
    ]) {
      expect(isCredentialKey(key), key).toBe(true);
    }
    for (const key of ['tokenCount', 'credentialId', 'secretName', 'surfaceId', 'keys', 'author']) {
      expect(isCredentialKey(key), key).toBe(false);
    }
  });

  it('blanks the value under such a key at any depth and keeps every other value as it is', () => {
    expect(
      withCredentialValuesBlanked({
        a: { password: { nested: 'x' } },
        list: [{ token: 'abc' }, 'plain'],
        tokenCount: 2,
      }),
    ).toEqual({
      a: { password: CREDENTIAL_VALUE_REDACTION },
      list: [{ token: CREDENTIAL_VALUE_REDACTION }, 'plain'],
      tokenCount: 2,
    });
    expect(withCredentialValuesBlanked('text')).toBe('text');
  });
});
