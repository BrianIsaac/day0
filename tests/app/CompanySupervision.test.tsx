import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CompanySupervision,
  CompanySupervisionCard,
  decisionsCell,
  PILOT_FIGURES,
} from '../../app/CompanySupervision';
import type { AgentMetrics, OwnerMetrics, PilotFigures } from '../../src/metrics/types';
import type { Id } from '../../convex/_generated/dataModel';

const query = vi.hoisted(() => ({ result: undefined as unknown }));

/** A labelled-set grade, fixed so the cell's words do not move with the tracked grade. */
const GRADED_RECALL = {
  pages: 0.95,
  blocks: 0.9333333333333333,
  cases: 30,
  gradedAt: '2026-10-07T19:39:48.260Z',
  commit: '0123456789abcdef0123456789abcdef01234567',
};

vi.mock('convex/react', () => ({
  useQuery: (): unknown => query.result,
}));

afterEach(() => {
  query.result = undefined;
});

function agentMetrics(overrides: {
  approvedAfterMs: number | null;
  decisions: [approved: number, rejected: number];
  waits: [median: number | null, p90: number | null];
  actions: [automaticChanges: number, approved: number, held: number];
  /** The reads and manager messages that also applied on their own. */
  alsoAutomatic?: [reads: number, managerMessages: number];
  audit: [complete: number, total: number];
  sessionRestores?: number;
}): AgentMetrics {
  const [approved, rejected] = overrides.decisions;
  const [medianLatencyMs, p90LatencyMs] = overrides.waits;
  const [writes, approvedActions, held] = overrides.actions;
  const [reads, managerMessages] = overrides.alsoAutomatic ?? [0, 0];
  const [complete, total] = overrides.audit;
  return {
    writeLanded: writes + approvedActions > 0,
    workingSince: null,
    charter: {
      timeToFirstDraftedMs: overrides.approvedAfterMs,
      timeToFirstApprovedMs: overrides.approvedAfterMs,
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
      autoApplied: writes + reads + managerMessages,
      automatic: { reads, managerMessages, writes },
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
    pilot: {
      skillReuse: { runs: 0, reused: 0, adopted: 0, rate: null },
      cycleTime: {
        ended: 0,
        medianToEndMs: null,
        completed: 0,
        medianToCompletionMs: null,
        p90ToCompletionMs: null,
      },
      reorientation: { answered: 0, amended: 0, rate: null },
      hoursSaved: { estimatedItems: 0, hours: null },
      retrieval: { tokens: null, recall: GRADED_RECALL },
    },
  };
}

const priya = agentMetrics({
  approvedAfterMs: 67_000,
  decisions: [2, 0],
  waits: [48_000, 49_000],
  // The 17 September recording: 25 automatic rows, of them 12 writes.
  actions: [12, 1, 1],
  alsoAutomatic: [12, 1],
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
    actions: {
      ...priya.actions,
      autoApplied: 33,
      automatic: { reads: 12, managerMessages: 1, writes: 20 },
      approved: 3,
      held: 1,
      sessionRestores: 3,
    },
    surfaces: { approved: 0, rejected: 0, absent: 0 },
    skills: { approved: 0, rejected: 0 },
    autonomyChanges: 0,
    auditTrail: { complete: 36, total: 38, fraction: 36 / 38 },
    pilot: priya.pilot,
  },
  excludedAgents: 2,
  omittedEmployees: 0,
};

/** The text a row reads, from its label to its last cell. */
function rowOf(html: string, label: string): string {
  const start = html.indexOf(`>${label}</th>`);
  expect(start).toBeGreaterThan(-1);
  return html
    .slice(start, html.indexOf('</tr>', start))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

describe('the company supervision card', (): void => {
  it('lists one row per employee and a company row of pooled figures', (): void => {
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
    expect(company).toContain('20 · 3 · 1');
    expect(company).toContain('+ 12 reads, 1 manager message');
    expect(company).toContain('95% (36/38)');
    expect(html.indexOf('>Company</th>')).toBeGreaterThan(html.indexOf('>Aiko</th>'));
  });

  it('shows rejected and refused actions in each row and the company total', (): void => {
    const figures: OwnerMetrics = {
      ...FIGURES,
      employees: FIGURES.employees.map((employee, index) => ({
        ...employee,
        metrics: {
          ...employee.metrics,
          actions: {
            ...employee.metrics.actions,
            rejected: index === 0 ? 2 : 0,
            refused: index === 1 ? 1 : 0,
          },
        },
      })),
      company: {
        ...FIGURES.company,
        actions: { ...FIGURES.company.actions, rejected: 2, refused: 1 },
      },
    };
    const html = renderToStaticMarkup(<CompanySupervisionCard figures={figures} />);

    expect(rowOf(html, 'Priya')).toContain('12 · 1 · 1 · 2 · 0');
    expect(rowOf(html, 'Mateo')).toContain('8 · 2 · 0 · 0 · 1');
    expect(rowOf(html, 'Company')).toContain('20 · 3 · 1 · 2 · 1');
    expect(html).toContain('automatic changes · approved · held · rejected · refused');
  });

  it('quotes each employee’s time to an approved charter and their median, never a sum', (): void => {
    const company = rowOf(
      renderToStaticMarkup(<CompanySupervisionCard figures={FIGURES} />),
      'Company',
    );

    expect(company).toContain('1 min 7 s · 2 min 10 s · 3 min');
    expect(company).toContain('median of three: 2 min 10 s');
    expect(company).not.toContain('6 min 17 s');
  });

  it('names a pending charter and takes the median over the approved ones only', (): void => {
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
  });

  it('carries each definition as the label’s tooltip', (): void => {
    const html = renderToStaticMarkup(<CompanySupervisionCard figures={FIGURES} />);
    const titles = [...html.matchAll(/title="([^"]*)"/g)].map((match) => match[1]).join('\n');

    expect(titles).toContain('never a sum');
    expect(titles).toContain('pooled across employees, because one manager made them');
    expect(titles).toContain('not a median of the employees');
    expect(titles).toContain('replayed browser calls included');
    expect(titles).toContain('never an automatic action');
    expect(titles).toContain('Evaluation employees and baseline arms are left out');
  });

  it('says what the company row leaves out and what it counts beside the actions', (): void => {
    const html = renderToStaticMarkup(<CompanySupervisionCard figures={FIGURES} />);
    expect(html).toContain('2 evaluation employees left out');
    expect(html).toContain('3 browser calls replayed to sign in again');
    expect(html).not.toContain('most recent');

    const crowded = renderToStaticMarkup(
      <CompanySupervisionCard figures={{ ...FIGURES, excludedAgents: 0, omittedEmployees: 4 }} />,
    );
    expect(crowded).toContain('the 3 most recent employees; 4 earlier ones are not counted');
    expect(crowded).not.toContain('evaluation employees left out');
  });

  it('renders nothing until the owner has an employee', (): void => {
    for (const result of [undefined, null, 0, { ...FIGURES, employees: [] }]) {
      query.result = result;
      expect(renderToStaticMarkup(<CompanySupervision />)).toBe('');
    }
    query.result = FIGURES;
    expect(renderToStaticMarkup(<CompanySupervision />)).toContain('Company supervision');
  });

  it("prints A9's five pilot figures for each employee and the company, hours saved as an internal gauge", (): void => {
    const figures: OwnerMetrics = {
      ...FIGURES,
      employees: FIGURES.employees.map((employee, index) =>
        index === 0
          ? {
              ...employee,
              metrics: {
                ...employee.metrics,
                pilot: {
                  skillReuse: { runs: 4, reused: 1, adopted: 0, rate: 0.25 },
                  cycleTime: {
                    ended: 3,
                    medianToEndMs: 60_000,
                    completed: 2,
                    medianToCompletionMs: 67_000,
                    p90ToCompletionMs: 300_000,
                  },
                  reorientation: { answered: 2, amended: 1, rate: 0.5 },
                  hoursSaved: { estimatedItems: 2, hours: 1.5 },
                  retrieval: { tokens: null, recall: GRADED_RECALL },
                },
              },
            }
          : employee,
      ),
    };
    const html = renderToStaticMarkup(<CompanySupervisionCard figures={figures} />);
    const pilot = html.slice(html.indexOf('Pilot figures'));
    for (const label of [
      'Skill reuse',
      'Cycle time',
      'Reorientation',
      'Hours saved',
      'Retrieval',
    ]) {
      expect(pilot).toContain(label);
    }
    expect(pilot).toContain('your estimates, internal gauge');
    const priyaRow = rowOf(pilot, 'Priya');
    expect(priyaRow).toContain('1 of 4 (25%)');
    expect(priyaRow).toContain('1 min 7 s / 5 min (2 done)');
    expect(priyaRow).toContain('1 of 2 answers');
    expect(priyaRow).toContain('1.5 h over 2 items');
    // No prompt of Priya's carried a selection yet; the recall is the labelled set's grade.
    expect(priyaRow).toContain('no selection read yet; recall 95% of pages, 93% of sections');
    expect(pilot).not.toContain('not measured yet');
    const companyRow = rowOf(pilot, 'Company');
    expect(companyRow).toContain('not yet');
    expect(companyRow).toContain('no estimates yet');
  });
});

describe('the retrieval figure (14-R)', (): void => {
  const retrievalFigure = PILOT_FIGURES.find((figure) => figure.label === 'Retrieval')!;
  const figures = (retrieval: PilotFigures['retrieval']): PilotFigures => ({
    ...FIGURES.company.pilot,
    retrieval,
  });

  it('says the documentation an item read against its billed input tokens, and the recall', (): void => {
    expect(
      retrievalFigure.value(
        figures({
          tokens: { items: 3, charsPerItem: 6_210.4, inputTokensPerItem: 31_402.6 },
          recall: GRADED_RECALL,
        }),
      ),
    ).toBe(
      '6,210 characters an item against 31,403 input tokens; recall 95% of pages, 93% of sections',
    );
  });

  it('says the recall is not graded when a backend before 0.18.0 answers none', (): void => {
    expect(retrievalFigure.value(figures({ tokens: null, recall: null }))).toBe(
      'no selection read yet; recall not graded',
    );
  });

  it('leaves the tokens out when no provider reported usage', (): void => {
    expect(
      retrievalFigure.value(
        figures({
          tokens: { items: 1, charsPerItem: 980, inputTokensPerItem: null },
          recall: GRADED_RECALL,
        }),
      ),
    ).toBe('980 characters an item; recall 95% of pages, 93% of sections');
  });
});

describe('the skill reuse figure (A14, 10-A)', (): void => {
  const [reuse] = PILOT_FIGURES;
  const figures = (skillReuse: PilotFigures['skillReuse']): PilotFigures => ({
    ...FIGURES.company.pilot,
    skillReuse,
  });

  it('keeps its meaning and says the adopted runs beside it, once there are any', (): void => {
    expect(reuse?.label).toBe('Skill reuse');
    expect(reuse?.value(figures({ runs: 4, reused: 2, adopted: 1, rate: 0.5 }))).toBe(
      '2 of 4 (50%), 1 adopted',
    );
    expect(reuse?.value(figures({ runs: 4, reused: 1, adopted: 0, rate: 0.25 }))).toBe(
      '1 of 4 (25%)',
    );
    expect(reuse?.value(figures({ runs: 0, reused: 0, adopted: 0, rate: null }))).toBe('not yet');
  });

  it('defines the adopted runs as part of the reuse they are counted in', (): void => {
    expect(reuse?.definition).toBe(
      'Of the distinct work item and skill runs, those run with a skill first made for another item. Runs of a skill adopted from another employee count as reuse, and are shown as adopted.',
    );
  });
});

describe("a row's decisions", (): void => {
  it('quotes decisions made on the dashboard when no chat surface was asked (walk m14)', (): void => {
    const decisions = {
      requested: 0,
      approved: 2,
      rejected: 1,
      partiallyApproved: 0,
      cancelled: 0,
      medianLatencyMs: 60_000,
      p90LatencyMs: 60_000,
      byVia: {
        dashboard: { decided: 3, medianLatencyMs: 60_000, p90LatencyMs: 60_000 },
        channel: { decided: 0, medianLatencyMs: null, p90LatencyMs: null },
      },
    };
    expect(decisionsCell(decisions)).toBe('2 / 1');
    expect(decisionsCell({ ...decisions, approved: 0, rejected: 0 })).toBe('not yet');
  });
});

describe('the company supervision card at a narrow width', (): void => {
  const html = renderToStaticMarkup(<CompanySupervisionCard figures={FIGURES} />);

  it('never scrolls sideways: no minimum table width and no horizontal scroller', (): void => {
    expect(html).not.toContain('min-w-[640px]');
    expect(html).not.toContain('overflow-x-auto');
  });

  it('stacks both tables below lg, each row a grid whose cells carry their column’s label', (): void => {
    const tables = [...html.matchAll(/<table role="table" class="([^"]*)"/g)].map(
      (match) => match[1],
    );
    expect(tables).toHaveLength(2);
    for (const table of tables) expect(table).toContain('max-lg:block');
    const heads = [...html.matchAll(/<thead role="rowgroup" class="([^"]*)"/g)].map(
      (match) => match[1],
    );
    for (const head of heads) expect(head).toContain('max-lg:sr-only');
    const bodyRows = [...html.matchAll(/<tbody[\s\S]*?<\/tbody>/g)].flatMap(
      (body) => body[0].match(/<tr role="row" class="[^"]*"/g) ?? [],
    );
    expect(bodyRows).toHaveLength(8);
    for (const row of bodyRows) expect(row).toContain('max-lg:grid');
    const labels = [
      ...html.matchAll(
        /<span aria-hidden="true" class="[^"]*lg:hidden[^"]*"><span class="[^"]*">([^<]*)</g,
      ),
    ].map((match) => match[1]);
    expect(labels.slice(0, 5)).toEqual([
      'Charter',
      'Decisions',
      'Decision wait',
      'Actions',
      'Audit trail',
    ]);
    expect(labels).toContain('Skill reuse');
  });

  it('prints each stacked value’s unit beside its label, so a phone reader knows what 12 · 1 · 1 counts', (): void => {
    const stacked = [
      ...html.matchAll(
        /<span aria-hidden="true" class="[^"]*lg:hidden[^"]*">([\s\S]*?)<\/span><\/span>/g,
      ),
    ].map((match) =>
      match[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
    expect(stacked).toContain('Actions automatic changes · approved · held · rejected · refused');
    expect(stacked).toContain('Decisions approved / rejected');
  });

  it('keeps table semantics when the rows stack, with the stacked labels hidden from assistive technology', (): void => {
    expect(html).toMatch(/<table role="table"/);
    expect(html).toMatch(/<tbody role="rowgroup"/);
    expect(html).toMatch(/<tr role="row"/);
    expect(html).toMatch(/<th scope="row" role="rowheader"/);
    expect(html).toMatch(/<td role="cell"/);
    expect(html).toMatch(/<th scope="col" role="columnheader"/);
  });

  it('says "employee" in its manager-facing copy, never "agent" (N29)', (): void => {
    expect(html.replace(/<[^>]+>/g, ' ')).not.toMatch(/\bagents?\b/i);
    expect(html).not.toMatch(/title="[^"]*\bagents?\b/i);
  });

  it('sets no type below the 12 px floor', (): void => {
    expect(html).not.toMatch(/text-\[(9|10|11)px\]/);
  });
});
