/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** What Clerk answers, driven by each test: `user` is undefined while it has not loaded. */
const clerk = vi.hoisted(
  (): {
    user: { primaryEmailAddress: { emailAddress: string }; firstName: string } | null | undefined;
    status: 'loading' | 'ready' | 'error';
  } => ({ user: undefined, status: 'loading' }),
);
vi.mock('@clerk/nextjs', () => ({
  useUser: () =>
    clerk.user === undefined
      ? { isLoaded: false, isSignedIn: undefined, user: undefined }
      : { isLoaded: true, isSignedIn: clerk.user !== null, user: clerk.user },
  useClerk: () => ({ status: clerk.status }),
}));

import { useAccount } from '../../app/account';

const MANAGER = {
  primaryEmailAddress: { emailAddress: 'boss@example.invalid' },
  firstName: 'Boss',
};

/** Prints the account the hook answers, so a test reads it as text. */
function Probe() {
  const account = useAccount();
  return <p>{account.kind === 'signed-in' ? `signed-in ${account.boss.email}` : account.kind}</p>;
}

let host: HTMLDivElement;
let root: Root;

function render(): string {
  act(() => root.render(<Probe />));
  return host.textContent ?? '';
}

function clearCookies(): void {
  for (const name of document.cookie.split(/;\s*/).map((pair) => pair.split('=')[0])) {
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

beforeEach((): void => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clerk.user = undefined;
  clerk.status = 'loading';
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach((): void => {
  act(() => root.unmount());
  clearCookies();
});

describe('useAccount', (): void => {
  it('answers resolving on the server, whatever the browser later holds', (): void => {
    expect(renderToStaticMarkup(<Probe />)).toBe('<p>resolving</p>');
  });

  it('stays resolving while Clerk loads a session this browser holds', (): void => {
    document.cookie = '__client_uat=1759100000; path=/';
    expect(render()).toBe('resolving');
  });

  it('reads a suffixed session cookie as a session too', (): void => {
    document.cookie = '__client_uat_AbC12=1759100000; path=/';
    expect(render()).toBe('resolving');
  });

  it('answers signed-out at once for a browser with no Clerk session, before Clerk loads', (): void => {
    expect(render()).toBe('signed-out');
    document.cookie = '__client_uat=0; path=/';
    expect(render()).toBe('signed-out');
  });

  it('answers signed-out when Clerk failed to load, rather than holding the shell', (): void => {
    document.cookie = '__client_uat=1759100000; path=/';
    clerk.status = 'error';
    expect(render()).toBe('signed-out');
  });

  it('answers the signed-in manager once Clerk resolves one', (): void => {
    document.cookie = '__client_uat=1759100000; path=/';
    clerk.user = MANAGER;
    clerk.status = 'ready';
    expect(render()).toBe('signed-in boss@example.invalid');
  });

  it('holds the signed-in manager while Clerk re-resolves the session mid-visit', (): void => {
    document.cookie = '__client_uat=1759100000; path=/';
    clerk.user = MANAGER;
    clerk.status = 'ready';
    expect(render()).toBe('signed-in boss@example.invalid');
    clerk.user = undefined;
    expect(render()).toBe('signed-in boss@example.invalid');
  });

  it('lets the manager go once Clerk resolves that nobody is signed in', (): void => {
    document.cookie = '__client_uat=1759100000; path=/';
    clerk.user = MANAGER;
    clerk.status = 'ready';
    render();
    clerk.user = null;
    expect(render()).toBe('signed-out');
    clerk.user = undefined;
    expect(render()).toBe('resolving');
  });
});
