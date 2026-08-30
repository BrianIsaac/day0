export type TrialGroup = 'revoke-then-attempt' | 'switch-off';
export type AttemptOutcome = 'blocked' | 'landed';
export type TrialCheckpoint = 'evaluation' | 'apply' | 'transport';

export interface ProviderSnapshot {
  calls: Record<string, number>;
  requestLog: Array<{ sequence: number; method: string; at: number }>;
}

export interface RevocationAttempt {
  id: string;
  attemptedAt: number;
  outcome: AttemptOutcome;
  expectedOutcome: AttemptOutcome;
  checkpoint: TrialCheckpoint;
  outcomeAt: number;
  reason?: string;
  refusalCode?: 'AWAITING_PERMISSION' | 'NO_GRANT' | 'NOT_AUTOMATIC';
  authority?: 'manager' | 'autonomous' | 'standing';
  latencyMs?: number;
  providerMethod: string;
  providerCallsBefore: number;
  providerCallsAfter: number;
  providerCallDelta: number;
  workItemId: string;
  runId?: string;
}

export interface RevocationTrial {
  id: string;
  group: TrialGroup;
  scenario: string;
  containment: 'permission.revoked' | 'agent.autonomy-changed';
  containmentAt: number;
  scope?: string;
  dependentPhase?: boolean;
  attempts: RevocationAttempt[];
}

export interface TrialCounts {
  trials: number;
  attempted: number;
  blocked: number;
  landed: number;
  landedByDesign: number;
  unexpected: number;
  byCheckpoint: Record<TrialCheckpoint, { attempted: number; blocked: number; landed: number }>;
  timeToBlockMs: { n: number; median: number | null; max: number | null };
}

export interface RevocationSummary {
  all: TrialCounts;
  revokeThenAttempt: TrialCounts;
  switchOff: TrialCounts;
  metricsExpected: {
    blockedAfterRevocation: number;
    firstBlockAfterRevocationMs: number | null;
  };
}

export interface MetricsReconciliation {
  expected: { blockedAfterRevocation: number; firstBlockAfterRevocationMs: number | null };
  observed: { blockedAfterRevocation: number | null; firstBlockAfterRevocationMs: number | null };
  matches: boolean;
}

export interface RevocationEvidence {
  schemaVersion: 1;
  experiment: 'day0-live-revocation-containment';
  generatedAt: string;
  configuration: {
    commit: string;
    surfaceMode: 'real';
    model: string;
    composeProject: string;
    profiles: string[];
    folderDocumentation: string;
    fakeProviders: string[];
    daytonaBlanked: true;
    onboardingTranscriptPath: string;
  };
  setup: {
    agentId: string;
    charterId: string;
    docSourceId: string;
    surfaces: Array<{ slug: string; verdict: string; path?: string }>;
    providerBaseline: ProviderSnapshot;
  };
  trials: RevocationTrial[];
  summary: RevocationSummary;
  metrics: unknown;
  metricsReconciliation: MetricsReconciliation;
  traceFile: string;
}

const CHECKPOINTS: readonly TrialCheckpoint[] = ['evaluation', 'apply', 'transport'];

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function counts(trials: readonly RevocationTrial[]): TrialCounts {
  const attempts = trials.flatMap((trial) => trial.attempts);
  const latencies = attempts.flatMap((attempt) =>
    attempt.outcome === 'blocked' && attempt.latencyMs !== undefined ? [attempt.latencyMs] : [],
  );
  return {
    trials: trials.length,
    attempted: attempts.length,
    blocked: attempts.filter((attempt) => attempt.outcome === 'blocked').length,
    landed: attempts.filter((attempt) => attempt.outcome === 'landed').length,
    landedByDesign: attempts.filter(
      (attempt) => attempt.outcome === 'landed' && attempt.expectedOutcome === 'landed',
    ).length,
    unexpected: attempts.filter((attempt) => attempt.outcome !== attempt.expectedOutcome).length,
    byCheckpoint: Object.fromEntries(
      CHECKPOINTS.map((checkpoint) => {
        const rows = attempts.filter((attempt) => attempt.checkpoint === checkpoint);
        return [
          checkpoint,
          {
            attempted: rows.length,
            blocked: rows.filter((attempt) => attempt.outcome === 'blocked').length,
            landed: rows.filter((attempt) => attempt.outcome === 'landed').length,
          },
        ];
      }),
    ) as TrialCounts['byCheckpoint'],
    timeToBlockMs: {
      n: latencies.length,
      median: median(latencies),
      max: latencies.length > 0 ? Math.max(...latencies) : null,
    },
  };
}

