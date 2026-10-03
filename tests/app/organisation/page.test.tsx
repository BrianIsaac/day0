import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Page, { metadata } from '../../../app/organisation/page';

/** Convex's answer about the token, and every query the page asked for, with its arguments. */
const convex = vi.hoisted(() => ({
  isLoading: true,
  isAuthenticated: false,
  asked: [] as Array<{ name: string; args: unknown }>,
}));

vi.mock('@clerk/nextjs', () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({ isLoaded: true, isSignedIn: false }),
  useClerk: () => ({ status: 'ready' }),
}));
vi.mock('next/navigation', () => ({ usePathname: (): string => '/organisation' }));
vi.mock('convex/react', () => ({
  useConvexAuth: () => ({ isLoading: convex.isLoading, isAuthenticated: convex.isAuthenticated }),
  useQuery: (query: FunctionReference<'query'>, args: unknown): unknown => {
    const name = getFunctionName(query);
    convex.asked.push({ name, args });
    return name === 'organisationConnections:summaryForManager'
      ? { callerIsAdministrator: false, systems: [] }
      : undefined;
  },
  useMutation: () => async (): Promise<void> => undefined,
  useAction: () => async (): Promise<void> => undefined,
}));

afterEach((): void => {
  convex.isLoading = true;
  convex.isAuthenticated = false;
  convex.asked.length = 0;
});

/** The page rendered for an address with the given search. */
async function render(search: Record<string, string | string[]> = {}): Promise<string> {
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(search) }));
}

describe('the organisation page behind the session gate (B8)', (): void => {
  it('is titled for the tab, then Day0, as every signed-in page is (round 0141 R-D item 5)', (): void => {
    expect(metadata.title).toBe('Organisation · Day0');
  });

  it('asks for nothing until Convex holds the token', async (): Promise<void> => {
    const html = await render();
    expect(html).toMatch(/<div role="status"[^>]*>loading the organisation…<\/div>/);
    expect(convex.asked).toEqual([]);
  });

  it('refuses a manager in words once signed in, asking no administrator read', async (): Promise<void> => {
    convex.isLoading = false;
    convex.isAuthenticated = true;
    const html = await render({ card: 'surface-1' });
    expect(html).toContain('This page is for your organisation&#x27;s administrators</h1>');
    expect(
      convex.asked.filter((ask) => ask.name !== 'organisationConnections:summaryForManager'),
    ).toEqual([
      { name: 'organisationConnections:listForAdministrator', args: 'skip' },
      { name: 'connectionEvents:forAdministrator', args: 'skip' },
    ]);
  });
});
