/**
 * The address of a handover's Review: the home with the request named, which opens the
 * acceptance dialog. A module of its own, free of the dialog's reads, so the signed-out landing
 * can carry it through the sign-in without reaching an owned read before its gate.
 */

/** The address parameter that opens the acceptance dialog: `/?transfer=<transferId>`. */
export const TRANSFER_PARAMETER = 'transfer';

/**
 * The Review link of a handover request: the home, with the request named.
 *
 * @param transferId - The request's id.
 */
export function reviewHref(transferId: string): string {
  return `/?${new URLSearchParams({ [TRANSFER_PARAMETER]: transferId }).toString()}`;
}
