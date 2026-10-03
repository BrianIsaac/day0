import type { Doc } from '../../convex/_generated/dataModel';

/**
 * What a handover does to one surface of the employee. `cut`: the old manager's credential, chat
 * binding and approval are cleared and the card goes back to `proposed` for the new manager to
 * approve and connect again; `reapprove`: the employee's own identity, obtained through IT's
 * organisation connection, is kept and only the approval goes, so the new manager re-approves the
 * card with one click and no credential (A25); `carry`: nothing of the old manager's acts through
 * it, so it moves as it is. Either way, quotes of the old owner's documentation are dropped.
 */
export const SURFACE_HANDOVERS = ['cut', 'reapprove', 'carry'] as const;

/** One of {@link SURFACE_HANDOVERS}. */
export type SurfaceHandover = (typeof SURFACE_HANDOVERS)[number];

/** The verdicts that stand on the manager's approval of the card, the one approval there is (Q10). */
const APPROVED_VERDICTS: ReadonlySet<Doc<'surfaces'>['verdict']> = new Set([
  'approved',
  'connected',
  'ungranted',
  'listed-dead',
]);

/** What the decision reads of a surface: a row before the move, or a card as the page lists it. */
export type HandoverCandidate = Pick<
  Doc<'surfaces'>,
  'verdict' | 'credentialId' | 'provisioning' | 'managerApprovedAt'
> &
  Partial<Pick<Doc<'surfaces'>, 'organisationConnectionId' | 'actsAs'>>;

/** The identities a card acts as that are the employee's own app, kept at a handover (A25). */
const OWN_IDENTITY_KINDS: ReadonlySet<NonNullable<Doc<'surfaces'>['actsAs']>['kind']> = new Set([
  'own-app',
  'shared-app',
]);

/**
 * Whether a card acts as the employee's own identity obtained through IT's organisation
 * connection, and nothing of the old manager's: it is linked to the connection, says it acts as
 * an app, and every credential row it binds, where they are read, was issued through an
 * organisation connection or is held by the organisation.
 *
 * @param surface - The surface before the move.
 * @param bound - Its bound credential rows as read, or undefined where the caller reads none.
 */
function keepsOwnIdentity(
  surface: HandoverCandidate,
  bound: readonly Doc<'credentials'>[] | undefined,
): boolean {
  const linked =
    surface.organisationConnectionId !== undefined ||
    surface.provisioning?.organisationConnectionId !== undefined;
  if (!linked || surface.actsAs === undefined || !OWN_IDENTITY_KINDS.has(surface.actsAs.kind)) {
    return false;
  }
  // A page reads no rows: the card's own link and identity decide, its token or, once an expiry
  // or a Disconnect cleared that, its app's client secret, which the move reads and keeps
  // (11-AC's item 15). Rows read and gone keep nothing.
  if (bound === undefined) {
    return (
      surface.credentialId !== undefined ||
      surface.provisioning?.clientSecretCredentialId !== undefined
    );
  }
  return (
    bound.length > 0 &&
    bound.every(
      (row) => row.holder !== undefined || row.issuedBy?.organisationConnectionId !== undefined,
    )
  );
}

/**
 * The per-surface decision of a handover, stated once: the move, its preview and the hand-over
 * dialog's list of what is cut all ask here (the wave 9 review's U4-m6). A surface that acts as
 * the employee's own identity obtained through IT's organisation connection keeps it, and only its
 * approval goes (`reapprove`, A25). Any other surface bound to a credential, its own or its
 * provisioned app's client secret, which is always its owner's, is cut (D5 (a)): the new manager
 * cannot see what acts through it. A surface the old manager approved is cut too, credential or
 * not: the approval was theirs, and the new manager re-approves each system (A25). Anything else
 * is carried.
 *
 * @param surface - The surface as it stands before the move.
 * @param bound - The credential rows the surface binds, as read before the move; a bound id whose
 *   row is gone still cuts. A page that reads no credential rows passes none.
 */
export function surfaceHandoverOf(
  surface: HandoverCandidate,
  bound?: readonly Doc<'credentials'>[],
): SurfaceHandover {
  if (keepsOwnIdentity(surface, bound)) return 'reapprove';
  const bindsCredential =
    (bound !== undefined && bound.length > 0) ||
    surface.credentialId !== undefined ||
    surface.provisioning !== undefined;
  if (bindsCredential) return 'cut';
  if (surface.managerApprovedAt !== undefined || APPROVED_VERDICTS.has(surface.verdict)) {
    return 'cut';
  }
  return 'carry';
}
