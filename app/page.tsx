'use client';

import { Show, useUser } from '@clerk/nextjs';

export default function LandingPage() {
  return (
    <main className="min-h-[calc(100vh-3.25rem)] flex flex-col">
      <Show when="signed-out">
        <SignedOutHero />
      </Show>
      <Show when="signed-in">
        <SignedInPlaceholder />
      </Show>
    </main>
  );
}

function SignedOutHero() {
  return (
    <div className="flex-1 flex items-center justify-center px-6">
      <div className="max-w-2xl w-full">
        <h1 className="text-5xl font-semibold tracking-tight leading-[1.05] mb-6">
          Hire an agent. Don&apos;t configure one.
        </h1>
        <p className="text-lg text-[var(--color-muted)] mb-8 leading-relaxed">
          Day0 joins on day zero with no role, no skills, no scope. You give it a name and sign in
          as the boss it reports to. From there it runs the new-hire week as an autonomous loop:
          a Day-1 1:1 over voice, a charter you approve, work it claims under your eye, and skills
          it proposes when it hits a gap.
        </p>
        <p className="text-sm text-[var(--color-muted)] mb-2">
          Sign in (top right) to deploy your own demo agent.
        </p>
        <p className="mt-12 text-xs text-[var(--color-muted)]">
          Built on OpenAI GPT-5.5, ElevenLabs Conversational AI, Convex, Mastra, Exa, Daytona,
          Vercel, Cloudflare, Clerk.
        </p>
      </div>
    </div>
  );
}

function SignedInPlaceholder() {
  const { user } = useUser();
  return (
    <div className="flex-1 px-6 py-10 max-w-4xl mx-auto w-full">
      <h1 className="text-3xl font-semibold tracking-tight mb-2">
        Welcome{user?.firstName ? `, ${user.firstName}` : ''}.
      </h1>
      <p className="text-sm text-[var(--color-muted)]">
        Auth is wired. The agent dashboard, charter, work loop, and skills loop land in the next
        commits.
      </p>
    </div>
  );
}
