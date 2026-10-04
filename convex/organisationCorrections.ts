import { ConvexError, v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
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

/** The hosts a plain-http redirect may name: this machine, for a bed. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The longest redirect address a connection records. */
const REDIRECT_MAX = 2_048;

/** Whether an address is absolute https, or http on this machine for a bed. */
function securedAddress(address: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    // Not an address at all: refused in the same words as any other.
    return false;
  }
  return (
    parsed.protocol === 'https:' ||
    (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))
  );
}

/** Why a redirect address is not one a connection can record, or undefined when it is. */
function redirectRefusal(redirectUrl: string): string | undefined {
  if (redirectUrl.length > REDIRECT_MAX) {
    return `A redirect address is at most ${REDIRECT_MAX} characters.`;
  }
  return securedAddress(redirectUrl)
    ? undefined
    : 'A redirect address is an absolute https (or local http) address.';
}

/**
 * Why an issuer cannot be recorded on the connection, or undefined when it can (the round review's
 * m13): only an MCP client records one, only where none is recorded (a recorded issuer is the
 * server IT registered the client with, and changing it would send the client's secret elsewhere,
 * M12 f), and only an https (or local http) address.
 */
function issuerRefusal(
  connection: Doc<'organisationConnections'>,
  issuer: string,
): string | undefined {
  if (connection.kind !== 'mcp-client') return 'Only an MCP connection records an issuer.';
  if (connection.issuer !== undefined && connection.issuer !== issuer) {
    return 'The connection already records its issuer: revoke it and land it again to change it.';
  }
  if (issuer.length > REDIRECT_MAX || !securedAddress(issuer)) {
    return 'An issuer is an absolute https (or local http) address.';
  }
  return undefined;
}

/**
 * Correct the redirect and the scopes the system's connection records, from the setup command
 * (`./setup.sh access --correct <system>`, which acts with the deployment's admin key), and the
 * issuer of an MCP connection landed with none (the round review's m13), which otherwise only a
 * revoke and a landing again cured, ending every card on it. Internal. Reads the system's active
 * connection, or the one needing IT's attention; writes the values that differ and one
 * `organisation.connection-corrected` line with what each was, naming no address; writes nothing
 * when nothing differs. The client-credentials scope set is never touched (L2).
 *
 * @throws ConvexError when the system has no connection, or a value is not one.
 */
export const correctFromSetup = internalMutation({
  args: {
    system: v.string(),
    redirectUrl: v.optional(v.string()),
    scopes: v.optional(v.array(v.string())),
    issuer: v.optional(v.string()),
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
    const issuer = args.issuer?.trim();
    if (issuer !== undefined) {
      const refusal = issuerRefusal(connection, issuer);
      if (refusal !== undefined) throw new ConvexError(refusal);
    }
    const scopes = args.scopes === undefined ? undefined : [...cleanScopes(args.scopes)];
    const redirectChanged = redirectUrl !== undefined && redirectUrl !== connection.redirectUrl;
    const scopesChanged =
      scopes !== undefined && scopes.join('\n') !== connection.scopes.join('\n');
    const issuerRecorded = issuer !== undefined && connection.issuer === undefined;
    if (!redirectChanged && !scopesChanged && !issuerRecorded) return { changed: false };
    await ctx.db.patch(connection._id, {
      ...(redirectChanged ? { redirectUrl } : {}),
      ...(scopesChanged ? { scopes } : {}),
      ...(issuerRecorded ? { issuer } : {}),
    });
    await appendConnectionEvent(ctx, {
      organisationConnectionId: connection._id,
      type: 'organisation.connection-corrected',
      payload: {
        organisationConnectionId: connection._id,
        system: connection.system,
        displayName: connection.displayName,
        via: 'setup-cli',
        ...(redirectChanged ? { redirectCorrected: true } : {}),
        ...(scopesChanged ? { scopes, previousScopes: connection.scopes } : {}),
        ...(issuerRecorded ? { issuerRecorded: true } : {}),
      },
      createdAt: Date.now(),
    });
    return { changed: true };
  },
});
