import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Set up Day0',
  description: 'Where the instructions for running Day0 on your own machine live today.',
};

const README = 'https://github.com/BrianIsaac/day0';

/** One route out of this page, so no line of it is a dead end. */
function Route({ href, title, body }: { href: string; title: string; body: string }) {
  return (
    <li className="border border-[var(--color-border)] rounded-xl p-4 bg-[var(--color-card)]">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm font-medium text-[var(--color-accent)] underline underline-offset-4"
      >
        {title}
      </a>
      <p className="text-sm text-[var(--color-muted)] mt-1.5 leading-relaxed">{body}</p>
    </li>
  );
}

/**
 * A placeholder, on purpose. The landing page offers "Set up Day0" beside "Try
 * the demo", and a button that goes nowhere is worse than a button that admits
 * what it has: the README already carries working, dated setup instructions, so
 * this page hands the visitor those rather than a promise.
 */
export default function SetupPage() {
  return (
    <main className="min-h-[calc(100vh-3.25rem)] px-6 py-16 max-w-3xl mx-auto w-full">
      <p className="text-[11px] uppercase tracking-[0.28em] text-[var(--color-accent)] mb-5">
        Set up Day0
      </p>
      <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight leading-tight mb-5">
        The setup guide is not here yet.
      </h1>
      <p className="text-base text-[var(--color-muted)] leading-relaxed mb-10">
        A guided version of this page is being written. Everything it will say already works today in
        the repository&rsquo;s README, which is kept current with the code and shows the commands for
        each of the three ways to run Day0 on your own machine.
      </p>

      <ul className="space-y-3 mb-10">
        <Route
          href={`${README}#local-dev`}
          title="Local dev"
          body="What you need installed, how the backend and the app come up, and what a working first run looks like."
        />
        <Route
          href={`${README}#run-it-with-no-accounts`}
          title="Run it with no accounts"
          body="The route with no sign-up anywhere: your own model server, a local sandbox, and no provider key."
        />
        <Route
          href={`${README}#run-it-with-an-openai-key`}
          title="Run it with a provider key"
          body="The shorter route if you already hold a key for a compatible model provider."
        />
      </ul>

      <p className="text-sm text-[var(--color-muted)]">
        Only wanted to see it work?{' '}
        <Link href="/demo" className="text-[var(--color-accent)] underline underline-offset-4">
          Try the demo
        </Link>{' '}
        instead - it is a recording, and it needs nothing installed.
      </p>
    </main>
  );
}
