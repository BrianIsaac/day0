import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { HOSTED_DEMO_NOTICE } from '@/demo/hosted-notice';
import { DEV_NO_AUTH } from '@/lib/dev-auth';
import { Disclosure } from '../../components/Disclosure';
import { HeadedSignIn, StepHeading } from '../../HeadedClerk';
import { HostedDemoNotice } from '../../HostedDemoNotice';
import { signInHeading } from '../sign-in-words';

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
 * The notice folded under its own heading, for a phone: the heading is read before the card and
 * the receivers are one tap away, where the open notice put the card below the fold at 390 by 844
 * (the v0.11.0 walk). The words are `HOSTED_DEMO_NOTICE`'s, as the open notice's are.
 */
function FoldedNotice() {
  return (
    <div
      role="note"
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 text-sm leading-relaxed text-[var(--color-muted)] md:hidden"
    >
      <Disclosure
        summary={
          <span className="text-sm font-semibold text-[var(--color-fg)]">
            {HOSTED_DEMO_NOTICE.heading}
          </span>
        }
      >
        <div className="grid gap-1.5 pb-3.5">
          {HOSTED_DEMO_NOTICE.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
          <p>
            {HOSTED_DEMO_NOTICE.link.before}
            <a
              href={HOSTED_DEMO_NOTICE.link.href}
              className="underline decoration-[var(--color-link-line)] underline-offset-4 transition-colors hover:decoration-[var(--color-accent)]"
            >
              {HOSTED_DEMO_NOTICE.link.label}
            </a>
            {HOSTED_DEMO_NOTICE.link.after}
          </p>
        </div>
      </Disclosure>
    </div>
  );
}

/**
 * The hosted demo's way in: what the office is, what happens after signing in, and what the
 * demo collects and who receives it (N6), beside Clerk's sign-in. In no-auth dev mode there is
 * nothing to sign in to and the page sends the local manager home.
 *
 * Its heading says the sign-in continues to the page a visitor asked for when Clerk sent them
 * from one ({@link signInHeading}).
 *
 * On a wide screen the words are a column beside the card, the notice open. On a phone the
 * column's parts join the page's single column, so the card can come straight after the heading
 * and the folded notice, in the first screen, and the lede and the steps, which hold nothing to
 * press, follow the card; the notice stays before the card in reading order at every width.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  if (DEV_NO_AUTH) redirect('/');
  const { redirect_url: redirectUrl } = await searchParams;

  return (
    <div className="mx-auto grid w-full max-w-7xl grid-cols-1 items-start gap-6 px-6 py-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:gap-12 md:py-16">
      <div className="contents md:flex md:flex-col md:gap-5">
        <StepHeading
          base="/sign-in"
          className="text-[1.75rem] font-semibold leading-tight tracking-[-0.02em] text-balance"
        >
          {signInHeading(redirectUrl)}
        </StepHeading>
        <div className="order-last grid gap-5 md:order-none">
          <p className="max-w-[60ch] leading-relaxed text-[var(--color-muted)]">
            {/* That none of it reaches a real system is the notice's first sentence, below. */}
            The hosted office is a seeded, synthetic workplace: a Slack, a tracker, a wiki, a ticket
            queue and one social mention.
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
        </div>
        <FoldedNotice />
        <div className="hidden md:block">
          <HostedDemoNotice />
        </div>
      </div>
      <div id="sign-in-card" className="flex justify-center">
        <HeadedSignIn />
      </div>
    </div>
  );
}
