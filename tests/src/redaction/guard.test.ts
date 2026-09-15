import { describe, expect, it } from 'vitest';
import { guardReason, guardSecretSpan } from '../../../src/redaction/guard';

function spanOf(text: string, value: string): { start: number; end: number } {
  const start = text.indexOf(value);
  if (start === -1) throw new Error(`${value} not in ${text}`);
  return { start, end: start + value.length };
}

describe('the guard between a model span and the stored text', (): void => {
  it.each([
    ['REVOPS-7', 'issue key'],
    ['{{secret}}', 'reference'],
    ['${LOOKER_PASSWORD}', 'reference'],
    ['<password>', 'reference'],
    ['<credential: linear service token, stored>', 'reference'],
    ['PASTE_LINEAR_API_KEY_HERE', 'upper-case name'],
    ['OPENAI_API_KEY', 'upper-case name'],
    ['YOUR_TOKEN', 'upper-case name'],
    ['https://slack.com/api/', 'url'],
    ['xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'masked'],
    ['password', 'label word'],
    ['C0123456789', 'slack id'],
    ['0f8fad5b-d9cb-469f-a165-70867728950e', 'uuid'],
    ['3f2a9c1e7b5d4a6f8e0c2b1d9a7f6e5c4b3a2d1e', 'hex id'],
    ['2026-09-03', 'date'],
    ['74%', 'figure'],
    ['$45k', 'figure'],
    ['see the vault item', 'prose'],
    ['abc', 'too short'],
  ])('rejects %s as %s', (value: string, reason: string): void => {
    expect(guardReason(value)).toBe(reason);
    expect(guardSecretSpan(value, { start: 0, end: value.length }, 'access token')).toBeUndefined();
  });

  it.each(['hunter2', 'pipeline-tile-local', 'P@ssw0rd!', 'Tr0ub4dor&3', 'Sunny-Day-42', '0419', 'q7Mz2Kv9'])(
    'passes %s through',
    (value: string): void => {
      expect(guardReason(value)).toBeUndefined();
      expect(guardSecretSpan(value, { start: 0, end: value.length }, 'password')).toEqual({
        start: 0,
        end: value.length,
      });
    },
  );

  it('narrows a span that swallowed its label to the value', (): void => {
    for (const [text, value] of [
      ['Sign in with password: hunter2 and press Save.', 'hunter2'],
      ['the password is hunter2; rotate it', 'hunter2'],
      ['Looker password: `revops2026`', 'revops2026'],
      ['密码：hunter2，请勿写入工单', 'hunter2'],
    ]) {
      const swallowed = spanOf(text, text.slice(text.search(/password|密码/), spanOf(text, value).end));
      const narrowed = guardSecretSpan(text, swallowed, 'password');
      expect(narrowed).toEqual(spanOf(text, value));
    }
  });

  it('trims whitespace and enclosing punctuation and drops a span that is prose', (): void => {
    const text = 'Use (hunter2), then rotate it.';
    expect(guardSecretSpan(text, spanOf(text, ' (hunter2),'), 'password')).toEqual(spanOf(text, 'hunter2'));
    const prose = 'Session: token, valid for one hour.';
    expect(guardSecretSpan(prose, spanOf(prose, 'valid for one hour'), 'access token')).toBeUndefined();
  });

  it('keeps the whitespace of a private key block', (): void => {
    const text = 'key\nAAAA\nBBBB\nend';
    expect(guardSecretSpan(text, spanOf(text, 'AAAA\nBBBB'), 'private key')).toEqual(spanOf(text, 'AAAA\nBBBB'));
  });
});

describe('explicit password assignments', () => {
  it.each([
    ['Looker password: revops2026', 'Looker password', 'revops2026'],
    ['密码：revops2026', '密码', 'revops2026'],
    ['Password: abc', 'abc', 'abc'],
    ['Password: 123', '123', '123'],
    ['Password: revops\n2026', 'revops\n2026', 'revops\n2026'],
    ['{"message":"Looker password: revops2026\\nNext step"}', 'Looker password', 'revops2026'],
  ])('keeps the value span for %s', (text, candidate, value) => {
    expect(guardSecretSpan(text, spanOf(text, candidate), 'password')).toEqual(spanOf(text, value));
  });

  it.each(['{{secret}}', '<credential: looker password, stored>', '74%', 'https://example.test', 'REVOPS-7'])(
    'keeps working material after a label: %s', (value) => {
      const text = `Password: ${value}`;
      expect(guardSecretSpan(text, spanOf(text, 'Password'), 'password')).toBeUndefined();
    },
  );
});