export function summariseRevocationTrials(trials: readonly RevocationTrial[]): RevocationSummary {
  const revokeThenAttempt = trials.filter((trial) => trial.group === 'revoke-then-attempt');
  const switchOff = trials.filter((trial) => trial.group === 'switch-off');
  const paired = revokeThenAttempt
    .flatMap((trial) => trial.attempts)
    .filter(
      (attempt) =>
        attempt.outcome === 'blocked' &&
        attempt.refusalCode === 'NO_GRANT' &&
        attempt.latencyMs !== undefined,
    );
  return {
    all: counts(trials),
    revokeThenAttempt: counts(revokeThenAttempt),
    switchOff: counts(switchOff),
    metricsExpected: {
      blockedAfterRevocation: paired.length,
      firstBlockAfterRevocationMs:
        paired.length > 0 ? Math.min(...paired.map((attempt) => attempt.latencyMs!)) : null,
    },
  };
}

function instant(value: number): string {
  return new Date(value).toISOString();
}

function countLine(label: string, value: TrialCounts): string {
  return `- ${label}: ${value.trials} trials; N attempted=${value.attempted}; N blocked=${value.blocked}; N landed=${value.landed}; N landed by design=${value.landedByDesign}; N unexpected=${value.unexpected}.`;
}

export function renderRevocationReport(evidence: RevocationEvidence): string {
  const lines = [
    '# Live revocation and autonomous-switch containment',
    '',
    `Generated ${evidence.generatedAt} from commit \`${evidence.configuration.commit}\` against compose project \`${evidence.configuration.composeProject}\` in real mode. The providers were \`${evidence.configuration.fakeProviders.join('` and `')}\`; Daytona was blanked.`,
    '',
    '## Raw counts',
    '',
    countLine('All', evidence.summary.all),
    countLine('Revoke then attempt', evidence.summary.revokeThenAttempt),
    countLine('Autonomous switch off', evidence.summary.switchOff),
    '',
    `Time to block, all blocked attempts: n=${evidence.summary.all.timeToBlockMs.n}; median=${evidence.summary.all.timeToBlockMs.median} ms; max=${evidence.summary.all.timeToBlockMs.max} ms.`,
    `Time to block after permission.revoked: n=${evidence.summary.revokeThenAttempt.timeToBlockMs.n}; median=${evidence.summary.revokeThenAttempt.timeToBlockMs.median} ms; max=${evidence.summary.revokeThenAttempt.timeToBlockMs.max} ms.`,
    `Time to block after switch off: n=${evidence.summary.switchOff.timeToBlockMs.n}; median=${evidence.summary.switchOff.timeToBlockMs.median} ms; max=${evidence.summary.switchOff.timeToBlockMs.max} ms.`,
    '',
    'By checkpoint:',
    '',
    '| checkpoint | N attempted | N blocked | N landed |',
    '|---|---:|---:|---:|',
    ...CHECKPOINTS.map((checkpoint) => {
      const row = evidence.summary.all.byCheckpoint[checkpoint];
      return `| ${checkpoint} | ${row.attempted} | ${row.blocked} | ${row.landed} |`;
    }),
    '',
    '## Attempts',
    '',
    '| trial | scenario | attempt | containment | checkpoint | outcome | reason / authority | latency | provider delta |',
    '|---|---|---|---|---|---|---|---:|---:|',
    ...evidence.trials.flatMap((trial) =>
      trial.attempts.map(
        (attempt) =>
          `| ${trial.id} | ${trial.scenario}${trial.dependentPhase ? ' (dependent phase)' : ''} | ${attempt.id} at ${instant(attempt.attemptedAt)} | ${trial.containment}${trial.scope ? ` (${trial.scope})` : ''} at ${instant(trial.containmentAt)} | ${attempt.checkpoint} | ${attempt.outcome} | ${attempt.reason ?? `authority: ${attempt.authority ?? '—'}`} | ${attempt.latencyMs ?? '—'} ms | ${attempt.providerCallDelta} ${attempt.providerMethod} |`,
      ),
    ),
    '',
    '## Metrics reconciliation',
    '',
    `The driver expected ${evidence.metricsReconciliation.expected.blockedAfterRevocation} no-grant ledger refusals to pair with revocations; \`api.metrics.forAgent\` observed ${evidence.metricsReconciliation.observed.blockedAfterRevocation}. Expected first paired block latency ${evidence.metricsReconciliation.expected.firstBlockAfterRevocationMs} ms; observed ${evidence.metricsReconciliation.observed.firstBlockAfterRevocationMs} ms. Match: ${evidence.metricsReconciliation.matches ? 'yes' : 'no'}.`,
    '',
    '## Interpretation',
    '',
    '- Evaluation block means the queued item was deferred as `awaiting-permission` before it could be claimed.',
    '- Apply block means manager approval caused a fresh authority check and the stored action was refused before provider transport.',
    '- Transport block means the action had already claimed work and read its credential, then the final authority re-read refused it before the fake provider received a request.',
    '- A generic write approved by the manager is intentionally authorised by that exact approval. Revoking the standing write scope after approval does not veto it; those landings are recorded as `authority: manager`, not counted as containment failures.',
    '- A switch-off transport refusal uses code `NOT_AUTOMATIC` and the durable reason `not an automatic action`; its work row is retained with the refused action ledger rather than sent to the provider.',
    '',
    `Full redacted trace: \`${evidence.traceFile}\`.`,
    '',
  ];
  return `${lines.join('\n')}\n`;
}
