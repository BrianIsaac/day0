/**
 * The source ref of a credential found on a documentation page, and the page
 * it names.
 *
 * A leaf module, so the connection card (a client component) can print the
 * page a credential came from without bundling the redaction pipeline.
 */

/** What joins a page's ref to the fingerprint of a credential found on it. */
const CREDENTIAL_REF_SEPARATOR = '#credential=';

/**
 * The shape of a value fingerprint (`credentialValueFingerprint`): lower-case
 * hex, never the `-` an earlier release's `<position>-<label>` suffix carries.
 */
const FINGERPRINT_PATTERN = /^[0-9a-f]{32}$/;

/**
 * The source ref of a credential found on a page: the page ref and the
 * fingerprint of the value.
 *
 * Keyed by the value, not its position or label, so a page edit that moves or
 * relabels a value keeps its credential, and a different value under the same
 * label is a new credential (P5-12, P7-15). The page part stays, so every row
 * of a page is read by `credentialRefRange` and `credentialPageRef`.
 *
 * @param pageRef - Stable provider page reference.
 * @param fingerprint - The value's fingerprint for its owner under the
 *   deployment's key (`credentialCryptoActions.fingerprint`).
 * @throws Error when `fingerprint` is not a value fingerprint.
 */
export function credentialSourceRef(pageRef: string, fingerprint: string): string {
  if (!FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new Error('A credential source ref is keyed by a value fingerprint.');
  }
  return `${pageRef}${CREDENTIAL_REF_SEPARATOR}${fingerprint}`;
}

/**
 * Whether a credential source ref is keyed by a value fingerprint, rather than
 * by the page alone or a position and label as before value-keyed refs.
 *
 * @param ref - A credential source ref.
 */
export function isValueKeyedRef(ref: string): boolean {
  const at = ref.lastIndexOf(CREDENTIAL_REF_SEPARATOR);
  return at !== -1 && FINGERPRINT_PATTERN.test(ref.slice(at + CREDENTIAL_REF_SEPARATOR.length));
}

/**
 * The page a credential's source ref belongs to: the inverse of
 * `credentialSourceRef` on its page part, and of the page-only and
 * position-and-label refs rows stored before value-keyed refs still carry
 * until the `credentials-value-refs` migration rewrites them.
 *
 * @param ref - A credential source ref.
 * @returns The page ref the credential was found on.
 */
export function credentialPageRef(ref: string): string {
  const at = ref.lastIndexOf(CREDENTIAL_REF_SEPARATOR);
  return at === -1 ? ref : ref.slice(0, at);
}

/**
 * The index bounds of every credential ref of one page that extends the page
 * ref: its value-keyed refs, and the position-and-label refs stored before
 * them. The page-only ref stored before them is the page ref itself. Only a
 * page whose own ref carries the separator can share the range, which
 * `credentialPageRef` tells apart.
 *
 * @param pageRef - Stable provider page reference.
 */
export function credentialRefRange(pageRef: string): { from: string; to: string } {
  return {
    from: `${pageRef}${CREDENTIAL_REF_SEPARATOR}`,
    to: `${pageRef}${CREDENTIAL_REF_SEPARATOR}\uffff`,
  };
}
