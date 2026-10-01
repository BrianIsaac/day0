import { describe, expect, it } from 'vitest';
import { managerStandingOf } from '../../../src/agent/manager-standing';

describe('managerStandingOf', (): void => {
  it("answers you when the employee reports to the caller's verified address, in any older spelling", (): void => {
    expect(
      managerStandingOf({
        bossEmail: ' Boss@Day0.local ',
        callerAddress: 'boss@day0.local',
        evaluation: false,
      }),
    ).toEqual({ standing: 'you' });
  });

  it('answers other with the address the employee reports to, as it is stored', (): void => {
    expect(
      managerStandingOf({
        bossEmail: 'Ana@Kestrel.example',
        callerAddress: 'boss@day0.local',
        evaluation: false,
      }),
    ).toEqual({ standing: 'other', bossEmail: 'Ana@Kestrel.example' });
  });

  it('answers unverified when the sign-in asserts no verified address, whatever the row holds', (): void => {
    for (const bossEmail of ['boss@day0.local', 'ana@kestrel.example']) {
      expect(
        managerStandingOf({ bossEmail, callerAddress: undefined, evaluation: false }),
        bossEmail,
      ).toEqual({ standing: 'unverified' });
    }
  });

  it("answers evaluation for an evaluation employee, whose address is its run's marker and never flagged", (): void => {
    expect(
      managerStandingOf({
        bossEmail: 'eval-day0-r1-1758150000000@day0.local',
        callerAddress: 'boss@day0.local',
        evaluation: true,
      }),
    ).toEqual({ standing: 'evaluation' });
  });

  it('never matches a stored value that is not shaped like an address', (): void => {
    expect(
      managerStandingOf({
        bossEmail: 'not an address',
        callerAddress: 'boss@day0.local',
        evaluation: false,
      }),
    ).toEqual({ standing: 'other', bossEmail: 'not an address' });
  });
});
