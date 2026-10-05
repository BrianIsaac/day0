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

  // Re-pinned by 13-FD (the v0.16.0 redeploy's finding 5): `/home` is the signed-in home a
  // returning manager's session ends on, whose employees are already deployed, so its sign-in
  // continues there as every other page's does. The landing (`/`) still asks to deploy one.
  it('continues to the home a returning manager was on', (): void => {
    for (const value of ['/home', '/home/', 'https://dayzer0.dev/home?tab=all']) {
      expect(signInHeading(value)).toBe(CONTINUE_HEADING);
    }
  });

  it('asks to deploy an employee for the landing, for no address, and for one that is none', (): void => {
    for (const value of [
      undefined,
      '',
      ['/agent/a', '/agent/b'],
      'https://dayzer0.dev',
      '/?transfer=k57abc',
      'not an address',
    ]) {
      expect(signInHeading(value)).toBe(DEPLOY_HEADING);
    }
  });
});
