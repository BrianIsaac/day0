import { normaliseManagerAddress } from '../agent/manager-address';
import type { EnvReader } from './hosted-markers';

/*
 * The deployment's administrators (B8; the access plan, section 4.1): the people IT names by
 * address at install, who manage the organisation's connections and nothing else. Each
 * employee's access keeps its one approval, the manager's. Read by the deployment's guard
 * (`assertAdministrator`, `convex/ownership.ts`), the setup verb that writes the list and the
 * access check that reports it, so all three agree on what the list says.
 */

/** The addresses of the deployment's administrators, comma- or space-separated. */
export const ADMINISTRATORS_VAR = 'DAY0_ADMINISTRATORS';

/**
 * What a caller who is not an administrator reads: a manager, a person the list does not name,
 * or a named person whose sign-in does not prove the address.
 */
export const NOT_AN_ADMINISTRATOR =
  "Only an administrator named at install, signed in with a verified address, manages the organisation's connections.";

/**
 * Read an administrators list: comma- or space-separated addresses, each in the one spelling
 * every address is compared in (`normaliseManagerAddress`), in order and without repeats.
 *
 * @param raw - The value as configured.
 * @returns The addresses; empty when nothing is configured.
 * @throws Error when an entry is not shaped like an address. The value is never repeated, since
 *   a list pasted wrong may hold something that is not an address at all.
 */
export function parseAdministrators(raw: string | undefined): readonly string[] {
  const entries = (raw ?? '')
    .split(/[\s,]+/)
    .filter((entry: string): boolean => entry.trim() !== '');
  const addresses = entries.map((entry: string): string | undefined =>
    normaliseManagerAddress(entry),
  );
  if (addresses.some((address: string | undefined): boolean => address === undefined)) {
    throw new Error(
      `${ADMINISTRATORS_VAR} holds an entry that is not an email address: list the ` +
        'administrators by the address they sign in with, such as it@acme.com,ops@acme.com.',
    );
  }
  return [...new Set(addresses as readonly string[])];
}

/**
 * The administrators this deployment names. A list that cannot be read names nobody, so a typo
 * never makes an administrator of anyone; the access check reports the list by name.
 *
 * @param read - Reads one name of the deployment's env.
 */
export function deploymentAdministrators(read: EnvReader): readonly string[] {
  try {
    return parseAdministrators(read(ADMINISTRATORS_VAR));
  } catch {
    // An entry that is not an address: the check names it; meanwhile nobody is an administrator.
    return [];
  }
}

/**
 * Whether an address is one of the administrators, however either is spelt.
 *
 * @param address - The caller's verified address.
 * @param administrators - The deployment's administrators ({@link deploymentAdministrators}).
 */
export function isAdministratorAddress(
  address: string,
  administrators: readonly string[],
): boolean {
  const normalised = normaliseManagerAddress(address);
  return normalised !== undefined && administrators.includes(normalised);
}
