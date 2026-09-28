import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ loaded: true, signedIn: false, pathname: '/' }));
vi.mock('@clerk/nextjs', () => ({
  useUser: () =>
    auth.loaded
      ? { isLoaded: true, isSignedIn: auth.signedIn, user: auth.signedIn ? { id: 'user-1' } : null }
      : { isLoaded: false, isSignedIn: undefined, user: undefined },
  useClerk: () => ({ status: auth.loaded ? 'ready' : 'loading' }),
}));
vi.mock('next/navigation', () => ({ usePathname: (): string => auth.pathname }));

afterEach(() => {
  auth.loaded = true;
  auth.signedIn = false;
  auth.pathname = '/';
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function render(): Promise<string> {
  const { SiteNav } = await import('../../../app/marketing/SiteNav');
  return renderToStaticMarkup(<SiteNav />);
}

describe('the public site navigation', () => {
  it('offers a signed-out visitor how it works, the evidence, the walkthrough and GitHub', async () => {
    const html = await render();
    expect(html).toMatch(/<nav aria-label="Site"/);
    const links = [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)</g)].map(
      ([, href, label]) => `${label} ${href}`,
    );
    expect(links).toEqual([
      'How it works /#how',
      'Evidence /#evidence',
      'Walkthrough /walkthrough',
      ' https://github.com/BrianIsaac/day0',
    ]);
    expect(html).toContain('aria-label="Day0 on GitHub"');
  });

  it('gives every link a 44 px target inside the header (N14)', async () => {
    const html = await render();
    const links = [...html.matchAll(/<a [^>]*>/g)].map(([tag]) => tag);
    expect(links).toHaveLength(4);
    for (const link of links) expect(link).toMatch(/\b(min-h-11|size-11)\b/);
  });

  it('marks the walkthrough link as the current page only on the walkthrough', async () => {
    expect(await render()).not.toContain('aria-current');
    auth.pathname = '/walkthrough';
    expect(await render()).toMatch(
      /<a [^>]*href="\/walkthrough"[^>]*aria-current="page"|<a [^>]*aria-current="page"[^>]*href="\/walkthrough"/,
    );
  });

  it('is absent until the browser knows the visitor is signed out, as the account controls are', async () => {
    auth.loaded = false;
    expect(await render()).toBe('');
  });

  it('is absent for a signed-in manager, whose / is the company dashboard', async () => {
    auth.signedIn = true;
    expect(await render()).toBe('');
  });

  it('is absent in no-auth dev mode, where the local manager is always signed in', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
    vi.stubEnv('NODE_ENV', 'development');
    expect(await render()).toBe('');
  });
});
