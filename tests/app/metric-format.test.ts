import { describe, expect, it } from 'vitest';
import { decidedCount, formatAuditTrail, formatMetricDuration } from '../../app/metric-format';

describe('the supervision figures as the cards print them', (): void => {
  it('counts every decision the manager made, a partial approval among the approvals (walk m14)', (): void => {
    expect(decidedCount({ approved: 3, rejected: 2 })).toBe(5);
    expect(decidedCount({ approved: 0, rejected: 0 })).toBe(0);
  });

  it('prints a duration in seconds, then minutes, then hours, and a dash before it happened', (): void => {
    expect(formatMetricDuration(null)).not.toMatch(/\d/);
    expect(formatMetricDuration(42_000)).toContain('42');
    expect(formatMetricDuration(3 * 60_000 + 5_000)).toMatch(/3.*5/);
  });

  it('prints the audit trail as a share of the landed rows, and says not yet before any', (): void => {
    expect(formatAuditTrail({ complete: 26, total: 26, fraction: 1 })).toBe('100% (26/26)');
    expect(formatAuditTrail({ complete: 0, total: 0, fraction: null })).toBe('not yet');
  });
});
