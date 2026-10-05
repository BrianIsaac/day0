import { describe, expect, it } from 'vitest';
import {
  CONTINUE_HEADING,
  DEPLOY_HEADING,
  signInHeading,
} from '../../../app/sign-in/sign-in-words';

describe('signInHeading', (): void => {
  it('continues to a page the visitor asked for, by its address or its path', (): void => {
    expect(signInHeading('https://dayzer0.dev/organisation')).toBe(CONTINUE_HEADING);
    expect(signInHeading('/agent/k57abc?tab=work')).toBe(CONTINUE_HEADING);
  });

  it('asks to deploy an employee for the home, for no address, and for one that is none', (): void => {
    for (const value of [
      undefined,
      '',
      ['/agent/a', '/agent/b'],
      'https://dayzer0.dev',
      '/home/',
      'not an address',
    ]) {
      expect(signInHeading(value)).toBe(DEPLOY_HEADING);
    }
  });
});
