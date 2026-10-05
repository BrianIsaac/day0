import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { httpAction, internalMutation, internalQuery, type MutationCtx } from './_generated/server';
import { purgeCredential } from './credentials';
import { appendEvent } from './eventLog';
import { resolveManagerReply } from './work';
import { isManagerChannel } from './workLoop';
import {
  bridgeSecretMatches,
  decisionButtonsFor,
  parsePress,
  SOCKET_BRIDGE_SECRET_VAR,
  type SocketPress,
} from '../src/surfaces/slack-socket';
import { parseDecisionPress } from '../src/work/decision-blocks';
import { accessEnded } from '../src/work/surface-access';

/**
 * The internal routes the Socket Mode bridge (`slack-socket/`, RM7) calls, and what they read and
 * decide (wave 12, 12-M). Nothing here is reached from the internet: Slack pushes a press down the
 * bridge's own outbound WebSocket (Q13), and the bridge hands it to the backend on the compose
 * network, presenting the generated secret every route checks first.
 */

/** How many chat cards one page of the bridge's list reads. */
const BRIDGE_PAGE = 200;

/** The most pages the bridge's list reads (40,000 chat cards), so one call is bounded. */
const BRIDGE_PAGES = 200;

/** A chat card that carries presses: buttons available, connected, its access not ended. */
function carriesPresses(surface: Doc<'surfaces'>, now: number): boolean {
  return (
    surface.class === 'chat' &&
    surface.verdict === 'connected' &&
    !accessEnded(surface, now) &&
    surface.managerDmChannelId !== undefined &&
    decisionButtonsFor(surface, true).available
  );
}

/** One app the bridge carries presses for: its card, its id and its name, never its token. */
interface BridgeApp {
  readonly surfaceId: Id<'surfaces'>;
  readonly appId: string;
  /** The app's name, which `check:access` names its card by (W12-R32). */
  readonly appName: string;
  /**
   * Which app-level token the card holds: the id of its row, never the token. A new one tells the
   * bridge the token was replaced, so it dials again with it (W12V-6).
   */
  readonly tokenRef: string;
}

/**
 * Internal: one page of the apps whose presses the bridge carries, each by its card, its app id
 * and its name, never its token: every card that can carry buttons (its own app with its app-level token)
 * and is connected with its access running.
 */
export const appsForBridge = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    apps: BridgeApp[];
    cursor: string | null;
  }> => {
    const now = Date.now();
    const page = await ctx.db
      .query('surfaces')
      .withIndex('by_class', (q) => q.eq('class', 'chat'))
      .paginate({ cursor: args.cursor, numItems: BRIDGE_PAGE });
    return {
      apps: page.page.flatMap((surface) =>
        carriesPresses(surface, now) &&
        surface.provisioning?.appLevelTokenCredentialId !== undefined
          ? [
              {
                surfaceId: surface._id,
                appId: surface.provisioning.appId,
                appName: surface.provisioning.appName,
                tokenRef: surface.provisioning.appLevelTokenCredentialId,
              },
            ]
          : [],
      ),
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});

/**
 * Internal: the app-level token's credential a card's connection opens with, when the card carries
 * presses; null otherwise. The bridge names the card as a string, so it is checked to be one.
 */
export const connectionTarget = internalQuery({
  args: { surfaceId: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ credentialId: Id<'credentials'>; appId: string } | null> => {
    const surfaceId = ctx.db.normalizeId('surfaces', args.surfaceId);
    const surface = surfaceId === null ? null : await ctx.db.get(surfaceId);
    const credentialId = surface?.provisioning?.appLevelTokenCredentialId;
    if (surface === null || credentialId === undefined || !carriesPresses(surface, Date.now())) {
      return null;
    }
    return { credentialId, appId: surface.provisioning!.appId };
  },
});

const pressValidator = v.object({
  userId: v.string(),
  teamId: v.optional(v.string()),
  appId: v.string(),
  channelId: v.string(),
  messageTs: v.string(),
  actionTs: v.string(),
  action: v.object({ action_id: v.string(), value: v.optional(v.string()) }),
});

/**
 * Whether a press was made on the message of the request its code names, live or replaced: a
 * button decides only the request whose message carries it.
 */
