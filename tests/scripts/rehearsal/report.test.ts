import { describe, expect, it } from 'vitest';
import { renderSummary, runStamp, type RunRecord } from '../../../scripts/rehearsal/report';

describe('the run record', (): void => {
  it('stamps a directory name from the clock without colons', (): void => {
    expect(runStamp(new Date('2026-09-15T09:12:34.567Z'))).toBe('2026-09-15T09-12-34Z');
  });

  it('renders the phases, the five checks, the writes and the cleanup as one page', (): void => {
    const record: RunRecord = {
      startedAt: '2026-09-15T09:12:34Z',
      commit: 'abc1234',
      ref: 'HEAD',
      project: 'day0-rehearsal-abc123',
      clone: '/tmp/day0-rehearsal-abc123',
      ports: { backend: 45210, site: 45211, dashboard: 45791, app: 45300 },
      dryRun: false,
      status: 'failed',
      stoppedAt: 'closing-comment: the closing set held no save_comment',
      phases: [
        { name: 'preflight', status: 'ok', seconds: 1.2, detail: 'ports 45210-45300 free' },
        { name: 'closing-comment', status: 'failed', seconds: 60, detail: 'no save_comment' },
        { name: 'completion', status: 'skipped' },
      ],
      checks: [
        { check: 'plan-without-ownership-gate', passed: true, detail: 'three runbook steps', rows: null },
        { check: 'closing-comment-quotes-read-back', passed: false, detail: 'no save_comment', rows: null },
      ],
      writes: ['Linear issueUpdate REVOPS-7 assigneeId=u1'],
      cleanup: [{ label: 'REVOPS-7 assignee back to none', ok: true }],
      notes: ['Slack card approved; bot day0 in workspace day0.'],
    };
    const text = renderSummary(record);
    expect(text).toContain('# Real-mode rehearsal 2026-09-15T09:12:34Z');
    expect(text).toContain('| plan-without-ownership-gate | pass |');
    expect(text).toContain('| closing-comment-quotes-read-back | FAIL |');
    expect(text).toContain('Stopped at: closing-comment: the closing set held no save_comment');
    expect(text).toContain('| preflight | ok | 1.2 s |');
    expect(text).toContain('| completion | skipped |');
    expect(text).toContain('- Linear issueUpdate REVOPS-7 assigneeId=u1');
    expect(text).toContain('| REVOPS-7 assignee back to none | ok |');
    expect(text).toContain('Slack card approved');
  });

  it('says a dry run stopped at the boundary and lists the writes it did not make', (): void => {
    const text = renderSummary({
      startedAt: 's',
      commit: 'c',
      ref: 'HEAD',
      project: 'p',
      clone: '/c',
      ports: { backend: 1, site: 2, dashboard: 3, app: 4 },
      dryRun: true,
      status: 'dry-run',
      phases: [],
      checks: [],
      writes: ['Linear issueUpdate REVOPS-7 assigneeId=u1', 'work.approvePlan REVOPS-7'],
      cleanup: [],
      notes: [],
    });
    expect(text).toContain('Dry run: stopped before the first provider write');
    expect(text).toContain('- work.approvePlan REVOPS-7');
  });
});
