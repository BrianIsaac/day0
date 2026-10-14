import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CompanySupervision,
  CompanySupervisionCard,
  decisionsCell,
  PILOT_FIGURES,
  reorientationWords,
} from '../../app/CompanySupervision';
import type { AgentMetrics, OwnerMetrics, PilotFigures } from '../../src/metrics/types';
import type { Id } from '../../convex/_generated/dataModel';

const query = vi.hoisted(() => ({ result: undefined as unknown }));

/** A labelled-set grade, fixed so the cell's words do not move with the tracked grade. */
const GRADED_RECALL = {
  pages: 0.95,
  blocks: 0.9333333333333333,
  cases: 30,
  corpusPages: 17,
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
        partlyDone: 0,
        medianToCompletionMs: null,
        p90ToCompletionMs: null,
      },
      reorientation: {
        cards: { opened: 0, approved: 0, dismissed: 0, deferred: 0 },
        answered: 0,
        amended: 0,
        rate: null,
      },
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

  it('renders nothing until the owner has an employee and the mode is known', (): void => {
    const drawn = (figures: OwnerMetrics | undefined): string =>
      renderToStaticMarkup(<CompanySupervision company={{ figures, coverage: { kind: 'all' } }} />);
    // The one query the card itself reads is the deployment's mode.
    query.result = { mode: 'real', label: 'real' };
    for (const figures of [undefined, { ...FIGURES, employees: [] }]) {
      expect(drawn(figures)).toBe('');
    }
    expect(drawn(FIGURES)).toContain('Company supervision');
    query.result = undefined;
    expect(drawn(FIGURES)).toBe('');
  });

  it('says how many employees its figures are of while every employee is read by pages, then the whole count (RM33 (a))', (): void => {
    // The review's bed 1: the subscribed read keeps twenty of fifty-one.
    const twenty = { ...FIGURES, excludedAgents: 0, omittedEmployees: 31 };
    const reading = renderToStaticMarkup(
      <CompanySupervisionCard figures={twenty} coverage={{ kind: 'reading', read: 20, of: 51 }} />,
    );
    expect(reading).toContain('>20 of 51 read<');
    expect(reading).not.toContain('employees, one manager');
    expect(reading).not.toContain('most recent');

    const every = renderToStaticMarkup(
      <CompanySupervisionCard
        figures={{ ...FIGURES, company: { ...FIGURES.company, employees: 51 }, excludedAgents: 0 }}
        coverage={{ kind: 'every', employees: 51 }}
      />,
    );
    expect(every).toContain('51 employees, one manager');
    expect(every).not.toContain(' read<');
    expect(every).not.toContain('most recent');

    // A read by pages that failed leaves the most recent employees' figures, and says so.
    const recent = renderToStaticMarkup(
      <CompanySupervisionCard figures={twenty} coverage={{ kind: 'recent', read: 20, of: 51 }} />,
    );
    expect(recent).toContain('most recent employees; 31 earlier ones are not counted');
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
                    partlyDone: 0,
                    medianToCompletionMs: 67_000,
                    p90ToCompletionMs: 300_000,
                  },
                  reorientation: {
                    cards: { opened: 0, approved: 0, dismissed: 0, deferred: 0 },
                    answered: 2,
                    amended: 1,
                    rate: 0.5,
                  },
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
    // W16-R32: Hours saved sat alone on its row below the wide breakpoint, between two wide
    // figures; it spans both columns as they do.
    const hoursCell = /<td[^>]*class="([^"]*)"[^>]*>(?:(?!<\/td>).)*Hours saved/s.exec(pilot);
    expect(hoursCell?.[1]).toContain('max-lg:col-span-2');
    const priyaRow = rowOf(pilot, 'Priya');
    expect(priyaRow).toContain('1 of 4 (25%)');
    expect(priyaRow).toContain('1 min 7 s / 5 min (2 done)');
    // Re-pinned for 16-O: the figure counts cards first, and its answers line names what they amended.
    expect(priyaRow).toContain('1 of 2 charter answers amended it');
    expect(priyaRow).toContain('1.5 h over 2 items');
    // No prompt of Priya's carried a selection yet; the recall is the labelled set's grade.
    expect(priyaRow).toContain(
      'no documentation counted yet; recall 95% of pages and 93% of sections on 30 test items over a 17-page test library, graded on 7 October 2026',
    );
    expect(pilot).not.toContain('not measured yet');
    const companyRow = rowOf(pilot, 'Company');
    expect(companyRow).toContain('not yet');
    expect(companyRow).toContain('no estimates yet');
  });
});

