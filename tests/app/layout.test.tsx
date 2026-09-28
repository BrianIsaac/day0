import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/providers', () => ({
  Providers: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../../app/HeaderAccount', () => ({ HeaderAccount: () => null }));
vi.mock('../../app/WhipCursor', () => ({ WhipCursor: () => null }));

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

/** Render the root layout around one page. */
async function renderLayout(): Promise<string> {
  const { default: Layout } = await import('../../app/layout');
  return renderToStaticMarkup(
    <Layout>
      <main>Page</main>
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
