/**
 * The `src/surfaces/credentials` module as the apply-path tests replace it:
 * a credential decrypts to `plain-<id>` and the decrypt reference keeps the
 * function's name. A test mounts it with
 * `vi.mock('../../src/surfaces/credentials', () => import('./fakes/surface-credentials'))`.
 */

/** The decrypt action's reference, by name only, as the fake's callers compare it. */
export const decryptCredentialRef = { name: 'credentials:decrypt' };

/** The plaintext every credential decrypts to under the fake. */
export async function decryptCredential(_ctx: unknown, credentialId: string): Promise<string> {
  return `plain-${credentialId}`;
}
