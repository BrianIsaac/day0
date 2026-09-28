import type { Metadata } from 'next';
import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { RECORDED_RUN, walkthroughProvenanceLine } from '@/demo/walkthrough';
import { HostedDemoNotice } from '../HostedDemoNotice';
import { EvidenceTable } from '../marketing/EvidenceTable';
import { HERO } from '../marketing/copy';
import { PageMotion } from '../PageMotion';
import { WALKTHROUGH } from './copy';
import { RunParagraph } from './RunParagraph';
import { RunStory } from './RunStory';

export const metadata: Metadata = {
  title: 'Day0 walkthrough',
  description:
    'One recorded real-mode run of a Day0 employee, step by step: the documentation, the one-to-one, the charter, the held writes, the switch and the refused write.',
};

const WRAP = 'mx-auto w-full max-w-7xl px-6';
const BUTTON =
  'inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg border px-5 text-[15px] font-medium transition-[transform,border-color,opacity] duration-150 active:scale-[0.97] motion-reduce:active:scale-100';
const PRIMARY = `${BUTTON} border-transparent bg-[var(--color-accent)] text-[var(--color-bg)] hover:opacity-90`;
const SECONDARY = `${BUTTON} border-[var(--color-border)] bg-[var(--color-card)] hover:border-[var(--color-accent)]`;
const QUIET = `${BUTTON} border-transparent text-[var(--color-muted)] hover:text-[var(--color-fg)]`;
const H2 =
  'max-w-[26ch] text-[clamp(1.625rem,2.8vw,2.125rem)] font-semibold leading-[1.15] tracking-[-0.02em] text-balance';
/** A way on from the page: a hairline above it rather than a card, so the notice is never a card in a card. */
const WAY = 'flex flex-col items-start gap-3 border-t border-[var(--color-border)] pt-5';

/** The scrubbed reveal's stagger among siblings, read by `[data-rise]` in the stylesheet. */
const rise = (index: number): CSSProperties => ({ '--i': index }) as CSSProperties;

/** A section of the page: its anchor, the hairline that draws in above it, and the wrap. */
function Section({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <section id={id} data-hairline="" className="scroll-mt-14 py-11 md:py-16">
      <div className={WRAP}>{children}</div>
    </section>
  );
}

/**
 * Public, static, and built entirely from tracked data: the run from
 * `src/demo/walkthrough-steps.json`, which the README generates, and its captures under
 * `public/walkthrough/`. The route reads no row and holds no session: a signed-out visitor gets
 * the same bytes as anybody else, and nothing they do here can write. `/demo` redirects here.
 */
export default function WalkthroughPage() {
  const run = RECORDED_RUN;
  return (
    <PageMotion className="flex flex-1 flex-col">
      <section className="pb-6 pt-9 md:pt-[72px]">
        <div className={WRAP}>
          <h1
            data-rise=""
            style={rise(0)}
            className="max-w-[22ch] text-[clamp(2rem,4vw,3rem)] font-semibold leading-[1.1] tracking-[-0.025em] text-balance"
          >
            {WALKTHROUGH.heading}
          </h1>
          <p
            data-rise=""
            style={rise(1)}
            className="mt-5 max-w-[62ch] text-lg leading-relaxed text-[var(--color-muted)]"
          >
            {WALKTHROUGH.lede(run)}
          </p>
          <div
            data-rise=""
            style={rise(2)}
            role="note"
            className="mt-5 grid max-w-[62ch] gap-1.5 text-sm leading-relaxed text-[var(--color-muted)]"
          >
            <p>{WALKTHROUGH.readOnly}</p>
            <p>{WALKTHROUGH.clock(run)}</p>
            <p>{walkthroughProvenanceLine(run)}</p>
          </div>
        </div>
      </section>

      <section id="run" aria-labelledby="run-heading" className="pb-11 pt-6 md:pb-16">
        <div className={WRAP}>
          <h2 id="run-heading" className="sr-only">
            {WALKTHROUGH.storyHeading}
          </h2>
          <RunStory run={run} />
        </div>
      </section>

      <Section id="numbers">
        <div className="grid grid-cols-1 items-start gap-10 md:grid-cols-2 md:gap-12">
          <div>
            <h2 data-rise="" className={H2}>
              {WALKTHROUGH.numbers.heading}
            </h2>
            <p
              data-rise=""
              style={rise(1)}
              className="mb-6 mt-3 text-[17px] leading-relaxed text-[var(--color-muted)]"
            >
              {WALKTHROUGH.numbers.lede}
            </p>
            <EvidenceTable />
          </div>
          <div id="deviations">
            <h2 data-rise="" className={H2}>
              {WALKTHROUGH.deviationsHeading}
            </h2>
            <ul className="mt-6 grid gap-3 pl-[18px] [list-style:disc] marker:text-[var(--color-border)]">
              {run.deviations.map((deviation) => (
                <li key={deviation.lead} className="leading-relaxed text-[var(--color-muted)]">
                  <strong className="font-semibold text-[var(--color-fg)]">{deviation.lead}</strong>{' '}
                  <RunParagraph text={deviation.body} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <Section id="try">
        <h2 data-rise="" className={H2}>
          {WALKTHROUGH.tryHeading}
        </h2>
        <div className="mt-8 grid grid-cols-1 gap-10 md:grid-cols-2 md:gap-12">
          <div className={WAY}>
            <h3 className="text-base font-semibold">{WALKTHROUGH.hosted.title}</h3>
            <p className="leading-relaxed text-[var(--color-muted)]">{WALKTHROUGH.hosted.body}</p>
            <HostedDemoNotice />
            <Link href="/sign-in" className={`${PRIMARY} max-md:w-full`}>
              {HERO.tryDemo}
            </Link>
          </div>
          <div className={WAY}>
            <h3 className="text-base font-semibold">{WALKTHROUGH.local.title}</h3>
            <p className="leading-relaxed text-[var(--color-muted)]">{WALKTHROUGH.local.body}</p>
            <div className="flex w-full flex-wrap gap-3">
              <Link href="/setup" className={`${SECONDARY} max-md:w-full`}>
                {HERO.setUp}
              </Link>
              <Link href="/" className={`${QUIET} max-md:w-full`}>
                {WALKTHROUGH.local.back}
              </Link>
            </div>
          </div>
        </div>
      </Section>
    </PageMotion>
  );
}
