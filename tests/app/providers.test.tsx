import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConvexReactClient } from 'convex/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const recorded = vi.hoisted(() => ({ clients: [] as unknown[] }));

vi.mock('@clerk/nextjs', () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => <div data-auth="clerk">{children}</div>,
  useAuth: () => ({}),
}));
vi.mock('convex/react-clerk', () => ({
  ConvexProviderWithClerk: ({ client, children }: { client: unknown; children: ReactNode }) => {
    recorded.clients.push(client);
    return children;
  },
}));

afterEach(async () => {
  for (const client of recorded.clients) await (client as ConvexReactClient).close();
  recorded.clients.length = 0;
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('application providers', () => {
  it('renders an unconfigured shell without a public Convex address', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', undefined);
    const { Providers } = await import('../../app/providers');
    const NeedsBackend = (): never => { throw new Error('Backend-dependent children must wait'); };
    const html = renderToStaticMarkup(<Providers><NeedsBackend /></Providers>);
    expect(html).toContain('Day0');
    expect(html).toContain('build and start the app again');
    expect(recorded.clients).toHaveLength(0);
  });

  it('constructs the same real client and Clerk provider when configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://configured-test.convex.cloud');
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', undefined);
    const { Providers } = await import('../../app/providers');
    const html = renderToStaticMarkup(<Providers><main>Configured page</main></Providers>);
    expect(html).toContain('data-auth="clerk"');
    expect(html).toContain('Configured page');
    expect(recorded.clients).toHaveLength(1);
    expect(recorded.clients[0]).toBeInstanceOf(ConvexReactClient);
    expect((recorded.clients[0] as ConvexReactClient).url).toBe('https://configured-test.convex.cloud');
  });

  it('still refuses the no-auth flag in a production build', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', undefined);
    await expect(import('../../app/providers')).rejects.toThrow('refused outside `next dev`');
  });
});
