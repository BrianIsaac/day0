import type { Metadata } from 'next';
import Link from 'next/link';
import { Fragment } from 'react';
import { PageMotion } from '../PageMotion';
import { api } from '@convex/_generated/api';
import { deploymentReleaseLine, readDeploymentRelease } from '@/setup/deployment-release';

import {
  DATA_LOCATION,
  DETAILED_SECTIONS,
  FIRST_SUCCESS,
  HOSTED_COPY,
  MEASURED_TIMINGS,
  MOCK_OFFICE_NOTE,
  MODEL_ROUTES,
  PREREQUISITES,
  PUBLISHED_PORTS,
  QUICKSTART_COMMANDS,
  REAL_MODE_NOTE,
  REAL_MODE_VERBS,
  REPOSITORY_URL,
  SETUP_PAGE_URL,
  RUN_WAYS,
  RUN_WAY_VERBS_NOTE,
  STOP_AND_RESTART,
  TIMING_CAVEAT,
  TRAPS,
} from '@/setup/quickstart';

/**
 * The page's title and description, and its own address: every installation serves this guide,
 * and the hosted copy is the one each stands for.
 */
export const metadata: Metadata = {
  title: 'Set up Day0',
  description:
    'Run Day0 on your own machine: what you need, the three ways to run it, the five commands, what a first success looks like, and what to do when it stops.',
  // Only the canonical: a page's `openGraph` replaces the layout's whole, not field by field.
  alternates: { canonical: SETUP_PAGE_URL },
};

/**
 * How often the page is drawn again: it is static apart from the release line, which is read at
 * most hourly, so a functions upgrade reaches it without an app deploy.
 */
export const revalidate = 3600;

/**
 * The setup guide, signed out, and static but for the line naming the
 * deployment's release.
 *
 * A visitor arrives here from the landing page having never run the product,
 * and this page may be the only instruction they read, so it carries the whole
 * path rather than a pointer to one: prerequisites, the three ways to run it
 * (the hosted demo, and the two local ways, which are real mode and differ
 * only in where the model runs) with a complete command list each, the choice
 * the command will ask them to make, the commands, what success looks like,
 * what was measured, the two traps a rehearsal found, and how to stop.
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
  { id: 'ways', title: 'Three ways to run it' },
  { id: 'model', title: 'How it reaches a model' },
  { id: 'commands', title: 'The commands' },
  { id: 'success', title: 'What first success looks like' },
  { id: 'time', title: 'How long it takes' },
  { id: 'stops', title: 'If it stops' },
  { id: 'stop-restart', title: 'Stopping and starting again' },
  { id: 'detail', title: 'Where the detail is' },
] as const;

/**
 * A command in running text, set as code, that wraps only between its words, so a flag such as
 * `--endpoint` never breaks after its hyphens (the hosted walk's m24).
 *
 * @param command - The command, its words separated by single spaces.
 */
function InlineCommand({ command }: { command: string }) {
  return (
    <code className="font-mono text-[var(--color-fg)]">
      {command.split(' ').map((word, index) => (
        <Fragment key={index}>
          {index > 0 ? ' ' : null}
          <span className="whitespace-nowrap">{word}</span>
        </Fragment>
      ))}
    </code>
  );
}

/** A command-line flag in running text, with the placeholder that follows it, if any. */
const FLAG = /(--[a-z][a-z-]*(?: <[a-z-]+>)?)/;

/**
 * Running text whose flags wrap only as a whole, never after their hyphens,
 * so `--dry-run` cannot break into `--` and `dry-run` at phone width (the
 * hosted walk's m24, found again on this page at 390 px, 1 October 2026).
 *
 * @param text - The prose.
 */
