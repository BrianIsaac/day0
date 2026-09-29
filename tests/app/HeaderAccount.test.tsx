import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const clerk = vi.hoisted(() => ({
  signedIn: false,
  appearance: {} as Record<string, unknown>,
}));

vi.mock('@clerk/nextjs', () => ({
  Show: ({ when, children }: { when: string; children: ReactNode }): ReactNode =>
    (when === 'signed-in') === clerk.signedIn ? children : null,
  SignInButton: ({ children, appearance }: { children: ReactNode; appearance?: unknown }) => {
    clerk.appearance.signIn = appearance;
    return children;
  },
  SignUpButton: ({ children, appearance }: { children: ReactNode; appearance?: unknown }) => {
    clerk.appearance.signUp = appearance;
    return children;
  },
  UserButton: ({
    appearance,
    userProfileProps,
  }: {
    appearance?: unknown;
    userProfileProps?: { appearance?: unknown };
  }): null => {
    clerk.appearance.account = appearance;
    clerk.appearance.profile = userProfileProps?.appearance;
    return null;
  },
}));

import { HeaderAccount } from '../../app/HeaderAccount';
import { clerkAppearance } from '../../app/clerk-appearance';

describe('the header account controls', (): void => {
  it('gives Sign in and Create account a 44 px target once Clerk has loaded (N14)', (): void => {
    clerk.signedIn = false;
    const buttons = [
      ...renderToStaticMarkup(<HeaderAccount />).matchAll(/<button [^>]*>([^<]*)<\/button>/g),
    ];
    expect(buttons.map(([, label]) => label)).toEqual(['Sign in', 'Create account']);
    for (const [button] of buttons) expect(button).toMatch(/\bmin-h-11\b/);
  });

  it('opens the sign-in and create-account modals in the shared appearance', (): void => {
    clerk.signedIn = false;
    renderToStaticMarkup(<HeaderAccount />);
    expect(clerk.appearance.signIn).toBe(clerkAppearance);
    expect(clerk.appearance.signUp).toBe(clerkAppearance);
  });

  it('opens the account menu in the shared appearance once signed in', (): void => {
    clerk.signedIn = true;
    renderToStaticMarkup(<HeaderAccount />);
    expect(clerk.appearance.account).toBe(clerkAppearance);
    // Manage account opens the profile as a modal of its own, which takes the appearance too.
    expect(clerk.appearance.profile).toBe(clerkAppearance);
  });
});

describe('the no-auth badge', (): void => {
  afterEach((): void => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('says no-auth mode is on at the 12 px floor, never below it (m8)', async (): Promise<void> => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
    vi.resetModules();
    const { HeaderAccount: Badged } = await import('../../app/HeaderAccount');
    const html = renderToStaticMarkup(<Badged />);
    expect(html).toContain('No-auth dev mode');
    expect(html).not.toMatch(/text-\[(9|10|11)px\]/);
  });
});
