'use client';

import {
  Fragment,
  useEffect,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useUser } from '@clerk/nextjs';
import Link from 'next/link';
import { api } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import {
  DEFAULT_AGENT_AVATAR,
  SINGAPORE_AI_BUILDER_AVATARS,
  avatarById,
  type AgentAvatarPet,
} from '@/agent/avatar-pets';
import { DEV_BOSS_EMAIL, DEV_BOSS_FIRST_NAME, DEV_NO_AUTH } from '@/lib/dev-auth';
import { deploymentZone } from '@/lib/zone';
import { CompanySupervision } from './CompanySupervision';
import { CursorToggle } from './CursorToggle';
import { PageMotion } from './PageMotion';
import { errorMessage } from '@/lib/errors';

/** Whoever the dashboard is acting for - a Clerk user, or the local dev boss. */
interface Boss {
  email: string | undefined;
  firstName: string | undefined;
}

/** One employee as `agents.rosterForUser` returns it. */
type RosterRow = FunctionReturnType<typeof api.agents.rosterForUser>[number];

export default function LandingPage() {
  return (
    <main className="min-h-[calc(100vh-3.25rem)] flex flex-col">
      <CursorToggle />
      {DEV_NO_AUTH ? (
        <SignedInDashboard boss={{ email: DEV_BOSS_EMAIL, firstName: DEV_BOSS_FIRST_NAME }} />
      ) : (
        <ClerkLanding />
      )}
    </main>
  );
}

function ClerkLanding() {
  const { user } = useUser();
  if (!user) return <SignedOutHero />;
  return (
    <SignedInDashboard
      boss={{
        email: user?.primaryEmailAddress?.emailAddress,
        firstName: user?.firstName ?? undefined,
      }}
    />
  );
}

function SignedOutHero() {
  return (
    <PageMotion className="day0-public-motion flex-1 flex flex-col">
      <section className="px-6 pt-16 lg:pt-24 pb-16 max-w-6xl mx-auto w-full">
        <div className="grid lg:grid-cols-[1.15fr_1fr] gap-12 lg:gap-16 items-center">
          <div>
            <p
              data-enter="0"
              className="text-[11px] uppercase tracking-[0.28em] text-[var(--color-accent)] mb-5"
            >
              Day0 · autonomous teammate
            </p>
            <h1
              data-enter="1"
              className="text-4xl sm:text-5xl lg:text-6xl font-semibold tracking-tight leading-[1.05] mb-6"
            >
              Enterprise digital employees{' '}
              <span className="text-[var(--color-muted)]">that just work.</span>
            </h1>
            <p
              data-enter="2"
              className="text-lg text-[var(--color-muted)] mb-10 leading-relaxed max-w-xl"
            >
              One name in. Everything else is learned state. The agent runs its own Day-1 1:1 with
              its boss, drafts a charter for approval, then claims work under your eye - proposing
              new skills when it hits a gap, and authoring them in a sandbox.
            </p>
            <div data-enter="3" className="flex flex-wrap items-center gap-3">
              {/* The hosted mock office is the signed-in landing page, so the
                  demo starts at sign-in and Clerk's fallback redirect returns
                  the visitor here as the boss. In no-auth dev mode the sign-in
                  route redirects straight to the dashboard. */}
              <Link
                href="/sign-in"
                aria-describedby="demo-cta-help"
                className="px-6 py-3 rounded-lg border border-transparent bg-[var(--color-accent)] text-[var(--color-bg)] font-medium text-sm hover:opacity-90 transition"
              >
                Try the demo
              </Link>
              <Link
                href="/setup"
                className="px-6 py-3 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-accent)] text-sm transition"
              >
                Set up Day0
              </Link>
            </div>
            <p data-enter="3" id="demo-cta-help" className="mt-3 text-sm text-[var(--color-muted)]">
              Sign in, deploy an agent into the mock office, and hold its Day-1 1:1 yourself.
            </p>
            <p data-enter="3" className="mt-5 text-xs text-[var(--color-muted)]">
              <a
                href="https://github.com/BrianIsaac/day0"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-4 hover:text-[var(--color-accent)]"
              >
                Source
              </a>
            </p>
          </div>
          <div data-enter="4" className="relative order-first lg:order-last">
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
              body="The conversation becomes a charter for the boss to review and approve."
            />
            <LoopStep
              n="03"
              title="Work loop"
              body="A seven-criterion evaluator gates every candidate. Plans drafted, work boss-approved, output landed."
            />
            <LoopStep
              n="04"
              title="Skill creation"
              body="When the agent hits a gap it proposes a skill - authored in a sandbox, smoke-tested, and registered."
            />
          </ol>
          <div
            data-reveal=""
            className="mt-10 flex flex-wrap items-center justify-center gap-x-4 gap-y-3 text-sm text-[var(--color-muted)]"
          >
            <span>Rather see a whole run before you sign in?</span>
            <Link
              href="/demo"
              className="px-4 py-2 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-accent)] text-sm text-[var(--color-fg)] transition"
            >
              Watch the recorded walkthrough
            </Link>
          </div>
        </div>
      </section>

      <footer className="px-6 py-10 border-t border-[var(--color-border)] mt-auto">
        <p className="text-xs text-[var(--color-muted)] text-center">
          Run Day0 with a compatible model provider or your own model server.
        </p>
      </footer>
    </PageMotion>
  );
}

