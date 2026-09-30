import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  MAX_FINALISATION_RECOVERIES,
  ONE_TO_ONE_PHASE_KINDS,
  oneToOnePhase,
  type OneToOnePhase,
  type OneToOneSession,
} from '../../../src/agent/one-to-one-phase';

function session(fields: Partial<OneToOneSession>): OneToOneSession {
  return { state: 'active', ...fields };
}

describe('the one-to-one phase', (): void => {
  it('is talking before a session exists and while no transcript has been accepted', (): void => {
    expect(oneToOnePhase(null)).toEqual({ kind: 'talking' });
    expect(oneToOnePhase(undefined)).toEqual({ kind: 'talking' });
    expect(oneToOnePhase(session({}))).toEqual({ kind: 'talking' });
    expect(oneToOnePhase(session({ state: 'pending' }))).toEqual({ kind: 'talking' });
  });

  it('is drafting while a finisher holds the session, and once a sent-back draft is queued', (): void => {
    expect(
      oneToOnePhase(session({ state: 'synthesising', pendingTranscript: 'USER: hi' })),
    ).toEqual({ kind: 'drafting' });
    expect(oneToOnePhase(session({ pendingTranscript: 'USER: hi' }))).toEqual({
      kind: 'drafting',
    });
  });

  it('is drafting again, naming the last failure, while the deployment still retries', (): void => {
    expect(
      oneToOnePhase(
        session({
          pendingTranscript: 'USER: hi',
          finalisationError: 'model timed out',
          recoveryAttempts: MAX_FINALISATION_RECOVERIES - 1,
        }),
      ),
    ).toEqual({ kind: 'drafting', retrying: 'model timed out' });
  });

  it('has failed once every attempt the deployment makes on its own is spent', (): void => {
    expect(
      oneToOnePhase(
        session({
          pendingTranscript: 'USER: hi',
          finalisationError: 'model timed out',
          recoveryAttempts: MAX_FINALISATION_RECOVERIES,
        }),
      ),
    ).toEqual({ kind: 'failed', reason: 'model timed out' });
    expect(oneToOnePhase(session({ state: 'failed' }))).toEqual({
      kind: 'failed',
      reason: 'the session failed',
    });
  });

  it('is drafted once the session produced a charter', (): void => {
    expect(oneToOnePhase(session({ state: 'done' }))).toEqual({ kind: 'drafted' });
  });
});

describe('the one-to-one phase kinds', (): void => {
  it('names every kind the phase can be, once, for the validators that must list them (second review w5)', (): void => {
    expect([...ONE_TO_ONE_PHASE_KINDS].sort()).toEqual([
      'drafted',
      'drafting',
      'failed',
      'talking',
    ]);
    expectTypeOf(ONE_TO_ONE_PHASE_KINDS).items.toEqualTypeOf<OneToOnePhase['kind']>();
  });
});
