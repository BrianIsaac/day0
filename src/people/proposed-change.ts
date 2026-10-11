/**
 * A change a source proposes to a person the manager confirmed (W13-R3): a title, a team or an
 * address the source gives that differs from the confirmed one. The merge keeps it beside the
 * confirmed values, never over them, until the manager takes or dismisses it on the person's card.
 *
 * No Convex dependency: the merge and its tests read it alike.
 */

import { sha256OfText } from '../lib/sha256';

/** The values a change may name; each one present differs from the person's confirmed value. */
export interface ProposedValues {
  readonly title?: string;
  readonly team?: string;
  readonly primaryEmail?: string;
}

/** What the merge weighs a source's values against: the person as confirmed. */
export interface ConfirmedValues extends ProposedValues {
  /** Addresses the manager said are someone else's, never proposed again. */
  readonly notTheirAddresses?: readonly string[];
}

/** A value with its surrounding space taken off, or nothing for an empty one. */
function given(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/** An address with a `+tag` taken off its local part: the mailbox the tagged spelling reaches. */
function withoutPlusTag(address: string): string {
  const at = address.lastIndexOf('@');
  const plus = address.indexOf('+');
  return plus <= 0 || plus > at ? address : `${address.slice(0, plus)}${address.slice(at)}`;
}

/**
 * Whether an address is one the manager said is someone else's, read by its mailbox: a
 * plus-tagged spelling ("mei+hr@kestrel.test") is the address it tags (W14-R54).
 *
 * @param marked - The person's `notTheirAddresses`, normalised.
 * @param address - The address a source gives, normalised.
 */
export function isNotTheirAddress(marked: readonly string[] | undefined, address: string): boolean {
  const mailbox = withoutPlusTag(address);
  return (marked ?? []).some((kept) => withoutPlusTag(kept) === mailbox);
}

/**
 * The values a source gives that differ from a confirmed person's, or nothing when it gives none
 * that do. An address the manager said is someone else's is never one of them.
 *
 * @param person - The person as confirmed.
 * @param offered - The source's values, the address normalised.
 */
export function proposedValues(
  person: ConfirmedValues,
  offered: ProposedValues,
): ProposedValues | undefined {
  const title = given(offered.title);
  const team = given(offered.team);
  const address = given(offered.primaryEmail);
  const values: ProposedValues = {
    ...(title !== undefined && title !== person.title ? { title } : {}),
    ...(team !== undefined && team !== person.team ? { team } : {}),
    ...(address !== undefined &&
    address !== person.primaryEmail &&
    !isNotTheirAddress(person.notTheirAddresses, address)
      ? { primaryEmail: address }
      : {}),
  };
  return Object.keys(values).length === 0 ? undefined : values;
}

/** Whether two changes name the same values. */
export function sameValues(left: ProposedValues, right: ProposedValues): boolean {
  return (
    left.title === right.title &&
    left.team === right.team &&
    left.primaryEmail === right.primaryEmail
  );
}

/** How many dismissed changes a person remembers: the newest (`people.dismissedChanges`). */
export const DISMISSED_CHANGES_KEPT = 20;

/** A title or team as the digest reads it: one width, one case, single spaces. */
function digestWords(value: string | undefined): string {
  return (value ?? '').normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * The digest a dismissed change is remembered by (W14-R52): SHA-256, as lower-case hex, of the
 * three lines `title=`, `team=` and `address=`, each value in one width and case with single
 * spaces (the address trimmed with its ASCII letters lower-cased, its one spelling), an absent
 * value empty. The whole change is the unit: the same title beside a different team is another
 * change.
 *
 * @remarks The input is fixed for good. A changed input re-proposes every change a manager
 * dismissed once, so a later rule gets a new field, never a new input here.
 */
export function changeDigest(change: ProposedValues): string {
  const address = (change.primaryEmail ?? '')
    .trim()
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  return sha256OfText(
    `title=${digestWords(change.title)}\nteam=${digestWords(change.team)}\naddress=${address}`,
  );
}

/**
 * A person's dismissed changes with one more, newest last, each digest once, the newest
 * {@link DISMISSED_CHANGES_KEPT} kept.
 *
 * @param held - The digests the person holds, oldest first.
 * @param digest - The change dismissed now.
 */
export function withDismissedChange(held: readonly string[] | undefined, digest: string): string[] {
  return [...(held ?? []).filter((kept) => kept !== digest), digest].slice(-DISMISSED_CHANGES_KEPT);
}
