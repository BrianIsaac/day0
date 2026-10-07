'use client';

import type { ReactNode } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { AgentMetrics, OwnerMetrics, PilotFigures } from '@/metrics/types';
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
  const chars = `${Math.round(tokens.charsPerItem).toLocaleString('en-GB')} characters of documentation an item`;
  return tokens.inputTokensPerItem === null
    ? chars
    : `${chars}; ${Math.round(tokens.inputTokensPerItem).toLocaleString('en-GB')} input tokens billed an item`;
}

/** One of decision A9's pilot figures as the Supervision cards print it. */
export interface PilotFigure {
  readonly label: string;
  readonly unit: string;
  readonly definition: string;
  readonly value: (pilot: PilotFigures) => string;
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
      'From the ask (the provider’s own time when intake had one) to the item’s first completion, over the items completed.',
    value: ({ cycleTime }) =>
      cycleTime.completed === 0
        ? cycleTime.ended === 0
          ? 'not yet'
          : `none done; ${count(cycleTime.ended, 'item')} ended after ${formatMetricDuration(cycleTime.medianToEndMs)}`
        : `${formatMetricDuration(cycleTime.medianToCompletionMs)} / ${formatMetricDuration(cycleTime.p90ToCompletionMs)} (${cycleTime.completed} done)`,
  },
  {
    label: 'Reorientation',
    unit: 'answers that changed the charter',
    definition:
      'The charter questions the manager answered, and how many of the answers amended it.',
    value: ({ reorientation }) =>
      reorientation.answered === 0
        ? 'not yet'
        : `${reorientation.amended} of ${count(reorientation.answered, 'answer')}`,
  },
  {
    label: 'Hours saved',
    unit: 'your estimates, internal gauge',
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
    definition:
      'The characters of documentation the model was given for an item, beside the input tokens billed for the item where the provider reported them. Recall is a test result: on the labelled test items, where people marked the pages and sections they would open, the share Day0 chose too.',
    value: ({ retrieval }) =>
      `${retrievalRead(retrieval.tokens)}; ${
        retrieval.recall === null
          ? 'recall not tested yet'
          : `recall ${Math.round(retrieval.recall.pages * 100)}% of pages and ${Math.round(retrieval.recall.blocks * 100)}% of sections on ${retrieval.recall.cases} test items`
      }`,
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
function PilotFiguresTable({ figures }: { figures: OwnerMetrics }) {
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
                <td key={figure.label} role="cell" className={CELL}>
                  <StackLabel column={figure} />
                  {figure.value(row.pilot)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The company's supervision figures: one row per employee and a company
 * row, as `metrics:forOwner` computes them. At `lg` each is a table; below
 * it every row stacks with its cells labelled, so the card never scrolls
 * sideways.
 *
 * @param figures - The owner's figures.
 */
export function CompanySupervisionCard({ figures }: { figures: OwnerMetrics }) {
  const { company } = figures;
  const notes = [
    figures.excludedAgents > 0
      ? `${count(figures.excludedAgents, 'evaluation employee')} left out`
      : null,
    figures.omittedEmployees > 0
      ? `Covers the ${company.employees} most recent employees; ${count(figures.omittedEmployees, 'earlier one', 'earlier ones')} ${figures.omittedEmployees === 1 ? 'is' : 'are'} not counted`
      : null,
    company.actions.sessionRestores > 0
      ? `${count(company.actions.sessionRestores, 'browser call')} replayed to sign in again, on the audit trail and never automatic`
      : null,
  ].filter((note): note is string => note !== null);
  return (
    <section className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-card)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4">
        <h2 className="text-sm font-semibold">Company supervision</h2>
        <span className="text-xs text-[var(--color-muted)]">
          {count(company.employees, 'employee')}, one manager
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
      <PilotFiguresTable figures={figures} />
      {notes.length > 0 ? (
        <p className="border-t border-[var(--color-border)] px-5 py-2 text-xs leading-relaxed text-[var(--color-muted)]">
          {notes.join(' · ')}
        </p>
      ) : null}
    </section>
  );
}

/** The company supervision card for the signed-in owner, once there is an employee. */
export function CompanySupervision() {
  const figures = useQuery(api.metrics.forOwner);
  if (!figures || figures.employees.length === 0) return null;
  return <CompanySupervisionCard figures={figures} />;
}
