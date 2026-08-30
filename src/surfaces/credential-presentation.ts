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
  source: 'entered' | 'oauth' | { ref: string; sourceId: string };
}

export interface SurfaceProvisioning {
  appId: string;
  appName: string;
  installUrl: string;
  installedAt?: number;
  lastError?: string;
  stateExpiresAt?: number;
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

/** What the card shows for the documented self-provisioning procedure. */
export interface ProvisioningPresentation {
  /** The install link, once an app exists and the link has not been spent. */
  installUrl?: string;
  note: string;
  /** Whether the card offers the configuration-token form. */
  offerProvisioning: boolean;
  stage: 'not-applicable' | 'unavailable' | 'offer' | 'awaiting-install' | 'installed' | 'failed';
  title: string;
}

const DETAIL_LENGTH = 400;

/** Button text for the shared-token fallback on an OAuth surface. */
export const OAUTH_FALLBACK_LABEL = 'Land a shared bot token (fallback)';

/** Why an OAuth surface still offers a landing field beside provisioning. */
export const OAUTH_FALLBACK_NOTE =
  'A dedicated app is the documented path, and the control above registers one. Where the ' +
  'administrator would rather hand over the workspace token instead, land it here: it is stored ' +
  'encrypted as a shared credential, and writes through it carry the employee name and run id ' +
  'so they stay attributable.';

/** Button text for the documented self-provisioning control. */
export const PROVISION_LABEL = 'Provision a dedicated app';

/** What the administrator is asked for, and what happens to it. */
export const PROVISION_NOTE =
  'Paste an app configuration token (api.slack.com/apps, Your App Configuration Tokens). Day0 ' +
  'registers this employee its own app from the manifest on the policy page, then shows the ' +
  'install link for you to click. The token is stored encrypted for that one call and revoked ' +
  'immediately afterwards; it is never kept for the twelve hours it would otherwise live.';

export interface CredentialPresentationInput {
  credential?: SurfaceCredentialFinding;
  credentialId?: string;
  credentialLocation?: string;
  provisioning?: SurfaceProvisioning;
  sourceLabel?: string;
  summary?: CredentialOwnerSummary;
}

/**
 * Compose the card's copy for the documented self-provisioning procedure.
 *
 * The procedure has three human steps and the card has to say which one is
 * next, because two of them are the administrator's and neither is something
 * Day0 can do on their behalf: issue a configuration token, then click the
 * install link, then invite the new app to the channels it should read.
 *
 * Args:
 *   input.credential: The credential finding orientation extracted.
 *   input.provisioning: The dedicated app, once one has been registered.
 *   input.hasPublicUrl: Whether this deployment has an address an install can
 *     redirect back to.
 *
 * Returns:
 *   The stage, its copy and the install link when there is one to show.
 */
export function presentProvisioning(input: {
  credential?: SurfaceCredentialFinding;
  hasPublicUrl: boolean;
  provisioning?: SurfaceProvisioning;
}): ProvisioningPresentation {
  if (input.credential?.method !== 'oauth') {
    return {
      note: 'The documentation describes no app installation procedure for this system.',
      offerProvisioning: false,
      stage: 'not-applicable',
      title: 'Dedicated app',
    };
  }
  const provisioning = input.provisioning;
  if (provisioning?.installedAt) {
    return {
      note:
        `Installed. This employee acts as its own app, ${provisioning.appName}, and its writes ` +
        'are attributable to that bot user rather than to a shared token.',
      offerProvisioning: false,
      stage: 'installed',
      title: 'Dedicated app installed',
    };
  }
  if (provisioning?.lastError) {
    return {
      installUrl: provisioning.installUrl,
      note: `${provisioning.lastError} Provision again to issue a fresh install link.`,
      offerProvisioning: true,
      stage: 'failed',
      title: 'Install did not complete',
    };
  }
  if (provisioning) {
    return {
      installUrl: provisioning.installUrl,
      note:
        `${provisioning.appName} is registered. Open the install link and approve it for the ` +
        'workspace; the bot token arrives through the redirect and is never shown to anyone. ' +
        'The link is single-use and expires fifteen minutes after it was issued.',
      offerProvisioning: false,
      stage: 'awaiting-install',
      title: 'Awaiting the install click',
    };
  }
  if (!input.hasPublicUrl) {
    return {
      note:
        'This deployment has no public address for the install to return to, so an app cannot ' +
        'be registered yet. Set DAY0_PUBLIC_URL to a tunnel pointing at this machine.',
      offerProvisioning: false,
      stage: 'unavailable',
      title: 'Dedicated app',
    };
  }
  return {
    note: PROVISION_NOTE,
    offerProvisioning: true,
    stage: 'offer',
    title: PROVISION_LABEL,
  };
}

/**
 * Compose the copy the card shows about channels the app cannot read yet.
 *
 * Args:
 *   channels: Channel names the probe found the app is not a member of.
 *   appName: The dedicated app's name, when there is one.
 *
 * Returns:
 *   The sentence for the card, or undefined when there is nothing to say.
 */
export function presentChannelsNotJoined(
  channels: readonly string[] | undefined,
  appName?: string,
): string | undefined {
  if (!channels || channels.length === 0) return undefined;
  const who = appName ?? 'this employee';
  const list = channels.join(', ');
  return (
    `Not in ${list}. The probe reached the workspace and opened the manager DM, but the ` +
    `provider answers "not in channel" until someone invites the app. Invite ${who} to ${list} ` +
    '(`/invite` in the channel), then probe again; intake reads those channels once it is a member.'
  );
}

/**
 * Compose safe credential copy without accepting credential material.
 *
 * An `oauth` surface describes an install flow the employee runs for itself.
 * Until a credential is stored the row still offers a labelled fallback beside
 * that flow: the administrator may hand over the workspace's shared bot token,
 * which is kept as a shared credential and carries provenance on every write.
 * Once any credential is stored the row shows the store's metadata.
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
    if (input.summary.source === 'oauth') {
      return {
        canLand: false,
        governanceFinding,
        kind: 'masked',
        label: input.summary.label,
        text: input.provisioning
          ? `delivered by the install of ${input.provisioning.appName} (masked)`
          : 'delivered by an OAuth install (masked)',
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
