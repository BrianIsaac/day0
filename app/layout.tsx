import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Day0',
  description:
    'An autonomous teammate that joins on day zero with no role, no skills, no scope — and figures it all out by talking to its boss.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="px-6 py-3 flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg)]/80 backdrop-blur-sm sticky top-0 z-10">
          <Link href="/" className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-[0.2em] text-[var(--color-accent)]">
              Day0
            </span>
            <span className="text-[10px] text-[var(--color-muted)] hidden sm:inline">
              AI Engineer Hackathon · Singapore
            </span>
          </Link>
        </header>
        {children}
      </body>
    </html>
  );
}
