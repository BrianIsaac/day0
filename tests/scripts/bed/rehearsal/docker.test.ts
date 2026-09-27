import { describe, expect, it } from 'vitest';
import { BED_PROFILES, bedComposeArgs, parseLines } from '../../../../scripts/bed/rehearsal/docker';

describe('compose invocation for the bed', (): void => {
  it('names the project, the env file and the five real-mode profiles', (): void => {
    expect(BED_PROFILES).toEqual(['real', 'sandbox', 'browser', 'demo', 'redactor']);
    const args = bedComposeArgs('day0-rehearsal-1', '/tmp/c/.env.local');
    expect(args.slice(0, 5)).toEqual([
      'compose',
      '-p',
      'day0-rehearsal-1',
      '--env-file',
      '/tmp/c/.env.local',
    ]);
    expect(args.filter((a) => a === '--profile')).toHaveLength(5);
  });

  it('splits docker list output into trimmed non-empty lines', (): void => {
    expect(parseLines(' a \n\nb\n')).toEqual(['a', 'b']);
  });
});
