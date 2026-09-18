import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMetrics, OwnerMetrics } from '../../convex/metrics';
import type { Id } from '../../convex/_generated/dataModel';

const query = vi.hoisted(() => ({ result: undefined as unknown }));

vi.mock('convex/react', () => ({
  useQuery: (): unknown => query.result,
}));

/** The card's module as the tests use it; imported by path until it exists. */
interface CardModule {
  CompanySupervision(): ReactElement | null;
  CompanySupervisionCard(props: { figures: OwnerMetrics }): ReactElement;
}

const CARD = '../../app/CompanySupervision';
const loadCard = async (): Promise<CardModule> =>
  (await import(/* @vite-ignore */ CARD)) as CardModule;

afterEach(() => {
  query.result = undefined;
});

function agentMetrics(overrides: {
  approvedAfterMs: number | null;
  decisions: [approved: number, rejected: number];
  waits: [median: number | null, p90: number | null];
  actions: [autoApplied: number, approved: number, held: number];
  audit: [complete: number, total: number];
  sessionRestores?: number;
}): AgentMetrics {
  const [approved, rejected] = overrides.decisions;
  const [medianLatencyMs, p90LatencyMs] = overrides.waits;
  const [autoApplied, approvedActions, held] = overrides.actions;
  const [complete, total] = overrides.audit;
  return {
    charter: {
      timeToFirstDraftedMs: overrides.approvedAfterMs,
      timeToFirstApprovedMs: overrides.approvedAfterMs,
      revisions: 0,
      requestChanges: 0,
    },
    decisions: {
      requested: approved + rejected,
      approved,
      rejected,
      partiallyApproved: 0,
      cancelled: 0,
      medianLatencyMs,
      p90LatencyMs,
      byVia: {
        dashboard: { decided: approved + rejected, medianLatencyMs, p90LatencyMs },
        channel: { decided: 0, medianLatencyMs: null, p90LatencyMs: null },
      },
    },
    actions: {
      autoApplied,
      sessionRestores: overrides.sessionRestores ?? 0,
      held,
      approved: approvedActions,
      rejected: 0,
      refused: 0,
      blockedAfterRevocation: null,
      firstBlockAfterRevocationMs: null,
    },
    surfaces: { approved: 0, rejected: 0, absent: 0 },
    skills: { approved: 0, rejected: 0 },
    autonomyChanges: 0,
    auditTrail: { complete, total, fraction: total > 0 ? complete / total : null },
  };
}

const priya = agentMetrics({
  approvedAfterMs: 67_000,
  decisions: [2, 0],
  waits: [48_000, 49_000],
  actions: [25, 1, 1],
  audit: [26, 26],
});
const mateo = agentMetrics({
  approvedAfterMs: 130_000,
  decisions: [2, 1],
  waits: [20_000, 70_000],
  actions: [8, 2, 0],
  audit: [10, 12],
  sessionRestores: 3,
});
const aiko = agentMetrics({
  approvedAfterMs: 180_000,
  decisions: [0, 0],
  waits: [null, null],
  actions: [0, 0, 0],
  audit: [0, 0],
});

const FIGURES: OwnerMetrics = {
  employees: [
    { agentId: 'priya' as Id<'agents'>, name: 'Priya', deployedAt: 1, metrics: priya },
    { agentId: 'mateo' as Id<'agents'>, name: 'Mateo', deployedAt: 2, metrics: mateo },
    { agentId: 'aiko' as Id<'agents'>, name: 'Aiko', deployedAt: 3, metrics: aiko },
  ],
  company: {
    employees: 3,
    charter: {
      timesToFirstApprovedMs: [67_000, 130_000, 180_000],
      medianTimeToFirstApprovedMs: 130_000,
      approvedEmployees: 3,
    },
    // Pooled over the five decisions: not the median of the two medians.
    decisions: {
      ...mateo.decisions,
      requested: 5,
      approved: 4,
      rejected: 1,
      medianLatencyMs: 30_000,
      p90LatencyMs: 70_000,
    },
    actions: { ...priya.actions, autoApplied: 33, approved: 3, held: 1, sessionRestores: 3 },
    surfaces: { approved: 0, rejected: 0, absent: 0 },
    skills: { approved: 0, rejected: 0 },
    autonomyChanges: 0,
    auditTrail: { complete: 36, total: 38, fraction: 36 / 38 },
  },
  excludedAgents: 2,
  omittedEmployees: 0,
};

