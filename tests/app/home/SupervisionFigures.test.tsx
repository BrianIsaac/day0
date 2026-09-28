import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SupervisionFigures } from '../../../app/home/SupervisionFigures';
import type { OwnerMetrics } from '@/metrics/types';

/** The company row of the 17 September recording, pooled over one employee. */
const company = {
  employees: 1,
  decisions: {
    requested: 2,
    approved: 2,
    rejected: 0,
    medianLatencyMs: 127_000,
    p90LatencyMs: 130_000,
  },
  actions: {
    automatic: { reads: 12, managerMessages: 1, writes: 12 },
    approved: 11,
    held: 1,
    rejected: 0,
    refused: 1,
  },
  auditTrail: { complete: 41, total: 41, fraction: 1 },
} as unknown as OwnerMetrics['company'];

/** The figures as the manager reads them: each term followed by its value. */
const readAs = (markup: string): string =>
  markup
    .replace(/<\/dd>/g, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

describe('SupervisionFigures', (): void => {
  const html = renderToStaticMarkup(<SupervisionFigures company={company} />);

  it('lists the company’s supervision figures as terms and values', (): void => {
    expect(html).toMatch(/^<dl\b/);
    const text = readAs(html);
    expect(text).toContain('Decisions 2 approved, 0 rejected |');
    expect(text).toContain('Decision wait median / p90 2 min 7 s / 2 min 10 s |');
    expect(text).toContain('Automatic changes 12 + 12 reads, 1 manager message |');
    expect(text).toContain('Held, then approved 11 |');
    expect(text).toContain('Held now 1 |');
    expect(text).toContain('Refused 1 |');
    expect(text).toContain('Audit trail 100% (41/41) |');
  });

  it('carries each figure’s definition on its term', (): void => {
    expect(html).toMatch(/<dt[^>]*title="Plans and actions the manager approved or rejected/);
    expect(html).toMatch(/<dt[^>]*title="Landed ledger rows that carry their tool/);
  });

  it('says not yet before the first decision', (): void => {
    const quiet = readAs(
      renderToStaticMarkup(
        <SupervisionFigures
          company={{
            ...company,
            decisions: { ...company.decisions, requested: 0, medianLatencyMs: null },
          }}
        />,
      ),
    );
    expect(quiet).toContain('Decisions not yet |');
    expect(quiet).toContain('Decision wait median / p90 not yet |');
  });

  it('sets no type below the 12 px floor', (): void => {
    expect(html).not.toMatch(/text-\[(9|10|11)px\]/);
  });
});
