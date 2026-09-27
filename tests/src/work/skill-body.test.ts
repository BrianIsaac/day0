import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { skillBodyHash } from '../../../src/work/skill-body';

/** The reference digest, from Node's own SHA-256. */
function reference(body: string): string {
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

describe('skillBodyHash', (): void => {
  it('is the SHA-256 of the UTF-8 body, prefixed with the algorithm', (): void => {
    for (const body of [
      '',
      'abc',
      'Comment, then close. 柑橘',
      'x'.repeat(55),
      'x'.repeat(56),
      'y'.repeat(64),
    ]) {
      expect(skillBodyHash(body)).toBe(reference(body));
    }
  });

  it('matches the reference on bodies across block boundaries', (): void => {
    for (let length = 0; length < 300; length += 7) {
      const body = randomBytes(length).toString('base64');
      expect(skillBodyHash(body)).toBe(reference(body));
    }
  });

  it('tells two bodies apart that differ by one character', (): void => {
    expect(skillBodyHash('Comment, then close.')).not.toBe(skillBodyHash('Comment, then close!'));
  });
});
