'use client';

import type { ReactNode } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { AgentMetrics, OwnerMetrics, PilotFigures } from '@/metrics/types';
import { formatAuditTrail, formatMetricDuration } from './metric-format';

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
const DEFINITIONS = {
  charter:
    'Time from deploy to the employee’s first approved charter. The company row quotes each employee’s time and their median, never a sum.',
  decisions:
    'Plans and actions the manager approved or rejected, pooled across employees, because one manager made them.',
  wait: 'How long each decision waited for the manager, median and 90th percentile. The company row takes both over every decision pooled, the one manager’s distribution, not a median of the employees’ medians.',
  actions:
    'Automatic changes: writes to a system applied without asking, under standing or autonomous authority. Reads and messages to the manager also apply on their own and are counted on the line below, never as changes; a browser call replayed to sign in again is never an automatic action. Approved: approved by the manager. Held: waiting for the manager. Rejected: rejected by the manager. Refused: blocked by the gate or a missing grant.',
  audit:
    'Landed ledger rows that carry their tool, authority, effect, run and idempotency key, over every landed row, replayed browser calls included. The company row pools every employee’s rows.',
  company: 'Every employee above, pooled. Evaluation agents and baseline arms are left out.',
} as const;

interface Column {
  label: string;
  unit: string;
  definition: string;
  width?: string;
}

const COLUMNS: readonly Column[] = [
  // Wide enough for the company row to quote three times on one line.
  { label: 'Charter', unit: 'approved after', definition: DEFINITIONS.charter, width: 'w-[17rem]' },
  { label: 'Decisions', unit: 'approved / rejected', definition: DEFINITIONS.decisions },
  { label: 'Decision wait', unit: 'median / p90', definition: DEFINITIONS.wait },
  {
    label: 'Actions',
    unit: 'automatic changes · approved · held · rejected · refused',
    definition: DEFINITIONS.actions,
  },
  { label: 'Audit trail', unit: 'complete', definition: DEFINITIONS.audit },
];

function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}

function inWords(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

function decisionsCell(decisions: AgentMetrics['decisions']): string {
  return decisions.requested === 0 ? 'not yet' : `${decisions.approved} / ${decisions.rejected}`;
}

function waitCell(decisions: AgentMetrics['decisions']): string {
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
      'Of the distinct work item and skill runs, those run with a skill first made for another item.',
    value: ({ skillReuse }) =>
      skillReuse.runs === 0 || skillReuse.rate === null
        ? 'not yet'
        : `${skillReuse.reused} of ${skillReuse.runs} (${Math.round(skillReuse.rate * 100)}%)`,
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
    unit: 'tokens read',
    definition:
      'Counted once each run records the documentation blocks it selected and the provider’s usage; not measured yet.',
    value: () => 'not measured yet',
  },
];

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
      <td className="px-3 py-2.5 align-top">{charter}</td>
      <td className="whitespace-nowrap px-3 py-2.5 align-top">{decisionsCell(decisions)}</td>
      <td className="whitespace-nowrap px-3 py-2.5 align-top">{waitCell(decisions)}</td>
      <td className="whitespace-nowrap px-3 py-2.5 align-top">
        <span className="block">{actionsCell(actions)}</span>
        <span className="block text-[var(--color-muted)]">
          + {readsAndMessages(actions.automatic)}
        </span>
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 align-top">{formatAuditTrail(auditTrail)}</td>
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
    <div className="overflow-x-auto border-t border-[var(--color-border)]">
      <table className="w-full min-w-[640px] text-left text-xs tabular-nums">
        <caption className="px-5 pt-3 text-left text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
          Pilot figures
        </caption>
        <thead>
          <tr className="border-b border-[var(--color-border)] text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
            <th scope="col" className="px-5 py-2 align-bottom font-medium">
              Employee
            </th>
            {PILOT_FIGURES.map((figure) => (
              <th
                key={figure.label}
                scope="col"
                title={figure.definition}
                className="cursor-help px-3 py-2 align-bottom font-medium"
              >
                <span className="block underline decoration-dotted underline-offset-2">
                  {figure.label}
                </span>
                <span className="block normal-case tracking-normal">{figure.unit}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono text-[var(--color-fg)]">
          {rows.map((row) => (
            <tr
              key={row.key}
              className={
                row.key === 'company'
                  ? 'bg-[var(--color-bg)]/60'
                  : 'border-b border-[var(--color-border)]'
              }
            >
              <th scope="row" className="px-5 py-2.5 align-top font-sans font-semibold">
                {row.name}
              </th>
              {PILOT_FIGURES.map((figure) => (
                <td key={figure.label} className="px-3 py-2.5 align-top">
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
 * row, as `metrics:forOwner` computes them.
 *
 * Args:
 *   figures: The owner's figures.
 */
export function CompanySupervisionCard({ figures }: { figures: OwnerMetrics }) {
  const { company } = figures;
  const notes = [
    figures.excludedAgents > 0
      ? `${count(figures.excludedAgents, 'evaluation agent')} left out`
      : null,
    figures.omittedEmployees > 0
      ? `Covers the ${company.employees} most recent employees; ${count(figures.omittedEmployees, 'earlier one', 'earlier ones')} ${figures.omittedEmployees === 1 ? 'is' : 'are'} not counted`
      : null,
    company.actions.sessionRestores > 0
      ? `${count(company.actions.sessionRestores, 'browser call')} replayed to sign in again, on the audit trail and never automatic`
      : null,
  ].filter((note): note is string => note !== null);
  return (
    <section className="mb-6 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-card)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4">
        <h2 className="text-sm font-semibold">Company supervision</h2>
        <span className="text-[10px] text-[var(--color-muted)]">
          {count(company.employees, 'employee')}, one manager
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-xs tabular-nums">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
              <th scope="col" className="px-5 py-2 align-bottom font-medium">
                Employee
              </th>
              {COLUMNS.map((column) => (
                <th
                  key={column.label}
                  scope="col"
                  title={column.definition}
                  className={`cursor-help px-3 py-2 align-bottom font-medium ${column.width ?? ''}`}
                >
                  <span className="block underline decoration-dotted underline-offset-2">
                    {column.label}
                  </span>
                  <span className="block normal-case tracking-normal">{column.unit}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="font-mono text-[var(--color-fg)]">
            {figures.employees.map((employee) => (
              <tr key={employee.agentId} className="border-b border-[var(--color-border)]">
                <th scope="row" className="px-5 py-2.5 align-top font-sans font-semibold">
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
            <tr className="bg-[var(--color-bg)]/60">
              <th
                scope="row"
                title={DEFINITIONS.company}
                className="cursor-help px-5 py-2.5 align-top font-sans font-semibold underline decoration-dotted underline-offset-2"
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
      </div>
      <PilotFiguresTable figures={figures} />
      {notes.length > 0 ? (
        <p className="border-t border-[var(--color-border)] px-5 py-2 text-[10px] leading-relaxed text-[var(--color-muted)]">
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
