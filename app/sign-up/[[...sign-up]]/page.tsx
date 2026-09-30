import { redirect } from 'next/navigation';
import { SignUp } from '@clerk/nextjs';
import { DEV_NO_AUTH } from '@/lib/dev-auth';
import { clerkAppearance } from '../../clerk-appearance';

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
        <h1 className="text-3xl font-semibold tracking-tight mb-6 text-center">
          Create an account
        </h1>
        {/* Clerk's first step leaves its own h1 out under the page's (app/globals.css). */}
        <div data-headed-clerk="" className="flex justify-center">
          <SignUp appearance={clerkAppearance} />
        </div>
      </div>
    </div>
  );
}
