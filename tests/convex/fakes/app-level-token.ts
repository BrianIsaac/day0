import type { TestConvex } from 'convex-test';
import type { Id } from '../../../convex/_generated/dataModel';
import type schema from '../../../convex/schema';
import { ORGANISATION_HOLDER, ORGANISATION_OWNER_KEY } from '../../../src/lib/organisation-key';

/**
 * Give a Slack card's app the app-level token a person landed for its Socket Mode connection, in
 * the shape `slackSocketActions:landAppLevelToken` writes it (wave 12, 12-M): a pasted value held
 * by the organisation under the reserved key, with the app's id and no `issuedBy`, named by the
 * card's `provisioning.appLevelTokenCredentialId`. The card must already carry its app.
 *
 * @param harness - The test's backend.
 * @param surfaceId - The Slack card whose app the token is for.
 * @returns The token's credential row.
 */
export async function landAppLevelTokenRow(
  harness: TestConvex<typeof schema>,
  surfaceId: Id<'surfaces'>,
): Promise<Id<'credentials'>> {
  return await harness.run(async (ctx) => {
    const card = await ctx.db.get(surfaceId);
    if (!card?.provisioning) throw new Error('the card carries no app to give a token');
    const credentialId = await ctx.db.insert('credentials', {
      userId: ORGANISATION_OWNER_KEY,
      holder: ORGANISATION_HOLDER,
      kind: 'value',
      label: `${card.provisioning.appName} app-level token`,
      ciphertext: 'sealed-app-level-token',
      iv: 'iv',
      keyId: 'key-1',
      source: 'entered',
      appId: card.provisioning.appId,
      createdAt: 1,
    });
    await ctx.db.patch(surfaceId, {
      provisioning: { ...card.provisioning, appLevelTokenCredentialId: credentialId },
    });
    return credentialId;
  });
}
