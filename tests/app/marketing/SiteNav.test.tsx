import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ signedIn: false }));
vi.mock('@clerk/nextjs', () => ({
  useUser: () => ({ user: auth.signedIn ? { id: 'user-1' } : null }),
}));

afterEach(() => {
  auth.signedIn = false;
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
