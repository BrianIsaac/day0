'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from 'convex/react';
import { useUser, Show, SignInButton } from '@clerk/nextjs';
import Link from 'next/link';
import { api } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import {
  DEFAULT_AGENT_AVATAR,
  SINGAPORE_AI_BUILDER_AVATARS,
  avatarById,
  type AgentAvatarPet,
} from '@/agent/avatar-pets';

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
      <SurfaceNode cx={465} cy={190} label="spreadsheet" anchor="start" labelDx={20} labelDy={4} />
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
  const [selectedAvatarId, setSelectedAvatarId] = useState(DEFAULT_AGENT_AVATAR.id);
  const [submitting, setSubmitting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedAvatar = avatarById(selectedAvatarId);

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
      const agentId = await deploy({
        bossEmail,
        name: workerName.trim(),
        avatarId: selectedAvatar.id,
      });
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
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between mb-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight mb-2">
            Welcome{user?.firstName ? `, ${user.firstName}` : ''}.
          </h1>
          <p className="text-sm text-[var(--color-muted)]">
            Each agent runs the new-hire loop independently. Deploy as many as you like; reset wipes
            the slate clean.
          </p>
        </div>
        <AgentAvatarRail
          agents={agents ?? []}
          previewAvatar={selectedAvatar}
          previewLabel={workerName}
        />
      </div>

      <section className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-5 mb-6">
        <div className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-center">
          <AgentPixelAvatar avatar={selectedAvatar} state="deployed" label={workerName} size="lg" />
          <div>
            <h2 className="text-sm font-semibold mb-3">Deploy a new Day0 agent</h2>
            <AvatarPicker selectedId={selectedAvatarId} onSelect={setSelectedAvatarId} />
            <form onSubmit={onDeploy} className="flex flex-col gap-3 sm:flex-row">
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
          </div>
        </div>
        {error ? <p className="text-xs text-[var(--color-danger)] mt-2">{error}</p> : null}
      </section>

      <OfficeWorld agents={agents} />

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

const OFFICE_ROOMS = [
  { left: 2, top: 4, width: 39, height: 31, tone: 'ops' },
  { left: 58, top: 4, width: 40, height: 31, tone: 'briefing' },
  { left: 2, top: 41, width: 31, height: 24, tone: 'archive' },
  { left: 64, top: 41, width: 34, height: 24, tone: 'studio' },
  { left: 2, top: 72, width: 31, height: 23, tone: 'lounge' },
  { left: 43, top: 70, width: 55, height: 25, tone: 'lab' },
] as const;

const OFFICE_CORRIDORS = [
  { left: 41, top: 4, width: 17, height: 91, axis: 'vertical' },
  { left: 33, top: 51, width: 31, height: 12, axis: 'horizontal' },
  { left: 33, top: 78, width: 10, height: 11, axis: 'horizontal' },
] as const;

const OFFICE_DECOR = [
  { kind: 'server', x: 8, y: 51 },
  { kind: 'server', x: 24, y: 51 },
  { kind: 'plant', x: 7, y: 88 },
  { kind: 'plant', x: 38, y: 74 },
  { kind: 'plant', x: 94, y: 36 },
  { kind: 'console', x: 52, y: 18 },
  { kind: 'console', x: 52, y: 83 },
  { kind: 'table', x: 77, y: 53 },
  { kind: 'table', x: 18, y: 84 },
] as const;

const OFFICE_SIGNALS = [
  { x: 49, y: 12, delay: 0 },
  { x: 49, y: 34, delay: 0.8 },
  { x: 39, y: 57, delay: 1.6 },
  { x: 58, y: 57, delay: 2.2 },
  { x: 49, y: 82, delay: 1.1 },
] as const;

const OFFICE_IDLE_SPOTS = [
  { x: 49, y: 17 },
  { x: 49, y: 32 },
  { x: 48, y: 48 },
  { x: 49, y: 62 },
  { x: 39, y: 57 },
  { x: 58, y: 56 },
  { x: 38, y: 83 },
  { x: 50, y: 86 },
  { x: 74, y: 37 },
  { x: 19, y: 37 },
] as const;

type OfficePoint = {
  x: number;
  y: number;
};

const OFFICE_DESKS = [
  { x: 14, y: 17, seatX: 14, seatY: 25, variant: 'wide' },
  { x: 29, y: 17, seatX: 29, seatY: 25, variant: 'wide' },
  { x: 67, y: 17, seatX: 67, seatY: 25, variant: 'wide' },
  { x: 86, y: 17, seatX: 86, seatY: 25, variant: 'wide' },
  { x: 68, y: 31, seatX: 68, seatY: 37, variant: 'compact' },
  { x: 87, y: 31, seatX: 87, seatY: 37, variant: 'compact' },
  { x: 13, y: 50, seatX: 13, seatY: 58, variant: 'console' },
  { x: 27, y: 50, seatX: 27, seatY: 58, variant: 'console' },
  { x: 73, y: 50, seatX: 73, seatY: 58, variant: 'compact' },
  { x: 90, y: 50, seatX: 90, seatY: 58, variant: 'compact' },
  { x: 53, y: 79, seatX: 53, seatY: 87, variant: 'wide' },
  { x: 67, y: 79, seatX: 67, seatY: 87, variant: 'wide' },
  { x: 83, y: 79, seatX: 83, seatY: 87, variant: 'wide' },
  { x: 13, y: 82, seatX: 13, seatY: 90, variant: 'compact' },
  { x: 28, y: 82, seatX: 28, seatY: 90, variant: 'compact' },
  { x: 15, y: 30, seatX: 15, seatY: 36, variant: 'compact' },
  { x: 30, y: 30, seatX: 30, seatY: 36, variant: 'compact' },
  { x: 55, y: 31, seatX: 51, seatY: 33, variant: 'console' },
  { x: 55, y: 65, seatX: 50, seatY: 63, variant: 'console' },
  { x: 93, y: 83, seatX: 89, seatY: 88, variant: 'console' },
] as const;

type OfficeStyle = CSSProperties & {
  '--walk-duration'?: string;
};

function OfficeWorld({ agents }: { agents: Doc<'agents'>[] | undefined }) {
  const deskCount = Math.max(8, Math.min(OFFICE_DESKS.length, agents?.length ?? 0));
  const [agentDestinations, setAgentDestinations] = useState<Record<string, OfficePoint>>({});

  useEffect(() => {
    if (!agents?.length) {
      setAgentDestinations({});
      return;
    }

    function updateDestinations() {
      setAgentDestinations((current) => {
        const next: Record<string, OfficePoint> = {};

        for (const agent of agents ?? []) {
          if (!agentIsWorking(agent.state)) {
            next[agent._id] = randomOfficePoint(current[agent._id]);
          }
        }

        return next;
      });
    }

    updateDestinations();
    const timer = window.setInterval(updateDestinations, 3400);
    return () => window.clearInterval(timer);
  }, [agents]);

  return (
    <section className="mb-6 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-card)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4">
        <h2 className="text-sm font-semibold">Mini office world</h2>
        <span className="text-[10px] text-[var(--color-muted)]">{agents?.length ?? 0} total</span>
      </div>

      {!agents ? (
        <p className="px-5 py-8 text-xs text-[var(--color-muted)]">loading...</p>
      ) : agents.length === 0 ? (
        <p className="px-5 py-8 text-xs text-[var(--color-muted)]">
          no agents yet - deploy one above
        </p>
      ) : (
        <div className="day0-pixel-office relative min-h-[560px] overflow-hidden">
          {OFFICE_ROOMS.map((room) => (
            <OfficeRoom key={`${room.left}-${room.top}`} room={room} />
          ))}

          {OFFICE_CORRIDORS.map((corridor) => (
            <OfficeCorridor key={`${corridor.left}-${corridor.top}`} corridor={corridor} />
          ))}

          {OFFICE_DECOR.map((decor, index) => (
            <OfficeDecor key={`${decor.kind}-${decor.x}-${decor.y}-${index}`} decor={decor} />
          ))}

          {OFFICE_SIGNALS.map((signal) => (
            <OfficeSignal key={`${signal.x}-${signal.y}`} signal={signal} />
          ))}

          {OFFICE_DESKS.slice(0, deskCount).map((desk, index) => (
            <OfficeDesk key={`${desk.x}-${desk.y}-${index}`} desk={desk} />
          ))}

          {agents.map((agent, index) => (
            <OfficeAgent
              key={agent._id}
              agent={agent}
              destination={agentDestinations[agent._id]}
              index={index}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function OfficeRoom({ room }: { room: (typeof OFFICE_ROOMS)[number] }) {
  return (
    <div
      className={`day0-pixel-room day0-pixel-room-${room.tone} absolute`}
      style={rectStyle(room)}
      aria-hidden="true"
    />
  );
}

function OfficeCorridor({ corridor }: { corridor: (typeof OFFICE_CORRIDORS)[number] }) {
  return (
    <div
      className={`day0-pixel-corridor day0-pixel-corridor-${corridor.axis} absolute`}
      style={rectStyle(corridor)}
      aria-hidden="true"
    />
  );
}

function OfficeDecor({ decor }: { decor: (typeof OFFICE_DECOR)[number] }) {
  return (
    <div
      className={`day0-pixel-decor day0-pixel-${decor.kind} absolute -translate-x-1/2 -translate-y-1/2`}
      style={{ left: `${decor.x}%`, top: `${decor.y}%` }}
      aria-hidden="true"
    />
  );
}

function OfficeSignal({ signal }: { signal: (typeof OFFICE_SIGNALS)[number] }) {
  return (
    <div
      className="day0-pixel-signal absolute"
      style={{
        left: `${signal.x}%`,
        top: `${signal.y}%`,
        animationDelay: `${signal.delay}s`,
      }}
      aria-hidden="true"
    />
  );
}

function OfficeDesk({ desk }: { desk: (typeof OFFICE_DESKS)[number] }) {
  return (
    <>
      <div
        className={`day0-pixel-chair day0-pixel-chair-${desk.variant} absolute -translate-x-1/2 -translate-y-1/2`}
        style={{ left: `${desk.seatX}%`, top: `${desk.seatY}%` }}
        aria-hidden="true"
      />
      <div
        className={`day0-pixel-desk day0-pixel-desk-${desk.variant} absolute -translate-x-1/2 -translate-y-1/2`}
        style={{ left: `${desk.x}%`, top: `${desk.y}%` }}
        aria-hidden="true"
      >
        <div className="day0-pixel-monitor absolute left-3 right-3 top-2 h-4">
          <span className="absolute left-2 top-1 h-1 w-8 bg-[var(--color-accent)]/70" />
        </div>
        <div className="day0-pixel-keyboard absolute bottom-2 left-4 h-3 w-7" />
        <div className="day0-pixel-notepad absolute bottom-2 right-4 h-3 w-5" />
      </div>
    </>
  );
}

function rectStyle(rect: { left: number; top: number; width: number; height: number }) {
  return {
    left: `${rect.left}%`,
    top: `${rect.top}%`,
    width: `${rect.width}%`,
    height: `${rect.height}%`,
  };
}

function OfficeAgent({
  agent,
  destination,
  index,
}: {
  agent: Doc<'agents'>;
  destination: OfficePoint | undefined;
  index: number;
}) {
  const working = agentIsWorking(agent.state);
  const desk = OFFICE_DESKS[index % OFFICE_DESKS.length];
  const seed = hashString(`${agent._id}:${agent.name}`);
  const idleSpot = OFFICE_IDLE_SPOTS[seed % OFFICE_IDLE_SPOTS.length];
  const idleX = destination?.x ?? clamp(idleSpot.x + ((seed >> 5) % 13) - 6, 8, 92);
  const idleY = destination?.y ?? clamp(idleSpot.y + ((seed >> 11) % 11) - 5, 12, 90);
  const x = working ? desk.seatX : idleX;
  const y = working ? desk.seatY : idleY;
  const style: OfficeStyle = {
    left: `${x}%`,
    top: `${y}%`,
    '--walk-duration': `${2700 + (seed % 700)}ms`,
  };

  return (
    <Link
      href={`/agent/${agent._id}`}
      className={`day0-office-agent absolute z-10 -translate-x-1/2 -translate-y-1/2 outline-none ${
        working ? 'day0-office-agent-seated' : 'day0-office-agent-walking'
      }`}
      style={style}
      title={`${agent.name} - ${working ? 'at desk' : 'roaming'}`}
    >
      <div className={working ? 'day0-office-agent-working' : 'day0-office-agent-roaming'}>
        <AgentPixelAvatar
          avatar={avatarById(agent.avatarId)}
          state={agent.state}
          label={agent.name}
        />
        <div className="day0-pixel-nameplate mt-1 max-w-28 truncate px-2 py-1 text-center text-[10px] text-[var(--color-fg)]">
          {agent.name}
        </div>
      </div>
    </Link>
  );
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function randomOfficePoint(previous: OfficePoint | undefined): OfficePoint {
  const candidates = previous
    ? OFFICE_IDLE_SPOTS.filter(
        (spot) => Math.abs(spot.x - previous.x) + Math.abs(spot.y - previous.y) > 18,
      )
    : OFFICE_IDLE_SPOTS;
  const spot = candidates[Math.floor(Math.random() * candidates.length)] ?? OFFICE_IDLE_SPOTS[0];
  const jitterX = Math.floor(Math.random() * 13) - 6;
  const jitterY = Math.floor(Math.random() * 11) - 5;

  return {
    x: clamp(spot.x + jitterX, 8, 92),
    y: clamp(spot.y + jitterY, 12, 90),
  };
}

function agentIsWorking(state: Doc<'agents'>['state']) {
  return state === 'day-one-in-progress';
}

function AvatarPicker({
  selectedId,
  onSelect,
}: {
  selectedId: string;
  onSelect: (avatarId: string) => void;
}) {
  return (
    <div className="mb-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-[var(--color-muted)]">
          Choose avatar
        </span>
        <span className="text-[10px] text-[var(--color-muted)]">Singaporean AI Builders - 29</span>
      </div>
      <div className="grid max-h-40 grid-cols-6 gap-1 overflow-y-auto pr-1 sm:grid-cols-10">
        {SINGAPORE_AI_BUILDER_AVATARS.map((avatar) => {
          const selected = avatar.id === selectedId;
          return (
            <button
              key={avatar.id}
              type="button"
              onClick={() => onSelect(avatar.id)}
              title={`${avatar.name} ${avatar.handle}`}
              className={`grid h-12 w-full place-items-center rounded-md border bg-[var(--color-bg)] transition ${
                selected
                  ? 'border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]'
                  : 'border-[var(--color-border)] hover:border-[var(--color-muted)]'
              }`}
            >
              <PixelAvatarSprite avatar={avatar} className="h-10 w-10" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AgentAvatarRail({
  agents,
  previewAvatar,
  previewLabel,
}: {
  agents: Doc<'agents'>[];
  previewAvatar: AgentAvatarPet;
  previewLabel: string;
}) {
  const shownAgents = agents.slice(0, 5);
  const hasAgents = shownAgents.length > 0;

  return (
    <div className="flex min-h-14 items-center justify-start -space-x-2 sm:justify-end">
      {hasAgents ? (
        shownAgents.map((agent) => (
          <AgentPixelAvatar
            key={agent._id}
            avatar={avatarById(agent.avatarId)}
            state={agent.state}
            label={agent.name}
            compact
          />
        ))
      ) : (
        <AgentPixelAvatar avatar={previewAvatar} state="deployed" label={previewLabel} compact />
      )}
    </div>
  );
}

function AgentPixelAvatar({
  avatar,
  state,
  label,
  size = 'md',
  compact = false,
}: {
  avatar: AgentAvatarPet;
  state: Doc<'agents'>['state'];
  label: string;
  size?: 'md' | 'lg';
  compact?: boolean;
}) {
  const sizeClass = size === 'lg' ? 'h-24 w-24' : 'h-14 w-14';
  const tone = agentStateTone(state);

  return (
    <div
      className={`relative grid shrink-0 place-items-center overflow-hidden rounded-sm border p-1 ${tone.border} ${tone.bg} ${
        compact ? 'shadow-[0_0_0_2px_var(--color-bg)]' : ''
      }`}
      title={`${label} - ${avatar.name} ${avatar.handle}`}
    >
      <div className={`${sizeClass} overflow-hidden rounded-sm bg-[var(--color-bg)]`}>
        <PixelAvatarSprite avatar={avatar} className="h-full w-full" />
      </div>
      <span
        className={`absolute bottom-1 right-1 h-2.5 w-2.5 rounded-[1px] border border-[var(--color-card)] ${tone.dot}`}
        aria-label={state}
      />
    </div>
  );
}

function PixelAvatarSprite({ avatar, className }: { avatar: AgentAvatarPet; className: string }) {
  return (
    <span
      aria-hidden="true"
      className={`block bg-center bg-no-repeat [image-rendering:pixelated] ${className}`}
      style={{
        backgroundImage: `url("${avatar.src}")`,
        backgroundSize: 'contain',
      }}
    />
  );
}

function agentStateTone(state: Doc<'agents'>['state']) {
  if (state === 'active') {
    return {
      bg: 'bg-[var(--color-ok)]/10',
      border: 'border-[var(--color-ok)]/35',
      dot: 'bg-[var(--color-ok)]',
    };
  }
  if (state === 'day-one-in-progress') {
    return {
      bg: 'bg-[var(--color-accent)]/10',
      border: 'border-[var(--color-accent)]/35',
      dot: 'bg-[var(--color-accent)]',
    };
  }
  return {
    bg: 'bg-[var(--color-warn)]/10',
    border: 'border-[var(--color-warn)]/35',
    dot: 'bg-[var(--color-warn)]',
  };
}
