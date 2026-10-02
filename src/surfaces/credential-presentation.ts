import { credentialPageRef } from '../docs/credential-ref';
import { isManagerLookupFailure } from './manager-lookup';

/** How a system authenticates, as orientation read it from the documentation. */
export type CredentialMethod = 'api-key' | 'bot-token' | 'oauth' | 'unknown';

/** What orientation found about a surface's credential: a value, a location, or nothing, with the evidence. */
export interface SurfaceCredentialFinding {
  evidenceRef?: string;
  found: 'value' | 'location' | 'none';
  governanceFinding?: string;
  label?: string;
  location?: string;
  method: CredentialMethod;
}

/** One stored credential as the card lists it: its id, label and kind. */
export interface CredentialOwnerSummary {
  _id: string;
  label: string;
  source: 'entered' | 'oauth' | { ref: string; sourceId: string };
}

/** The dedicated app a surface was provisioned with. */
export interface SurfaceProvisioning {
  appId: string;
  appName: string;
  installUrl: string;
  installedAt?: number;
  lastError?: string;
  stateExpiresAt?: number;
}

/** What the credential row shows and allows for one surface. */
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
  /** Whether the card offers the control that registers the app or issues its link again. */
  offerProvisioning: boolean;
  /**
   * Whether that control asks for an app configuration token: only to create a new app where the
   * organisation has no Slack connection (Q8 (b)). With the connection (B9), or for an app that
   * already exists, the card pastes nothing.
   */
  asksForConfigurationToken: boolean;
  stage:
    | 'not-applicable'
    | 'unavailable'
    | 'offer'
    | 'awaiting-install'
    | 'installed'
    | 'reinstall'
    | 'failed';
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
  'install link for you to click. The token is stored encrypted for that one call; straight ' +
  "afterwards Day0 asks Slack to revoke it and records Slack's answer, rather than keeping it for " +
  'the twelve hours it would otherwise live.';

/** What the administrator is told where the organisation's Slack connection creates the app (B9). */
export const ORGANISATION_PROVISION_NOTE =
  "The organisation's Slack connection creates this employee its own app from the manifest, with " +
  'nothing to paste. Day0 then shows the install link for an administrator to approve; the bot ' +
  'token arrives through the redirect and is never shown to anyone.';

/** Title of the renewal of an installed app whose access ended (A26). */
export const REINSTALL_LABEL = "Install the employee's own app again";

/** What the presentation is built from: the verdict, the finding, the stored credentials and the provisioning. */
export interface CredentialPresentationInput {
  verdict?: string;
  credential?: SurfaceCredentialFinding;
  credentialId?: string;
  credentialLocation?: string;
  provisioning?: SurfaceProvisioning;
  sourceLabel?: string;
  summary?: CredentialOwnerSummary;
  /** Why the last probe left the surface where it is, as the row stores it. */
  reason?: string;
}

/**
 * Compose the card's copy for the documented self-provisioning procedure.
 *
 * The procedure has three human steps and the card has to say which one is
 * next, because two of them are the administrator's and neither is something
 * Day0 can do on their behalf: issue a configuration token (unless the
 * organisation's Slack connection creates the app, B9), then click the install
 * link, then invite the new app to the channels it should read. An installed
 * app whose access ended is offered again (A26), with what the renewal restores
 * of its channels (RM4).
 *
 * Args:
 *   input.credential: The credential finding orientation extracted.
 *   input.provisioning: The dedicated app, once one has been registered.
 *   input.hasPublicUrl: Whether this deployment has an address an install can
 *     redirect back to.
 *   input.organisationConnected: Whether the organisation's Slack connection is active.
 *   input.credentialHeld: Whether the card holds its credential now.
 *
 * Returns:
 *   The stage, its copy and the install link when there is one to show.
 */
export function presentProvisioning(input: {
  credential?: SurfaceCredentialFinding;
  hasPublicUrl: boolean;
  provisioning?: SurfaceProvisioning;
  /** Whether the organisation has an active Slack configuration connection (B9). */
  organisationConnected?: boolean;
  /**
   * Whether the card holds its credential now. False for an installed app whose access ended (an
   * expiry or a Disconnect revoked its bot token, A26); absent reads as held, as before 11-AS.
   */
  credentialHeld?: boolean;
}): ProvisioningPresentation {
  if (input.credential?.method !== 'oauth') {
    return {
      note: 'The documentation describes no app installation procedure for this system.',
      offerProvisioning: false,
      asksForConfigurationToken: false,
      stage: 'not-applicable',
      title: 'Dedicated app',
    };
  }
  const provisioning = input.provisioning;
  if (provisioning?.installedAt && input.credentialHeld === false) {
    return {
      ...(provisioning.stateExpiresAt !== undefined ? { installUrl: provisioning.installUrl } : {}),
      note:
        `${provisioning.appName} stays in the workspace, but its access ended and Slack took its ` +
        'bot out of every channel. Issue its install link again and have an administrator ' +
        'approve it: after the install the employee re-joins the public channels its approved ' +
        'intake scope names itself, and someone in each private channel adds it again.',
      offerProvisioning: true,
      asksForConfigurationToken: false,
      stage: 'reinstall',
      title: REINSTALL_LABEL,
    };
  }
  if (provisioning?.installedAt) {
    return {
      note:
        `Installed. This employee acts as its own app, ${provisioning.appName}, and its writes ` +
        'are attributable to that bot user rather than to a shared token.',
      offerProvisioning: false,
      asksForConfigurationToken: false,
      stage: 'installed',
      title: 'Dedicated app installed',
    };
  }
  if (provisioning?.lastError) {
    return {
      installUrl: provisioning.installUrl,
      note: `${provisioning.lastError} Provision again to issue a fresh install link.`,
      offerProvisioning: true,
      asksForConfigurationToken: false,
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
      asksForConfigurationToken: false,
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
      asksForConfigurationToken: false,
      stage: 'unavailable',
      title: 'Dedicated app',
    };
  }
  const connected = input.organisationConnected === true;
  return {
    note: connected ? ORGANISATION_PROVISION_NOTE : PROVISION_NOTE,
    offerProvisioning: true,
    asksForConfigurationToken: !connected,
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
  const lookupFailure = isManagerLookupFailure(input.reason) ? input.reason : undefined;
  if (input.verdict === 'ungranted' && input.credentialId && lookupFailure !== undefined) {
    // The credential works; a new one would fail the same way (U9 step 18). With the free edit
    // gone the address is the owner's; People hands the employee over or makes it the owner's.
    return {
      canLand: false,
      kind: 'masked',
      label: input.summary?.label,
      governanceFinding,
      text: `The credential works, but the manager could not be found: ${lookupFailure.replace(/\.$/, '')}. The manager’s address must be one this workspace knows: choose on this employee’s People tab, then probe again.`,
    };
  }
  if (input.verdict === 'ungranted' && input.credentialId) {
    return {
      canLand: true,
      kind: 'landing',
      label: input.summary?.label,
      governanceFinding,
      text: 'The connection was not granted. Ask the system administrator to land a valid credential with the documented permissions.',
    };
  }
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
        text: 'entered on the card (masked)',
      };
    }
    return {
      canLand: false,
      governanceFinding,
      kind: 'masked',
      label: input.summary.label,
      text: `located in ${input.sourceLabel ?? 'documentation'} / ${credentialPageRef(input.summary.source.ref)} (masked)`,
    };
  }

  if (input.credential?.found === 'value' && !input.credentialLocation) {
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
