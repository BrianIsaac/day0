import type { Metadata } from 'next';
import Link from 'next/link';

import {
  DATA_LOCATION,
  DETAILED_SECTIONS,
  FIRST_SUCCESS,
  MEASURED_TIMINGS,
  MODEL_ROUTES,
  PREREQUISITES,
  PUBLISHED_PORTS,
  QUICKSTART_COMMANDS,
  REPOSITORY_URL,
  STOP_AND_RESTART,
  TIMING_CAVEAT,
  TRAPS,
} from '@/setup/quickstart';

export const metadata: Metadata = {
  title: 'Set up Day0',
  description:
    'Run Day0 on your own machine: what you need, the five commands, what a first success looks like, and what to do when it stops.',
};

/**
 * The setup guide, static and signed out.
 *
 * A visitor arrives here from the landing page having never run the product,
 * and this page may be the only instruction they read, so it carries the whole
 * path rather than a pointer to one: prerequisites, the choice the command will
 * ask them to make, the commands, what success looks like, what was measured,
 * the two traps a rehearsal found, and how to stop.
 *
 * It collects nothing. There is no form, no field and no control anywhere on
 * it: the one secret this setup needs is asked for by the command, in a hidden
 * terminal prompt on the reader's own machine, and never by a web page.
 * Everything it renders comes from `src/setup/quickstart.ts`, which the README
 * quick starts are tested against, so the page and both READMEs cannot drift.
 */

/** The revision this page describes, when the build knows one. */
const REVISION = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.NEXT_PUBLIC_SOURCE_REVISION;

const SECTIONS = [
  { id: 'before', title: 'Before you start' },
  { id: 'model', title: 'How it reaches a model' },
  { id: 'commands', title: 'The commands' },
  { id: 'success', title: 'What first success looks like' },
  { id: 'time', title: 'How long it takes' },
  { id: 'stops', title: 'If it stops' },
  { id: 'stop-restart', title: 'Stopping and starting again' },
  { id: 'detail', title: 'Where the detail is' },
] as const;

function Section({
  id,
  index,
  title,
  lede,
  children,
}: {
  id: string;
  index: number;
  title: string;
  lede?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20">
      <div className="flex items-baseline gap-3 mb-3">
        <span className="font-mono text-[11px] text-[var(--color-muted)]">
          {String(index).padStart(2, '0')}
        </span>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      </div>
      {lede ? (
        <p className="text-sm text-[var(--color-muted)] leading-relaxed mb-4">{lede}</p>
      ) : null}
      {children}
    </section>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-4">
      {children}
    </div>
  );
}

