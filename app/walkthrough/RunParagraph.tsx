import type { RunText } from '@/demo/walkthrough';

/** A README paragraph's spans: code in the mono face, bold as bold, the rest as text. */
export function RunParagraph({ text }: { text: RunText }) {
  return text.map((span, index) =>
    span.code ? (
      <code
        key={index}
        className="rounded bg-[var(--color-card)] px-1 py-px font-mono text-[0.875em] text-[var(--color-fg)]"
      >
        {span.text}
      </code>
    ) : span.strong ? (
      <strong key={index} className="font-semibold text-[var(--color-fg)]">
        {span.text}
      </strong>
    ) : (
      span.text
    ),
  );
}
