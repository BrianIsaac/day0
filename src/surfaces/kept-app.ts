/*
 * An employee's own Slack app after IT revoked the organisation's connection that created it
 * (W12X-4): Day0 never installs it again, so its card connects through nothing, now or once IT
 * connects Slack again. Every reader of such a card asks the same question here (13-FS).
 */

/** The fields of a card the question reads. */
export interface KeptAppCard {
  readonly class: string;
  readonly credentialId?: unknown;
  readonly provisioning?: { readonly organisationConnectionId?: unknown };
}

/**
 * Whether a card's own app is one IT's revoke ended: a chat card holding no credential whose app
 * was created through an organisation connection that is now revoked.
 *
 * @param card - The card.
 * @param creatorRevoked - Whether the connection named by `provisioning.organisationConnectionId`
 *   is revoked.
 */
export function keptAppNotReinstalled(card: KeptAppCard, creatorRevoked: boolean): boolean {
  return (
    card.class === 'chat' &&
    card.credentialId === undefined &&
    card.provisioning?.organisationConnectionId !== undefined &&
    creatorRevoked
  );
}

/** Why a card IT's revoke ended takes no app-level token (13-FS, W12X-4). */
export const KEPT_APP_TAKES_NO_TOKEN =
  "This card's own Slack app is not installed again: IT revoked the organisation's connection it was created with, so it takes no app-level token.";
