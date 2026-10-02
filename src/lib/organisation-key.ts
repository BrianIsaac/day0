/**
 * The reserved key the organisation's own rows are stored under (the access plan, section 4.1;
 * decision AC12).
 *
 * A customer-local deployment is one company, so what IT connects at install (an organisation
 * connection's secret, an app token shared by every employee) belongs to no manager. Such a
 * `credentials` row carries `holder: 'organisation'` and this key as its `userId`, so every
 * owner-facing read, which goes by the caller's own key, never reaches it by index, and its
 * seal binds this key as associated data.
 *
 * The key holds no `|`, so the customer issuer's owner keys (its `tokenIdentifier`, issuer and
 * subject joined by a bar) can never equal it, and it is neither the local issuer's one subject
 * nor shaped as a Clerk subject (`user_...`). `ownerKeyOf` refusing a bare subject equal to it is
 * the one guard left, and it is 11-AO's.
 */

/** The owner key of every organisation-held row. No signed-in caller is ever keyed on it. */
export const ORGANISATION_OWNER_KEY = 'day0:organisation';

/** The `credentials.holder` of a row the organisation holds; absent means the owner holds it. */
export const ORGANISATION_HOLDER = 'organisation';

/**
 * Whether an owner key is the organisation's reserved key.
 *
 * @param key - An owner key, as `ownerKeyOf` or a stored `userId` gives it.
 */
export function isOrganisationOwnerKey(key: string): boolean {
  return key === ORGANISATION_OWNER_KEY;
}
