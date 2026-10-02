import { ConvexError, v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { appendConnectionEvent } from './connectionEvents';
import { cleanScopes, occupyingConnectionFor, scopesRefusal } from './organisationConnections';

/*
 * Correcting what an organisation connection records of IT's registration at the vendor (the
 * wave 11 review's M12 e): its redirect and its scopes, which `check:access` compares with what
 * Day0 needs. A redirect IT registered again at the vendor, or scopes it granted there, change
 * nothing Day0 holds, and a rotation from the organisation page sends no scopes, so without this a
 * gap the runbook cures survives its cure. No secret changes and no card ends: the connection is
 * the same one, recorded right.
 */

/** The longest redirect address a connection records. */
const REDIRECT_MAX = 2_048;

/** Why a redirect address is not one a connection can record, or undefined when it is. */
function redirectRefusal(redirectUrl: string): string | undefined {
  if (redirectUrl.length > REDIRECT_MAX) {
    return `A redirect address is at most ${REDIRECT_MAX} characters.`;
  }
  let parsed: URL;
  try {
    parsed = new URL(redirectUrl);
  } catch {
    // Not an address at all: refused in the same words as any other.
    return 'A redirect address is an absolute https (or local http) address.';
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:'
    ? undefined
    : 'A redirect address is an absolute https (or local http) address.';
}

/**
 * Correct the redirect and the scopes the system's connection records, from the setup command
 * (`./setup.sh access --correct <system>`, which acts with the deployment's admin key). Internal.
 * Reads the system's active connection, or the one needing IT's attention; writes the values that
 * differ and one `organisation.connection-corrected` line with what each was, naming no address;
 * writes nothing when nothing differs. The client-credentials scope set is never touched (L2).
 *
 * @throws ConvexError when the system has no connection, or a value is not one.
 */
export const correctFromSetup = internalMutation({
  args: {
    system: v.string(),
    redirectUrl: v.optional(v.string()),
    scopes: v.optional(v.array(v.string())),
  },
  returns: v.object({ changed: v.boolean() }),
  handler: async (ctx, args): Promise<{ changed: boolean }> => {
    const connection = await occupyingConnectionFor(ctx, args.system);
    if (connection === null) {
      throw new ConvexError(`No connection for ${args.system} is active: land it first.`);
    }
    const redirectUrl = args.redirectUrl?.trim();
    if (redirectUrl !== undefined) {
      const refusal = redirectRefusal(redirectUrl);
      if (refusal !== undefined) throw new ConvexError(refusal);
    }
    if (args.scopes !== undefined) {
      const refusal = scopesRefusal(args.scopes, 'The registration');
      if (refusal !== undefined) throw new ConvexError(refusal);
    }
    const scopes = args.scopes === undefined ? undefined : [...cleanScopes(args.scopes)];
    const redirectChanged = redirectUrl !== undefined && redirectUrl !== connection.redirectUrl;
    const scopesChanged =
      scopes !== undefined && scopes.join('\n') !== connection.scopes.join('\n');
    if (!redirectChanged && !scopesChanged) return { changed: false };
    await ctx.db.patch(connection._id, {
      ...(redirectChanged ? { redirectUrl } : {}),
      ...(scopesChanged ? { scopes } : {}),
    });
    await appendConnectionEvent(ctx, {
      organisationConnectionId: connection._id,
      type: 'organisation.connection-corrected',
      payload: {
        organisationConnectionId: connection._id,
        system: connection.system,
        displayName: connection.displayName,
        via: 'setup-cli',
        ...(redirectChanged
          ? {
              redirectUrl,
              ...(connection.redirectUrl !== undefined
                ? { previousRedirectUrl: connection.redirectUrl }
                : {}),
            }
          : {}),
        ...(scopesChanged ? { scopes, previousScopes: connection.scopes } : {}),
      },
      createdAt: Date.now(),
    });
    return { changed: true };
  },
});
