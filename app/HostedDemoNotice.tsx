import { HOSTED_DEMO_NOTICE } from '@/demo/hosted-notice';

/**
 * What the hosted demo collects and who receives it (N6), as a note beside whatever asks a
 * visitor to sign in. The words are `HOSTED_DEMO_NOTICE`'s, so every page that shows the
 * notice says the same thing.
 */
export function HostedDemoNotice() {
  return (
    <div
      role="note"
      className="grid gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3.5 text-sm leading-relaxed text-[var(--color-muted)]"
    >
      <strong className="font-semibold text-[var(--color-fg)]">{HOSTED_DEMO_NOTICE.heading}</strong>
      {HOSTED_DEMO_NOTICE.paragraphs.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
      <p>
        <a
          href={HOSTED_DEMO_NOTICE.link.href}
          className="underline decoration-zinc-700 underline-offset-4 transition-colors hover:decoration-[var(--color-accent)]"
        >
          {HOSTED_DEMO_NOTICE.link.label}
        </a>
      </p>
    </div>
  );
}
