import type { CSSProperties } from 'react';
import { DOCUMENTATION } from './fixtures';
import { Chip, ProductFrame } from './ProductFrame';

/** Step 1: the documentation the manager linked, synced before the employee exists. */
export function DocumentationFrame() {
  return (
    <ProductFrame
      caption={`Documentation · ${DOCUMENTATION.sources} sources · ${DOCUMENTATION.pages} pages`}
    >
      <div className="px-3 py-2 sm:px-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs tracking-[0.04em] text-[var(--color-muted)]">
              <th className="px-2 py-2 font-semibold">Page</th>
              <th className="px-2 py-2 font-semibold">Source</th>
              <th className="px-2 py-2 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {DOCUMENTATION.rows.map((row, index) => (
              <tr
                key={row.title}
                data-seq=""
                style={{ '--i': index } as CSSProperties}
                className="border-t border-[var(--color-border)]"
              >
                <td className="px-2 py-2.5">{row.title}</td>
                <td className="px-2 py-2.5 text-[var(--color-muted)]">{row.source}</td>
                <td className="px-2 py-2.5">
                  <Chip tone="ok">Synced</Chip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ProductFrame>
  );
}