function Prose({ text }: { text: string }) {
  return (
    <>
      {text.split(FLAG).map((part, index) =>
        index % 2 === 1 ? (
          <span key={index} className="whitespace-nowrap">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

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
    <section id={id} data-reveal="" data-scroll-section="" className="scroll-mt-20">
      <div className="flex items-baseline gap-3 mb-3">
        <span className="font-mono text-xs text-[var(--color-muted)]">
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

export default async function SetupPage() {
  const stamp = await readDeploymentRelease(api.config.release);
  return (
    <PageMotion className="day0-public-motion day0-setup-motion" revealMargin="0px 0px 120px 0px">
      <div className="min-h-[calc(100vh-3.25rem)] px-6 py-12 max-w-3xl lg:max-w-6xl mx-auto w-full lg:grid lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-x-12">
        <header
          id="setup"
          data-reveal=""
          data-scroll-section=""
          className="mb-10 scroll-mt-20 lg:col-start-2"
        >
          <p className="text-xs uppercase tracking-[0.28em] text-[var(--color-accent)] mb-4">
            Set up Day0
          </p>
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight leading-tight mb-5">
            Run Day0 on your own machine.
          </h1>
          <p className="text-base text-[var(--color-muted)] leading-relaxed mb-4">
            The product the hosted demo shows, running locally in real mode: a self-hosted backend,
            your own documentation and the systems it names, and a sandbox that verifies the skills
            the employee writes. The backend and sandbox run locally. A cloud model receives your
            chat and relevant content from your documentation; the local-model way runs the model
            here too. The seeded mock office the hosted demo works in is mock mode, which the
            evaluation harness uses and which no local way runs.
          </p>
          {stamp !== null ? (
            <p className="text-xs text-[var(--color-muted)] leading-relaxed mb-4">
              {deploymentReleaseLine(stamp)}
            </p>
          ) : null}
          <div
            role="note"
            className="rounded-xl border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 p-4"
          >
            <p className="text-sm leading-relaxed">
              This page asks you for nothing. It has no form and no field: the one secret the setup
              needs is typed into a hidden prompt in your own terminal and saved in a private file
              beside your checkout. It is used to authenticate requests to your model provider.
            </p>
          </div>
        </header>

        <nav
          aria-label="Sections of this guide"
          className="day0-setup-nav mb-12 lg:sticky lg:top-24 lg:self-start lg:col-start-1 lg:row-start-1 lg:row-span-3 lg:max-h-[calc(100dvh-7rem)] lg:overflow-y-auto"
        >
          <ol className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap lg:flex-col">
            {SECTIONS.map((section, index) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  data-section-link=""
                  className="flex h-full min-h-11 items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-xs hover:border-[var(--color-accent)]"
                >
                  <span className="font-mono text-xs text-[var(--color-muted)]">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  {section.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="space-y-12 min-w-0 lg:col-start-2">
          <Section
            id="before"
            index={1}
            title="Before you start"
            lede="Three tools and the ports listed below. Setup checks the backend ports, reports app port 3000 as a note, and checks the model port when you choose the local-model way."
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
              Move the backend ports and choose an installation name:{' '}
              <InlineCommand command="./setup.sh --project day0-new --port 4210 --site-port 4211 --dashboard-port 4791" />
              . Two installations on one machine need different ports and different Compose project
              names, and the command refuses to attach a new installation to another one&rsquo;s
              data. Use <span className="whitespace-nowrap">--model-port</span> for the local model
              server and <span className="whitespace-nowrap">--app-port</span> for the app, which
              pnpm dev otherwise serves on 3000.
            </p>
          </Section>

          <Section
            id="ways"
            index={2}
            title="Three ways to run it"
            lede="The hosted demo needs nothing installed. The two local ways are real mode, on your own documentation and systems, and differ in one thing only: where the model runs. Each block is complete on its own, and every command in it is one this repository ships."
          >
            <div className="space-y-3">
              {RUN_WAYS.map((way, index) => (
                <Panel key={way.id}>
                  <div className="flex items-baseline gap-3 mb-2">
                    <span className="font-mono text-xs text-[var(--color-accent)]">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <h3 id={`run-${way.id}`} className="text-sm font-semibold tracking-tight">
                      {way.title}
                    </h3>
                  </div>
                  {way.address ? (
                    // The hosted demo by its address: the page is served by every installation,
                    // and a reader on one of them is told where the demo it describes runs.
                    <p className="text-sm text-[var(--color-fg)] leading-relaxed mb-2">
                      It runs at{' '}
                      <a
                        href={way.address.href}
                        className="text-[var(--color-accent)] underline underline-offset-4"
                      >
                        {way.address.label}
                      </a>
                      .
                    </p>
                  ) : null}
                  <p className="text-sm text-[var(--color-muted)] leading-relaxed mb-3">
                    <Prose text={way.body} />
                  </p>
                  {way.links ? (
                    <ul>
                      {way.links.map((link) => (
                        <li key={link.href}>
                          <Link
                            href={link.href}
                            className="inline-flex min-h-11 items-center text-sm text-[var(--color-accent)] underline underline-offset-4"
                          >
                            {link.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {way.commands ? (
                    // Focusable so a keyboard can scroll it where a command runs wider than the panel.
                    <code
                      tabIndex={0}
                      role="region"
                      aria-label={`Commands: ${way.title}`}
                      className="font-mono text-xs text-[var(--color-accent)] leading-relaxed block overflow-x-auto whitespace-nowrap"
                    >
                      {way.commands.map((command) => (
                        <span key={command} className="block">
                          {command}
                        </span>
                      ))}
                    </code>
                  ) : null}
                  {way.after ? (
                    <p className="text-sm text-[var(--color-muted)] leading-relaxed mt-3">
                      <Prose text={way.after} />
                    </p>
                  ) : null}
                </Panel>
              ))}
            </div>
            <p className="text-sm text-[var(--color-muted)] leading-relaxed mt-4">
              <Prose text={REAL_MODE_NOTE} />
            </p>
            <ul className="space-y-2 mt-3">
              {REAL_MODE_VERBS.map((verb) => (
                <li key={verb.command} className="flex flex-col sm:flex-row sm:gap-4">
                  <code className="font-mono text-xs text-[var(--color-accent)] leading-relaxed sm:w-52 sm:shrink-0">
                    {verb.command}
                  </code>
                  <span className="text-sm text-[var(--color-muted)] leading-relaxed">
                    <Prose text={verb.what} />
                  </span>
                </li>
              ))}
              <li className="text-sm text-[var(--color-muted)] leading-relaxed">
                <Prose text={RUN_WAY_VERBS_NOTE} />
              </li>
            </ul>
            <h3 id="hosted-copy" className="text-sm font-semibold tracking-tight mt-6 mb-2">
              {HOSTED_COPY.title}
            </h3>
            <p className="text-sm text-[var(--color-muted)] leading-relaxed mb-3">
              {HOSTED_COPY.body.split(HOSTED_COPY.targetLine)[0]}
              <InlineCommand command={HOSTED_COPY.targetLine} />
              {HOSTED_COPY.body.split(HOSTED_COPY.targetLine)[1]}
            </p>
            <Panel>
              {/* Focusable so a keyboard can scroll it where a command runs wider than the panel. */}
              <code
                tabIndex={0}
                role="region"
                aria-label={`Commands: ${HOSTED_COPY.title}`}
                className="font-mono text-xs text-[var(--color-accent)] leading-relaxed block overflow-x-auto whitespace-nowrap"
              >
                {HOSTED_COPY.commands.map((command) => (
                  <span key={command} className="block">
                    {command}
                  </span>
                ))}
              </code>
            </Panel>
            <p className="text-sm text-[var(--color-muted)] leading-relaxed mt-3">
              <Prose text={HOSTED_COPY.after} />
            </p>
            <h3 id="mock-office" className="text-sm font-semibold tracking-tight mt-6 mb-2">
              {MOCK_OFFICE_NOTE.title}
            </h3>
            <p className="text-sm text-[var(--color-muted)] leading-relaxed">
              {MOCK_OFFICE_NOTE.body}
            </p>
          </Section>

          <Section
            id="model"
            index={3}
            title="How it reaches a model"
            lede="The setup command asks where the model runs, then asks for the key or lists the local models to pick from. Both support the loop; they are the one thing the two local ways disagree about. Naming the route on the command line, as the blocks above do, skips the question."
          >
            <div className="space-y-3">
              {MODEL_ROUTES.map((route) => (
                <Panel key={route.id}>
                  <h3 className="text-sm font-semibold tracking-tight mb-2">{route.title}</h3>
                  <p className="text-sm text-[var(--color-muted)] leading-relaxed mb-2">
                    <Prose text={route.needs} />
                  </p>
                  <p className="text-sm text-[var(--color-muted)] leading-relaxed mb-3">
                    {route.gives}
                  </p>
                  <code className="font-mono text-xs text-[var(--color-accent)]">{route.flag}</code>
                </Panel>
              ))}
            </div>
            <p className="text-sm text-[var(--color-muted)] leading-relaxed mt-4">
              A third answer exists for a reader who already runs a compatible endpoint of their
              own:{' '}
              <InlineCommand command="./setup.sh --route endpoint --endpoint https://your-server/v1" />
              . It performs the same local setup and writes paired host/backend model addresses. Set
              OPENAI_MODEL and, if required, OPENAI_API_KEY in .env.local for that endpoint, then
              run pnpm sync:env before starting the app. A host-loopback endpoint must also be
              reachable from the backend container via host.docker.internal. The fourth answer,{' '}
              <InlineCommand command="./setup.sh --route key" />, is an OpenAI key, or any key an
              OpenAI-compatible provider issues, asked for in the same hidden prompt. All three are
              the cloud-model way; only <InlineCommand command="--route local" /> runs the model
              here.
            </p>
          </Section>

          <Section
            id="commands"
            index={4}
            title="The commands"
            lede="Five, from an empty directory. The fourth is the one that does the work, in real mode; run it again whenever you want, because it keeps what is already there rather than starting over."
          >
            <pre
              tabIndex={0}
              role="region"
              aria-label="The five commands"
              className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-4 overflow-x-auto"
            >
              <code className="font-mono text-sm leading-relaxed">
                {QUICKSTART_COMMANDS.map((command) => (
                  <span key={command} className="block">
                    {command}
                  </span>
                ))}
              </code>
            </pre>
            <p className="text-sm text-[var(--color-muted)] leading-relaxed mt-4">
              The fourth command asks where the model runs when{' '}
              <span className="whitespace-nowrap">--route</span> does not say and, where a key is
              needed, for that key in a hidden prompt; it also asks for the email address your Slack
              DM is resolved from. Then it starts the backend, the sandbox, the redactor, the
              components and, on the local-model way, the model server; creates the documentation
              folder with a placeholder page; writes the values it generates into{' '}
              <InlineCommand command=".env.local" /> instead of asking you to paste them; pushes the
              backend functions; and finishes by running{' '}
              <InlineCommand command="pnpm check:setup" /> and printing the unlock URL. If it stops,
              it says which step stopped and what to run next. It never deletes a volume to recover.
            </p>
          </Section>

          <Section
            id="success"
            index={5}
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
              {/* Lazy, as it sits far below the fold: an eager `<img>` makes React emit a preload
                hint, which a prefetch of this route carried to the landing page (C2, 30 Sep). */}
              {/* eslint-disable-next-line @next/next/no-img-element -- this page is
                prerendered and must serve its own bytes; the optimiser would put
                a server request in front of the one picture a stuck reader needs. */}
              <img
                src="/setup/first-success-day-one-chat.webp"
                width={817}
                height={447}
                loading="lazy"
                decoding="async"
                alt="The Day-1 one-to-one in chat mode, the employee opening the conversation by asking what triggered the decision to bring it on and what the team is trying to make easier"
                className="rounded-xl border border-[var(--color-border)] w-full h-auto"
              />
              <figcaption className="text-xs text-[var(--color-muted)] mt-2 leading-relaxed">
                Step three, as it arrives: the employee opens the one-to-one itself. Captured
                locally on a run of this repository.
              </figcaption>
            </figure>
          </Section>

          <Section
            id="time"
            index={6}
            title="How long it takes"
            lede="Measured on one machine, from a clean clone with nothing copied into it. Each figure says what it does not include."
          >
            <Panel>
              <ul className="space-y-3">
                {MEASURED_TIMINGS.map((timing) => (
                  <li key={timing.phase} className="flex flex-col sm:flex-row sm:gap-4">
                    <span className="font-mono text-sm sm:w-64 sm:shrink-0">
                      <Prose text={timing.phase} />
                    </span>
                    <span className="text-sm">
                      <span className="text-[var(--color-accent)] font-mono">
                        {timing.measured}
                      </span>
                      <span className="text-[var(--color-muted)] leading-relaxed">
                        {' '}
                        <Prose text={timing.excludes} />
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
            index={7}
            title="If it stops"
            lede="Run pnpm check:setup. It reads .env.local and reports configuration and local service status for the backend, auth, model, sandbox and voice. It does not make a model call or verify provider credentials. These are the traps to check first."
          >
            <div className="space-y-3">
              {TRAPS.map((trap) => (
                <Panel key={trap.title}>
                  <h3 className="text-sm font-semibold tracking-tight mb-2">{trap.title}</h3>
                  <p className="text-sm text-[var(--color-muted)] leading-relaxed">
                    <Prose text={trap.body} />
                  </p>
                </Panel>
              ))}
            </div>
          </Section>

          <Section id="stop-restart" index={8} title="Stopping and starting again">
            <Panel>
              <p className="text-sm leading-relaxed mb-3">{STOP_AND_RESTART}</p>
              <p className="text-sm text-[var(--color-muted)] leading-relaxed">{DATA_LOCATION}</p>
            </Panel>
          </Section>

          <Section
            id="detail"
            index={9}
            title="Where the detail is"
            lede="The README says what the setup does on every route, step by step, which is what to read when you want to know what a command did rather than to run it."
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

        <footer className="lg:col-start-2 mt-14 pt-6 border-t border-[var(--color-border)] space-y-2">
          <p className="text-sm text-[var(--color-muted)]">
            Only wanted to see it work?{' '}
            <Link
              href="/walkthrough"
              className="text-[var(--color-accent)] underline underline-offset-4"
            >
              Watch the recorded walkthrough
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
      </div>
    </PageMotion>
  );
}
