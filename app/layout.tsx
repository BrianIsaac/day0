import type { Metadata } from 'next';
import Link from 'next/link';
import { Show, SignInButton, SignUpButton, UserButton } from '@clerk/nextjs';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Day0',
  description:
    'An autonomous teammate that joins on day zero with no role, no skills, no scope — and figures it all out by talking to its boss.',
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
              <span className="text-[10px] text-[var(--color-muted)] hidden sm:inline">
                AI Engineer Hackathon · Singapore
              </span>
            </Link>
            <Show when="signed-out">
              <div className="flex items-center gap-2">
                <SignInButton mode="modal">
                  <button className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-accent)]">
                    Sign in
                  </button>
                </SignInButton>
                <SignUpButton mode="modal">
                  <button className="text-xs px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-bg)] font-medium hover:opacity-90">
                    Create account
                  </button>
                </SignUpButton>
              </div>
            </Show>
            <Show when="signed-in">
              <UserButton
                appearance={{
                  variables: {
                    colorBackground: '#18181b',
                    colorText: '#f4f4f5',
                    colorPrimary: '#22d3ee',
                  },
                }}
              />
            </Show>
          </header>
          {children}
        </Providers>
      </body>
    </html>
  );
}
