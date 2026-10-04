import { ConvexError, v, type Infer } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import { internal } from './_generated/api';
import { appendEvent, eventsOfType } from './eventLog';
import { activeConnectionFor, systemConnectionRevoked } from './organisationConnectionReads';
import { assertOwnsAgent, getCallerOrThrow } from './ownership';
import { isEventOf } from '../src/events/contract';
import { agentZone } from '../src/lib/zone';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { ACCESS_REQUEST_REASONS } from '../src/surfaces/access-identity';
import {
  accessRequestReason,
  accessRequestMailto,
  draftAccessRequest,
  organisationSystemOf,
  type AccessRequestDraft,
} from '../src/surfaces/access-request';
import { BOSS_MESSAGE_SCOPE, surfaceRefusal } from '../src/surfaces/policy';
import { toSurfaceRecord } from '../src/surfaces/records';
import { isSlackApiEndpoint } from '../src/surfaces/slack-endpoint';
import { accessEnded } from '../src/work/surface-access';

/*
 * The access request (the access plan, section 4.5; A24): when an approved card's system has no
 * active organisation connection, needs an administrator's install, or needs a wider scope, the
 * card shows a request for IT instead of a credential field. Its words come from one pure
 * function (`src/surfaces/access-request.ts`) over the card and the connection, so they are the
 * same on the card (`forCard`), in the manager's DM (`managerChannelActions.sendAccessRequest`)
 * and in the export (the `surface.access-requested` event). It is a request, never a grant:
 * nothing changes until an administrator lands the connection.
 */

/** Bound on an employee's surfaces read for the Slack card the DM goes through. */
const DM_SURFACE_READ_LIMIT = 50;

/** Bound on an employee's grants read for the DM's authority. */
const DM_GRANT_READ_LIMIT = 500;

/** Bound on an employee's request lines read for the words a draft recorded, newest first. */
const DRAFT_EVENT_READ_LIMIT = 50;

/** Every status a connection can be in, each read for the system's newest connection in it. */
const CONNECTION_STATUSES = ['active', 'needs-attention', 'revoked'] as const;

/** The refusal for a card that asks IT for nothing. */
export const NO_ACCESS_REQUEST = 'This card needs no access request: it connects without IT.';

/** The refusal for marking a request sent before it was drafted. */
const NOT_DRAFTED = 'Draft the access request before marking it sent.';

/** The request a card makes now, and the connection it was judged against. */
interface CurrentRequest {
  readonly draft: AccessRequestDraft;
  readonly connection: Doc<'organisationConnections'> | null;
}

/**
 * The access request a card makes now, or null when it makes none: its system's active
 * connection read, the reason judged, and the words built from the card, the employee and the
 * employee's zone.
 */
async function currentRequest(
  ctx: Pick<QueryCtx, 'db'>,
  surface: Doc<'surfaces'>,
  agent: Doc<'agents'>,
): Promise<CurrentRequest | null> {
  const system = organisationSystemOf(surface);
  if (system === undefined) return null;
  const connection = await activeConnectionFor(ctx, system);
  const reason = accessRequestReason(surface, connection);
  if (reason === undefined) return null;
  const publicUrl = process.env.DAY0_PUBLIC_URL;
  const connectionRevoked = connection === null && (await systemConnectionRevoked(ctx, system));
  const draft = draftAccessRequest({
    card: surface,
    connection,
    reason,
    employeeName: agent.name,
    zone: agentZone(agent),
    ...(publicUrl ? { publicUrl } : {}),
    ...(connectionRevoked ? { connectionRevoked } : {}),
  });
  return { draft, connection };
}

/** The card and its employee, if the caller owns the employee; throws otherwise. */
async function ownedCard(
  ctx: QueryCtx | MutationCtx,
  surfaceId: Id<'surfaces'>,
): Promise<{ surface: Doc<'surfaces'>; agent: Doc<'agents'> }> {
  // The guard first, so a caller with no identity is never told whether a card exists (12-G).
  await getCallerOrThrow(ctx);
  const surface = await ctx.db.get(surfaceId);
  if (surface === null) throw new ConvexError('That card no longer exists.');
  const agent = await assertOwnsAgent(ctx, surface.agentId);
  return { surface, agent };
}

const reasonValidator = v.union(...ACCESS_REQUEST_REASONS.map((reason) => v.literal(reason)));

