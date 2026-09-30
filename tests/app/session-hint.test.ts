/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  holdsClerkSession,
  SESSION_HINT_ATTRIBUTE,
  SESSION_HINT_SCRIPT,
} from '../../app/session-hint';

// By path: under jsdom, `URL` is jsdom's own, which `fs` does not accept.
const CSS = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../app/globals.css'),
  'utf8',
);

/** The header's reservation rule, as `app/globals.css` writes it. */
const RESERVATION_RULE = /html\[data-session-hint[^{]*\{[^}]*\}/.exec(CSS)?.[0];

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

function clearCookies(): void {
  for (const name of document.cookie.split(/;\s*/).map((pair) => pair.split('=')[0])) {
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

/** Run the head's script as the browser does, against this document. */
function runHeadScript(): string | null {
  // The script is the layout's inline text; running it here is running what ships.
  new Function(SESSION_HINT_SCRIPT)();
  return document.documentElement.getAttribute(SESSION_HINT_ATTRIBUTE);
}

afterEach((): void => {
  clearCookies();
  document.documentElement.removeAttribute(SESSION_HINT_ATTRIBUTE);
  document.head.replaceChildren();
  document.body.replaceChildren();
});

describe('holdsClerkSession', (): void => {
  it.each(COOKIES)('reads %j as holding a session: %s', (cookie, holds): void => {
    expect(holdsClerkSession(cookie)).toBe(holds);
  });
});

describe('the head script', (): void => {
  it.each(COOKIES.filter(([cookie]) => cookie !== ''))(
    'writes onto <html> the answer holdsClerkSession gives for %j',
    (cookie, holds): void => {
      for (const pair of cookie.split('; ')) document.cookie = `${pair}; path=/`;
      expect(runHeadScript()).toBe(holds ? 'present' : 'none');
    },
  );

  it('writes none for a browser with no cookie at all', (): void => {
    expect(runHeadScript()).toBe('none');
  });
});

describe("the header's reservation rule", (): void => {
  /** Lay out both reservations under the rule, and say which the page would draw. */
  function drawn(): string[] {
    const style = document.createElement('style');
    style.textContent = RESERVATION_RULE ?? '';
    document.head.append(style);
    document.body.innerHTML =
      '<div data-account-reserve="signed-out"></div><div data-account-reserve="signed-in"></div>';
    return [...document.querySelectorAll<HTMLElement>('[data-account-reserve]')]
      .filter((element) => getComputedStyle(element).display !== 'none')
      .map((element) => element.dataset.accountReserve ?? '');
  }

  it('is in the stylesheet', (): void => {
    expect(RESERVATION_RULE).toBeDefined();
  });

  it("holds the account menu's room for a browser with a session", (): void => {
    document.cookie = '__client_uat=1759100000; path=/';
    runHeadScript();
    expect(drawn()).toEqual(['signed-in']);
  });

  it("holds the sign-in controls' room for a browser without one", (): void => {
    document.cookie = '__client_uat=0; path=/';
    runHeadScript();
    expect(drawn()).toEqual(['signed-out']);
  });

  it("holds the sign-in controls' room when the script has not run", (): void => {
    expect(drawn()).toEqual(['signed-out']);
  });
});
