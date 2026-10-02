/*
 * What a revoker builds and what it reads back (wave 11, 11-AR; the access plan, section 4.4).
 * The revokers are pure: each builds the one HTTP request a vendor's revocation takes and reads
 * the vendor's answer into one of four meanings. The action that sends the request
 * (`convex/sourceRevocationActions.ts`) is the only code that reaches the network.
 */

/** One HTTP POST a revoker asks the caller to send. */
export interface RevocationRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The form-encoded body; empty where the method takes nothing beyond its bearer. */
  readonly body: string;
}

/**
 * What a vendor's answer means: the credential or app was revoked; it was already gone, so there
 * is nothing left to revoke; the vendor failed in a way another attempt may not (rate limited, or
 * its own error), with its words; or it refused in a way another attempt cannot change, with its
 * words.
 */
export type RevocationAnswer =
  | { readonly kind: 'revoked' }
  | { readonly kind: 'gone' }
  | { readonly kind: 'retry'; readonly words: string }
  | { readonly kind: 'refused'; readonly words: string };

/** Which token of an OAuth pair a revocation names (RFC 7009, section 2.1). */
export type TokenTypeHint = 'access_token' | 'refresh_token';

/** The form encoding every revocation request in this directory sends. */
export const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
