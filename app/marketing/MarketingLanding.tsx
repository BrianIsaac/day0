import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { PageMotion } from '../PageMotion';
import { CardGroup } from './CardGroup';
import { EVIDENCE } from './evidence';
import { EvidenceTable } from './EvidenceTable';
import { DISCLOSURES_URL, FOOTER, HERO, HOW, PROBLEM, TRY, WHY } from './copy';
import { CharterFrame } from './frames/CharterFrame';
import { DocumentationFrame } from './frames/DocumentationFrame';
import { HeldWriteFrame } from './frames/HeldWriteFrame';
import { OneToOneFrame } from './frames/OneToOneFrame';
import { PinnedSequence, type PinnedStep } from './PinnedSequence';
import { SurfaceOrbit } from './SurfaceOrbit';

const WRAP = 'mx-auto w-full max-w-7xl px-6';
const BUTTON =
  'inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg border px-5 text-[15px] font-medium transition-[transform,border-color,opacity] duration-150 active:scale-[0.97] motion-reduce:active:scale-100';
const PRIMARY = `${BUTTON} border-transparent bg-[var(--color-accent)] text-[var(--color-bg)] hover:opacity-90`;
const SECONDARY = `${BUTTON} border-[var(--color-border)] bg-[var(--color-card)] hover:border-[var(--color-accent)]`;
const H2 =
  'max-w-[26ch] text-[clamp(1.625rem,2.8vw,2.125rem)] font-semibold leading-[1.15] tracking-[-0.02em] text-balance';
const LEDE = 'mt-3 max-w-[60ch] text-[17px] leading-relaxed text-[var(--color-muted)]';
const CARD = 'rounded-xl border bg-[var(--color-card)] p-5';
const INLINE_LINK =
  'underline decoration-zinc-700 underline-offset-4 transition-colors hover:decoration-[var(--color-accent)]';

const FRAMES = [
  <DocumentationFrame key="documentation" />,
  <OneToOneFrame key="one-to-one" />,
  <CharterFrame key="charter" />,
  <HeldWriteFrame key="held-write" />,
];
const STEPS: readonly PinnedStep[] = HOW.steps.map((step, index) => ({
  ...step,
  frame: FRAMES[index],
}));

/** The scrubbed reveal's stagger among siblings, read by `[data-rise]` in the stylesheet. */
const rise = (index: number): CSSProperties => ({ '--i': index }) as CSSProperties;

/** A landing section: its anchor, the hairline that draws in above it, and the wrap. */
function Section({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <section id={id} data-hairline="" className="scroll-mt-14 py-11 md:py-16">
      <div className={WRAP}>{children}</div>
    </section>
  );
}

/**
 * The signed-out `/`: the case for onboarding over engineering, the four steps as a pinned
 * sequence over product frames, the dated evidence, and the two ways in. Every sentence is in
 * `copy.ts` and `evidence.ts`.
 */
