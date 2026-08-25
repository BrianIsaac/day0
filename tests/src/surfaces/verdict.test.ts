import { describe, expect, it } from 'vitest';
import { LIVENESS_HOURS, verdictFor } from '../../../src/surfaces/verdict';

describe('surface connection verdict', (): void => {
  const now = Date.UTC(2026, 7, 25, 12);

  it('requires a landed credential and a recent successful probe', (): void => {
    expect(
      verdictFor({ verdict: 'connected', credentialLanded: true, lastVerifiedAt: now }, now),
    ).toBe('connected');
    expect(
      verdictFor(
        {
          verdict: 'connected',
          credentialLanded: true,
          lastVerifiedAt: now - LIVENESS_HOURS * 60 * 60 * 1_000 - 1,
        },
        now,
      ),
    ).toBe('listed-dead');
  });

  it('treats approval without a credential as ungranted', (): void => {
    expect(verdictFor({ verdict: 'approved', credentialLanded: false }, now)).toBe('ungranted');
  });

  it('preserves non-liveness verdicts', (): void => {
    expect(verdictFor({ verdict: 'absent', credentialLanded: false }, now)).toBe('absent');
    expect(verdictFor({ verdict: 'proposed', credentialLanded: false }, now)).toBe('proposed');
  });
});
