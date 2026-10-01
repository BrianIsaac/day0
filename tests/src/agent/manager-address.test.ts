import { describe, expect, it } from 'vitest';
import {
  MANAGER_ADDRESS_REFUSAL,
  MAX_MANAGER_ADDRESS_LENGTH,
  isEvaluationShapedAddress,
  isManagerAddressShaped,
  normaliseManagerAddress,
  sameManagerAddress,
} from '../../../src/agent/manager-address';

describe('isManagerAddressShaped', (): void => {
  it('takes one @, a dotted domain and no spaces, after trimming', (): void => {
    expect(isManagerAddressShaped('name@company.com')).toBe(true);
    expect(isManagerAddressShaped('  Name@Company.com ')).toBe(true);
    expect(isManagerAddressShaped('first.last+tag@sub.company.co.uk')).toBe(true);
  });

  it('refuses a typo, a space, a second @, an undotted domain and an empty string', (): void => {
    for (const typo of ['not an address', 'name@company', 'a@b@c.com', 'name @company.com', '']) {
      expect(isManagerAddressShaped(typo), typo).toBe(false);
    }
  });

  it('refuses an address past the mailbox path limit and takes one at it', (): void => {
    const domain = '@company.com';
    const atLimit = `${'a'.repeat(MAX_MANAGER_ADDRESS_LENGTH - domain.length)}${domain}`;
    expect(atLimit).toHaveLength(MAX_MANAGER_ADDRESS_LENGTH);
    expect(isManagerAddressShaped(atLimit)).toBe(true);
    expect(isManagerAddressShaped(`a${atLimit}`)).toBe(false);
  });
});

describe('normaliseManagerAddress', (): void => {
  it('trims and lower-cases a shaped address, so one mailbox has one spelling', (): void => {
    expect(normaliseManagerAddress('  Boss@Day0.Local ')).toBe('boss@day0.local');
  });

  it('answers undefined for an address that is not shaped like one, or for no address', (): void => {
    expect(normaliseManagerAddress('not an address')).toBeUndefined();
    expect(normaliseManagerAddress('   ')).toBeUndefined();
    expect(normaliseManagerAddress(undefined)).toBeUndefined();
  });
});

describe('sameManagerAddress', (): void => {
  it('compares two spellings of one mailbox case-insensitively and ignoring the edges', (): void => {
    expect(sameManagerAddress('Boss@Day0.local', ' boss@day0.LOCAL ')).toBe(true);
    expect(sameManagerAddress('boss@day0.local', 'other@day0.local')).toBe(false);
  });

  it('never matches an address that is not shaped like one, even against itself', (): void => {
    expect(sameManagerAddress('not an address', 'not an address')).toBe(false);
  });
});

describe('isEvaluationShapedAddress', (): void => {
  it('knows the reserved addresses the evaluation harness deploys under', (): void => {
    for (const address of [
      'eval-revocation-2026-09-18t07-00-00z@day0.local',
      'eval-day0-r1-1758150000000@day0.local',
      'eval-baseline-r2-1758150000000@day0.local',
      ' EVAL-payroll@Day0.local ',
    ]) {
      expect(isEvaluationShapedAddress(address), address).toBe(true);
    }
  });

  it('takes an ordinary manager whose address only begins with eval- for no evaluation', (): void => {
    expect(isEvaluationShapedAddress('eval-team@company.com')).toBe(false);
    expect(isEvaluationShapedAddress('boss@day0.local')).toBe(false);
    expect(isEvaluationShapedAddress('eval-@day0.local')).toBe(false);
  });
});

describe('MANAGER_ADDRESS_REFUSAL', (): void => {
  it('names the shape the manager must give, in the words the dashboard shows', (): void => {
    expect(MANAGER_ADDRESS_REFUSAL).toBe(
      'The manager must be an email address, such as name@company.com.',
    );
  });
});
