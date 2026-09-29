import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';
import { DocumentationLink } from './DocumentationLink';
import { HeaderAccount } from './HeaderAccount';
import { MainTransition } from './MainTransition';
import { BrandMark } from './marketing/BrandMark';
import { HERO } from './marketing/copy';
import { SiteNav } from './marketing/SiteNav';
import { Providers } from './Providers';

const description = HERO.lede;

/**
 * Absolute base for the generated `og:image` URL. A scraper is a stranger to the
 * page and cannot resolve a relative one, and Next otherwise falls back to
 * localhost. Vercel exposes the production alias on every deployment, preview
 * builds included; the literal covers running outside Vercel.
 */
const siteUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : 'https://day0-olive.vercel.app';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'Day0',
  description,
  openGraph: { title: 'Day0', description, siteName: 'Day0', url: siteUrl, type: 'website' },
  twitter: { card: 'summary_large_image', title: 'Day0', description },
};

/** The browser chrome takes the page colour, `--color-bg`, so the header runs into it. */
export const viewport: Viewport = { themeColor: '#0a0a0b' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body>
        {/* Held above the window at its full 44 px, not shrunk to a pixel, so it is the same
            target whether a keyboard has reached it or not; focus brings it down. */}
        <a
          href="#main"
          className="fixed left-4 top-2 z-50 inline-flex min-h-11 -translate-y-[calc(100%+1rem)] items-center rounded-lg bg-[var(--color-card)] px-4 text-sm focus:translate-y-0"
        >
          Skip to content
        </a>
        <Providers>
          {/* Named so a page transition leaves it in place above the pages that swap under it. */}
          <header
            style={{ viewTransitionName: 'site-header' }}
            className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-bg)]/80 backdrop-blur-sm"
          >
            <div className="mx-auto flex min-h-14 max-w-7xl items-center justify-between gap-4 px-6">
              <Link
                href="/"
                aria-label="Day0 home"
                className="flex min-h-11 items-center gap-2.5 text-xs font-medium uppercase tracking-[0.2em] text-[var(--color-accent)]"
              >
                <BrandMark className="size-5" />
                <span aria-hidden="true">Day0</span>
              </Link>
              <SiteNav />
              <div className="flex items-center gap-4">
                <DocumentationLink />
                <HeaderAccount />
              </div>
            </div>
          </header>
          <MainTransition>{children}</MainTransition>
        </Providers>
      </body>
    </html>
  );
}