/** The access request as the card shows it. */
const accessRequestViewValidator = v.object({
  system: v.string(),
  reason: reasonValidator,
  scopes: v.array(v.string()),
  subject: v.string(),
  text: v.string(),
  mailto: v.string(),
  /** When it was drafted and how it went out, once the manager drafted it. */
  draftedAt: v.optional(v.number()),
  copiedAt: v.optional(v.number()),
  emailedAt: v.optional(v.number()),
  /** When Slack took the DM to the manager, its timestamp kept as the evidence. */
  messagedAt: v.optional(v.number()),
  /** True while Day0 is sending the DM the manager asked for, before Slack has it. */
  messaging: v.optional(v.boolean()),
});

/** The access request as the card shows it. */
export type AccessRequestView = Infer<typeof accessRequestViewValidator>;

/** How the manager sent a drafted request: copied, opened in their email, or to themselves in Slack. */
const sentViaValidator = v.union(v.literal('copied'), v.literal('emailed'), v.literal('messaged'));

/**
 * How long a claim of the manager's DM stands without Slack's timestamp before it is read as
 * released: past twice the Slack call's own bound, so a send whose action died between the claim
 * and Slack never leaves the request stuck "being sent" (the code pass's M2).
 */
const MESSAGE_CLAIM_STANDS_MS = 10 * 60 * 1000;

/** Whether the request's DM went out, or a claim of it still stands, at `now`. */
function messageClaimed(
  request: NonNullable<Doc<'surfaces'>['accessRequest']>,
  now: number,
): boolean {
  if (request.messagedAt === undefined) return false;
  return (
    request.messageProviderTs !== undefined || now - request.messagedAt < MESSAGE_CLAIM_STANDS_MS
  );
}

/**
 * The view of a current request: once drafted, the words the draft recorded (which the DM sends
 * and the export carries) and how it went out; before, the words built now.
 */
function viewOf(
  draft: AccessRequestDraft,
  recorded?: {
    readonly request: NonNullable<Doc<'surfaces'>['accessRequest']>;
    readonly words?: string;
  },
): AccessRequestView {
  const text = recorded?.words ?? draft.text;
  const request = recorded?.request;
  return {
    system: draft.system,
    reason: draft.reason,
    scopes: [...draft.scopes],
    subject: draft.subject,
    text,
    mailto: accessRequestMailto(draft.subject, text),
    ...(request === undefined
      ? {}
      : {
          draftedAt: request.draftedAt,
          ...(request.copiedAt === undefined ? {} : { copiedAt: request.copiedAt }),
          ...(request.emailedAt === undefined ? {} : { emailedAt: request.emailedAt }),
          // The claim of the DM writes `messagedAt`; Slack's timestamp says it went out, and a
          // claim with none is on its way while it stands. The release scheduled at the claim
          // ends it by a write, so the query runs again at the bound (the round review's m9); the
          // bound read here covers a claim made before the upgrade, which no release was
          // scheduled for (the second pass).
          ...(request.messagedAt === undefined
            ? {}
            : request.messageProviderTs !== undefined
              ? { messagedAt: request.messagedAt }
              : messageClaimed(request, Date.now())
                ? { messaging: true }
                : {}),
        }),
  };
}

/** A drafted request with the words its draft recorded. */
async function recordedView(
  ctx: Pick<QueryCtx, 'db'>,
  surface: Doc<'surfaces'>,
  draft: AccessRequestDraft,
  request: NonNullable<Doc<'surfaces'>['accessRequest']>,
): Promise<AccessRequestView> {
  const words = await draftedWords(ctx, surface, request.draftedAt);
  return viewOf(draft, { request, ...(words === undefined ? {} : { words }) });
}

/** Whether a recorded request is the one the card makes now: the same reason and scopes. */
function sameRequest(
  recorded: NonNullable<Doc<'surfaces'>['accessRequest']>,
  draft: AccessRequestDraft,
): boolean {
  return (
    recorded.reason === draft.reason &&
    recorded.scopes.length === draft.scopes.length &&
    recorded.scopes.every((scope, index) => scope === draft.scopes[index])
  );
}

/**
 * The request the card recorded, when it is still the one the card makes now: the same reason and
 * scopes, and no connection of its system landed since it was drafted. After a connection landed
 * (and perhaps was revoked again), the same reason is a new request for IT, not the old one.
 */
