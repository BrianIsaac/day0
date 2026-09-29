'use client';

import { useRef } from 'react';
import { useCountUp, useSeenOnce } from '../motion';
import { EVIDENCE } from './evidence';

/** One integer that counts up from zero once `run` turns true, holding its final width. */
function CountNumber({ value, run }: { value: number; run: boolean }) {
  const shown = useCountUp(value, run);
  return (
    <span className="inline-block text-right" style={{ minWidth: `${String(value).length}ch` }}>
      {shown}
    </span>
  );
}

/**
 * A figure whose integers count up once the card is seen. Assistive technology reads the final
 * figure; the counting digits are hidden from it.
 */
export function CountUp({ text, run }: { text: string; run: boolean }) {
  const parts = text.split(/(\d+)/);
  return (
    <>
      <span aria-hidden="true">
        {parts.map((part, index) =>
          index % 2 === 1 ? <CountNumber key={index} value={Number(part)} run={run} /> : part,
        )}
      </span>
      <span className="sr-only">{text}</span>
    </>
  );
}

/**
 * The dated figures one real-mode run ended on, in a card that arrives when seen; its figures
 * count up once, on the same arrival. On a phone each row stacks into a labelled pair.
 */
export function EvidenceTable() {
  const group = useRef<HTMLDivElement>(null);
  const seen = useSeenOnce(group);
  return (
    <div ref={group} data-cards="" data-seen={seen}>
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-card)]">
        <table className="m-2 w-[calc(100%-1rem)] text-sm">
          <caption className="sr-only">
            {EVIDENCE.heading}, {EVIDENCE.runOn}
          </caption>
          <tbody>
            {EVIDENCE.rows.map((row) => (
              <tr
                key={row.label}
                className="grid grid-cols-1 gap-1.5 border-b border-[var(--color-border)] px-2 py-3 last:border-b-0 sm:table-row sm:p-0"
              >
                <th scope="row" className="text-left font-normal sm:px-3 sm:py-3">
                  {row.label}
                </th>
                <td className="font-mono text-[13px] tabular-nums sm:px-3 sm:py-3 sm:text-right">
                  <CountUp text={row.value} run={seen === 'seen'} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="border-t border-[var(--color-border)] px-4 py-3 text-xs leading-relaxed text-[var(--color-muted)]">
          {EVIDENCE.footnote}
        </p>
      </div>
    </div>
  );
}