function rowOf(html: string, label: string): string {
  const start = html.indexOf(`>${label}</th>`);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</tr>', start));
}

describe('the company supervision card', (): void => {
  it.fails(
    'lists one row per employee and a company row of pooled figures',
    async (): Promise<void> => {
      const { CompanySupervisionCard } = await loadCard();
      const html = renderToStaticMarkup(<CompanySupervisionCard figures={FIGURES} />);

      expect(html).toContain('Company supervision');
      expect(rowOf(html, 'Priya')).toContain('1 min 7 s');
      expect(rowOf(html, 'Priya')).toContain('2 / 0');
      expect(rowOf(html, 'Priya')).toContain('48 s / 49 s');
      expect(rowOf(html, 'Priya')).toContain('100% (26/26)');
      expect(rowOf(html, 'Mateo')).toContain('83% (10/12)');
      expect(rowOf(html, 'Aiko')).toContain('3 min');
      expect(rowOf(html, 'Aiko')).toContain('not yet');

      const company = rowOf(html, 'Company');
      expect(company).toContain('4 / 1');
      expect(company).toContain('30 s / 1 min 10 s');
      expect(company).toContain('33 · 3 · 1');
      expect(company).toContain('95% (36/38)');
      expect(html.indexOf('>Company</th>')).toBeGreaterThan(html.indexOf('>Aiko</th>'));
    },
  );

  it.fails(
    'quotes each employee’s time to an approved charter and their median, never a sum',
    async (): Promise<void> => {
      const { CompanySupervisionCard } = await loadCard();
      const company = rowOf(
        renderToStaticMarkup(<CompanySupervisionCard figures={FIGURES} />),
        'Company',
      );

      expect(company).toContain('1 min 7 s · 2 min 10 s · 3 min');
      expect(company).toContain('median of three: 2 min 10 s');
      expect(company).not.toContain('6 min 17 s');
    },
  );

  it.fails(
    'names a pending charter and takes the median over the approved ones only',
    async (): Promise<void> => {
      const { CompanySupervisionCard } = await loadCard();
      const figures: OwnerMetrics = {
        ...FIGURES,
        company: {
          ...FIGURES.company,
          charter: {
            timesToFirstApprovedMs: [67_000, null, 180_000],
            medianTimeToFirstApprovedMs: 123_500,
            approvedEmployees: 2,
          },
        },
      };
      const company = rowOf(
        renderToStaticMarkup(<CompanySupervisionCard figures={figures} />),
        'Company',
      );

      expect(company).toContain('1 min 7 s · pending · 3 min');
      expect(company).toContain('median of two: 2 min 4 s');
    },
  );

  it.fails('carries each definition as the label’s tooltip', async (): Promise<void> => {
    const { CompanySupervisionCard } = await loadCard();
    const html = renderToStaticMarkup(<CompanySupervisionCard figures={FIGURES} />);
    const titles = [...html.matchAll(/title="([^"]*)"/g)].map((match) => match[1]).join('\n');

    expect(titles).toContain('never a sum');
    expect(titles).toContain('pooled across employees, because one manager made them');
    expect(titles).toContain('not a median of the employees');
    expect(titles).toContain('replayed browser calls included');
    expect(titles).toContain('never an automatic action');
    expect(titles).toContain('Evaluation agents and baseline arms are left out');
  });

  it.fails(
    'says what the company row leaves out and what it counts beside the actions',
    async (): Promise<void> => {
      const { CompanySupervisionCard } = await loadCard();
      const html = renderToStaticMarkup(<CompanySupervisionCard figures={FIGURES} />);
      expect(html).toContain('2 evaluation agents left out');
      expect(html).toContain('3 browser calls replayed to sign in again');
      expect(html).not.toContain('most recent');

      const crowded = renderToStaticMarkup(
        <CompanySupervisionCard figures={{ ...FIGURES, excludedAgents: 0, omittedEmployees: 4 }} />,
      );
      expect(crowded).toContain('the 3 most recent employees; 4 earlier ones are not counted');
      expect(crowded).not.toContain('evaluation agents left out');
    },
  );

  it.fails('renders nothing until the owner has an employee', async (): Promise<void> => {
    const { CompanySupervision } = await loadCard();
    for (const result of [undefined, null, 0, { ...FIGURES, employees: [] }]) {
      query.result = result;
      expect(renderToStaticMarkup(<CompanySupervision />)).toBe('');
    }
    query.result = FIGURES;
    expect(renderToStaticMarkup(<CompanySupervision />)).toContain('Company supervision');
  });
});
