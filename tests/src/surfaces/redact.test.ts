import { describe, expect, it } from 'vitest';
import {
  containsTokenShape,
  redactSecret,
  redactTokenShapes,
  safeFailureMessage,
} from '../../../src/surfaces/redact';

const LINEAR = ['lin', 'api', 'ReviewValue0123456789'].join('_');
const SLACK = ['xoxb', '1234567890', 'ReviewValue'].join('-');

describe('surface credential redaction', (): void => {
  it('replaces provider-prefixed values wherever they occur', (): void => {
    expect(redactTokenShapes(`key ${LINEAR} and token ${SLACK}.`)).toBe(
      'key <redacted> and token <redacted>.',
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
      'Password: <redacted>\nNext line',
    );
    const prose = 'using a bot token Bearer header. It names the usable methods.';
    expect(redactTokenShapes(prose)).toBe(prose);
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
