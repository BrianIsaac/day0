import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/nextjs', () => ({
  // Clerk has answered: nobody is signed in.
  Show: ({ when, children }: { when: string; children: ReactNode }): ReactNode =>
    when === 'signed-out' ? children : null,
  SignInButton: ({ children }: { children: ReactNode }): ReactNode => children,
  SignUpButton: ({ children }: { children: ReactNode }): ReactNode => children,
  UserButton: (): null => null,
}));

import { HeaderAccount } from '../../app/HeaderAccount';

describe('the header account controls', (): void => {
  it('gives Sign in and Create account a 44 px target once Clerk has loaded (N14)', (): void => {
    const buttons = [
      ...renderToStaticMarkup(<HeaderAccount />).matchAll(/<button [^>]*>([^<]*)<\/button>/g),
    ];
    expect(buttons.map(([, label]) => label)).toEqual(['Sign in', 'Create account']);
    for (const [button] of buttons) expect(button).toMatch(/\bmin-h-11\b/);
  });
});
