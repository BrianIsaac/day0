export type CredentialMethod = 'api-key' | 'bot-token' | 'oauth' | 'unknown';

export interface SurfaceCredentialFinding {
  evidenceRef?: string;
  found: 'value' | 'location' | 'none';
  governanceFinding?: string;
  label?: string;
  location?: string;
  method: CredentialMethod;
}

export interface CredentialOwnerSummary {
  _id: string;
  label: string;
  source: 'entered' | { ref: string; sourceId: string };
}

export interface CredentialPresentation {
  canLand: boolean;
  /** A longer documented procedure shown under the row, clipped for the card. */
  detail?: string;
  governanceFinding?: string;
  kind: 'masked' | 'oauth' | 'landing' | 'unresolved';
  label?: string;
  /** Button text for the landing form when it is not the plain documented landing. */
  landingLabel?: string;
  /** Why the landing form is offered, shown above it. */
  landingNote?: string;
  text: string;
}

const DETAIL_LENGTH = 400;

/** Button text for the shared-token fallback on an OAuth surface. */
export const OAUTH_FALLBACK_LABEL = 'Land a shared bot token (fallback)';

/** Why an OAuth surface still offers a landing field. */
export const OAUTH_FALLBACK_NOTE =
  'Day0 cannot yet provision its own app, so until it can the installing administrator may land ' +
  'the shared bot token here. It is stored encrypted as a shared credential: writes through it ' +
  'carry the employee name and run id, and it is replaced by the app token once the install flow exists.';

export interface CredentialPresentationInput {
  credential?: SurfaceCredentialFinding;
  credentialId?: string;
  credentialLocation?: string;
  sourceLabel?: string;
  summary?: CredentialOwnerSummary;
}

/**
 * Compose safe credential copy without accepting credential material.
 *
 * An `oauth` surface describes an install flow Day0 cannot run yet (the app
 * is provisioned in Phase 3), so until a credential is stored the row offers
 * a labelled fallback: the administrator lands the workspace's shared bot
 * token, which is kept as a shared credential and carries provenance on every
 * write. Once any credential is stored the row shows the store's metadata.
 *
 * Args:
 *   input: Surface finding and owner-visible credential metadata.
 *
 * Returns:
 *   Display copy and whether a write-only landing form is appropriate.
 */
export function presentSurfaceCredential(
  input: CredentialPresentationInput,
): CredentialPresentation {
  const governanceFinding = input.credential?.governanceFinding;
  if (input.credential?.method === 'oauth' && !input.credentialId) {
    const procedure = input.credential.location;
    const summary = input.credentialLocation ?? procedure;
    return {
      canLand: true,
      detail:
        procedure && procedure !== summary
          ? procedure.length > DETAIL_LENGTH
            ? `${procedure.slice(0, DETAIL_LENGTH).trimEnd()}...`
            : procedure
          : undefined,
      governanceFinding,
      kind: 'oauth',
      label: input.credential.label,
      landingLabel: OAUTH_FALLBACK_LABEL,
      landingNote: OAUTH_FALLBACK_NOTE,
      text: summary ?? 'Follow the documented OAuth approval procedure.',
    };
  }

  if (input.credentialId) {
    if (!input.summary) {
      return {
        canLand: false,
        governanceFinding,
        kind: 'unresolved',
        text: 'Stored credential metadata is unavailable.',
      };
    }
    if (input.summary.source === 'entered') {
      return {
        canLand: false,
        governanceFinding,
        kind: 'masked',
        label: input.summary.label,
        text: 'entered by IT (masked)',
      };
    }
    return {
      canLand: false,
      governanceFinding,
      kind: 'masked',
      label: input.summary.label,
      text: `located in ${input.sourceLabel ?? 'documentation'} / ${input.summary.source.ref} (masked)`,
    };
  }

  if (input.credential?.found === 'value') {
    return {
      canLand: false,
      governanceFinding,
      kind: 'unresolved',
      text: 'Stored credential marker could not be resolved - re-sync the documentation.',
    };
  }

  const location = input.credential?.location ?? input.credentialLocation;
  if (!location) {
    return {
      canLand: false,
      governanceFinding,
      kind: 'unresolved',
      label: input.credential?.label,
      text: 'not in the docs - location not documented',
    };
  }
  return {
    canLand: true,
    governanceFinding,
    kind: 'landing',
    label: input.credential?.label,
    text: `not in the docs - ${location}`,
  };
}
