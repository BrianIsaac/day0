import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { appendEvent } from './eventLog';

/**
 * A colleague's acknowledgement of a message Day0 posted in the mock office.
 *
 * Mock follows real (decision Q2): in real mode nothing reads a reply to
 * Day0, so a canned reply that asks Day0 to hold, add, pin or forward
 * something teaches the demo a behaviour the product lacks. Every reply here
 * acknowledges and asks for nothing. A channel with no colleague gets no
 * reply, rather than one in the manager's name, and one message always gets
 * the same reply, so a replayed demo shows the same office.
 */

interface ResponderProfile {
  readonly responder: string;
  readonly senderKind: 'manager' | 'teammate' | 'requester';
  /** The colleague's replies, given the name of the employee they answer. */
  readonly replies: (employee: string) => readonly string[];
}

const PROFILES: Readonly<Record<string, ResponderProfile>> = {
  'dm-manager': {
    responder: 'Manager',
    senderKind: 'manager',
    replies: () => ['Thanks, seen.', 'Got it, thanks.'],
  },
  'dm-priya': {
    responder: 'Priya',
    senderKind: 'teammate',
    replies: () => ['Thanks, I have it.', 'Seen, thanks.'],
  },
  'dm-aman': {
    responder: 'Aman',
    senderKind: 'teammate',
    replies: () => ['Got it, thanks.'],
  },
  'revops-asks': {
    responder: 'Priya',
    senderKind: 'requester',
    replies: (employee) => [`Thanks, ${employee}.`, 'Seen, thank you.'],
  },
  revops: {
    responder: 'Sara',
    senderKind: 'teammate',
    replies: () => ['Noted, thanks.'],
  },
};

/**
 * The reply a channel's colleague gives to one message, or none on a channel with no colleague.
 *
 * @param channelSlug - The channel the employee posted on.
 * @param originalBody - What the employee posted; it chooses among the colleague's replies.
 * @param employee - The name of the employee who posted, which a reply may address.
 */
function pickReply(
  channelSlug: string,
  originalBody: string,
  employee: string,
): { responder: string; senderKind: ResponderProfile['senderKind']; body: string } | undefined {
  const profile = PROFILES[channelSlug];
  if (!profile) return undefined;
  let seed = 0;
  for (const char of originalBody) seed = (seed + (char.codePointAt(0) ?? 0)) % 9_973;
  const replies = profile.replies(employee);
  return {
    responder: profile.responder,
    senderKind: profile.senderKind,
    body: replies[seed % replies.length],
  };
}

/**
 * Post a colleague's acknowledgement under a message Day0 posted. Internal;
 * scheduled by the mock Slack verb once the post lands. Writes the reply and
 * a `coworker.replied` event, or nothing on a channel with no colleague or
 * for an employee that no longer exists.
 */
export const replyToAgentMessage = internalMutation({
  args: {
    agentId: v.id('agents'),
    channelSlug: v.string(),
    threadKey: v.optional(v.string()),
    originalBody: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    // A colleague thanks the employee by the name its manager gave it (the hosted walk's m5).
    const employee = await ctx.db.get(args.agentId);
    if (employee === null) return;
    const reply = pickReply(args.channelSlug, args.originalBody, employee.name);
    if (!reply) return;
    const now = Date.now();
    await ctx.db.insert('mockSlackMessages', {
      agentId: args.agentId,
      channelSlug: args.channelSlug,
      threadKey: args.threadKey,
      sender: reply.responder,
      senderKind: reply.senderKind,
      body: reply.body,
      timestamp: now,
    });
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'coworker.replied',
      payload: { channelSlug: args.channelSlug, responder: reply.responder },
      createdAt: now,
    });
  },
});