async function pressedOnRequest(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  code: string,
  messageTs: string,
): Promise<boolean> {
  const row = await ctx.db
    .query('workItems')
    .withIndex('by_agent_decision', (q) => q.eq('agentId', agentId).eq('decision.id', code))
    .first();
  if (row?.decision !== undefined) return row.decision.ts === messageTs;
  const replaced = await ctx.db
    .query('replacedDecisionRequests')
    .withIndex('by_agent_decision', (q) => q.eq('agentId', agentId).eq('decisionId', code))
    .first();
  // Day0's buttons carry one request's code on that request's own message: a batch code or a
  // code no request carries came from a message Day0 did not post with buttons, and decides nothing.
  return replaced !== null && replaced.ts === messageTs;
}

/**
 * Internal: decide one press exactly as a typed reply is decided (wave 12, 12-M): through
 * {@link resolveManagerReply}, the same checks and the same record, keyed by the press's own
 * timestamp so a redelivered envelope is the same press. First it holds the press to the card it
 * came through: a card the decision poll would read now (connected, its access running, the
 * manager's ids known), the app that carried it, the workspace, the manager's DM and the request's
 * own message. Writes the decision, its events and its acknowledgement as a reply does, or a
 * `work.decision-ignored` event saying why nothing was decided.
 */
