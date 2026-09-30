import { describe, expect, it } from 'vitest';
import { holdsClerkSession } from '../../app/session-hint';

/** Cookie strings and whether each holds a session for Clerk to resolve. */
const COOKIES: ReadonlyArray<readonly [string, boolean]> = [
  ['', false],
  ['theme=dark', false],
  ['__client_uat=0', false],
  ['__client_uat=1759100000', true],
  ['__client_uat_AbC12=1759100000', true],
  ['__client_uat=0; __client_uat_AbC12=1759100000', true],
  ['__client_uat_AbC12=0; theme=dark', false],
  ['not__client_uat=1759100000', false],
];

describe('holdsClerkSession', (): void => {
  it.each(COOKIES)('reads %j as holding a session: %s', (cookie, holds): void => {
    expect(holdsClerkSession(cookie)).toBe(holds);
  });
});
