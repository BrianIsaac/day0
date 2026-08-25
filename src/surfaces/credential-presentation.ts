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
  text: string;
}

const DETAIL_LENGTH = 400;

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
  if (input.credential?.method === 'oauth') {
    const procedure = input.credential.location;
    const summary = input.credentialLocation ?? procedure;
    return {
      canLand: false,
      detail:
        procedure && procedure !== summary
          ? procedure.length > DETAIL_LENGTH
            ? `${procedure.slice(0, DETAIL_LENGTH).trimEnd()}...`
            : procedure
          : undefined,
      governanceFinding,
      kind: 'oauth',
      label: input.credential.label,
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
