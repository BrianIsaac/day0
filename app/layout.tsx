import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';
import { DocumentationLink } from './DocumentationLink';
import { HeaderAccount } from './HeaderAccount';
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
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-[var(--color-card)] focus:px-4 focus:py-2 focus:text-sm"
        >
          Skip to content
        </a>
        <Providers>
          <header className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-bg)]/80 backdrop-blur-sm">
            <div className="mx-auto flex min-h-14 max-w-7xl items-center justify-between gap-4 px-6">
              <Link
                href="/"
                aria-label="Day0 home"
                className="flex items-center gap-2.5 py-2 text-xs font-medium uppercase tracking-[0.2em] text-[var(--color-accent)]"
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
          <main id="main" tabIndex={-1} className="outline-none">
            {children}
          </main>
        </Providers>
      </body>
    </html>
  );
}
