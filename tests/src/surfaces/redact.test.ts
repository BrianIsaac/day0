import { describe, expect, it } from 'vitest';
import {
  containsTokenShape,
  redactOutcome,
  redactSecret,
  redactTokenShapes,
  safeFailureMessage,
} from '../../../src/surfaces/redact';
import { CORPUS_SLOTS } from '../../fixtures/redaction-corpus';
import { RecordedSpanModel, UnreachableSpanModel } from '../../fixtures/redaction-double';

const LINEAR = CORPUS_SLOTS.linear_token;
const SLACK = CORPUS_SLOTS.slack_bot_token;
const OPENAI = CORPUS_SLOTS.openai_key;

describe('the synchronous surface floor', (): void => {
  it('preserves ordinary labelled ticket values and prose', (): void => {
    for (const text of [
      'Ticket key: REVOPS-7\nStatus: Backlog',
      'Token budget: none',
      'Key contacts: Alice',
      'using a bot token Bearer header. It names the usable methods.',
      '- Integration: Slack Web API over HTTPS at `https://slack.com/api/`, bot token in the `Authorization: Bearer` header.',
      '- Service token: <credential: linear service token, stored>',
    ]) {
      expect(redactTokenShapes(text)).toBe(text);
      expect(containsTokenShape(text)).toBe(false);
    }
  });

  it('replaces provider-prefixed values wherever they occur', (): void => {
    expect(redactTokenShapes(`key ${LINEAR}, token ${SLACK}, provider ${OPENAI}.`)).toBe(
      'key <redacted>, token <redacted>, provider <redacted>.',
    );
    expect(redactTokenShapes(`(${LINEAR})`)).toBe('(<redacted>)');
  });

  it('replaces the value after Bearer and a connection-string password', (): void => {
    expect(redactTokenShapes('Authorization: Bearer opaque-value-here; retry')).toBe(
      'Authorization: Bearer <redacted>; retry',
    );
    expect(redactTokenShapes('could not reach postgres://app:hunter2@db/app: timeout')).toBe(
      'could not reach postgres://app:<redacted>@db/app: timeout',
    );
    expect(redactTokenShapes('Database: postgres://app:${DB_PASSWORD}@db/app')).toBe(
      'Database: postgres://app:${DB_PASSWORD}@db/app',
    );
  });

  it('removes an exact value of any length and bounds a failure message', (): void => {
    for (const secret of ['x', 'hunter2', 'q7Mz2Kv9Tx4Wp6Rn8Js3']) {
      expect(redactSecret(`Password: ${secret}`, secret)).toBe('Password: <redacted>');
    }
    expect(redactSecret('401 for local-value-only', 'local-value-only')).toBe('401 for <redacted>');
    const message = safeFailureMessage(
      new Error(`local-value Bearer ${SLACK} ${'x'.repeat(400)}\n    at Transport._send (/srv/app/index.mjs:1:1)`),
      'local-value',
      'Provider failed.',
    );
    expect(message.startsWith('<redacted> Bearer <redacted> ')).toBe(true);
    expect(message).toHaveLength(300);
    expect(message).not.toContain('/srv/app');
    expect(safeFailureMessage(new Error('\n\nFailed to connect: 401 Unauthorized\n    at x'), '', 'f')).toBe(
      'Failed to connect: 401 Unauthorized',
    );
    expect(safeFailureMessage(new Error('   '), '', 'Provider failed.')).toBe('Provider failed.');
    expect(safeFailureMessage('plain string', '', 'Provider failed.')).toBe('plain string');
  });
});

describe('redactOutcome', (): void => {
  it('redacts a labelled password and an echoed email with the model and keeps the ids', async (): Promise<void> => {
    const text = `{"ok":true,"channel":"D0123456789","user":{"real_name":"Priya Nair","email":"priya.nair@acme.example"},"note":"password: hunter2"}`;
    const result = await redactOutcome(text, 'plain-cred-slack', new RecordedSpanModel());
    expect(result.redaction).toBeUndefined();
    expect(result.text).not.toContain('hunter2');
    expect(result.text).not.toContain('priya.nair@acme.example');
    expect(result.text).toContain('D0123456789');
    expect(result.text).toContain('Priya Nair');
  });

  it('keeps the exact value and the grammar when the model is unreachable, and says so', async (): Promise<void> => {
    const result = await redactOutcome(`HTTP 401 · Bearer plain-cred-slack · ${LINEAR}`, 'plain-cred-slack', new UnreachableSpanModel());
    expect(result).toEqual({ text: 'HTTP 401 · Bearer <redacted> · <redacted>', redaction: 'structural-only' });
    const none = await redactOutcome('HTTP 200 · ok', '', undefined);
    expect(none).toEqual({ text: 'HTTP 200 · ok', redaction: 'structural-only' });
  });
});