export function MarketingLanding() {
  return (
    <PageMotion className="flex flex-1 flex-col">
      <section className="pb-8 pt-9 md:pb-14 md:pt-[72px]">
        <div className={`${WRAP} grid grid-cols-1 items-center gap-8 md:grid-cols-2 md:gap-12`}>
          <div>
            <h1
              data-rise=""
              style={rise(0)}
              className="max-w-[18ch] text-[clamp(2.25rem,4.6vw,3.5rem)] font-semibold leading-[1.08] tracking-[-0.025em] text-balance max-md:max-w-none"
            >
              {HERO.claim} <span className="text-[var(--color-accent)]">{HERO.answer}</span>
            </h1>
            <p
              data-rise=""
              style={rise(1)}
              className="mt-5 max-w-[56ch] text-lg leading-relaxed text-[var(--color-muted)]"
            >
              {HERO.lede}
            </p>
            <div data-rise="" style={rise(2)} className="mt-8 flex flex-wrap gap-3">
              <Link href="/sign-in" className={`${PRIMARY} max-md:w-full`}>
                {HERO.tryDemo}
              </Link>
              <Link href="/setup" className={`${SECONDARY} max-md:w-full`}>
                {HERO.setUp}
              </Link>
            </div>
          </div>
          <div data-orbit-lag="" className="-order-1 md:order-none">
            <SurfaceOrbit />
          </div>
        </div>
      </section>

      <Section id="problem">
        <h2 data-rise="" className={H2}>
          {PROBLEM.heading}
        </h2>
        <CardGroup className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6">
          {PROBLEM.cards.map((card, index) => (
            <div
              key={card.title}
              className={`${CARD} ${index === 1 ? 'border-[var(--color-accent)]/40' : 'border-[var(--color-border)]'}`}
            >
              <h3 className="text-base font-semibold">{card.title}</h3>
              <p className="mt-2 leading-relaxed text-[var(--color-muted)]">{card.body}</p>
            </div>
          ))}
        </CardGroup>
      </Section>

      <Section id="why">
        <h2 data-rise="" className={H2}>
          {WHY.heading}
        </h2>
        <p data-rise="" style={rise(1)} className={LEDE}>
          {WHY.lede}
        </p>
        <CardGroup className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-4">
          {WHY.items.map((item) => (
            <div key={item.title} className="border-t border-[var(--color-border)] pt-3.5">
              <h3 className="mb-1.5 font-semibold">{item.title}</h3>
              <p className="text-[15px] leading-relaxed text-[var(--color-muted)]">{item.body}</p>
            </div>
          ))}
        </CardGroup>
      </Section>

      <Section id="how">
        <h2 data-rise="" className={H2}>
          {HOW.heading}
        </h2>
        <PinnedSequence steps={STEPS} />
      </Section>

      <Section id="evidence">
        <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-2">
          <div>
            <h2 data-rise="" className={H2}>
              {EVIDENCE.heading}
            </h2>
            <p data-rise="" style={rise(1)} className={LEDE}>
              {EVIDENCE.lede}
            </p>
            <p data-rise="" style={rise(2)} className="mt-4 leading-relaxed">
              <Link href="/walkthrough" prefetch={false} className={INLINE_LINK}>
                {EVIDENCE.walkthroughLink}
              </Link>
              {' · '}
              <a href={EVIDENCE.comparisonHref} className={INLINE_LINK}>
                {EVIDENCE.comparisonLink}
              </a>
            </p>
          </div>
          <EvidenceTable />
        </div>
      </Section>

      <Section id="run">
        <h2 data-rise="" className={H2}>
          {TRY.heading}
        </h2>
        <CardGroup className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6">
          <div className={`${CARD} flex flex-col items-start gap-3 border-[var(--color-border)]`}>
            <h3 className="text-base font-semibold">{TRY.hosted.title}</h3>
            <p className="leading-relaxed text-[var(--color-muted)]">
              {TRY.hosted.body} {TRY.hosted.notice.before}
              <a href={DISCLOSURES_URL} className={INLINE_LINK}>
                {TRY.hosted.notice.link}
              </a>
              {TRY.hosted.notice.after}
            </p>
            <Link href="/sign-in" className={PRIMARY}>
              {HERO.tryDemo}
            </Link>
          </div>
          <div
            className={`${CARD} flex min-w-0 flex-col items-start gap-3 border-[var(--color-border)]`}
          >
            <h3 className="text-base font-semibold">{TRY.local.title}</h3>
            <p className="leading-relaxed text-[var(--color-muted)]">{TRY.local.body}</p>
            <pre className="w-full overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-3 font-mono text-[13px] leading-relaxed">
              <code>{TRY.local.commands.join('\n')}</code>
            </pre>
            <Link href="/setup" className={SECONDARY}>
              {HERO.setUp}
            </Link>
          </div>
        </CardGroup>
      </Section>

      <Section>
        <h2 data-rise="" className={H2}>
          {TRY.closingHeading}
        </h2>
        <p data-rise="" style={rise(1)} className={LEDE}>
          {TRY.closingLede}
        </p>
        <div data-rise="" style={rise(2)} className="mt-6 flex flex-wrap gap-3">
          <Link href="/sign-in" className={`${PRIMARY} max-md:w-full`}>
            {HERO.tryDemo}
          </Link>
          <Link href="/walkthrough" prefetch={false} className={`${SECONDARY} max-md:w-full`}>
            {TRY.readWalkthrough}
          </Link>
        </div>
      </Section>

      <footer className="mt-auto border-t border-[var(--color-border)] py-8 text-[13px] text-[var(--color-muted)]">
        <div className={`${WRAP} flex flex-wrap items-center justify-between gap-x-6 gap-y-3`}>
          <p>{FOOTER.disclosure}</p>
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            {FOOTER.links.map((link) => (
              <li key={link.label}>
                <a href={link.href} className={INLINE_LINK}>
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </footer>
    </PageMotion>
  );
}