describe("the card's header on a phone (Q6, 16-T)", (): void => {
  // 15-Q's phone shot (`wave15-q-2026-10-11-bed/card-phone.png`): at 390 the title and "3
  // employees, one manager" shared one line with a few pixels between them. A column gap keeps
  // them apart, and the count wraps under the title when the line has no room for both.
  it('keeps a gap between the title and the count, and wraps the count under the title when there is no room', (): void => {
    const html = renderToStaticMarkup(<CompanySupervisionCard figures={FIGURES} />);
    const header = /<div class="([^"]*)"><h2[^>]*>Company supervision<\/h2>/.exec(html)?.[1] ?? '';
    expect(header.split(' ')).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'gap-x-4']));
    expect(header).toMatch(/\bgap-y-1\b/);
  });
});

describe('the retrieval figure (14-R)', (): void => {
  it('takes both columns of the stacked grid on a phone, as its words are the longest', (): void => {
    const html = renderToStaticMarkup(<CompanySupervisionCard figures={FIGURES} />);
    const pilot = html.slice(html.indexOf('Pilot figures'));
    const cells =
      pilot.match(
        /<td role="cell" class="[^"]*"><span aria-hidden="true"[^>]*><span[^>]*>Retrieval</g,
      ) ?? [];
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) expect(cell).toContain('max-lg:col-span-2');
  });

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
      '6,210 characters of documentation and 31,403 input tokens billed an item; recall 95% of pages and 93% of sections on 30 test items over a 17-page test library, graded on 7 October 2026',
    );
  });

  it('dates the recall by the day its grade was taken, in UTC, wherever the page is read', (): void => {
    const lateInTheDay = { ...GRADED_RECALL, gradedAt: '2026-10-11T23:59:59.000Z' };
    expect(retrievalFigure.value(figures({ tokens: null, recall: lateInTheDay }))).toBe(
      'no documentation counted yet; recall 95% of pages and 93% of sections on 30 test items over a 17-page test library, graded on 11 October 2026',
    );
    expect(retrievalFigure.definition).toContain(
      'graded on the day shown with the search Day0 itself runs',
    );
  });

  it('says no recall where no selection ran, as on the hosted mock office or a backend before 0.18.0 (W14-R6)', (): void => {
    expect(retrievalFigure.value(figures({ tokens: null, recall: null }))).toBe(
      'no documentation counted yet',
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
    ).toBe(
      '980 characters of documentation an item; recall 95% of pages and 93% of sections on 30 test items over a 17-page test library, graded on 7 October 2026',
    );
  });
});

