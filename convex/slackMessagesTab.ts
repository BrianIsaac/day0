import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import { isEventOf } from '../src/events/contract';
import { appendEvent, eventsOfType } from './eventLog';
import { endedByItsRevoke } from './organisationConnectionReads';
import { assertOwnsSurface } from './ownership';
import { assertRealMode } from '../src/lib/surface-mode';
import {
  MESSAGES_TAB_OPEN_HOWS,
  typedCodeReachFor,
  type MessagesTabOpenHow,
  type TypedCodeReach,
} from '../src/surfaces/slack-messages-tab';

/*
 * Whether an employee's own Slack app takes messages, so the manager's typed code can reach it
 * (W12V-7). The card's app records it (`provisioning.messagesTab`, 13-FS): `open`, written beside
 * the record's `surface.app-messages-open` line when Day0 created the app from a manifest that
 * opens the tab, opened the tab itself, found it open, or the manager said a person opened it; or
 * `refused`, with Slack's words and how many openings it refused, so the card's probe stops asking
 * until a person does. Every reader goes through `typedCodeReachOf`; the record's lines are what
 * the `surfaces-messages-tab` pass copied onto cards opened before 0.17.0.
 */

/** The most `surface.app-messages-open` events one read walks: one per app the card has had. */
const OPEN_EVENTS_READ = 50;

/** How many chat cards one page of the report reads. */
const REPORT_PAGE = 200;

const howValidator = v.union(...MESSAGES_TAB_OPEN_HOWS.map((how) => v.literal(how)));

/**
 * The newest `surface.app-messages-open` line the employee's record holds for the app, if any: the
 * backfill's source.
 */
async function newestOpening(
  ctx: Pick<QueryCtx, 'db'>,
  agentId: Id<'agents'>,
  appId: string,
): Promise<{ readonly how: MessagesTabOpenHow; readonly at: number } | undefined> {
  const opened = await eventsOfType(ctx, agentId, 'surface.app-messages-open')
    .order('desc')
    .take(OPEN_EVENTS_READ);
  for (const event of opened) {
    if (!isEventOf(event, 'surface.app-messages-open') || event.payload.appId !== appId) continue;
    return { how: event.payload.how, at: event.createdAt };
  }
  return undefined;
}

/** How many chat cards one page of the messages tab backfill reads; each may read its record. */
const MESSAGES_TAB_BACKFILL_PAGE = 25;

/**
 * Copy onto each chat card's app the open state the employee's record kept (the
 * `surfaces-messages-tab` pass, 13-K; W12V-7): the newest `surface.app-messages-open` line for
 * the card's app, as `provisioning.messagesTab` (`open`, how, when). A card with no app of Day0's,
 * an app the record does not name, and an app whose state is already written (the newer word) are
 * left, so a second run changes nothing.
 *
 * @param ctx - The migration page's mutation context.
 * @param cursor - Where the previous page stopped, or null for the first.
 */
export async function backfillMessagesTabPage(
  ctx: MutationCtx,
  cursor: string | null,
): Promise<{ read: number; changed: number; cursor: string; isDone: boolean }> {
  const page = await ctx.db
    .query('surfaces')
    .withIndex('by_class', (q) => q.eq('class', 'chat'))
    .paginate({ numItems: MESSAGES_TAB_BACKFILL_PAGE, cursor });
  let changed = 0;
  for (const surface of page.page) {
    const app = surface.provisioning;
    if (app === undefined || app.messagesTab !== undefined) continue;
    const opening = await newestOpening(ctx, surface.agentId, app.appId);
    if (opening === undefined) continue;
    await ctx.db.patch(surface._id, {
      provisioning: { ...app, messagesTab: { state: 'open', how: opening.how, at: opening.at } },
    });
    changed += 1;
  }
  return { read: page.page.length, changed, cursor: page.continueCursor, isDone: page.isDone };
}

/** Whether the configuration connection that created the card's app is still active. */
async function creatorActive(
  ctx: Pick<QueryCtx, 'db'>,
  surface: Doc<'surfaces'>,
): Promise<boolean> {
  const creatorId = surface.provisioning?.organisationConnectionId;
  if (creatorId === undefined) return false;
  const creator = await ctx.db.get(creatorId);
  return creator?.status === 'active' && creator.kind === 'slack-configuration';
}

/**
 * Whether the manager's typed code reaches the app a chat card's decision requests come from. A
 * card whose app Day0 did not create is read as before this release: Day0 cannot read it.
 *
 * @param ctx - A query's or a mutation's context.
 * @param surface - The chat card the decision requests go through.
 */
export async function typedCodeReachOf(
  ctx: Pick<QueryCtx, 'db'>,
  surface: Doc<'surfaces'>,
): Promise<TypedCodeReach> {
  const app = surface.provisioning;
  if (app === undefined || app.messagesTab?.state === 'open') return { state: 'open' };
  return typedCodeReachFor(surface, { creatorActive: await creatorActive(ctx, surface) });
}

/**
 * Record that the card's app takes messages, unless the card already says so: `open` on the card's
 * app, with how and when (over a refusal), and the `surface.app-messages-open` line on the
 * employee's record. Read from the card as it stands, so a writer that just patched the app is
 * seen; nothing is written when the card's app is not the one named.
 *
 * @returns Whether it was recorded.
 */
export async function recordAppTakesMessages(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
  app: { readonly appId: string; readonly appName: string },
  how: MessagesTabOpenHow,
  now: number,
): Promise<boolean> {
  const current = (await ctx.db.get(surface._id))?.provisioning;
  if (current === undefined || current.appId !== app.appId) return false;
  if (current.messagesTab?.state === 'open') return false;
  await ctx.db.patch(surface._id, {
    provisioning: { ...current, messagesTab: { state: 'open', how, at: now } },
  });
  await appendEvent(ctx, {
    agentId: surface.agentId,
    type: 'surface.app-messages-open',
    payload: { surfaceId: surface._id, appId: app.appId, appName: app.appName, how },
    createdAt: now,
  });
  return true;
}