/** One thing to type, or one thing the machine must already have. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <li className="flex flex-col sm:flex-row sm:gap-4">
      <span className="text-sm font-medium sm:w-52 sm:shrink-0">{label}</span>
      <span className="text-sm text-[var(--color-muted)] leading-relaxed">{children}</span>
    </li>
  );
}

export default function SetupPage() {
  return (
    <main className="min-h-[calc(100vh-3.25rem)] px-6 py-12 max-w-3xl mx-auto w-full">
      <header className="mb-10">
        <p className="text-[11px] uppercase tracking-[0.28em] text-[var(--color-accent)] mb-4">
          Set up Day0
        </p>
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight leading-tight mb-5">
          Run Day0 on your own machine.
        </h1>
        <p className="text-base text-[var(--color-muted)] leading-relaxed mb-4">
          The same product this demo records, running locally: a self-hosted backend, a seeded mock
          office to work in, and a sandbox that verifies the skills the agent writes. Nothing it
          does leaves your machine, and the office it works in is synthetic, so a first run reads
          nothing of yours.
        </p>
        <div
          role="note"
          className="rounded-xl border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 p-4"
        >
          <p className="text-sm leading-relaxed">
            This page asks you for nothing. It has no form and no field: the one secret the setup
            needs is typed into a hidden prompt in your own terminal, and it stays in a file beside
            your checkout.
          </p>
        </div>
      </header>

      <nav aria-label="Sections of this guide" className="mb-12">
        <ol className="flex flex-wrap gap-2">
          {SECTIONS.map((section, index) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-xs hover:border-[var(--color-accent)]"
              >
                <span className="font-mono text-[10px] text-[var(--color-muted)]">
                  {String(index + 1).padStart(2, '0')}
                </span>
                {section.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="space-y-12">
        <Section
          id="before"
          index={1}
          title="Before you start"
          lede="Three tools, and some room on five ports. The setup command checks every one of them before it starts a single service, and names the missing one rather than failing later."
        >
          <Panel>
            <ul className="space-y-3">
              {PREREQUISITES.map((item) => (
                <Row key={item.name} label={item.name}>
                  {item.detail}
                  {item.fix ? (
                    <code className="font-mono text-xs text-[var(--color-accent)] block mt-1.5">
                      {item.fix}
                    </code>
                  ) : null}
                </Row>
              ))}
            </ul>
          </Panel>
          <p className="text-sm text-[var(--color-muted)] leading-relaxed mt-4 mb-3">
            The ports a default installation publishes on your machine:
          </p>
          <Panel>
            <ul className="space-y-2">
              {PUBLISHED_PORTS.map((port) => (
                <li key={port.port} className="flex gap-4">
                  <span className="font-mono text-sm text-[var(--color-accent)] w-16 shrink-0">
                    {port.port}
                  </span>
                  <span className="text-sm text-[var(--color-muted)] leading-relaxed">
                    {port.what}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
          <p className="text-sm text-[var(--color-muted)] leading-relaxed mt-4">
            Any of them can move:{' '}
            <code className="font-mono text-[var(--color-fg)]">
              pnpm setup:local --port 4210 --site-port 4211 --dashboard-port 4791
            </code>
            . Two installations on one machine need different ports and different Compose project
            names, and the command refuses to attach a new installation to another one&rsquo;s data.
          </p>
        </Section>

        <Section
          id="model"
          index={2}
          title="How it reaches a model"
          lede="Every step of the loop is a model call, so this is the one question the setup command asks. Both answers run the whole loop; they differ over who runs the model."
        >
          <div className="space-y-3">
            {MODEL_ROUTES.map((route) => (
              <Panel key={route.id}>
                <h3 className="text-sm font-semibold tracking-tight mb-2">{route.title}</h3>
                <p className="text-sm text-[var(--color-muted)] leading-relaxed mb-2">
                  {route.needs}
                </p>
                <p className="text-sm text-[var(--color-muted)] leading-relaxed mb-3">
                  {route.gives}
                </p>
                <code className="font-mono text-xs text-[var(--color-accent)]">{route.flag}</code>
              </Panel>
            ))}
          </div>
          <p className="text-sm text-[var(--color-muted)] leading-relaxed mt-4">
            A third answer exists for a reader who already runs a compatible endpoint of their own:{' '}
            <code className="font-mono text-[var(--color-fg)]">
              pnpm setup:local --route endpoint --endpoint https://your-server/v1
            </code>
            . It writes the address you give it and nothing more.
          </p>
        </Section>

        <Section
          id="commands"
          index={3}
          title="The commands"
          lede="Five, from an empty directory. The fourth is the one that does the work; run it again whenever you want, because it keeps what is already there rather than starting over."
        >
          <pre className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-4 overflow-x-auto">
            <code className="font-mono text-sm leading-relaxed">
              {QUICKSTART_COMMANDS.map((command) => (
                <span key={command} className="block">
                  {command}
                </span>
              ))}
            </code>
          </pre>
          <p className="text-sm text-[var(--color-muted)] leading-relaxed mt-4">
            The fourth command asks how it should reach a model and, if the answer is a key you
            have, for that key in a hidden prompt. Then it starts the backend, the sandbox and, on
            the account-free route, the model server; writes the values it generates into{' '}
            <code className="font-mono text-[var(--color-fg)]">.env.local</code> instead of asking
            you to paste them; pushes the backend functions; and finishes by running{' '}
            <code className="font-mono text-[var(--color-fg)]">pnpm check:setup</code> and printing
            the unlock URL. If it stops, it says which step stopped and what to run next. It never
            deletes a volume to recover.
          </p>
        </Section>

        <Section
          id="success"
          index={4}
          title="What first success looks like"
          lede="Four things, in this order. The setup command prints the same four when it finishes."
        >
          <ol className="space-y-4 mb-6">
            {FIRST_SUCCESS.map((step, index) => (
              <li key={step.action} className="flex gap-4">
                <span className="font-mono text-xs text-[var(--color-accent)] pt-0.5">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span>
                  <span className="text-sm font-medium block mb-1">{step.action}</span>
                  <span className="text-sm text-[var(--color-muted)] leading-relaxed">
                    {step.detail}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          <figure>
            {/* eslint-disable-next-line @next/next/no-img-element -- this page is
                prerendered and must serve its own bytes; the optimiser would put
                a server request in front of the one picture a stuck reader needs. */}
            <img
              src="/setup/first-success-day-one-chat.webp"
              width={817}
              height={447}
              alt="The Day-1 one-to-one in chat mode, the agent opening the conversation by asking what triggered the decision to bring it on and what the team is trying to make easier"
              className="rounded-xl border border-[var(--color-border)] w-full h-auto"
            />
            <figcaption className="text-xs text-[var(--color-muted)] mt-2 leading-relaxed">
              Step three, as it arrives: the agent opens the one-to-one itself. Captured locally on
              a run of this repository.
            </figcaption>
          </figure>
        </Section>

        <Section
          id="time"
          index={5}
          title="How long it takes"
          lede="Measured on one machine, from a clean clone with nothing copied into it. Each figure says what it does not include."
        >
          <Panel>
            <ul className="space-y-3">
              {MEASURED_TIMINGS.map((timing) => (
                <li key={timing.phase} className="flex flex-col sm:flex-row sm:gap-4">
                  <span className="font-mono text-sm sm:w-64 sm:shrink-0">{timing.phase}</span>
                  <span className="text-sm">
                    <span className="text-[var(--color-accent)] font-mono">{timing.measured}</span>
                    <span className="text-[var(--color-muted)] leading-relaxed">
                      {' '}
                      {timing.excludes}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
          <div
            role="note"
            className="rounded-xl border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 p-4 mt-4"
          >
            <p className="text-sm leading-relaxed">{TIMING_CAVEAT}</p>
          </div>
        </Section>

        <Section
          id="stops"
          index={6}
          title="If it stops"
          lede="Run pnpm check:setup. It reads .env.local and reports the backend, the auth mode, the model, the sandbox and voice separately, failing only on what is actually broken rather than on what is merely absent. These two are the ones that have cost someone an afternoon."
        >
          <div className="space-y-3">
            {TRAPS.map((trap) => (
              <Panel key={trap.title}>
                <h3 className="text-sm font-semibold tracking-tight mb-2">{trap.title}</h3>
                <p className="text-sm text-[var(--color-muted)] leading-relaxed">{trap.body}</p>
              </Panel>
            ))}
          </div>
        </Section>

        <Section id="stop-restart" index={7} title="Stopping and starting again">
          <Panel>
            <p className="text-sm leading-relaxed mb-3">{STOP_AND_RESTART}</p>
            <p className="text-sm text-[var(--color-muted)] leading-relaxed">{DATA_LOCATION}</p>
          </Panel>
        </Section>

        <Section
          id="detail"
          index={8}
          title="Where the detail is"
          lede="The README carries the hand-run version of every route, which is what to read when you want to know what a command did rather than to run it."
        >
          <ul className="space-y-3">
            {DETAILED_SECTIONS.map((section) => (
              <li
                key={section.href}
                className="border border-[var(--color-border)] rounded-xl p-4 bg-[var(--color-card)]"
              >
                <a
                  href={section.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-medium text-[var(--color-accent)] underline underline-offset-4"
                >
                  {section.title}
                </a>
                <p className="text-sm text-[var(--color-muted)] mt-1.5 leading-relaxed">
                  {section.body}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      </div>

      <footer className="mt-14 pt-6 border-t border-[var(--color-border)] space-y-2">
        <p className="text-sm text-[var(--color-muted)]">
          Only wanted to see it work?{' '}
          <Link href="/demo" className="text-[var(--color-accent)] underline underline-offset-4">
            Try the demo
          </Link>{' '}
          instead - it is a recording, and it needs nothing installed.
        </p>
        <p className="text-xs text-[var(--color-muted)]">
          <a
            href={REPOSITORY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4"
          >
            Source
          </a>
          {' · '}
          This guide describes{' '}
          <a
            href={REVISION ? `${REPOSITORY_URL}/tree/${REVISION}` : `${REPOSITORY_URL}/tree/main`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono underline underline-offset-4"
          >
            {REVISION ? REVISION.slice(0, 7) : 'main'}
          </a>
          , and is generated from the same file the repository tests its own quick starts against.
        </p>
      </footer>
    </main>
  );
}