async function recordedRequest(
  ctx: Pick<QueryCtx, 'db'>,
  surface: Doc<'surfaces'>,
  draft: AccessRequestDraft,
): Promise<NonNullable<Doc<'surfaces'>['accessRequest']> | undefined> {
  const recorded = surface.accessRequest;
  if (recorded === undefined || !sameRequest(recorded, draft)) return undefined;
  const newest = await Promise.all(
    CONNECTION_STATUSES.map(
      async (status) =>
        await ctx.db
          .query('organisationConnections')
          .withIndex('by_system_status', (index) =>
            index.eq('system', draft.system).eq('status', status),
          )
          .order('desc')
          .first(),
    ),
  );
  return newest.some(
    (connection) => connection !== null && connection.createdAt > recorded.draftedAt,
  )
    ? undefined
    : recorded;
}

/**
 * The access request a card makes, for the card to show instead of a credential field, or null
 * when it makes none. Public, owner-guarded (`assertOwnsAgent`); writes nothing.
 */
export const forCard = query({
  args: { surfaceId: v.id('surfaces') },
  returns: v.union(v.null(), accessRequestViewValidator),
  handler: async (ctx, args): Promise<AccessRequestView | null> => {
    const { surface, agent } = await ownedCard(ctx, args.surfaceId);
    const current = await currentRequest(ctx, surface, agent);
    if (current === null) return null;
    const recorded = await recordedRequest(ctx, surface, current.draft);
    return recorded === undefined
      ? viewOf(current.draft)
      : await recordedView(ctx, surface, current.draft, recorded);
  },
});

/**
 * Draft the card's access request, as the manager sends it (`via`): record it on the card
 * (`accessRequest`) and append `surface.access-requested` with its words to the employee's record,
 * once; and, in real mode and only when the manager asked for it in Slack (`messaged`), schedule
 * the one DM to the manager (`managerChannelActions.sendAccessRequest`), for a request drafted now
 * or drafted before by a Copy or an Email it. A request already drafted with the same reason and
 * scopes keeps its words and its record line; a DM already sent or being sent is not sent again
 * (11-AC's item 2: product call, flagged). A draft that names no way it was sent, from a page
 * loaded before the upgrade, is read as copied. Public, owner-guarded (`assertOwnsAgent`).
 *
 * @throws ConvexError with {@link NO_ACCESS_REQUEST} for a card that asks IT for nothing.
 */
export const draft = mutation({
  args: {
    surfaceId: v.id('surfaces'),
    // Optional for one release: a tab open across the upgrade to 0.15.0 sends none, and is read
    // as a Copy (the round review's m14). Required again in the release after.
    via: v.optional(sentViaValidator),
  },
  returns: accessRequestViewValidator,
  handler: async (ctx, args): Promise<AccessRequestView> => {
    const { surface, agent } = await ownedCard(ctx, args.surfaceId);
    const current = await currentRequest(ctx, surface, agent);
    if (current === null) throw new ConvexError(NO_ACCESS_REQUEST);
    const recorded = await recordedRequest(ctx, surface, current.draft);
    if (recorded !== undefined) {
      if (args.via === 'messaged' && !messageClaimed(recorded, Date.now())) {
        await scheduleMessage(ctx, surface._id, recorded.draftedAt);
      }
      return await recordedView(ctx, surface, current.draft, recorded);
    }
    const now = Date.now();
    const accessRequest = {
      reason: current.draft.reason,
      scopes: [...current.draft.scopes],
      ...(current.connection === null ? {} : { organisationConnectionId: current.connection._id }),
      draftedAt: now,
    };
    await ctx.db.patch(surface._id, { accessRequest });
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.access-requested',
      payload: {
        surfaceId: surface._id,
        system: current.draft.system,
        reason: current.draft.reason,
        scopes: current.draft.scopes,
        text: current.draft.text,
      },
      createdAt: now,
    });
    if (args.via === 'messaged') await scheduleMessage(ctx, surface._id, now);
    return viewOf(current.draft, { request: accessRequest });
  },
});

/** Schedule the DM of the request drafted at `draftedAt` to the manager, in real mode only. */
async function scheduleMessage(
  ctx: MutationCtx,
  surfaceId: Id<'surfaces'>,
  draftedAt: number,
): Promise<void> {
  if (SURFACE_MODE !== 'real') return;
  await ctx.scheduler.runAfter(0, internal.managerChannelActions.sendAccessRequest, {
    surfaceId,
    draftedAt,
  });
}

