import { describe, expect, it } from 'vitest';
import {
  generatedCodeState,
  restoreGeneratedCode,
  type GitRunner,
} from '../../../scripts/lib/generated-code';

/** A git that answers `status` with the given listing and `checkout` with the given status. */
function git(
  listing: { status: number; stdout: string },
  checkout = 0,
): GitRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: (command: string, args: readonly string[]) => {
      calls.push([command, ...args].join(' '));
      return args[0] === 'status'
        ? { ...listing, stderr: '' }
        : { status: checkout, stdout: '', stderr: checkout === 0 ? '' : 'error: pathspec\n' };
    },
  };
}

describe('the generated code a push rewrites', (): void => {
  it('reads a checkout with no change there as clean, one with changes as changed, and no git as unknown', (): void => {
    expect(generatedCodeState(git({ status: 0, stdout: '' }))).toBe('clean');
    expect(generatedCodeState(git({ status: 0, stdout: ' M convex/_generated/api.d.ts\n' }))).toBe(
      'changed',
    );
    expect(generatedCodeState(git({ status: 128, stdout: '' }))).toBe('unknown');
  });

  it('puts back only what was clean, and says what to run when it cannot', (): void => {
    const clean = git({ status: 0, stdout: '' });
    expect(restoreGeneratedCode(clean, 'clean')).toBe(
      'convex/_generated put back as this checkout has it.',
    );
    expect(clean.calls).toEqual(['git checkout -- convex/_generated']);
    for (const state of ['changed', 'unknown'] as const) {
      const left = git({ status: 0, stdout: '' });
      expect(restoreGeneratedCode(left, state)).toContain('left as the push wrote it');
      expect(left.calls).toEqual([]);
    }
    expect(restoreGeneratedCode(git({ status: 0, stdout: '' }, 1), 'clean')).toBe(
      'convex/_generated could not be put back (error: pathspec): run `git checkout -- convex/_generated` before building.',
    );
  });
});
