import { describe, expect, it } from 'vitest';
import { redactCredentials } from '../../../src/docs/redaction';
import {
  containsTokenShape,
  redactSecret,
  redactTokenShapes,
  safeFailureMessage,
} from '../../../src/surfaces/redact';

const LINEAR = ['lin', 'api', 'ReviewValue0123456789'].join('_');
const SLACK = ['xoxb', '1234567890', 'ReviewValue'].join('-');
const OPENAI = ['sk', 'proj', 'ReviewValue0123456789'].join('-');

describe('surface credential redaction', (): void => {
  it('preserves ordinary labelled ticket values', (): void => {
    const text = 'Ticket key: REVOPS-7\nStatus: Backlog';
    expect(redactTokenShapes(text)).toBe(text);
  });

  it('replaces provider-prefixed values wherever they occur', (): void => {
    expect(redactTokenShapes(`key ${LINEAR}, token ${SLACK}, provider ${OPENAI}.`)).toBe(
      'key <redacted>, token <redacted>, provider <redacted>.',
    );
    expect(redactTokenShapes(`(${LINEAR})`)).toBe('(<redacted>)');
    expect(containsTokenShape('nothing to see')).toBe(false);
  });

  it('replaces the value after Bearer and on a labelled line', (): void => {
    expect(redactTokenShapes('Authorization: Bearer opaque-value-here; retry')).toBe(
      'Authorization: Bearer <redacted>; retry',
    );
    expect(redactTokenShapes('- Service token (RevOps automation): `PASTE_VALUE_HERE`')).toBe(
      '- Service token (RevOps automation): <redacted>',
    );
    expect(redactTokenShapes('Password: hunter2\nNext line')).toBe(
      'Password: hunter2\nNext line',
    );
    const prose = 'using a bot token Bearer header. It names the usable methods.';
    expect(redactTokenShapes(prose)).toBe(prose);
  });

  it('redacts high-entropy labelled values and exact credentials of any length', (): void => {
    expect(redactTokenShapes('API key: q7Mz2Kv9Tx4Wp6Rn8Js3')).toBe('API key: <redacted>');
    expect(redactTokenShapes('API key: aaaaaaaaaaaaaaaaaaaa')).toBe('API key: aaaaaaaaaaaaaaaaaaaa');
    for (const secret of ['x', 'hunter2', 'q7Mz2Kv9Tx4Wp6Rn8Js3']) {
      expect(redactSecret(`Password: ${secret}`, secret)).toBe('Password: <redacted>');
    }
  });

  it('keeps explicit credential rules independent of labelled entropy', (): void => {
    const connection = redactCredentials('Password: postgres://app:hunter2@db/app', 'Database');
    expect(connection.credentials).toEqual([{ label: 'postgres connection secret', plaintext: 'hunter2' }]);
    expect(redactTokenShapes(connection.markdown)).toContain('postgres://app:<credential: postgres connection secret, stored>@db/app');
    for (const value of ['x', 'hunter2']) {
      const declared = redactCredentials(`Password: \`${value}\``, 'Dashboard');
      expect(declared.credentials).toMatchObject([{ plaintext: value }]);
      expect(redactTokenShapes(declared.markdown)).toContain('<credential:');
    }
    expect(redactTokenShapes('Bearer aaaaaaaaaaaa')).toBe('Bearer <redacted>');
    expect(redactTokenShapes(['lin', 'api', 'aaaaaa'].join('_'))).toBe('<redacted>');
  });

  it('leaves a stored marker and ordinary prose alone', (): void => {
    const marker = '- Service token: <credential: linear service token, stored>';
    expect(redactTokenShapes(marker)).toBe(marker);
    const prose =
      '- Integration: Slack Web API over HTTPS at `https://slack.com/api/`, bot token in the `Authorization: Bearer` header.';
    expect(redactTokenShapes(prose)).toBe(prose);
    const rotation =
      '- Rotation: create a new key in Linear (Settings -> Security & access -> Personal API keys), replace the line above, revoke the old key.';
    expect(redactTokenShapes(rotation)).toBe(rotation);
  });

  it('removes an exact value and bounds a failure message', (): void => {
    expect(redactSecret('401 for local-value-only', 'local-value-only')).toBe('401 for <redacted>');
    const message = safeFailureMessage(
      new Error(
        `local-value Bearer ${SLACK} ${'x'.repeat(400)}\n    at Transport._send (/srv/app/index.mjs:1:1)`,
      ),
      'local-value',
      'Provider failed.',
    );
    expect(message.startsWith('<redacted> Bearer <redacted> ')).toBe(true);
    expect(message).toHaveLength(300);
    expect(message).not.toContain('/srv/app');
    expect(
      safeFailureMessage(new Error('\n\nFailed to connect: 401 Unauthorized\n    at x'), '', 'f'),
    ).toBe('Failed to connect: 401 Unauthorized');
    expect(safeFailureMessage(new Error('   '), '', 'Provider failed.')).toBe('Provider failed.');
    expect(safeFailureMessage('plain string', '', 'Provider failed.')).toBe('plain string');
  });
});