/**
 * Record that the manager copied the drafted request or opened it in their email ("Sent to IT on
 * 3 October"). Public, owner-guarded (`assertOwnsAgent`); writes `accessRequest.copiedAt` or
 * `emailedAt`.
 *
 * @throws ConvexError when the card has no drafted request.
 */
export const recordSent = mutation({
  args: {
    surfaceId: v.id('surfaces'),
    via: v.union(v.literal('copied'), v.literal('emailed')),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { surface } = await ownedCard(ctx, args.surfaceId);
    if (surface.accessRequest === undefined) throw new ConvexError(NOT_DRAFTED);
    const now = Date.now();
    await ctx.db.patch(surface._id, {
      accessRequest: {
        ...surface.accessRequest,
        ...(args.via === 'copied' ? { copiedAt: now } : { emailedAt: now }),
      },
    });
    return null;
  },
});

/**
 * The Slack card the employee's manager DM goes through, if it has one: connected on Slack's
 * documented API, its credential landed, its access not ended, its allowlist naming
 * `chat.postMessage`, its manager DM known, and the DM granted as the gate grants it
 * (`boss:message` or the card's own write scope, `grantingScopes`).
 */
async function managerDmCardOf(
  ctx: Pick<QueryCtx, 'db'>,
  agentId: Id<'agents'>,
  now: number,
): Promise<Doc<'surfaces'> | undefined> {
  const [surfaces, grants] = await Promise.all([
    ctx.db
      .query('surfaces')
      .withIndex('by_agent', (index) => index.eq('agentId', agentId))
      .take(DM_SURFACE_READ_LIMIT),
    ctx.db
      .query('permissionGrants')
      .withIndex('by_agent_scope', (index) => index.eq('agentId', agentId))
      .take(DM_GRANT_READ_LIMIT),
  ]);
  const active = new Set(grants.filter((grant) => !grant.revokedAt).map((grant) => grant.scope));
  return surfaces.find(
    (surface) =>
      surface.class === 'chat' &&
      surface.verdict === 'connected' &&
      surface.credentialLanded &&
      surface.credentialId !== undefined &&
      surface.managerDmChannelId !== undefined &&
      surface.path === 'documented-api' &&
      isSlackApiEndpoint(surface.endpoint) &&
      surface.toolAllowlist?.includes('chat.postMessage') === true &&
      (active.has(BOSS_MESSAGE_SCOPE) || active.has(`${surface.slug}:write`)) &&
      !accessEnded(surface, now) &&
      surfaceRefusal(toSurfaceRecord(surface), now) === undefined,
  );
}

