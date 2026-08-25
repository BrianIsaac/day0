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
  credentialId?: string;
  credentialKind?: string;
  managerDmChannelId?: string;
  request?: unknown;
}

/**
 * Decide whether writes through a surface's credential need the employee's
 * name on them.
 *
 * A `credentials.kind` stored on the row wins. Without it, the connect
 * request's credential method decides: an `oauth` install is a dedicated app
 * that posts as itself, and every other landing is a shared key handed over to
 * the agent, so the shared rule is the default.
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
  const method = (row.request as { credential?: { method?: unknown } } | undefined)?.credential
    ?.method;
  return method === 'oauth' ? 'oauth' : 'value';
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
    credentialId: row.credentialId,
    credentialKind: credentialKindFor(row),
    managerDmChannelId: row.managerDmChannelId,
  };
}
