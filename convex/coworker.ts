import { v } from 'convex/values';
import { internalMutation } from './_generated/server';

/**
 * Lightweight coworker auto-reply. After the agent posts a message to a
 * Slack channel/DM, we schedule a delayed reply from a teammate (Priya,
 * Aman, the manager, etc.) to make the demo loop feel alive.
 *
 * We pick the responder + reply style based on the channel; bodies are
 * short canned templates to keep the reply deterministic and cheap.
 */

interface ResponderProfile {
  responder: string;
  senderKind: 'manager' | 'teammate' | 'requester';
  templates: Array<(snippet: string) => string>;
}

const PROFILES: Record<string, ResponderProfile> = {
  'dm-manager': {
    responder: 'Manager',
    senderKind: 'manager',
    templates: [
      () => 'Thanks — looks good. I’ll forward it after a quick read.',
      () => "Got it. Make sure the close-date column is populated before we send to committee.",
      () => 'Nice. Pin it to the channel and I’ll ratify on Tuesday.',
    ],
  },
  'dm-priya': {
    responder: 'Priya',
    senderKind: 'teammate',
    templates: [
      () => 'Thanks — I’ll cross-check against Looker and send any tweaks back to you.',
      () => 'Good first pass. Add the source link for the four-week window before I forward.',
      () => 'Looks aligned with how I’d frame it. One caveat I’d add: enterprise stage gates.',
    ],
  },
  'dm-aman': {
    responder: 'Aman',
    senderKind: 'teammate',
    templates: [
      () => 'Got it — appreciate you catching this without breaking the model side.',
    ],
  },
  'revops-asks': {
    responder: 'Priya',
    senderKind: 'requester',
    templates: [
      () =>
        'Thanks Day0. I’ll review the draft and ratify or push back by EOD; please hold for my sign-off before any external send.',
      () =>
        'Appreciate the quick triage — leaving the pipeline interpretation to me, but the framing here is clean.',
    ],
  },
  revops: {
    responder: 'Sara',
    senderKind: 'teammate',
    templates: [
      () => 'Tagging this for the team to review — looks like a good template for similar asks.',
    ],
  },
};

function pickReply(channelSlug: string, originalBody: string): {
  responder: string;
  senderKind: ResponderProfile['senderKind'];
  body: string;
} {
  const profile = PROFILES[channelSlug];
  if (!profile) {
    return {
      responder: 'Manager',
      senderKind: 'manager',
      body: 'Acknowledged.',
    };
  }
  const idx = Math.floor(Math.random() * profile.templates.length);
  const tmpl = profile.templates[idx];
  return {
    responder: profile.responder,
    senderKind: profile.senderKind,
    body: tmpl(originalBody.slice(0, 60)),
  };
}

export const replyToAgentMessage = internalMutation({
  args: {
    agentId: v.id('agents'),
    channelSlug: v.string(),
    threadKey: v.optional(v.string()),
    originalBody: v.string(),
  },
  handler: async (ctx, args) => {
    const reply = pickReply(args.channelSlug, args.originalBody);
    await ctx.db.insert('mockSlackMessages', {
      agentId: args.agentId,
      channelSlug: args.channelSlug,
      threadKey: args.threadKey,
      sender: reply.responder,
      senderKind: reply.senderKind,
      body: reply.body,
      timestamp: Date.now(),
    });
    await ctx.db.insert('events', {
      agentId: args.agentId,
      type: 'coworker.replied',
      payload: { channelSlug: args.channelSlug, responder: reply.responder },
      createdAt: Date.now(),
    });
  },
});
