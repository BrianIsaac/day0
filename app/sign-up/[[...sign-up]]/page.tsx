import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { DEV_NO_AUTH } from '@/lib/dev-auth';
import { HeadedSignUp, StepHeading } from '../../HeadedClerk';

/** The tab's title: the account form, named as the sign-in page names its own. */
export const metadata: Metadata = { title: 'Create a Day0 account' };

/**
 * The hosted demo's account form: Clerk's sign-up under the page's own heading, in the shared
 * appearance. In no-auth dev mode no account exists to create, and the page sends the local
 * manager home.
 */
export default function SignUpPage() {
  // No accounts exist in no-auth dev mode, so there is nothing to create.
  if (DEV_NO_AUTH) redirect('/');

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-[var(--color-bg)]">
      <div className="max-w-md w-full">
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--color-accent)] mb-3 text-center">
          Day0
        </p>
        <StepHeading
          base="/sign-up"
          className="text-3xl font-semibold tracking-tight mb-6 text-center"
        >
          Create an account
        </StepHeading>
        <div className="flex justify-center">
          <HeadedSignUp />
        </div>
      </div>
    </div>
  );
}
