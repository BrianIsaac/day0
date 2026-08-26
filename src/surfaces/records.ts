import { isSurfacePath, CREDENTIAL_KINDS, type CredentialKind, type SurfaceRecord } from './types';
import type { PersistedSurfaceVerdict } from './verdict';

/**
 * A `surfaces` row as any lane's schema revision may store it. Only the fields
 * the executors read are named; everything else is carried opaquely.
 */
export interface SurfaceRowLike {
  slug: string;
  displayName: string;
  class: string;
  verdict: PersistedSurfaceVerdict;
  credentialLanded: boolean;
  lastVerifiedAt?: number;
  path?: string;
  endpoint?: string;
  toolAllowlist?: string[];
  toolArguments?: Array<{ tool: string; arguments: string[] }>;
  credentialId?: string;
  credentialKind?: string;
  managerDmChannelId?: string;
  managerName?: string;
}

/**
 * Decide whether writes through a surface's credential need the employee's
 * name on them.
 *
 * The kind is the one copied onto the row from the credentials table when
 * the credential was attached (`surfaces.propose`, `surfaces.attachCredential`),
 * so it says how the value was actually landed rather than what the connect
 * request expected. A row without one is treated as a shared key: an `oauth`
 * app posts as itself only when the install flow stored it as such.
 *
 * Args:
 *   row: The surface row.
 *
 * Returns:
 *   The credential kind the provenance rules should apply.
 */
export function credentialKindFor(row: SurfaceRowLike): CredentialKind {
  if (CREDENTIAL_KINDS.includes(row.credentialKind as CredentialKind)) {
    return row.credentialKind as CredentialKind;
  }
  return 'value';
}

/**
 * Narrow a stored surface row to the record the executors read.
 *
 * Args:
 *   row: The surface row.
 *
 * Returns:
 *   The executor-facing record.
 */
export function toSurfaceRecord(row: SurfaceRowLike): SurfaceRecord {
  return {
    slug: row.slug,
    displayName: row.displayName,
    class: row.class,
    verdict: row.verdict,
    credentialLanded: row.credentialLanded,
    lastVerifiedAt: row.lastVerifiedAt,
    path: isSurfacePath(row.path) ? row.path : undefined,
    endpoint: row.endpoint,
    toolAllowlist: row.toolAllowlist,
    toolArguments: row.toolArguments,
    credentialId: row.credentialId,
    credentialKind: credentialKindFor(row),
    managerDmChannelId: row.managerDmChannelId,
    managerName: row.managerName,
  };
}
