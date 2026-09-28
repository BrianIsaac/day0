import type { ReactNode } from 'react';
import type { OwnerMetrics } from '@/metrics/types';
import { formatAuditTrail } from '../metric-format';
import { DEFINITIONS, readsAndMessages, waitCell } from '../CompanySupervision';

/** One term of the figures, with its definition as the term's tooltip. */
interface Figure {
  readonly term: string;
  /** What the value quotes, where the term alone does not say. */
  readonly unit?: string;
  readonly definition: string;
  readonly value: ReactNode;
}

/**
 * The company's supervision figures beside the month, as `metrics:forOwner`
 * pools them over every employee: the decisions and their wait, what applied
 * on its own, what was held and how it ended, and the audit trail. Counts,
 * not rates.
 *
 * @param company - The company row of the owner's figures.
 */
export function SupervisionFigures({ company }: { company: OwnerMetrics['company'] }) {
  const { decisions, actions } = company;
  const figures: readonly Figure[] = [
    {
      term: 'Decisions',
      definition: DEFINITIONS.decisions,
      value:
        decisions.requested === 0
          ? 'not yet'
          : `${decisions.approved} approved, ${decisions.rejected} rejected`,
    },
    {
      term: 'Decision wait',
      unit: 'median / p90',
      definition: DEFINITIONS.wait,
      value: waitCell(decisions),
    },
    {
      term: 'Automatic changes',
      definition: DEFINITIONS.actions,
      value: (
        <>
          {actions.automatic.writes}
          <span className="block text-[var(--color-muted)]">
            + {readsAndMessages(actions.automatic)}
          </span>
        </>
      ),
    },
    { term: 'Held, then approved', definition: DEFINITIONS.actions, value: actions.approved },
    { term: 'Held', definition: DEFINITIONS.actions, value: actions.held },
    { term: 'Refused', definition: DEFINITIONS.actions, value: actions.refused },
    {
      term: 'Audit trail',
      definition: DEFINITIONS.audit,
      value: formatAuditTrail(company.auditTrail),
    },
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
      {figures.map((figure) => (
        <FigureRow key={figure.term} figure={figure} />
      ))}
    </dl>
  );
}

function FigureRow({ figure }: { figure: Figure }) {
  return (
    <>
      <dt
        title={figure.definition}
        className="cursor-help text-[var(--color-muted)] underline decoration-dotted underline-offset-2"
      >
        {figure.term}
        {figure.unit ? <span className="block text-xs">{figure.unit}</span> : null}
      </dt>
      <dd className="tabular-nums">{figure.value}</dd>
    </>
  );
}
