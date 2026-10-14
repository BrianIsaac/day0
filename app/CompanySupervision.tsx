'use client';

import type { ReactNode } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { dayLabelAt } from '@/demo/day-label';
import type { AgentMetrics, OwnerMetrics, PilotFigures } from '@/metrics/types';
import { coverageLine, type CompanyCoverage } from './home/company-coverage';
import type { CompanyFigures } from './home/use-company-figures';
import { decidedCount, formatAuditTrail, formatMetricDuration } from './metric-format';

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
];

/** What each figure means, as its label's tooltip says it. */
export const DEFINITIONS = {
  charter:
    'Time from deploy to the employee’s first approved charter. The company row quotes each employee’s time and their median, never a sum.',
  decisions:
    'Plans and actions the manager approved or rejected, pooled across employees, because one manager made them.',
  wait: 'How long each decision waited for the manager, median and 90th percentile. The company row takes both over every decision pooled, the one manager’s distribution, not a median of the employees’ medians.',
  actions:
    'Automatic changes: writes to a system applied without asking, under standing or autonomous authority. Reads and messages to the manager also apply on their own and are counted on the line below, never as changes; a browser call replayed to sign in again is never an automatic action. Approved: approved by the manager. Held: waiting for the manager. Rejected: rejected by the manager. Refused: blocked by the gate or a missing grant.',
  audit:
    'Landed ledger rows that carry their tool, authority, effect, run and idempotency key, over every landed row, replayed browser calls included. The company row pools every employee’s rows.',
  company: 'Every employee above, pooled. Evaluation employees and baseline arms are left out.',
} as const;

interface Column {
  readonly label: string;
  readonly unit: string;
  readonly definition: string;
}

/** The supervision table's columns after the employee, by figure. */
const COLUMN = {
  charter: { label: 'Charter', unit: 'approved after', definition: DEFINITIONS.charter },
  decisions: { label: 'Decisions', unit: 'approved / rejected', definition: DEFINITIONS.decisions },
  wait: { label: 'Decision wait', unit: 'median / p90', definition: DEFINITIONS.wait },
  actions: {
    label: 'Actions',
    unit: 'automatic changes · approved · held · rejected · refused',
    definition: DEFINITIONS.actions,
  },
  audit: { label: 'Audit trail', unit: 'complete', definition: DEFINITIONS.audit },
} as const satisfies Record<string, Column>;

const COLUMNS: readonly Column[] = [
  COLUMN.charter,
  COLUMN.decisions,
  COLUMN.wait,
  COLUMN.actions,
  COLUMN.audit,
];

function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}

