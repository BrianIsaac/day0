import { describe, expect, it } from 'vitest';
import {
  ADMINISTRATORS_VAR,
  deploymentAdministrators,
  isAdministratorAddress,
  parseAdministrators,
} from '../../../src/lib/administrators';

/** An env reader over a fixed map, as the deployment's `process.env` would answer. */
function readerOf(values: Readonly<Record<string, string>>): (name: string) => string | undefined {
  return (name: string): string | undefined => values[name];
}

describe('the administrators named at install (B8)', (): void => {
  it('is read from DAY0_ADMINISTRATORS', (): void => {
    expect(ADMINISTRATORS_VAR).toBe('DAY0_ADMINISTRATORS');
  });

  it('reads comma- or space-separated addresses in one spelling, without repeats', (): void => {
    expect(parseAdministrators(' Ines@Acme.test, ops@acme.test\nines@acme.test  ')).toEqual([
      'ines@acme.test',
      'ops@acme.test',
    ]);
  });

  it('names nobody when nothing is configured', (): void => {
    expect(parseAdministrators(undefined)).toEqual([]);
    expect(parseAdministrators('  ')).toEqual([]);
  });

  it('refuses an entry that is not an address, never repeating the value', (): void => {
    expect(() => parseAdministrators('ines@acme.test, acme.test')).toThrow(
      /DAY0_ADMINISTRATORS holds an entry that is not an email address/,
    );
    expect(() => parseAdministrators('ines@acme.test, acme.test')).not.toThrow(/acme\.test,/);
  });

  it('names nobody from a list it cannot read, so a typo admits no one', (): void => {
    expect(deploymentAdministrators(readerOf({ DAY0_ADMINISTRATORS: 'not-an-address' }))).toEqual(
      [],
    );
    expect(deploymentAdministrators(readerOf({ DAY0_ADMINISTRATORS: 'ines@acme.test' }))).toEqual([
      'ines@acme.test',
    ]);
  });

  it('matches an address however it is spelt, and nothing that is not one', (): void => {
    const administrators = ['ines@acme.test'];
    expect(isAdministratorAddress('INES@acme.test ', administrators)).toBe(true);
    expect(isAdministratorAddress('sam@acme.test', administrators)).toBe(false);
    expect(isAdministratorAddress('', administrators)).toBe(false);
    expect(isAdministratorAddress('ines@acme.test', [])).toBe(false);
  });
});