export const resolvePress = internalMutation({
  args: { surfaceId: v.id('surfaces'), press: pressValidator },
  handler: async (ctx, args) => {
    const surface = await ctx.db.get(args.surfaceId);
    if (surface === null || surface.class !== 'chat') {
      return { status: 'ignored' as const, reason: 'not a chat surface' };
    }
    const ignored = async (reason: string) => {
      await appendEvent(ctx, {
        agentId: surface.agentId,
        type: 'work.decision-ignored',
        payload: {
          surfaceId: surface._id,
          messageTs: args.press.actionTs,
          userId: args.press.userId,
          reason,
        },
        createdAt: Date.now(),
      });
      return { status: 'ignored' as const, reason };
    };
    // The decision poll reads only a card that can be asked through now; a press is held to it too.
    if (!isManagerChannel(surface) || accessEnded(surface, Date.now())) {
      return await ignored('the card takes no decisions now');
    }
    if (surface.provisioning?.appId !== args.press.appId) {
      return await ignored('pressed in another app');
    }
    if (
      args.press.teamId !== undefined &&
      surface.providerWorkspaceId !== undefined &&
      args.press.teamId !== surface.providerWorkspaceId
    ) {
      return await ignored('pressed in another workspace');
    }
    if (args.press.channelId !== surface.managerDmChannelId) {
      return await ignored('pressed outside the manager DM');
    }
    const reply = parseDecisionPress(args.press.action);
    if (reply === undefined) return await ignored('not a decision button');
    if (!(await pressedOnRequest(ctx, surface.agentId, reply.id, args.press.messageTs))) {
      return await ignored('pressed on another message');
    }
    return await resolveManagerReply(ctx, {
      surfaceId: surface._id,
      userId: args.press.userId,
      messageTs: args.press.actionTs,
      reply,
    });
  },
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Hold a bridge call to the deployment's secret: 503 where the deployment holds none (no bridge is
 * configured, so nothing may call), 401 where the call does not present it, otherwise nothing.
 */
async function refusal(request: Request): Promise<Response | undefined> {
  const secret = (process.env[SOCKET_BRIDGE_SECRET_VAR] ?? '').trim();
  if (secret === '') return json({ error: 'no socket bridge is configured' }, 503);
  if (!(await bridgeSecretMatches(request.headers.get('authorization'), secret))) {
    return json({ error: 'unauthorised' }, 401);
  }
  return undefined;
}

/** The request's JSON body as an object, or undefined when it is not one. */
async function bodyOf(request: Request): Promise<Record<string, unknown> | undefined> {
  const parsed: unknown = await request.json().catch((): unknown => undefined);
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/** `POST /slack-socket/apps`: the apps the bridge holds a connection for. Secret required. */
export const bridgeApps = httpAction(async (ctx, request) => {
  const refused = await refusal(request);
  if (refused !== undefined) return refused;
  const apps: BridgeApp[] = [];
  let cursor: string | null = null;
  for (let read = 0; read < BRIDGE_PAGES; read += 1) {
    const page: { apps: typeof apps; cursor: string | null } = await ctx.runQuery(
      internal.slackSocket.appsForBridge,
      { cursor },
    );
    apps.push(...page.apps);
    cursor = page.cursor;
    if (cursor === null) break;
  }
  return json({ apps });
});

/**
 * `POST /slack-socket/connection` with `{ surfaceId }`: a fresh Socket Mode URL for one app,
 * opened here with its app-level token, which never leaves the backend. Secret required; 404 for a
 * card that carries no presses, 502 when Slack refused.
 */
export const bridgeConnection = httpAction(async (ctx, request) => {
  const refused = await refusal(request);
  if (refused !== undefined) return refused;
  const surfaceId = (await bodyOf(request))?.surfaceId;
  if (typeof surfaceId !== 'string') return json({ error: 'surfaceId is required' }, 400);
  const opened = await ctx.runAction(internal.slackSocketActions.openConnection, { surfaceId });
  if ('url' in opened) return json({ url: opened.url });
  return json({ error: opened.error }, opened.missing ? 404 : 502);
});

/**
 * `POST /slack-socket/press` with `{ surfaceId, payload }`: one `block_actions` payload the
 * bridge acknowledged on its connection, decided as a typed reply is. Secret required; a payload
 * that is not a press is answered 400 and decides nothing.
 */
export const bridgePress = httpAction(async (ctx, request) => {
  const refused = await refusal(request);
  if (refused !== undefined) return refused;
  const body = await bodyOf(request);
  const surfaceId = typeof body?.surfaceId === 'string' ? body.surfaceId : undefined;
  const press: SocketPress | undefined = parsePress(body?.payload);
  if (surfaceId === undefined || press === undefined) {
    return json({ error: 'not a button press' }, 400);
  }
  const target = await ctx.runQuery(internal.slackSocket.cardOf, { surfaceId });
  if (target === null) return json({ error: 'unknown card' }, 404);
  return json(
    await ctx.runMutation(internal.slackSocket.resolvePress, { surfaceId: target, press }),
  );
});

/** Internal: a card id the bridge names, checked to be one. */
export const cardOf = internalQuery({
  args: { surfaceId: v.string() },
  handler: async (ctx, args): Promise<Id<'surfaces'> | null> =>
    ctx.db.normalizeId('surfaces', args.surfaceId),
});

/**
 * Internal, the landing's: the card's employee and its own app, when it has one (null when it
 * connects through no app Day0 created for the employee); null when the card is not a chat card.
 */
export const appLevelTokenTarget = internalQuery({
  args: { surfaceId: v.id('surfaces') },
  handler: async (
    ctx,
    args,
  ): Promise<{
    agentId: Id<'agents'>;
    app: { appId: string; appName: string } | null;
  } | null> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (surface === null || surface.class !== 'chat') return null;
    const provisioning = surface.provisioning;
    return {
      agentId: surface.agentId,
      app:
        provisioning === undefined
          ? null
          : { appId: provisioning.appId, appName: provisioning.appName },
    };
  },
});

/**
 * Internal, the landing's: point the card's app at its new app-level token, and end the earlier
 * token's row in Day0. Refused when the card's app changed since the landing read it (the new row
 * is then ended by the caller). Writes `surface.socket-token-landed`, naming no token.
 */
export const recordAppLevelToken = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    appId: v.string(),
    credentialId: v.id('credentials'),
  },
  handler: async (ctx, args): Promise<void> => {
    const surface = await ctx.db.get(args.surfaceId);
    const provisioning = surface?.provisioning;
    if (surface === null || provisioning === undefined || provisioning.appId !== args.appId) {
      throw new ConvexError("The card's Slack app changed while its token was checked.");
    }
    const earlierId = provisioning.appLevelTokenCredentialId;
    const now = Date.now();
    if (earlierId !== undefined && earlierId !== args.credentialId) {
      const earlier = await ctx.db.get(earlierId);
      if (earlier !== null) await purgeCredential(ctx, earlier, now);
    }
    await ctx.db.patch(surface._id, {
      provisioning: { ...provisioning, appLevelTokenCredentialId: args.credentialId },
    });
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.socket-token-landed',
      payload: {
        surfaceId: surface._id,
        appName: provisioning.appName,
        replaced: earlierId !== undefined,
      },
      createdAt: now,
    });
  },
});
