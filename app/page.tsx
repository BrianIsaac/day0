'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from 'convex/react';
import { useUser, Show, SignInButton } from '@clerk/nextjs';
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
    <div className="flex-1 flex flex-col">
      <section className="px-6 pt-16 lg:pt-24 pb-16 max-w-6xl mx-auto w-full">
        <div className="grid lg:grid-cols-[1.15fr_1fr] gap-12 lg:gap-16 items-center">
          <div>
            <p className="text-[11px] uppercase tracking-[0.28em] text-[var(--color-accent)] mb-5">
              Day0 · autonomous teammate
            </p>
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-semibold tracking-tight leading-[1.05] mb-6">
              Enterprise Digital Employees{' '}
              <span className="text-[var(--color-muted)]">that just works.</span>
            </h1>
            <p className="text-lg text-[var(--color-muted)] mb-10 leading-relaxed max-w-xl">
              One name in. Everything else is learned state. The agent runs its own Day-1 1:1 with
              its boss, drafts a charter for approval, then claims work under your eye — proposing
              new skills when it hits a gap, and authoring them in a sandbox.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <SignInButton mode="modal">
                <button className="px-6 py-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-bg)] font-medium text-sm hover:opacity-90 transition">
                  Deploy your first agent
                </button>
              </SignInButton>
              <a
                href="https://github.com/BrianIsaac/day0"
                target="_blank"
                rel="noopener noreferrer"
                className="px-6 py-3 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-accent)] text-sm transition"
              >
                View source
              </a>
            </div>
          </div>
          <div className="relative order-first lg:order-last">
            <SurfaceOrbitSvg />
          </div>
        </div>
      </section>

      <section className="px-6 py-14 border-t border-[var(--color-border)]">
        <div className="max-w-6xl mx-auto w-full">
          <p className="text-[11px] uppercase tracking-[0.28em] text-[var(--color-muted)] mb-8 text-center">
            The new-hire loop
          </p>
          <ol className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <LoopStep
              n="01"
              title="Day-1 1:1"
              body="Voice or chat. The agent walks the boss through seven topics in one sitting."
            />
            <LoopStep
              n="02"
              title="Charter"
              body="GPT-5.5 distils the conversation into a typed charter. Boss approves before anything ships."
            />
            <LoopStep
              n="03"
              title="Work loop"
              body="A seven-criterion evaluator gates every candidate. Plans drafted, work boss-approved, output landed."
            />
            <LoopStep
              n="04"
              title="Skill creation"
              body="When the agent hits a gap it proposes a skill — authored in a Daytona sandbox, smoke-tested, and registered."
            />
          </ol>
        </div>
      </section>

      <footer className="px-6 py-10 border-t border-[var(--color-border)] mt-auto">
        <p className="text-xs text-[var(--color-muted)] text-center">
          Built on OpenAI GPT-5.5 · ElevenLabs Conversational AI · Convex · Mastra · Exa · Daytona ·
          Vercel · Cloudflare · Clerk
        </p>
      </footer>
    </div>
  );
}

function LoopStep({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <li className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-5 hover:border-[var(--color-accent)]/40 transition">
      <div className="text-[10px] tracking-[0.2em] text-[var(--color-accent)] mb-3">{n}</div>
      <div className="text-sm font-semibold mb-2">{title}</div>
      <p className="text-xs text-[var(--color-muted)] leading-relaxed">{body}</p>
    </li>
  );
}

function SurfaceOrbitSvg() {
  return (
    <svg
      viewBox="0 0 600 600"
      xmlns="http://www.w3.org/2000/svg"
      className="w-full h-auto max-w-md mx-auto"
      role="img"
      aria-label="Day0 agent at the centre of mock work surfaces: docs, spreadsheet, slack, tickets, twitter."
    >
      <defs>
        <radialGradient id="agent-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.22" />
          <stop offset="55%" stopColor="#22d3ee" stopOpacity="0.04" />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
        </radialGradient>
      </defs>

      <circle cx="300" cy="300" r="290" fill="url(#agent-glow)" />

      <circle
        cx="300"
        cy="300"
        r="240"
        fill="none"
        stroke="#22d3ee"
        strokeOpacity="0.18"
        strokeWidth="1"
        strokeDasharray="3 12"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 300 300"
          to="360 300 300"
          dur="60s"
          repeatCount="indefinite"
        />
      </circle>

      <circle
        cx="300"
        cy="300"
        r="170"
        fill="none"
        stroke="#22d3ee"
        strokeOpacity="0.1"
        strokeWidth="1"
      />

      <g stroke="#22d3ee" strokeOpacity="0.25" strokeWidth="0.75" strokeDasharray="2 5">
        <line x1="300" y1="300" x2="300" y2="110" />
        <line x1="300" y1="300" x2="465" y2="190" />
        <line x1="300" y1="300" x2="500" y2="380" />
        <line x1="300" y1="300" x2="180" y2="455" />
        <line x1="300" y1="300" x2="115" y2="265" />
      </g>

      <SurfaceNode cx={300} cy={110} label="docs" anchor="middle" labelDx={0} labelDy={-22} />
      <SurfaceNode
        cx={465}
        cy={190}
        label="spreadsheet"
        anchor="start"
        labelDx={20}
        labelDy={4}
      />
      <SurfaceNode cx={500} cy={380} label="slack" anchor="start" labelDx={20} labelDy={4} />
      <SurfaceNode cx={180} cy={455} label="tickets" anchor="end" labelDx={-20} labelDy={4} />
      <SurfaceNode cx={115} cy={265} label="twitter" anchor="end" labelDx={-20} labelDy={4} />

      <circle
        cx="300"
        cy="300"
        r="48"
        fill="#22d3ee"
        fillOpacity="0.06"
        stroke="#22d3ee"
        strokeOpacity="0.3"
        strokeWidth="1"
      />
      <circle
        cx="300"
        cy="300"
        r="22"
        fill="#22d3ee"
        fillOpacity="0.18"
        stroke="#22d3ee"
        strokeOpacity="0.55"
        strokeWidth="1"
      >
        <animate attributeName="r" values="20;26;20" dur="3.2s" repeatCount="indefinite" />
        <animate
          attributeName="fill-opacity"
          values="0.18;0.32;0.18"
          dur="3.2s"
          repeatCount="indefinite"
        />
      </circle>
      <circle cx="300" cy="300" r="6" fill="#22d3ee" />
      <text
        x="300"
        y="338"
        textAnchor="middle"
        fill="#22d3ee"
        fillOpacity="0.75"
        fontSize="10"
        fontFamily="ui-sans-serif, system-ui"
        letterSpacing="3"
      >
        DAY0
      </text>
    </svg>
  );
}

function SurfaceNode({
  cx,
  cy,
  label,
  anchor,
  labelDx,
  labelDy,
}: {
  cx: number;
  cy: number;
  label: string;
  anchor: 'start' | 'middle' | 'end';
  labelDx: number;
  labelDy: number;
}) {
  return (
    <g>
      <circle
        cx={cx}
        cy={cy}
        r="16"
        fill="#0a0a0b"
        stroke="#22d3ee"
        strokeOpacity="0.4"
        strokeWidth="1"
      />
      <circle cx={cx} cy={cy} r="5" fill="#22d3ee" fillOpacity="0.7" />
      <text
        x={cx + labelDx}
        y={cy + labelDy}
        textAnchor={anchor}
        fill="#a1a1aa"
        fontSize="11"
        fontFamily="ui-sans-serif, system-ui"
        letterSpacing="0.5"
      >
        {label}
      </text>
    </g>
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
