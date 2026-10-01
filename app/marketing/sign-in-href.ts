import { TRANSFER_PARAMETER } from '../home/AcceptTransfer';

/** The sign-in a signed-out visitor is sent to from the landing page. */
export const SIGN_IN_HREF = '/sign-in';

/** A handover request's id as an address carries it: a Convex id's own characters, bounded. */
const TRANSFER_ID = /^[a-z0-9]{1,64}$/i;

/**
 * Where "Try the demo" sends a signed-out visitor: the sign-in, and, when they arrived on a
 * Review link (`/?transfer=<id>`), back to that handover after it, so the acceptance dialog
 * opens on the home rather than the request being lost at the sign-in (the wave 9 review's
 * U4-m2). Clerk's sign-in sends a signed-in visitor on to `redirect_url`. Only an id's own shape
 * is carried, and only to the home, so the address can send nobody anywhere else.
 *
 * @param transferId - The `transfer` parameter of the address the visitor arrived on, if any.
 */
export function signInHref(transferId: string | null): string {
  if (transferId === null || !TRANSFER_ID.test(transferId)) return SIGN_IN_HREF;
  const back = `/?${new URLSearchParams({ [TRANSFER_PARAMETER]: transferId }).toString()}`;
  return `${SIGN_IN_HREF}?${new URLSearchParams({ redirect_url: back }).toString()}`;
}
