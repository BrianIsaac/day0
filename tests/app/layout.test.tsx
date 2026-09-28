import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/Providers', () => ({
  Providers: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../../app/HeaderAccount', () => ({ HeaderAccount: () => null }));
vi.mock('@clerk/nextjs', () => ({ useUser: () => ({ user: null }) }));

/** What the backend's `config.surfaceMode` query answers; undefined while it has not. */
const backend = vi.hoisted((): { mode: 'mock' | 'real' | undefined } => ({ mode: undefined }));
vi.mock('convex/react', () => ({
  useQuery: (): { mode: 'mock' | 'real' } | undefined =>
    backend.mode ? { mode: backend.mode } : undefined,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  backend.mode = undefined;
});

/**
 * The header sits on every page, including the two public ones. A prefetched
 * link to a protected route is not free there: Next fetches it on sight, the
 * proxy protects it, and a signed-out visitor's browser is sent to Clerk's
 * hosted sign-in before they have clicked anything. The phase 1 request trace
 * caught ten of those on one pass.
 */
describe('the header on a public page', (): void => {
  const component = readFileSync(
    new URL('../../app/DocumentationLink.tsx', import.meta.url),
    'utf8',
  );

  it('does not prefetch the protected documentation route', (): void => {
    const link = /<Link[^>]*href="\/documentation"[\s\S]*?>/.exec(component)?.[0] ?? '';
    expect(link).not.toBe('');
    expect(link).toContain('prefetch={false}');
  });
});

describe('the focus ring', (): void => {
  const css = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');

  it('covers links and disclosures, not only form controls', (): void => {
    const rule = /:where\(([^)]*)\):focus-visible/.exec(css)?.[1] ?? '';
    for (const selector of ['a', 'summary', 'button']) {
      expect(rule.split(',').map((s) => s.trim())).toContain(selector);
    }
  });
});

/** Render the root layout around one page, which brings no landmark of its own. */
async function renderLayout(): Promise<string> {
  const { default: Layout } = await import('../../app/layout');
  return renderToStaticMarkup(
    <Layout>
      <p>Page</p>
    </Layout>,
  );
}

describe('the document language', (): void => {
  it('declares British English, the spelling every string on the page uses', async (): Promise<void> => {
    expect(await renderLayout()).toContain('<html lang="en-GB">');
  });
});

describe('documentation navigation by deployment mode', () => {
  it('omits the link until the backend has answered', async () => {
    expect(await renderLayout()).not.toContain('href="/documentation"');
  });

  it('omits the link when the backend runs in mock mode', async () => {
    backend.mode = 'mock';
    expect(await renderLayout()).not.toContain('href="/documentation"');
  });

  it('shows the link when the backend runs in real mode', async () => {
    backend.mode = 'real';
    expect(await renderLayout()).toContain('href="/documentation"');
  });

  it('renders under next start with real mode in the Next environment, where the gate would throw', async () => {
    vi.stubEnv('DAY0_SURFACE_MODE', 'real');
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', '');
    vi.stubEnv('NODE_ENV', 'production');
    backend.mode = 'real';
    vi.resetModules();
    expect(await renderLayout()).toContain('href="/documentation"');
  });
});

describe('the header', (): void => {
  it('puts the mark beside the wordmark in the one link home', async (): Promise<void> => {
    const html = await renderLayout();
    const home = /<a [^>]*href="\/"[^>]*>([\s\S]*?)<\/a>/.exec(html);
    expect(home?.[0]).toContain('aria-label="Day0 home"');
    expect(home?.[1]).toMatch(
      /^<svg viewBox="0 0 16 16"[\s\S]*<\/svg><span aria-hidden="true">Day0<\/span>$/,
    );
  });

  it('carries the public navigation for a signed-out visitor, with the walkthrough and GitHub', async (): Promise<void> => {
    const html = await renderLayout();
    expect(html).toMatch(
      /<nav aria-label="Site"[\s\S]*href="\/walkthrough"[\s\S]*aria-label="Day0 on GitHub"/,
    );
  });

  it('lets a keyboard skip the header to the page, before anything else takes focus', async (): Promise<void> => {
    const html = await renderLayout();
    const body = html.slice(html.indexOf('<body>') + '<body>'.length);
    expect(body).toMatch(/^<a href="#main"[^>]*>Skip to content<\/a>/);
    expect(html).toMatch(/<main id="main" tabindex="-1"[^>]*><p>Page<\/p><\/main>/);
  });

  it('holds every page in its one main landmark, after the header', async (): Promise<void> => {
    const html = await renderLayout();
    expect(html.match(/<main[\s>]/g)).toHaveLength(1);
    expect(html.indexOf('</header>')).toBeLessThan(html.indexOf('<main'));
  });

  /*
   * N29's page transition (UX 11) is a React `<ViewTransition>` around this main. Next's vendored
   * React has one; the React these tests render with (the installed 19.2.6) does not, so the
   * layout cannot render it here without a stand-in. When this fails, the installed React has
   * caught up: wrap the main as the wave 5 M handover (D1) sets out.
   */
  it('renders under the installed React, which has no ViewTransition yet', async (): Promise<void> => {
    const react: Record<string, unknown> = await import('react');
    expect(react.ViewTransition).toBeUndefined();
    expect(await renderLayout()).not.toContain('view-transition');
  });

  it('colours the browser chrome with the page', async (): Promise<void> => {
    const { viewport } = await import('../../app/layout');
    expect(viewport.themeColor).toBe('#0a0a0b');
    const css = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');
    expect(css).toContain('--color-bg: #0a0a0b;');
  });

  it('describes the site as the landing does, in the manager’s words', async (): Promise<void> => {
    const { metadata } = await import('../../app/layout');
    expect(metadata.description).toMatch(
      /^One name in\. Day0 holds a five-minute one-to-one with its manager/,
    );
    expect(metadata.description).not.toMatch(/boss|teammate/);
  });
});
