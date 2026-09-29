import type { AgentMetrics } from '@/metrics/types';
import { formatAuditTrail, formatMetricDuration } from '../../../metric-format';
import { Card } from '../../../components/Card';
import { readsAndMessages, PILOT_FIGURES } from '../../../CompanySupervision';
import { DISCLOSURE_SUMMARY } from '../../../components/Disclosure';

function metricValue(value: string | undefined): string {
  return value ?? 'loading…';
}

/** The employee's supervision figures. */
export function MetricsCard({ metrics }: { metrics: AgentMetrics | undefined }) {
  // A decision made on the dashboard is a decision whether or not a chat
  // surface was ever asked, so "not yet" means no decision at all (P6-9).
  const decisions = metrics?.decisions;
  const decided = decisions
    ? decisions.approved + decisions.rejected + decisions.partiallyApproved
    : 0;
  const humanDecisions = decisions
    ? decided === 0
      ? 'not yet'
      : `${decisions.approved} / ${decisions.rejected}`
    : undefined;
  const decidedFrom = decisions
    ? decisions.byVia.dashboard.decided + decisions.byVia.channel.decided === 0
      ? 'not yet'
      : `${decisions.byVia.dashboard.decided} / ${decisions.byVia.channel.decided}`
    : undefined;
  const blocked = metrics
    ? metrics.actions.blockedAfterRevocation === null
      ? 'not yet'
      : String(metrics.actions.blockedAfterRevocation)
    : undefined;
  const completeness = metrics ? formatAuditTrail(metrics.auditTrail) : undefined;
  const rows = [
    {
      label: 'time to first approved charter',
      value: metrics ? formatMetricDuration(metrics.charter.timeToFirstApprovedMs) : undefined,
    },
    { label: 'human decisions (approved / rejected)', value: humanDecisions },
    { label: 'human decisions (dashboard / phone)', value: decidedFrom },
    {
      label: 'median decision latency',
      value: metrics ? formatMetricDuration(metrics.decisions.medianLatencyMs) : undefined,
    },
    { label: 'actions blocked after revocation', value: blocked },
    { label: 'audit-trail completeness', value: completeness },
  ];
  return (
    <Card title="Supervision metrics" tone="accent">
      <dl className="space-y-2">
        {rows.map((row) => (
          <div key={row.label} className="flex items-start justify-between gap-3 text-xs">
            <dt className="text-[var(--color-muted)] leading-tight">{row.label}</dt>
            <dd className="font-mono text-[var(--color-fg)] text-right shrink-0">
              {metricValue(row.value)}
            </dd>
          </div>
        ))}
      </dl>
      {metrics ? (
        <div className="mt-3 pt-2 border-t border-[var(--color-border)] text-[10px] text-[var(--color-muted)] leading-relaxed">
          <p>
            {metrics.decisions.requested} asked on a chat surface -{' '}
            {metrics.decisions.partiallyApproved} partial - {metrics.actions.automatic.writes}{' '}
            automatic {metrics.actions.automatic.writes === 1 ? 'change' : 'changes'} -{' '}
            {metrics.actions.held} held - {metrics.actions.refused} refused
            {metrics.actions.sessionRestores > 0
              ? ` - ${metrics.actions.sessionRestores} browser ${metrics.actions.sessionRestores === 1 ? 'call' : 'calls'} replayed to sign in again`
              : null}
          </p>
          <p>Also applied on their own: {readsAndMessages(metrics.actions.automatic)}.</p>
        </div>
      ) : null}
      {metrics ? (
        <div className="mt-3 pt-2 border-t border-[var(--color-border)]">
          <h3 className="mb-1.5 text-[10px] font-normal uppercase tracking-wider text-[var(--color-muted)]">
            Pilot figures
          </h3>
          <dl className="space-y-1.5">
            {PILOT_FIGURES.map((figure) => (
              <div
                key={figure.label}
                title={figure.definition}
                className="flex items-start justify-between gap-3 text-xs"
              >
                <dt className="basis-1/2 shrink-0 text-[var(--color-muted)] leading-tight">
                  {figure.label.toLowerCase()}
                  <span className="block text-[10px]">{figure.unit}</span>
                </dt>
                <dd className="min-w-0 font-mono text-[var(--color-fg)] text-right break-words">
                  {figure.value(metrics.pilot)}
                </dd>
              </div>
            ))}
          </dl>
          <details className="mt-1 text-[10px] text-[var(--color-muted)]">
            <summary className={DISCLOSURE_SUMMARY}>What each pilot figure counts</summary>
            <dl className="space-y-1">
              {PILOT_FIGURES.map((figure) => (
                <div key={figure.label}>
                  <dt className="inline text-[var(--color-fg)]">{figure.label}: </dt>
                  <dd className="inline">{figure.definition}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>
      ) : null}
    </Card>
  );
}