/** The three characters Slack reads as markup in a message's text, escaped as Slack asks. */
function slackEscaped(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The words the draft at `draftedAt` recorded on the employee's record, which the export carries:
 * the DM sends these rather than words built again, so the two never differ.
 */
async function draftedWords(
  ctx: Pick<QueryCtx, 'db'>,
  surface: Doc<'surfaces'>,
  draftedAt: number,
): Promise<string | undefined> {
  const lines = await eventsOfType(ctx, surface.agentId, 'surface.access-requested')
    .order('desc')
    .take(DRAFT_EVENT_READ_LIMIT);
  const line = lines.find(
    (event) =>
      event.createdAt === draftedAt &&
      isEventOf(event, 'surface.access-requested') &&
      event.payload.surfaceId === surface._id,
  );
  return line !== undefined && isEventOf(line, 'surface.access-requested')
    ? line.payload.text
    : undefined;
}

/** What the DM action sends through, once the request is claimed for it. */
const claimedMessageValidator = v.union(
  v.object({ claimed: v.literal(false), reason: v.string() }),
  v.object({
    claimed: v.literal(true),
    credentialId: v.string(),
    channel: v.string(),
    /** The request's words, escaped for Slack; Slack shows them as written. */
    text: v.string(),
  }),
);

/**
 * Internal, for `managerChannelActions.sendAccessRequest`: claim the DM of the request drafted at
 * `draftedAt`, with the words that draft recorded. Refused in mock mode, when the card or its
 * employee is gone, the request was redrafted or already sent or being sent to the DM, the card
 * no longer makes it, or the employee has no Slack card that can carry the DM. Writes the claim
 * (`messagedAt`), so a second press of Send to me in Slack, or a second send scheduled before
 * this one finished, is refused; Slack's timestamp is written once it has the message
 * (`recordMessage`), and a send Slack refused releases the claim (`releaseMessage`), so the
 * manager may ask again, as they may once a claim with no timestamp outlives
 * `MESSAGE_CLAIM_STANDS_MS`. A post Slack took whose answer was lost is released too, and a second
 * ask then sends a second DM: a duplicate, never a silent loss.
 */
export const claimMessage = internalMutation({
  args: { surfaceId: v.id('surfaces'), draftedAt: v.number() },
  returns: claimedMessageValidator,
  handler: async (ctx, args): Promise<Infer<typeof claimedMessageValidator>> => {
    if (SURFACE_MODE !== 'real') {
      return { claimed: false, reason: 'the DM is sent in real mode only' };
    }
    const surface = await ctx.db.get(args.surfaceId);
    const recorded = surface?.accessRequest;
    if (surface === null || recorded === undefined || recorded.draftedAt !== args.draftedAt) {
      return { claimed: false, reason: 'the request was redrafted or is gone' };
    }
    if (messageClaimed(recorded, Date.now())) {
      return { claimed: false, reason: 'the request was already sent to the manager' };
    }
    const agent = await ctx.db.get(surface.agentId);
    if (agent === null) return { claimed: false, reason: 'the employee is gone' };
    const current = await currentRequest(ctx, surface, agent);
    if (current === null || (await recordedRequest(ctx, surface, current.draft)) === undefined) {
      return { claimed: false, reason: 'the card no longer makes this request' };
    }
    const words = await draftedWords(ctx, surface, args.draftedAt);
    if (words === undefined)
      return { claimed: false, reason: 'the drafted request is not recorded' };
    const card = await managerDmCardOf(ctx, agent._id, Date.now());
    if (card?.credentialId === undefined || card.managerDmChannelId === undefined) {
      return { claimed: false, reason: 'the employee has no chat connection that can carry it' };
    }
    // Claimed once: a second press, or a second send scheduled meanwhile, is refused above.
    const claimedAt = Date.now();
    await ctx.db.patch(surface._id, { accessRequest: { ...recorded, messagedAt: claimedAt } });
    // A send whose action died between the claim and Slack is released at the claim's bound by a
    // write, never by a query reading the clock (the round review's m9).
    await ctx.scheduler.runAfter(MESSAGE_CLAIM_STANDS_MS, internal.accessRequests.releaseMessage, {
      surfaceId: surface._id,
      draftedAt: args.draftedAt,
      claimedAt,
    });
    return {
      claimed: true,
      credentialId: card.credentialId,
      channel: card.managerDmChannelId,
      text: slackEscaped(words),
    };
  },
});

/**
 * Internal, for `managerChannelActions.sendAccessRequest`: record the DM Slack accepted, with its
 * timestamp as the evidence, on the request drafted at `draftedAt` only.
 */
export const recordMessage = internalMutation({
  args: { surfaceId: v.id('surfaces'), draftedAt: v.number(), providerTs: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const surface = await ctx.db.get(args.surfaceId);
    const recorded = surface?.accessRequest;
    if (surface === null || recorded === undefined || recorded.draftedAt !== args.draftedAt) {
      return null;
    }
    await ctx.db.patch(surface._id, {
      accessRequest: {
        ...recorded,
        messagedAt: recorded.messagedAt ?? Date.now(),
        messageProviderTs: args.providerTs,
      },
    });
    return null;
  },
});

/**
 * Internal, for `managerChannelActions.sendAccessRequest`, and scheduled by `claimMessage` at its
 * bound: release the claim of a DM Slack did not take, on the request drafted at `draftedAt` only,
 * so the card offers Send to me in Slack again. A DM Slack has the timestamp of is never released,
 * and a release scheduled at one claim (`claimedAt`) never ends a later one.
 */
export const releaseMessage = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    draftedAt: v.number(),
    claimedAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const surface = await ctx.db.get(args.surfaceId);
    const recorded = surface?.accessRequest;
    if (
      surface === null ||
      recorded === undefined ||
      recorded.draftedAt !== args.draftedAt ||
      recorded.messageProviderTs !== undefined ||
      (args.claimedAt !== undefined && recorded.messagedAt !== args.claimedAt)
    ) {
      return null;
    }
    const { messagedAt: released, ...kept } = recorded;
    if (released === undefined) return null;
    await ctx.db.patch(surface._id, { accessRequest: kept });
    return null;
  },
});
