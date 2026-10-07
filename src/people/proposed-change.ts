/**
 * A change a source proposes to a person the manager confirmed (W13-R3): a title, a team or an
 * address the source gives that differs from the confirmed one. The merge keeps it beside the
 * confirmed values, never over them, until the manager takes or dismisses it on the person's card.
 *
 * No Convex dependency: the merge and its tests read it alike.
 */

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
    !(person.notTheirAddresses ?? []).includes(address)
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
