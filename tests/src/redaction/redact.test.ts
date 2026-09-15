import { describe, expect, it } from 'vitest';
import { RedactorUnavailableError, type ModelSpan } from '../../../src/redaction/client';
import { personalDataMarker, redactStructural, redactText } from '../../../src/redaction/redact';
import { CORPUS_SLOTS } from '../../fixtures/redaction-corpus';
import { RecordedSpanModel, ScriptedSpanModel, UnreachableSpanModel } from '../../fixtures/redaction-double';

const recorded = new RecordedSpanModel();

describe('redactText', (): void => {
  it('removes a known value literally, JSON-escaped and URL-encoded before anything else', async (): Promise<void> => {
    const value = 'opaque+value/with=chars';
    const text = `raw ${value} · json ${JSON.stringify(value).slice(1, -1)} · url ${encodeURIComponent(value)}`;
    const result = await redactText(text, 'outcome', { known: [value], onUnavailable: 'structural' });
    expect(result.text).toBe('raw <redacted> · json <redacted> · url <redacted>');
    expect(result.degraded).toBe('structural-only');
  });

  it('fails closed when asked to and no model is configured or reachable', async (): Promise<void> => {
    await expect(redactText('x', 'documentation', { onUnavailable: 'throw' })).rejects.toBeInstanceOf(
      RedactorUnavailableError,
    );
    await expect(
      redactText('x', 'documentation', { model: new UnreachableSpanModel(), onUnavailable: 'throw' }),
    ).rejects.toBeInstanceOf(RedactorUnavailableError);
  });

  it('degrades to the structural floor and says so when the model cannot be reached', async (): Promise<void> => {
    const text = `password: hunter2 and DSN postgres://app:${CORPUS_SLOTS.db_password}@db/x`;
    const result = await redactText(text, 'outcome', { model: new UnreachableSpanModel(), onUnavailable: 'structural' });
    expect(result.degraded).toBe('structural-only');
    expect(result.text).toBe('password: hunter2 and DSN postgres://app:<redacted>@db/x');
    expect(result.findings.map((finding) => finding.label)).toEqual(['connection password']);
  });

  it('lets a model error that is not unavailability through', async (): Promise<void> => {
    const broken = new ScriptedSpanModel((): ModelSpan[] => {
      throw new TypeError('bad');
    });
    await expect(redactText('x', 'outcome', { model: broken, onUnavailable: 'structural' })).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it('applies the guard to a secret span and the policy to a personal-data span', async (): Promise<void> => {
    const text = 'Ticket REVOPS-7: password: hunter2; call Priya on +65 9123 4567 or priya@acme.example';
    const at = (value: string, label: string): ModelSpan => ({
      start: text.indexOf(value),
      end: text.indexOf(value) + value.length,
      label,
      score: 0.9,
    });
    const model = new ScriptedSpanModel((): ModelSpan[] => [
      at('REVOPS-7', 'access token'),
      at('password: hunter2', 'password'),
      at('Priya', 'person'),
      at('+65 9123 4567', 'phone number'),
      at('priya@acme.example', 'email'),
    ]);
    const documentation = await redactText(text, 'documentation', { model, onUnavailable: 'throw' });
    expect(documentation.text).toBe(
      `Ticket REVOPS-7: password: <redacted>; call Priya on ${personalDataMarker('phone')} or priya@acme.example`,
    );
    expect(documentation.findings.map((finding) => [finding.kind, finding.value, finding.redacted])).toEqual([
      ['secret', 'hunter2', true],
      ['person', 'Priya', false],
      ['phone', '+65 9123 4567', true],
      ['email', 'priya@acme.example', false],
    ]);
    const outcome = await redactText(text, 'outcome', { model, onUnavailable: 'throw' });
    expect(outcome.text).toContain(personalDataMarker('email'));
    expect(outcome.text).toContain('Priya');
    expect(model.calls[0]?.labels).toContain('password');
  });

  it('drops a span below its kind threshold and one whose label the policy does not know', async (): Promise<void> => {
    const text = 'password: hunter2 for Priya';
    const model = new ScriptedSpanModel((): ModelSpan[] => [
      { start: 10, end: 17, label: 'password', score: 0.35 },
      { start: 22, end: 27, label: 'organisation', score: 0.9 },
    ]);
    const result = await redactText(text, 'outcome', { model, onUnavailable: 'throw' });
    expect(result.text).toBe(text);
    expect(result.findings).toEqual([]);
  });

  it('lets a structural span win over a model span on the same text and uses the caller marker', async (): Promise<void> => {
    const text = `Bearer ${CORPUS_SLOTS.bearer_value} sent`;
    const model = new ScriptedSpanModel((): ModelSpan[] => [{ start: 0, end: text.length, label: 'credential', score: 0.9 }]);
    const result = await redactText(text, 'documentation', {
      model,
      onUnavailable: 'throw',
      secretMarker: (finding): string => `<${finding.label}>`,
    });
    expect(result.text).toBe('Bearer <header value> sent');
  });

  it('handles the review misses through the recorded model', async (): Promise<void> => {
    for (const [text, expected] of [
      ['Sign in with the shared account (user revops, password: hunter2) and press Save.', 'password: <redacted>)'],
      ['Password: hunter2\nNext line', 'Password: <redacted>\nNext line'],
      ['Client secret: abc123', 'Client secret: <redacted>'],
      ['共享账号的用户名是 revops，密码是 hunter2，请勿写入工单。', '密码是 <redacted>'],
    ]) {
      const result = await redactText(text, 'documentation', { model: recorded, onUnavailable: 'throw' });
      expect(result.text, text).toContain(expected);
      expect(result.text).not.toContain('hunter2');
      expect(result.text).not.toContain('abc123');
    }
  });
});

describe('redactStructural', (): void => {
  it('is the synchronous floor: exact values and the grammar, nothing else', (): void => {
    expect(redactStructural(`x ${CORPUS_SLOTS.slack_bot_token} y`, [])).toBe('x <redacted> y');
    expect(redactStructural('Password: hunter2', ['hunter2'])).toBe('Password: <redacted>');
    expect(redactStructural('Password: hunter2')).toBe('Password: hunter2');
    expect(redactStructural('Ticket key: REVOPS-7\nToken budget: none')).toBe('Ticket key: REVOPS-7\nToken budget: none');
  });
});
