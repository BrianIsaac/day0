/**
 * The run record: rewritten after every phase, so a crash still leaves one.
 */
import type { CheckResult } from './checks';
import type { UndoResult } from './cleanup';
import type { BedPorts } from './env';

export type PhaseStatus = 'ok' | 'failed' | 'skipped' | 'stopped';

export interface PhaseRecord {
  name: string;
  status: PhaseStatus;
  seconds?: number;
  detail?: string;
}

export interface RunRecord {
  startedAt: string;
  commit: string;
  ref: string;
  project: string;
  clone: string;
  ports: BedPorts;
  dryRun: boolean;
  status: 'running' | 'passed' | 'failed' | 'dry-run';
  stoppedAt?: string;
  phases: PhaseRecord[];
  checks: CheckResult[];
  /** Provider writes made, or (dry run) the writes that would have been made. */
  writes: string[];
  cleanup: UndoResult[];
  notes: string[];
}

/**
 * A directory name from the clock.
 *
 * Args:
 *   now: The clock.
 *
 * Returns:
 *   `YYYY-MM-DDTHH-MM-SSZ`.
 */
export function runStamp(now: Date = new Date()): string {
  return now
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');
}

function cell(value: string | undefined): string {
  return (value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * The summary page.
 *
 * Args:
 *   record: The run so far.
 *
 * Returns:
 *   Markdown.
 */
export function renderSummary(record: RunRecord): string {
  const lines: string[] = [
    `# Real-mode rehearsal ${record.startedAt}`,
    '',
    `- Status: ${record.status}`,
    ...(record.stoppedAt ? [`- Stopped at: ${record.stoppedAt}`] : []),
    `- Commit: ${record.commit} (${record.ref})`,
    `- Compose project: ${record.project}`,
    `- Clone: ${record.clone}`,
    `- Ports: backend ${record.ports.backend}, site ${record.ports.site}, dashboard ${record.ports.dashboard}, app ${record.ports.app}`,
    '',
  ];
  if (record.dryRun) {
    lines.push('Dry run: stopped before the first provider write. The writes below were not made.', '');
  }
  lines.push('## The five checks', '', '| Check | Result | Detail |', '|---|---|---|');
  for (const check of record.checks) {
    lines.push(`| ${check.check} | ${check.passed ? 'pass' : 'FAIL'} | ${cell(check.detail)} |`);
  }
  if (record.checks.length === 0) lines.push('| (none reached) | | |');
  lines.push('', '## Phases', '', '| Phase | Status | Time | Detail |', '|---|---|---|---|');
  for (const phase of record.phases) {
    lines.push(
      `| ${phase.name} | ${phase.status} | ${phase.seconds === undefined ? '' : `${phase.seconds.toFixed(1)} s`} | ${cell(phase.detail)} |`,
    );
  }
  lines.push('', record.dryRun ? '## Provider writes the run would make' : '## Provider writes made', '');
  for (const write of record.writes) lines.push(`- ${write}`);
  if (record.writes.length === 0) lines.push('- none');
  lines.push('', '## Cleanup', '', '| Step | Result | Error |', '|---|---|---|');
  for (const step of record.cleanup) {
    lines.push(`| ${cell(step.label)} | ${step.ok ? 'ok' : 'FAILED'} | ${cell(step.error)} |`);
  }
  if (record.cleanup.length === 0) lines.push('| (nothing to undo) | | |');
  lines.push('', '## Notes', '');
  for (const note of record.notes) lines.push(`- ${note}`);
  if (record.notes.length === 0) lines.push('- none');
  return `${lines.join('\n')}\n`;
}
