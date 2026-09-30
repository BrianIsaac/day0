/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';

const clerk = vi.hoisted(() => ({ signOuts: [] as unknown[] }));

vi.mock('@clerk/nextjs', () => ({
  ClerkProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => ({ isLoaded: true, isSignedIn: true }),
  useClerk: () => ({
    status: 'ready',
    signOut: async (options: unknown): Promise<void> => {
      clerk.signOuts.push(options);
    },
  }),
}));
vi.mock('next/navigation', () => ({ usePathname: (): string => '/agent/j57agent/charter' }));

import { SignedOut } from '../../app/Providers';
import { mount, press, unmountAll } from '../fixtures/dom/press';

afterEach((): void => {
  unmountAll();
  clerk.signOuts = [];
});

describe('the owned page once Convex settles with nobody signed in (the second review, x1)', (): void => {
  it('sends a manager who signed out to sign in, and back to the page', (): void => {
    const view = mount(<SignedOut refused={false} />);
    expect(view.container.querySelector('h1')?.textContent).toBe('You are signed out');
    expect(view.container.querySelector('a')?.getAttribute('href')).toBe(
      '/sign-in?redirect_url=%2Fagent%2Fj57agent%2Fcharter',
    );
  });

  it('ends a session the deployment refused before signing in again, so sign-in does not send it straight back (second pass A3)', async (): Promise<void> => {
    const view = mount(<SignedOut refused />);
    expect(view.container.querySelector('h1')?.textContent).toBe(
      'Day0 could not confirm your sign-in',
    );
    // No link to sign-in: Clerk would send the signed-in session straight back to this page.
    expect(view.container.querySelector('a[href^="/sign-in"]')).toBeNull();
    await press(view.container, 'Sign in again');
    expect(clerk.signOuts).toEqual([
      { redirectUrl: '/sign-in?redirect_url=%2Fagent%2Fj57agent%2Fcharter' },
    ]);
  });
});
