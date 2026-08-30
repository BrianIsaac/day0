import { describe, expect, it } from 'vitest';
import { LIVENESS_HOURS, verdictFor } from '../../../src/surfaces/verdict';

describe('surface connection verdict', (): void => {
  const now = Date.UTC(2026, 7, 25, 12);
  const liveAfter = now - LIVENESS_HOURS * 60 * 60 * 1_000;

  it('requires a landed credential and a recent successful probe', (): void => {
    expect(
      verdictFor({ verdict: 'connected', credentialLanded: true, lastVerifiedAt: now }, now),
    ).toBe('connected');
    expect(
      verdictFor({ verdict: 'connected', credentialLanded: true, lastVerifiedAt: liveAfter - 1 }, now),
    ).toBe('listed-dead');
    expect(verdictFor({ verdict: 'connected', credentialLanded: true }, now)).toBe('listed-dead');
    expect(
      verdictFor({ verdict: 'connected', credentialLanded: false, lastVerifiedAt: now }, now),
    ).toBe('listed-dead');
  });

  it('treats the liveness window as inclusive at its boundary', (): void => {
    expect(
      verdictFor({ verdict: 'connected', credentialLanded: true, lastVerifiedAt: liveAfter }, now),
    ).toBe('connected');
    expect(
      verdictFor({ verdict: 'connected', credentialLanded: true, lastVerifiedAt: liveAfter + 1 }, now),
    ).toBe('connected');
  });

  it('treats approval without a credential as ungranted', (): void => {
    expect(verdictFor({ verdict: 'approved', credentialLanded: false }, now)).toBe('ungranted');
  });

  it('keeps a landed but unprobed approval as approved, awaiting the probe', (): void => {
    expect(verdictFor({ verdict: 'approved', credentialLanded: true }, now)).toBe('approved');
  });

  it('reads a stale probe on an approved surface as dead', (): void => {
    expect(
      verdictFor({ verdict: 'approved', credentialLanded: true, lastVerifiedAt: liveAfter - 1 }, now),
    ).toBe('listed-dead');
    expect(
      verdictFor({ verdict: 'approved', credentialLanded: true, lastVerifiedAt: now }, now),
    ).toBe('connected');
  });

  it('preserves non-liveness verdicts', (): void => {
    expect(verdictFor({ verdict: 'absent', credentialLanded: false }, now)).toBe('absent');
    expect(verdictFor({ verdict: 'proposed', credentialLanded: false }, now)).toBe('proposed');
    expect(verdictFor({ verdict: 'declared', credentialLanded: false }, now)).toBe('declared');
  });
});