function inWords(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

/** The decisions a row quotes: approved over rejected, or "not yet" before the first one. */
export function decisionsCell(decisions: AgentMetrics['decisions']): string {
  return decidedCount(decisions) === 0
    ? 'not yet'
    : `${decisions.approved} / ${decisions.rejected}`;
}

/** The decision wait a row quotes: median over 90th percentile, or "not yet". */
export function waitCell(decisions: AgentMetrics['decisions']): string {
  return decisions.medianLatencyMs === null
    ? 'not yet'
    : `${formatMetricDuration(decisions.medianLatencyMs)} / ${formatMetricDuration(decisions.p90LatencyMs)}`;
}

function actionsCell(actions: AgentMetrics['actions']): string {
  return `${actions.automatic.writes} · ${actions.approved} · ${actions.held} · ${actions.rejected} · ${actions.refused}`;
}

/**
 * What applied on its own besides the automatic changes: the reads and the
 * messages to the manager (U12 D4 (b)), which change nothing in a system.
 *
 * Args:
 *   automatic: The automatic rows by what they did.
 *
 * Returns:
 *   For example "12 reads, 1 manager message".
 */
export function readsAndMessages(automatic: AgentMetrics['actions']['automatic']): string {
  return `${count(automatic.reads, 'read')}, ${count(automatic.managerMessages, 'manager message')}`;
}

/** Hours from the manager's own estimates, to one decimal place. */
function hours(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} h`;
}

/** The documentation an item read, and the input tokens billed an item where a provider reported them. */
function retrievalRead(tokens: PilotFigures['retrieval']['tokens']): string {
  if (tokens === null) return 'no documentation counted yet';
  const chars = Math.round(tokens.charsPerItem).toLocaleString('en-GB');
  if (tokens.inputTokensPerItem === null) return `${chars} characters of documentation an item`;
  return `${chars} characters of documentation and ${Math.round(tokens.inputTokensPerItem).toLocaleString('en-GB')} input tokens billed an item`;
}

/** One of decision A9's pilot figures as the Supervision cards print it. */
export interface PilotFigure {
  readonly label: string;
  readonly unit: string;
  readonly definition: string;
  readonly value: (pilot: PilotFigures) => string;
  /** Whether its cell takes both columns of the stacked grid below `lg`: its words run long. */
  readonly wide?: boolean;
}

/**
 * The reorientation figure in words (16-O): the cards and what was decided on them, then the
 * charter answers as before, so a release that had no cards still reads the same line.
 */
export function reorientationWords(reorientation: PilotFigures['reorientation']): string {
  // A backend older than 0.20.0 counts no cards (mid-redeploy): its line is the answers alone.
  const cards = reorientation.cards ?? { opened: 0, approved: 0, dismissed: 0, deferred: 0 };
  const opened =
    cards.opened === 0
      ? undefined
      : `${count(cards.opened, 'card')}: ${cards.approved} approved, ${cards.dismissed} dismissed, ${cards.deferred} deferred`;
  const answers =
    reorientation.answered === 0
      ? undefined
      : `${reorientation.amended} of ${count(reorientation.answered, 'charter answer')} amended it`;
  if (opened === undefined && answers === undefined) return 'not yet';
  return [opened, answers].filter((words) => words !== undefined).join('; ');
}

/**
 * Decision A9's five pilot figures, each recomputable from an exported
 * trace (`metrics:recompute`). Hours saved is the manager's own estimate
 * summed over finished work: an internal gauge, never a headline (N11).
 */
export const PILOT_FIGURES: readonly PilotFigure[] = [
  {
    label: 'Skill reuse',
    unit: 'runs with a skill made for other work',
    definition:
      'Of the distinct work item and skill runs, those run with a skill first made for another item. Runs of a skill adopted from another employee count as reuse, and are shown as adopted.',
    value: ({ skillReuse }) =>
      skillReuse.runs === 0 || skillReuse.rate === null
        ? 'not yet'
        : `${skillReuse.reused} of ${skillReuse.runs} (${Math.round(skillReuse.rate * 100)}%)${
            skillReuse.adopted > 0 ? `, ${skillReuse.adopted} adopted` : ''
          }`,
  },
  {
    label: 'Cycle time',
    unit: 'ask to done, median / p90',
    definition:
      'From the ask (the provider’s own time when intake had one) to the item’s first completion, over the items whose run answered that the work was done. Items finished partly done are counted beside it.',
    // One reading, the run's answer (RM23 (a)): partly done work is named beside the done, never
    // counted in it. A figure pushed before the field has no partly done to name.
    value: ({ cycleTime }) => {
      // A count keeps its word on its line: at 390 "(1" broke from "done)" (the 16-F bed).
      const partly = cycleTime.partlyDone ?? 0;
      if (cycleTime.completed === 0) {
        if (cycleTime.ended === 0) return 'not yet';
        const ended = `none done; ${count(cycleTime.ended, 'item')} ended after ${formatMetricDuration(cycleTime.medianToEndMs)}`;
        return partly > 0 ? `${ended} (${partly}\u00a0partly done)` : ended;
      }
      const done =
        partly > 0
          ? `${cycleTime.completed}\u00a0done, ${partly}\u00a0partly done`
          : `${cycleTime.completed}\u00a0done`;
      return `${formatMetricDuration(cycleTime.medianToCompletionMs)} / ${formatMetricDuration(cycleTime.p90ToCompletionMs)} (${done})`;
    },
  },
  {
    label: 'Reorientation',
    unit: 'cards decided, and answers that changed the charter',
    wide: true,
    definition:
      'The reorientation cards opened when something an employee relies on changed, and what you decided on them; beside them, the charter questions you answered and how many of the answers amended the charter.',
    value: ({ reorientation }) => reorientationWords(reorientation),
  },
  {
    label: 'Hours saved',
    unit: 'your estimates, internal gauge',
    // Between two wide figures it sat alone on its row below the wide breakpoint (W16-R32).
    wide: true,
    definition:
      'The minutes you estimated a plan would have taken you, summed over completed items. An internal gauge for you, never a headline figure.',
    value: ({ hoursSaved }) =>
      hoursSaved.hours === null
        ? 'no estimates yet'
        : `${hours(hoursSaved.hours)} over ${count(hoursSaved.estimatedItems, 'item')}`,
  },
  {
    label: 'Retrieval',
    unit: 'documentation read per item, and recall',
    wide: true,
    definition:
      'The characters of documentation the model was given for an item, beside the input tokens billed for the item where the provider reported them. Recall is a test result: on the labelled test items, where people marked the pages and sections they would open, the share Day0 chose too, graded on the day shown with the search Day0 itself runs.',
    value: ({ retrieval }) =>
      retrieval.recall === null
        ? retrievalRead(retrieval.tokens)
        : `${retrievalRead(retrieval.tokens)}; recall ${Math.round(retrieval.recall.pages * 100)}% of pages and ${Math.round(retrieval.recall.blocks * 100)}% of sections on ${retrieval.recall.cases} test items over a ${retrieval.recall.corpusPages}-page test library, graded on ${dayLabelAt(Date.parse(retrieval.recall.gradedAt), 'UTC')}`,
  },
];

/** The label and unit a stacked row prints above a cell's value, hidden where the table has its header. */
function StackLabel({ column }: { column: Column }) {
  // The header row carries the same words for assistive technology, so this copy is visual only.
  return (
    <span aria-hidden="true" className="mb-0.5 block font-sans text-xs lg:hidden">
      <span className="block text-[var(--color-muted)]">{column.label}</span>
      <span className="block text-[var(--color-muted)]/80">{column.unit}</span>
    </span>
  );
}

/** Classes for a cell that sits in a table row at `lg` and in a stacked grid below it. */
const CELL = 'px-3 py-2.5 align-top max-lg:p-0';

/** Classes for a body row: a table row at `lg`, a two-column grid below it. */
const ROW =
  'max-lg:grid max-lg:grid-cols-2 max-lg:gap-x-4 max-lg:gap-y-2.5 max-lg:px-5 max-lg:py-3.5';

/** Classes for a row's employee header: its own full line when stacked. */
const ROW_HEADER =
  'px-5 py-2.5 text-left align-top font-sans font-semibold max-lg:col-span-2 max-lg:p-0';

function FigureCells({
  charter,
  decisions,
  actions,
  auditTrail,
}: {
  charter: ReactNode;
  decisions: AgentMetrics['decisions'];
  actions: AgentMetrics['actions'];
  auditTrail: AgentMetrics['auditTrail'];
}) {
  return (
    <>
      <td role="cell" className={`${CELL} max-lg:col-span-2`}>
        <StackLabel column={COLUMN.charter} />
        {charter}
      </td>
      <td role="cell" className={`${CELL} whitespace-nowrap`}>
        <StackLabel column={COLUMN.decisions} />
        {decisionsCell(decisions)}
      </td>
      <td role="cell" className={`${CELL} whitespace-nowrap`}>
        <StackLabel column={COLUMN.wait} />
        {waitCell(decisions)}
      </td>
      <td role="cell" className={CELL}>
        <StackLabel column={COLUMN.actions} />
        <span className="block whitespace-nowrap">{actionsCell(actions)}</span>
        <span className="block text-[var(--color-muted)]">
          + {readsAndMessages(actions.automatic)}
        </span>
      </td>
      <td role="cell" className={`${CELL} whitespace-nowrap`}>
        <StackLabel column={COLUMN.audit} />
        {formatAuditTrail(auditTrail)}
      </td>
    </>
  );
}

function CompanyCharterCell({ charter }: { charter: OwnerMetrics['company']['charter'] }) {
  // A line may break between two employees' times, never inside one.
  const times = charter.timesToFirstApprovedMs.map((time, index) => (
    <span key={index}>
      {index > 0 ? ' · ' : null}
      <span className="whitespace-nowrap">
        {time === null ? 'pending' : formatMetricDuration(time)}
      </span>
    </span>
  ));
  return (
    <>
      <span className="block">{times}</span>
      {charter.approvedEmployees > 1 ? (
        <span className="block whitespace-nowrap text-[var(--color-muted)]">
          median of {inWords(charter.approvedEmployees)}:{' '}
          {formatMetricDuration(charter.medianTimeToFirstApprovedMs)}
        </span>
      ) : null}
    </>
  );
}

/** A column header: the figure's name, its unit, and its definition as the tooltip. */
function ColumnHeader({ column }: { column: Column }) {
  return (
    <th
      scope="col"
      role="columnheader"
      title={column.definition}
      className="cursor-help px-3 py-2 align-bottom font-medium"
    >
      <span className="block underline decoration-dotted underline-offset-2">{column.label}</span>
      <span className="block normal-case tracking-normal">{column.unit}</span>
    </th>
  );
}

/** The header row both tables share: the employee, then one header per figure. */
function HeaderRow({ columns }: { columns: readonly Column[] }) {
  return (
    <thead role="rowgroup" className="max-lg:sr-only">
      <tr
        role="row"
        className="border-b border-[var(--color-border)] text-xs uppercase tracking-wider text-[var(--color-muted)]"
      >
        <th scope="col" role="columnheader" className="px-5 py-2 align-bottom font-medium">
          Employee
        </th>
        {columns.map((column) => (
          <ColumnHeader key={column.label} column={column} />
        ))}
      </tr>
    </thead>
  );
}

/** Classes for one of the card's tables: a table at `lg`, stacked rows below it. */
const TABLE = 'w-full text-left text-xs tabular-nums max-lg:block';

/** Classes for a table body: the rows stack below `lg`. */
const BODY = 'font-mono text-[var(--color-fg)] max-lg:block';

/** Classes for the company row, set apart from the employees above it. */
const COMPANY_ROW = `bg-[var(--color-bg)]/60 ${ROW}`;

/** Classes for an employee's row. */
const EMPLOYEE_ROW = `border-b border-[var(--color-border)] ${ROW}`;

/**
 * The five pilot figures (A9), one row per employee and a company row pooled
 * before any median or rate is taken, beside the supervision figures.
 */
function PilotFiguresTable({
  figures,
  unselected,
}: {
  figures: OwnerMetrics;
  unselected: boolean;
}) {
  const rows = [
    ...figures.employees.map((employee) => ({
      key: String(employee.agentId),
      name: employee.name,
      pilot: employee.metrics.pilot,
    })),
    { key: 'company', name: 'Company', pilot: figures.company.pilot },
  ];
  return (
    <div className="border-t border-[var(--color-border)]">
      <table role="table" className={TABLE}>
        <caption className="px-5 pt-3 text-left text-xs uppercase tracking-wider text-[var(--color-muted)] max-lg:block">
          Pilot figures
        </caption>
        <HeaderRow columns={PILOT_FIGURES} />
        <tbody role="rowgroup" className={BODY}>
          {rows.map((row) => (
            <tr
              key={row.key}
              role="row"
              className={row.key === 'company' ? COMPANY_ROW : EMPLOYEE_ROW}
            >
              <th scope="row" role="rowheader" className={ROW_HEADER}>
                {row.name}
              </th>
              {PILOT_FIGURES.map((figure) => (
                <td
                  key={figure.label}
                  role="cell"
                  className={figure.wide === true ? `${CELL} max-lg:col-span-2` : CELL}
                >
                  <StackLabel column={figure} />
                  {unselected && figure.label === 'Retrieval'
                    ? 'none selected'
                    : figure.value(row.pilot)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {unselected ? (
        <p className="px-5 pb-3 text-xs leading-relaxed text-[var(--color-muted)]">
          {NO_SELECTION_SENTENCE}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Why the retrieval figure is empty on the hosted office, said once (RM25 (a); section 7's draft,
 * RM24): its employees read the few seeded pages whole, so the selector never runs and nothing is
 * graded. On the v0.19.0 walk every row read "no documentation counted yet" after nine runs.
 */
export const NO_SELECTION_SENTENCE =
  'The hosted office’s employees read its few seeded pages whole, so nothing here is selected or graded. A linked library is selected from, and graded.';

/**
 * The company's supervision figures: one row per employee and a company
 * row, as `metrics:forOwner` computes them. At `lg` each is a table; below
 * it every row stacks with its cells labelled, so the card never scrolls
 * sideways. On the hosted office, where no selection ever runs, the retrieval
 * column says so in one sentence under the table instead of on every row.
 *
 * @param figures - The owner's figures.
 * @param mode - The deployment's surface mode, once read.
 * @param coverage - Which employees the figures cover (wave 17, RM33 (a)): while every employee
 *   is being read by pages the card says how many of them its figures are of.
 */
export function CompanySupervisionCard({
  figures,
  mode,
  coverage = { kind: 'all' },
}: {
  figures: OwnerMetrics;
  mode?: 'mock' | 'real';
  coverage?: CompanyCoverage;
}) {
  const { company } = figures;
  const reading = coverage.kind === 'reading' ? coverageLine(coverage) : undefined;
  const unselected =
    mode === 'mock' &&
    company.pilot.retrieval.tokens === null &&
    company.pilot.retrieval.recall === null;
  const notes = [
    figures.excludedAgents > 0
      ? `${count(figures.excludedAgents, 'evaluation employee')} left out`
      : null,
    // While the rest are being read the card's head says so; the note is for figures that stay
    // the most recent employees' (a read by pages that failed).
    figures.omittedEmployees > 0 && reading === undefined
      ? `Covers the ${company.employees} most recent employees; ${count(figures.omittedEmployees, 'earlier one', 'earlier ones')} ${figures.omittedEmployees === 1 ? 'is' : 'are'} not counted`
      : null,
    company.actions.sessionRestores > 0
      ? `${count(company.actions.sessionRestores, 'browser call')} replayed to sign in again, on the audit trail and never automatic`
      : null,
  ].filter((note): note is string => note !== null);
  return (
    <section className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-card)]">
      {/* A column gap, and the count wrapping under the title, so the two never run together
          on a phone (Q6). */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-[var(--color-border)] px-5 py-4">
        <h2 className="text-sm font-semibold">Company supervision</h2>
        <span className="text-xs text-[var(--color-muted)]">
          {reading ?? `${count(company.employees, 'employee')}, one manager`}
        </span>
      </div>
      <table role="table" className={TABLE} aria-label="Company supervision">
        <HeaderRow columns={COLUMNS} />
        <tbody role="rowgroup" className={BODY}>
          {figures.employees.map((employee) => (
            <tr key={employee.agentId} role="row" className={EMPLOYEE_ROW}>
              <th scope="row" role="rowheader" className={ROW_HEADER}>
                {employee.name}
              </th>
              <FigureCells
                charter={
                  <span className="whitespace-nowrap">
                    {formatMetricDuration(employee.metrics.charter.timeToFirstApprovedMs)}
                  </span>
                }
                decisions={employee.metrics.decisions}
                actions={employee.metrics.actions}
                auditTrail={employee.metrics.auditTrail}
              />
            </tr>
          ))}
          <tr role="row" className={COMPANY_ROW}>
            <th
              scope="row"
              role="rowheader"
              title={DEFINITIONS.company}
              className={`${ROW_HEADER} cursor-help underline decoration-dotted underline-offset-2`}
            >
              Company
            </th>
            <FigureCells
              charter={<CompanyCharterCell charter={company.charter} />}
              decisions={company.decisions}
              actions={company.actions}
              auditTrail={company.auditTrail}
            />
          </tr>
        </tbody>
      </table>
      <PilotFiguresTable figures={figures} unselected={unselected} />
      {notes.length > 0 ? (
        <p className="border-t border-[var(--color-border)] px-5 py-2 text-xs leading-relaxed text-[var(--color-muted)]">
          {notes.join(' · ')}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The company supervision card for the signed-in owner, once there is an employee.
 *
 * @param company - The company's figures as the home read them, and which employees they cover.
 */
export function CompanySupervision({ company }: { company: CompanyFigures }) {
  const { figures, coverage } = company;
  const surface = useQuery(api.config.surfaceMode);
  // Drawn once the mode is known, so the retrieval column never changes its words under the
  // reader (the second pass's finding 10): the mode decides whether it says why it is empty.
  if (!figures || figures.employees.length === 0 || surface === undefined) return null;
  return <CompanySupervisionCard figures={figures} mode={surface.mode} coverage={coverage} />;
}
