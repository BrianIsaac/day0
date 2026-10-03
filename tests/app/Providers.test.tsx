import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConvexProviderWithAuth, ConvexReactClient } from 'convex/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const recorded = vi.hoisted(() => ({ clients: [] as unknown[], clerkStatus: 'loading' }));

vi.mock('@clerk/nextjs', () => ({
  ClerkProvider: ({
    children,
    signInUrl,
    signUpUrl,
    signInFallbackRedirectUrl,
    signUpFallbackRedirectUrl,
  }: {
    children: ReactNode;
    signInUrl?: string;
    signUpUrl?: string;
    signInFallbackRedirectUrl?: string;
    signUpFallbackRedirectUrl?: string;
  }) => (
    <div
      data-auth="clerk"
      data-sign-in={signInUrl}
      data-sign-up={signUpUrl}
      data-after-sign-in={signInFallbackRedirectUrl}
      data-after-sign-up={signUpFallbackRedirectUrl}
    >
      {children}
    </div>
  ),
  useAuth: () => ({}),
  useClerk: () => ({ status: recorded.clerkStatus }),
}));
vi.mock('next/navigation', () => ({ usePathname: (): string => '/agent/j57agent/charter' }));
vi.mock('convex/react-clerk', () => ({
  ConvexProviderWithClerk: ({ client, children }: { client: unknown; children: ReactNode }) => {
    recorded.clients.push(client);
    return children;
  },
}));

afterEach(async () => {
  for (const client of recorded.clients) await (client as ConvexReactClient).close();
  recorded.clients.length = 0;
  recorded.clerkStatus = 'loading';
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Convex's auth state as it stands before the token has been answered for. */
function tokenPending(): {
  isLoading: boolean;
  isAuthenticated: boolean;
  fetchAccessToken: () => Promise<null>;
} {
  return { isLoading: true, isAuthenticated: false, fetchAccessToken: async () => null };
}

describe('application providers', () => {
  it('renders an unconfigured shell without a public Convex address', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', undefined);
    const { Providers } = await import('../../app/Providers');
    const NeedsBackend = (): never => {
      throw new Error('Backend-dependent children must wait');
    };
    const html = renderToStaticMarkup(
      <Providers>
        <NeedsBackend />
      </Providers>,
    );
    expect(html).toContain('Day0');
    expect(html).toContain('build and start the app again');
    expect(recorded.clients).toHaveLength(0);
  });

  it('gives the skip link its target when the shell stands in for the whole page', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', undefined);
    const { Providers } = await import('../../app/Providers');
    const html = renderToStaticMarkup(<Providers>{null}</Providers>);
    expect(html).toMatch(/^<main id="main" tabindex="-1"/);
  });

  it('gives the skip link its target while no-auth dev mode unlocks the local session', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://configured-test.convex.cloud');
    const { Providers } = await import('../../app/Providers');
    const html = renderToStaticMarkup(<Providers>{null}</Providers>);
    expect(html).toContain('Unlocking this machine');
    expect(html).toMatch(/^<main id="main" tabindex="-1"/);
  });

  it('constructs the same real client and Clerk provider when configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://configured-test.convex.cloud');
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', undefined);
    const { Providers } = await import('../../app/Providers');
    const html = renderToStaticMarkup(
      <Providers>
        <main>Configured page</main>
      </Providers>,
    );
    expect(html).toContain('data-auth="clerk"');
    expect(html).toContain('Configured page');
    expect(recorded.clients).toHaveLength(1);
    expect(recorded.clients[0]).toBeInstanceOf(ConvexReactClient);
    expect((recorded.clients[0] as ConvexReactClient).url).toBe(
      'https://configured-test.convex.cloud',
    );
  });

  it("hands Clerk Day0's own sign-in and sign-up addresses when the environment names none (round 0141 R-D item 4)", async () => {
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://configured-test.convex.cloud');
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', undefined);
    vi.stubEnv('NEXT_PUBLIC_CLERK_SIGN_IN_URL', '');
    vi.stubEnv('NEXT_PUBLIC_CLERK_SIGN_UP_URL', '');
    vi.stubEnv('NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL', '');
    vi.stubEnv('NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL', '');
    const { Providers } = await import('../../app/Providers');
    const html = renderToStaticMarkup(<Providers>{null}</Providers>);
    expect(html).toContain('data-sign-in="/sign-in"');
    expect(html).toContain('data-sign-up="/sign-up"');
    expect(html).toContain('data-after-sign-in="/"');
    expect(html).toContain('data-after-sign-up="/"');
  });

  it('hands Clerk the sign-in address the environment names over the default', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://configured-test.convex.cloud');
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', undefined);
    vi.stubEnv('NEXT_PUBLIC_CLERK_SIGN_IN_URL', '/enter');
    const { Providers } = await import('../../app/Providers');
    const html = renderToStaticMarkup(<Providers>{null}</Providers>);
    expect(html).toContain('data-sign-in="/enter"');
  });

  it('still refuses the no-auth flag in a production build', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', undefined);
    await expect(import('../../app/Providers')).rejects.toThrow('refused outside `next dev`');
  });

  it('holds an owned page on its fallback while Convex waits for the token', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', undefined);
    const { SessionGate } = await import('../../app/Providers');
    const client = new ConvexReactClient('https://configured-test.convex.cloud');
    recorded.clients.push(client);
    const html = renderToStaticMarkup(
      <ConvexProviderWithAuth client={client} useAuth={tokenPending}>
        <SessionGate fallback={<p>held</p>}>
          <p>owned</p>
        </SessionGate>
      </ConvexProviderWithAuth>,
    );
    expect(html).toBe('<p>held</p>');
  });

  it('takes an owned page away once Convex settles with nobody signed in, and offers the way back (second review x1)', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', undefined);
    recorded.clerkStatus = 'ready';
    const { SessionGate } = await import('../../app/Providers');
    const client = new ConvexReactClient('https://configured-test.convex.cloud');
    recorded.clients.push(client);
    const settledSignedOut = () => ({
      isLoading: false,
      isAuthenticated: false,
      fetchAccessToken: async (): Promise<null> => null,
    });
    const html = renderToStaticMarkup(
      <ConvexProviderWithAuth client={client} useAuth={settledSignedOut}>
        <SessionGate fallback={<p>held</p>}>
          <p>owned</p>
        </SessionGate>
      </ConvexProviderWithAuth>,
    );
    expect(html).not.toContain('owned');
    expect(html).toContain('You are signed out');
    expect(html).toContain('href="/sign-in?redirect_url=%2Fagent%2Fj57agent%2Fcharter"');
  });

  it('lets an owned page through when Clerk failed to load and will never answer', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', undefined);
    recorded.clerkStatus = 'error';
    const { SessionGate } = await import('../../app/Providers');
    const client = new ConvexReactClient('https://configured-test.convex.cloud');
    recorded.clients.push(client);
    const html = renderToStaticMarkup(
      <ConvexProviderWithAuth client={client} useAuth={tokenPending}>
        <SessionGate fallback={<p>held</p>}>
          <p>owned</p>
        </SessionGate>
      </ConvexProviderWithAuth>,
    );
    expect(html).toBe('<p>owned</p>');
  });

  it('passes an owned page straight through in no-auth dev mode, whose whole tree is held above it', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
    const { SessionGate } = await import('../../app/Providers');
    const html = renderToStaticMarkup(
      <SessionGate fallback={<p>held</p>}>
        <p>owned</p>
      </SessionGate>,
    );
    expect(html).toBe('<p>owned</p>');
  });
});
