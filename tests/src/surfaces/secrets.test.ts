import { describe, expect, it } from 'vitest';
import {
  hasPlaceholder,
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
});
