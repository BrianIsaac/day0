/** @vitest-environment jsdom */

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from '../fixtures/dom/axe';
import { mount, unmountAll } from '../fixtures/dom/press';
import { syncServer, type SyncServer } from '../fixtures/convex/sync-socket';

/**
 * The header's account menu under the customer-local profile, drawn from the session's claims
 * (the token route's account), never from Clerk: name, address and Sign out, each a 44 px target
 * (N14), and the page's account (`useAccount`) the same person.
 */
vi.mock('@clerk/nextjs', () => {
  const never = (): never => {
    throw new Error('Clerk must never load under the customer-local profile');
  };
  return {
    ClerkProvider: never,
    useAuth: never,
    useClerk: never,
    useUser: never,
    Show: never,
    SignInButton: never,
    SignUpButton: never,
    UserButton: never,
  };
});
vi.mock('next/navigation', () => ({ usePathname: (): string => '/' }));

function idToken(sub: string): string {
  const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ sub, iat: now, exp: now + 3600 })}.c2ln`;
}

async function exchange(server: SyncServer): Promise<void> {
  let seen = -1;
  for (let turn = 0; turn < 200; turn += 1) {
    await act(async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (server.quiet() && server.sent.length === seen) return;
    seen = server.sent.length;
  }
  throw new Error('the exchange with the deployment was still going');
}

async function mountHeader(
  account: Record<string, string> = {
    name: 'Priya Raman',
    firstName: 'Priya',
    email: 'priya@acme.test',
  },
): Promise<HTMLElement> {
  vi.stubEnv('NEXT_PUBLIC_DAY0_PROFILE', 'customer-local');
  vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', undefined);
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://customer-test.convex.cloud');
  vi.stubGlobal(
    'fetch',
    async (): Promise<Response> =>
      Response.json({ token: idToken('priya'), expiresAt: Date.now() + 3_600_000, account }),
  );
  const server = syncServer(() => undefined);
  vi.stubGlobal('WebSocket', server.Socket);
  const { Providers } = await import('../../app/Providers');
  const { HeaderAccount } = await import('../../app/HeaderAccount');
  const { useAccount } = await import('../../app/account');
  function AccountProbe() {
    const seen = useAccount();
    return (
      <p data-probe>
        {seen.kind === 'signed-in' ? `${seen.boss.firstName} ${seen.boss.email}` : seen.kind}
      </p>
    );
  }
  const view = mount(
    <Providers>
      <header>
        <HeaderAccount />
      </header>
      <main>
        <AccountProbe />
      </main>
    </Providers>,
  );
  await exchange(server);
  return view.container;
}

function menuButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('header button[aria-expanded]');
  if (!button) throw new Error('no account menu button');
  return button;
}

afterEach((): void => {
  unmountAll();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the customer-local account menu', (): void => {
  it("names the signed-in person from the session's claims, in a 44 px button", async (): Promise<void> => {
    const container = await mountHeader();
    const button = menuButton(container);
    expect(button.getAttribute('aria-label')).toBe('Account: Priya Raman');
    expect(button.textContent).toBe('PR');
    expect(button.className).toContain('size-11');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-probe]')?.textContent).toBe('Priya priya@acme.test');
  });

  it('opens to the name, the address and Sign out, which posts to the sign-out route', async (): Promise<void> => {
    const container = await mountHeader();
    const button = menuButton(container);
    act((): void => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const panel = container.querySelector(`#${button.getAttribute('aria-controls')}`);
    expect(panel?.textContent).toContain('Priya Raman');
    expect(panel?.textContent).toContain('priya@acme.test');
    const form = panel?.querySelector('form');
    expect(form?.getAttribute('method')).toBe('post');
    expect(form?.getAttribute('action')).toBe('/api/auth/oidc/logout');
    expect(form?.querySelector('button[type="submit"]')?.className).toContain('min-h-11');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('closes on Escape and gives focus back to its button', async (): Promise<void> => {
    const container = await mountHeader();
    const button = menuButton(container);
    act((): void => button.click());
    const signOut = container.querySelector<HTMLButtonElement>('form button');
    signOut?.focus();
    act((): void => {
      signOut?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  it('falls back to the address when the token names nobody', async (): Promise<void> => {
    const container = await mountHeader({ email: 'mateo@acme.test' });
    const button = menuButton(container);
    expect(button.getAttribute('aria-label')).toBe('Account: mateo@acme.test');
    expect(button.textContent).toBe('M');
    expect(await axeViolations(container)).toEqual([]);
  });
});
