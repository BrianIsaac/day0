'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from 'convex/react';
import { useUser, Show } from '@clerk/nextjs';
import Link from 'next/link';
import { api } from '@convex/_generated/api';

export default function LandingPage() {
  return (
    <main className="min-h-[calc(100vh-3.25rem)] flex flex-col">
      <Show when="signed-out">
        <SignedOutHero />
      </Show>
      <Show when="signed-in">
        <SignedInDashboard />
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
          as the boss it reports to. From there it runs the new-hire week as an autonomous loop: a
          Day-1 1:1 over voice, a charter you approve, work it claims under your eye, and skills it
          proposes when it hits a gap.
        </p>
        <p className="text-sm text-[var(--color-muted)] mb-2">
          Sign in (top right) to deploy your own demo agent.
        </p>
        <p className="mt-12 text-xs text-[var(--color-muted)]">
          Built on OpenAI GPT-5.5 · ElevenLabs Conversational AI · Convex · Mastra · Exa · Daytona
          · Vercel · Cloudflare · Clerk
        </p>
      </div>
    </div>
  );
}

function SignedInDashboard() {
  const router = useRouter();
  const { user } = useUser();
  const agents = useQuery(api.agents.listForUser);
  const deploy = useMutation(api.agents.deploy);
  const reset = useMutation(api.reset.deleteMyData);
  const [workerName, setWorkerName] = useState('worker 1');
  const [submitting, setSubmitting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDeploy(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (!workerName.trim()) return;
    const bossEmail = user?.primaryEmailAddress?.emailAddress;
    if (!bossEmail) {
      setError('Could not read your email from Clerk — try signing out and back in.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const agentId = await deploy({ bossEmail, name: workerName.trim() });
      fetch(`/api/seed?agentId=${agentId}`, { method: 'POST' }).catch(() => {});
      router.push(`/agent/${agentId}`);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  async function onReset() {
    if (!confirm('Delete all your agents + their data? This cannot be undone.')) return;
    setResetting(true);
    try {
      await reset({});
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="flex-1 px-6 py-10 max-w-4xl mx-auto w-full">
      <h1 className="text-3xl font-semibold tracking-tight mb-2">
        Welcome{user?.firstName ? `, ${user.firstName}` : ''}.
      </h1>
      <p className="text-sm text-[var(--color-muted)] mb-8">
        Each agent runs the new-hire loop independently. Deploy as many as you like; reset wipes
        the slate clean.
      </p>

      <section className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-5 mb-6">
        <h2 className="text-sm font-semibold mb-3">Deploy a new Day0 agent</h2>
        <form onSubmit={onDeploy} className="flex gap-3">
          <input
            type="text"
            required
            disabled={submitting}
            placeholder="worker 1"
            value={workerName}
            onChange={(e) => setWorkerName(e.target.value)}
            className="flex-1 px-4 py-2.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)] text-sm"
          />
          <button
            type="submit"
            disabled={submitting}
            className="px-5 py-2.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-bg)] font-medium disabled:opacity-50 text-sm"
          >
            {submitting ? 'Deploying…' : 'Deploy'}
          </button>
        </form>
        {error ? <p className="text-xs text-[var(--color-danger)] mt-2">{error}</p> : null}
      </section>

      <section className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">Your agents</h2>
          <span className="text-[10px] text-[var(--color-muted)]">
            {agents?.length ?? 0} total
          </span>
        </div>
        {!agents ? (
          <p className="text-xs text-[var(--color-muted)]">loading…</p>
        ) : agents.length === 0 ? (
          <p className="text-xs text-[var(--color-muted)]">no agents yet — deploy one above</p>
        ) : (
          <ul className="space-y-2">
            {agents.map((a) => (
              <li key={a._id}>
                <Link
                  href={`/agent/${a._id}`}
                  className="flex items-center justify-between p-3 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-accent)] transition"
                >
                  <div>
                    <div className="text-sm font-medium text-[var(--color-fg)]">{a.name}</div>
                    <div className="text-[10px] text-[var(--color-muted)]">
                      reports to {a.bossEmail} · deployed {new Date(a.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <span
                    className={`text-[10px] px-2 py-1 rounded-full ${
                      a.state === 'active'
                        ? 'bg-[var(--color-ok)]/15 text-[var(--color-ok)]'
                        : 'bg-[var(--color-warn)]/15 text-[var(--color-warn)]'
                    }`}
                  >
                    {a.state}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold mb-1">Reset demo</h2>
            <p className="text-xs text-[var(--color-muted)]">
              Wipe every agent + workspace, charter, work item, skill, and mock environment row
              you&apos;ve created. Useful between demos.
            </p>
          </div>
          <button
            onClick={onReset}
            disabled={resetting || (agents?.length ?? 0) === 0}
            className="px-4 py-2 rounded-lg border border-[var(--color-danger)]/40 text-[var(--color-danger)] text-xs hover:bg-[var(--color-danger)]/10 disabled:opacity-50"
          >
            {resetting ? 'Resetting…' : 'Reset everything'}
          </button>
        </div>
      </section>
    </div>
  );
}
