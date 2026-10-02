import { organisationSystemOf } from '../../../../../../src/surfaces/access-request';
import type { CredentialOwnerSummary } from '../../../../../../src/surfaces/credential-presentation';
import {
  listedCardIdentity,
  type IdentityConnection,
  type ListedIdentity,
  type ListedIdentityInput,
} from '../../../../../../src/surfaces/card-identity';

/*
 * A card row as `surfaces.listForAgent` answers it, for the Surfaces tab's tests: the backend
 * answers whom each card acts as (`identity`, `connectionIdentity`) by the one rule
 * (`listedCardIdentity`), so a fixture row is given what that rule answers for it, from the same
 * organisation connections and stored credentials the test hands the card.
 */

/** What the listing reads beside the row: the organisation's connections and the credentials. */
export interface ListingContext {
  /** The systems IT connected, by system, as `summaryForManager` lists them. */
  readonly organisation?: ReadonlyMap<string, IdentityConnection>;
  /** The stored credentials, by id, with their `source`. */
  readonly credentials?: ReadonlyMap<string, Pick<CredentialOwnerSummary, 'source'>>;
  /** Whether the deployment has a public address for an install to return to. */
  readonly installRedirectConfigured?: boolean;
}

/**
 * The row with whom it acts as, as the backend lists it; a row that already says it is kept.
 *
 * @param row - The fixture row.
 * @param context - The connections and credentials the listing would read.
 */
export function withListedIdentity<Row extends object>(
  row: Row,
  context: ListingContext = {},
): Row & ListedIdentity {
  const card = row as ListedIdentityInput['card'] & { readonly identity?: unknown };
  if (card.identity !== undefined) return row as Row & ListedIdentity;
  const system = organisationSystemOf(card);
  const connection = system === undefined ? undefined : context.organisation?.get(system);
  const held =
    card.credentialId === undefined
      ? undefined
      : context.credentials?.get(String(card.credentialId));
  return {
    ...row,
    ...listedCardIdentity({
      card,
      ...(connection !== undefined ? { connection } : {}),
      ...(held !== undefined ? { heldCredentialSource: held.source } : {}),
      hasPublicUrl: context.installRedirectConfigured === true,
    }),
  };
}
