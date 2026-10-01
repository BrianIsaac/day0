import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Page from '../../../app/documentation/page';

/** Convex's answer about the token, and every query the page asked for. */
const convex = vi.hoisted(() => ({
  isLoading: true,
  isAuthenticated: false,
  asked: [] as string[],
}));

vi.mock('@clerk/nextjs', () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({ isLoaded: true, isSignedIn: false }),
  useClerk: () => ({ status: 'ready' }),
}));
vi.mock('next/navigation', () => ({ usePathname: (): string => '/documentation' }));
vi.mock('convex/react', () => ({
  useConvexAuth: () => ({ isLoading: convex.isLoading, isAuthenticated: convex.isAuthenticated }),
  useQuery: (query: FunctionReference<'query'>): undefined => {
    convex.asked.push(getFunctionName(query));
    return undefined;
  },
  useMutation: () => async (): Promise<void> => undefined,
  useAction: () => async (): Promise<void> => undefined,
}));

afterEach((): void => {
  convex.isLoading = true;
  convex.isAuthenticated = false;
  convex.asked.length = 0;
});

describe('the owner-level documentation page behind the session gate (second review x2, x6)', (): void => {
  it('says what it is waiting for, and asks for no owned row, until Convex holds the token', (): void => {
    const html = renderToStaticMarkup(<Page />);
    expect(html).toMatch(/<div role="status"[^>]*>loading documentation…<\/div>/);
    expect(html).not.toContain('<h1');
    expect(convex.asked).toEqual([]);
  });

  it('takes the page away once Convex settles with nobody signed in', (): void => {
    convex.isLoading = false;
    const html = renderToStaticMarkup(<Page />);
    expect(html).toContain('You are signed out');
    expect(html).toContain('href="/sign-in?redirect_url=%2Fdocumentation"');
    expect(convex.asked).toEqual([]);
  });

  it('draws the page and asks for its rows once Convex holds the token', (): void => {
    convex.isLoading = false;
    convex.isAuthenticated = true;
    const html = renderToStaticMarkup(<Page />);
    expect(html).toContain('>Documentation</h1>');
    expect(convex.asked).toEqual(['config:surfaceMode', 'docSources:listMine']);
  });
});
