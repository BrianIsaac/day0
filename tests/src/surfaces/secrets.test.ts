import { describe, expect, it } from 'vitest';
import {
  hasPlaceholder,
  httpSecretPlacementRefusal,
  injectSecret,
  redactValue,
  REDACTED,
  SecretTemplateError,
} from '../../../src/surfaces/secrets';

describe('secret injection', (): void => {
  it('substitutes every {{secret}} placeholder with the credential value', (): void => {
    expect(injectSecret('Bearer {{secret}}', 'tok-1')).toBe('Bearer tok-1');
    expect(injectSecret('{{ secret }} and {{secret}}', 'tok-1')).toBe('tok-1 and tok-1');
    expect(injectSecret('{"token":"{{secret}}","x":1}', 'tok-1')).toBe('{"token":"tok-1","x":1}');
  });

  it('leaves text without placeholders untouched', (): void => {
    expect(injectSecret('Content-Type: application/json', 'tok-1')).toBe(
      'Content-Type: application/json',
    );
    expect(hasPlaceholder('plain')).toBe(false);
    expect(hasPlaceholder('x {{secret}}')).toBe(true);
  });

  it('accepts a placeholder qualified with the action target surface only', (): void => {
    expect(injectSecret('Bearer {{secret:slack}}', 'tok-1', 'slack')).toBe('Bearer tok-1');
    expect(injectSecret('Bearer {{secret.slack}}', 'tok-1', 'slack')).toBe('Bearer tok-1');
  });

  it('refuses a template that names a secret for another surface', (): void => {
    expect(() => injectSecret('Bearer {{secret:linear}}', 'tok-1', 'slack')).toThrow(
      SecretTemplateError,
    );
    expect(() => injectSecret('Bearer {{secret:linear}}', 'tok-1', 'slack')).toThrow(
      /surface "linear"/,
    );
    expect(() => injectSecret('Bearer {{secret:linear}}', 'tok-1')).toThrow(SecretTemplateError);
  });

  it('refuses unknown placeholders rather than passing them through', (): void => {
    expect(() => injectSecret('{{token}}', 'tok-1', 'slack')).toThrow(/unknown placeholder/);
    expect(() => injectSecret('{{credential}}', 'tok-1')).toThrow(SecretTemplateError);
  });

  it('redacts a credential value wherever it appears', (): void => {
    expect(redactValue('bad token tok-1 rejected (tok-1)', 'tok-1')).toBe(
      `bad token ${REDACTED} rejected (${REDACTED})`,
    );
    expect(redactValue('nothing here', '')).toBe('nothing here');
  });

  it('redacts JSON-escaped and URL-encoded credential representations', (): void => {
    const secret = 'tok-"-\\-line\nend';
    const escaped = JSON.stringify(secret).slice(1, -1);
    const encoded = encodeURIComponent(secret);
    expect(redactValue(`{"error":"${escaped}"} ${encoded}`, secret)).toBe(
      `{"error":"${REDACTED}"} ${REDACTED}`,
    );
  });
});

describe('where an http.request may carry the credential', (): void => {
  it('admits it in a header value and nowhere else (review M4)', (): void => {
    expect(
      httpSecretPlacementRefusal({
        path: '/comments',
        headers: { Authorization: 'Bearer {{secret}}', 'X-Api-Key': '{{secret:tracker}}' },
        body: '{"body":"Done."}',
      }),
    ).toBeUndefined();
    expect(
      httpSecretPlacementRefusal({
        path: '/comments',
        headers: {},
        body: '{"body":"key: {{ secret }}"}',
      }),
    ).toBe(
      '{{secret}} goes only in a header value, never in the body, so the credential was not sent',
    );
    expect(
      httpSecretPlacementRefusal({
        path: '/issues/{{secret}}',
        headers: { '{{secret}}': 'x' },
      }),
    ).toBe(
      '{{secret}} goes only in a header value, never in the path, the header name {{secret}}, so the credential was not sent',
    );
  });

  it('leaves a placeholder that is not the credential to the unfilled-value rule', (): void => {
    expect(
      httpSecretPlacementRefusal({ path: '/issues/{{issue}}', headers: {}, body: '{{figure}}' }),
    ).toBeUndefined();
  });
});