/** The longest refusal the card keeps of Slack's words. */
const REFUSAL_REASON_LIMIT = 300;

/**
 * Internal, for `slackMessagesTabActions`: record that Slack refused Day0's opening of the card's
 * app, with Slack's words and one more attempt, so the probe stops trying until a person asks
 * (13-FS; the second pre-tag's second pass). Nothing is written when the card's app changed or the
 * card already says it takes messages.
 */
export const recordRefused = internalMutation({
  args: { surfaceId: v.id('surfaces'), appId: v.string(), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const surface = await ctx.db.get(args.surfaceId);
    const app = surface?.provisioning;
    if (surface === null || app === undefined || app.appId !== args.appId) return null;
    if (app.messagesTab?.state === 'open') return null;
    const attempts = app.messagesTab?.state === 'refused' ? app.messagesTab.attempts + 1 : 1;
    await ctx.db.patch(surface._id, {
      provisioning: {
        ...app,
        messagesTab: {
          state: 'refused',
          reason: args.reason.slice(0, REFUSAL_REASON_LIMIT),
          at: Date.now(),
          attempts,
        },
      },
    });
    return null;
  },
});

/**
 * Internal, for `slackMessagesTabActions`: what opening a card's app needs, or null when the card
 * has no app of Day0's, its app takes messages already, no active connection of Day0's created it,
 * or Slack refused the last opening and no person asked to try again (`asked`).
 */
export const forOpening = internalQuery({
  args: { surfaceId: v.id('surfaces'), asked: v.optional(v.boolean()) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    appId: string;
    appName: string;
    organisationConnectionId: Id<'organisationConnections'>;
  } | null> => {
    const surface = await ctx.db.get(args.surfaceId);
    const app = surface?.provisioning;
    if (surface === null || app === undefined || app.organisationConnectionId === undefined) {
      return null;
    }
    const reach = await typedCodeReachOf(ctx, surface);
    const opens =
      reach.state === 'day0-opens' || (reach.state === 'refused' && args.asked === true);
    if (!opens) return null;
    return {
      appId: app.appId,
      appName: app.appName,
      organisationConnectionId: app.organisationConnectionId,
    };
  },
});

/**
 * Internal, for `slackMessagesTabActions`: record that the card's app takes messages, once. Nothing
 * is written when the card's app changed since the action read it.
 */
export const recordOpened = internalMutation({
  args: { surfaceId: v.id('surfaces'), appId: v.string(), how: howValidator },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const surface = await ctx.db.get(args.surfaceId);
    const app = surface?.provisioning;
    if (surface === null || app === undefined || app.appId !== args.appId) return null;
    await recordAppTakesMessages(ctx, surface, app, args.how, Date.now());
    return null;
  },
});

/** Why the manager's confirmation is refused: the record already says the app takes messages. */
export const CONFIRM_NOT_NEEDED =
  'This app already takes messages, or is not one Day0 created: there is nothing to confirm.';

/**
 * Public, owner-guarded: the manager says a person turned on the messages tab of the employee's own
 * Slack app, for an app Day0 cannot read or update (created with a configuration token pasted on
 * the card, or by a connection IT has since revoked) or one whose opening Slack refused. Writes
 * the card's app `open` with `confirmed` and `surface.app-messages-open`, after which the requests
 * offer the typed code.
 * Real mode only.
 *
 * @throws ConvexError with {@link CONFIRM_NOT_NEEDED} when the record already says the app takes
 *   messages, or the card has no app of Day0's.
 */
export const confirmMessagesTab = mutation({
  args: { surfaceId: v.id('surfaces') },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const surface = await assertOwnsSurface(ctx, args.surfaceId);
    assertRealMode('Confirming an app takes messages');
    const app = surface.provisioning;
    const reach = await typedCodeReachOf(ctx, surface);
    if (app === undefined || reach.state === 'open') throw new ConvexError(CONFIRM_NOT_NEEDED);
    await recordAppTakesMessages(ctx, surface, app, 'confirmed', Date.now());
    return null;
  },
});

/** One employee app in `check:access`'s report: its name and whether the typed code reaches it. */
interface MessagesTabRow {
  readonly appName: string;
  readonly reach: TypedCodeReach['state'];
}

/**
 * Internal, for `check:access`: one page of the employee apps Day0 created that carry decision
 * requests, each with whether the manager's typed code reaches it; an app IT's revoke ended is not
 * installed again and carries none, so it is left out (13-FS, W12X-4).
 */
export const messagesTabReport = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<{ apps: MessagesTabRow[]; cursor: string | null }> => {
    const page = await ctx.db
      .query('surfaces')
      .withIndex('by_class', (q) => q.eq('class', 'chat'))
      .paginate({ cursor: args.cursor, numItems: REPORT_PAGE });
    const installed = (
      await Promise.all(
        page.page.map(async (surface) =>
          surface.provisioning?.installedAt === undefined ||
          (await endedByItsRevoke(ctx, surface)) === 'kept-app-ended'
            ? []
            : [{ surface, appName: surface.provisioning.appName }],
        ),
      )
    ).flat();
    const apps = await Promise.all(
      installed.map(
        async ({ surface, appName }): Promise<MessagesTabRow> => ({
          appName,
          reach: (await typedCodeReachOf(ctx, surface)).state,
        }),
      ),
    );
    return { apps, cursor: page.isDone ? null : page.continueCursor };
  },
});
