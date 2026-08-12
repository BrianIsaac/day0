import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { HeaderAccount } from './HeaderAccount';
import { Providers } from './providers';
import { WhipCursor } from './WhipCursor';

const description =
  'An autonomous teammate that joins on day zero with no role, no skills, no scope — and figures it all out by talking to its boss.';

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <header className="px-6 py-3 flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg)]/80 backdrop-blur-sm sticky top-0 z-10">
            <Link href="/" className="flex items-center gap-2">
              <span className="text-xs uppercase tracking-[0.2em] text-[var(--color-accent)]">
                Day0
              </span>
            </Link>
            <HeaderAccount />
          </header>
          {children}
        </Providers>
        <WhipCursor />
      </body>
    </html>
  );
}
