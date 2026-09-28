import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { SignIn } from '@clerk/nextjs';
import { DEV_NO_AUTH } from '@/lib/dev-auth';
import { HostedDemoNotice } from '../../HostedDemoNotice';

/** The tab's title: the hosted demo's way in. */
export const metadata: Metadata = { title: 'Sign in to Day0' };

/** What a new manager does after signing in, in order. */
const FIRST_STEPS = [
  'Give your first employee a name.',
  'Hold its Day-1 one-to-one, in chat or voice.',
  'Strike a rule you disagree with, then approve the charter it drafts.',
  'Decide on the writes it holds for you, until you turn autonomous actions on.',
] as const;

/**
 * The hosted demo's way in: what the office is, what happens after signing in, and what the
 * demo collects and who receives it (N6), beside Clerk's sign-in. In no-auth dev mode there is
 * nothing to sign in to and the page sends the local manager home.
 */
export default function SignInPage() {
  if (DEV_NO_AUTH) redirect('/');

  return (
    <main className="mx-auto grid w-full max-w-7xl grid-cols-1 items-start gap-10 px-6 py-10 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:gap-12 md:py-16">
      <div className="flex flex-col gap-5">
        <h1 className="text-[1.75rem] font-semibold leading-tight tracking-[-0.02em] text-balance">
          Sign in to deploy an employee
        </h1>
        <p className="max-w-[60ch] leading-relaxed text-[var(--color-muted)]">
          The hosted office is a seeded, synthetic workplace: a Slack, a tracker, a wiki, a ticket
          queue and one social mention. Nothing your employee does reaches a real system.
        </p>
        <ol className="grid gap-1.5 text-[15px]">
          {FIRST_STEPS.map((step, index) => (
            <li key={step} className="grid grid-cols-[28px_minmax(0,1fr)] items-baseline gap-2">
              <span
                aria-hidden="true"
                className="text-[13px] tabular-nums text-[var(--color-muted)]"
              >
                {index + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
        <HostedDemoNotice />
      </div>
      <div className="flex justify-center">
        <SignIn
          appearance={{
            variables: {
              colorPrimary: '#22d3ee',
              colorBackground: '#18181b',
              colorText: '#f4f4f5',
              colorInputBackground: '#0a0a0b',
              colorInputText: '#f4f4f5',
            },
          }}
        />
      </div>
    </main>
  );
}