function LoopStep({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <li
      data-reveal=""
      style={{ '--reveal-delay': `${(Number(n) - 1) * 80}ms` } as CSSProperties}
      className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-5 hover:border-[var(--color-accent)]/40 transition"
    >
      <div className="text-[10px] tracking-[0.2em] text-[var(--color-accent)] mb-3">{n}</div>
      <div className="text-sm font-semibold mb-2">{title}</div>
      <p className="text-xs text-[var(--color-muted)] leading-relaxed">{body}</p>
    </li>
  );
}

const ORBIT_SURFACES = [
  { cx: 300, cy: 110, label: 'docs', anchor: 'middle', labelDx: 0, labelDy: -22 },
  { cx: 465, cy: 190, label: 'spreadsheet', anchor: 'start', labelDx: 20, labelDy: 4 },
  { cx: 500, cy: 380, label: 'slack', anchor: 'start', labelDx: 20, labelDy: 4 },
  { cx: 180, cy: 455, label: 'tickets', anchor: 'end', labelDx: -20, labelDy: 4 },
  { cx: 115, cy: 265, label: 'twitter', anchor: 'end', labelDx: -20, labelDy: 4 },
] as const;

// HTML wrappers let the browser composite motion without relaying out SVG geometry.
function OrbitLayer({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={`absolute inset-0 ${className ?? ''}`} style={style}>
      <svg viewBox="0 0 600 600" className="w-full h-full" aria-hidden="true">
        {children}
      </svg>
    </div>
  );
}

function SurfaceOrbitSvg() {
  return (
    <div
      className="relative aspect-square w-full max-w-md mx-auto overflow-hidden pointer-events-none"
      role="img"
      aria-label="Day0 agent at the centre of mock work surfaces: docs, spreadsheet, slack, tickets, twitter."
    >
      <OrbitLayer className="day0-surface-glow">
        <defs>
          <radialGradient id="agent-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.22" />
            <stop offset="55%" stopColor="#22d3ee" stopOpacity="0.04" />
            <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="300" cy="300" r="290" fill="url(#agent-glow)" />
      </OrbitLayer>
      <OrbitLayer className="day0-surface-orbit">
        <circle
          cx="300"
          cy="300"
          r="240"
          fill="none"
          stroke="#22d3ee"
          strokeOpacity="0.18"
          strokeWidth="1"
          strokeDasharray="3 12"
        />
      </OrbitLayer>
      <OrbitLayer className="day0-surface-orbit day0-surface-orbit-inner">
        <circle
          cx="300"
          cy="300"
          r="170"
          fill="none"
          stroke="#22d3ee"
          strokeOpacity="0.1"
          strokeWidth="1"
          strokeDasharray="80 14 2 14"
        />
      </OrbitLayer>
      {ORBIT_SURFACES.map(({ cx, cy, ...label }, index) => (
        <div
          key={label.label}
          style={{ '--surface-delay': `${0.6 + index * 0.45}s` } as CSSProperties}
        >
          <OrbitLayer className="day0-surface-link">
            <line
              x1="300"
              y1="300"
              x2={cx}
              y2={cy}
              stroke="#22d3ee"
              strokeOpacity="0.25"
              strokeWidth="0.75"
              strokeDasharray="2 5"
            />
          </OrbitLayer>
          <OrbitLayer className="day0-surface-node">
            <SurfaceNode cx={cx} cy={cy} {...label} />
          </OrbitLayer>
        </div>
      ))}
      <OrbitLayer>
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
      </OrbitLayer>
      <OrbitLayer className="day0-surface-pulse">
        <circle
          cx="300"
          cy="300"
          r="22"
          fill="#22d3ee"
          fillOpacity="0.18"
          stroke="#22d3ee"
          strokeOpacity="0.55"
          strokeWidth="1"
        />
      </OrbitLayer>
      {ORBIT_SURFACES.map(({ cx, cy, label }, index) => (
        <OrbitLayer
          key={label}
          className={`day0-surface-packet${index === 0 ? ' day0-surface-packet-held' : ''}`}
          style={
            {
              '--packet-delay': `${4 + index * 2.4}s`,
              '--packet-x': `${(cx - 300) / 6}%`,
              '--packet-y': `${(cy - 300) / 6}%`,
            } as CSSProperties
          }
        >
          <circle cx="300" cy="300" r="3" fill="#a5f3fc" />
        </OrbitLayer>
      ))}
    </div>
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

// The signed-in half lives in app/home/; the cockpit moves this import to the top at the wave 5 landing.
import { SignedInDashboard } from './home/SignedInDashboard';