describe('the retrieval figure where no selection ran (RM25 (a), the v0.19.0 walk’s finding 5)', (): void => {
  const SENTENCE =
    'The hosted office’s employees read its few seeded pages whole, so nothing here is selected or graded. A linked library is selected from, and graded.';
  const unselected: OwnerMetrics = {
    ...FIGURES,
    employees: FIGURES.employees.map((employee) => ({
      ...employee,
      metrics: {
        ...employee.metrics,
        pilot: { ...employee.metrics.pilot, retrieval: { tokens: null, recall: null } },
      },
    })),
    company: {
      ...FIGURES.company,
      pilot: { ...FIGURES.company.pilot, retrieval: { tokens: null, recall: null } },
    },
  };

  it('says why once on the hosted office, where every row read "no documentation counted yet"', (): void => {
    const html = renderToStaticMarkup(<CompanySupervisionCard figures={unselected} mode="mock" />);
    expect(html).toContain(SENTENCE);
    expect(html.split(SENTENCE)).toHaveLength(2);
    expect(html).not.toContain('no documentation counted yet');
    expect(rowOf(html.slice(html.indexOf('Pilot figures')), 'Company')).toContain('none selected');
  });

  it('keeps the rows’ own words where a library can be linked, or where a selection ran', (): void => {
    const real = renderToStaticMarkup(<CompanySupervisionCard figures={unselected} mode="real" />);
    expect(real).not.toContain(SENTENCE);
    expect(real).toContain('no documentation counted yet');
    const selected = renderToStaticMarkup(<CompanySupervisionCard figures={FIGURES} mode="mock" />);
    expect(selected).not.toContain(SENTENCE);
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

describe('the cycle time counts done answers, partly done named beside (RM23 (a))', (): void => {
  const cycle = PILOT_FIGURES[1];
  const figures = (cycleTime: PilotFigures['cycleTime']): PilotFigures => ({
    ...FIGURES.company.pilot,
    cycleTime,
  });

  it('prints the walk’s company as four done with five partly done beside, not nine done', (): void => {
    expect(cycle?.label).toBe('Cycle time');
    expect(
      cycle?.value(
        figures({
          ended: 12,
          medianToEndMs: 60_000,
          completed: 4,
          partlyDone: 5,
          medianToCompletionMs: 1_081_000,
          p90ToCompletionMs: 1_212_000,
        }),
      ),
    ).toBe('18 min 1 s / 20 min 12 s (4\u00a0done, 5\u00a0partly done)');
  });

  it('says partly done work where none was done, and nothing of it where there is none', (): void => {
    expect(
      cycle?.value(
        figures({
          ended: 2,
          medianToEndMs: 60_000,
          completed: 0,
          partlyDone: 2,
          medianToCompletionMs: null,
          p90ToCompletionMs: null,
        }),
      ),
    ).toBe('none done; 2 items ended after 1 min (2\u00a0partly done)');
    expect(
      cycle?.value(
        figures({
          ended: 1,
          medianToEndMs: 60_000,
          completed: 1,
          partlyDone: 0,
          medianToCompletionMs: 60_000,
          p90ToCompletionMs: 60_000,
        }),
      ),
    ).toBe('1 min / 1 min (1\u00a0done)');
  });

  it('defines the cycle time over the items whose run answered done', (): void => {
    expect(cycle?.definition).toBe(
      'From the ask (the provider’s own time when intake had one) to the item’s first completion, over the items whose run answered that the work was done. Items finished partly done are counted beside it.',
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

describe('the reorientation figure in words (16-O; A9)', (): void => {
  const none = { opened: 0, approved: 0, dismissed: 0, deferred: 0 };
  it('says the cards and what was decided on them, then the answers, and not yet with neither', (): void => {
    expect(reorientationWords({ cards: none, answered: 0, amended: 0, rate: null })).toBe(
      'not yet',
    );
    expect(
      reorientationWords({
        cards: { opened: 3, approved: 1, dismissed: 1, deferred: 1 },
        answered: 0,
        amended: 0,
        rate: null,
      }),
    ).toBe('3 cards: 1 approved, 1 dismissed, 1 deferred');
    expect(
      reorientationWords({
        cards: { opened: 1, approved: 1, dismissed: 0, deferred: 0 },
        answered: 2,
        amended: 1,
        rate: 0.5,
      }),
    ).toBe('1 card: 1 approved, 0 dismissed, 0 deferred; 1 of 2 charter answers amended it');
    // A backend older than 0.20.0 counts no cards (mid-redeploy): its line is the answers alone.
    expect(reorientationWords({ answered: 2, amended: 1, rate: 0.5 })).toBe(
      '1 of 2 charter answers amended it',
    );
  });
});
