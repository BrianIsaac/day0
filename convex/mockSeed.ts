import { v } from 'convex/values';
import { internalMutation } from './_generated/server';

/**
 * Seed the per-agent mock work environment. Idempotent — safe to call
 * multiple times. The "how-to-update-X" guides in mockDocs are
 * machine-readable contracts the executor reads to decide which
 * actions[] to emit; the team docs are read by the see-internal-docs
 * skill when answering tier-2 asks.
 */

const TEAM_DOCS: Array<{ slug: string; title: string; body: string }> = [
  {
    slug: 'team-overview',
    title: 'Team overview — RevOps',
    body: `# Team overview — RevOps

We are the Revenue Operations team at Acme Co. We sit between Sales and Finance, owning the data, tooling, and reporting that turn deal activity into a credible revenue forecast.

## What we do

- Maintain the four Q-trackers (Q1–Q4 in Google Sheets) — these are the source of truth for the revenue committee.
- Wire Salesforce → BigQuery → Looker dashboards used by Sales leadership in their weekly cadence.
- Run the close-week process (last 5 business days of each quarter) — collecting closed-won deals, reconciling them with the CRM, signing off the revenue total.
- Field ad-hoc analytical asks ("What's our pipeline coverage on enterprise?", "How's the SMB segment trending?").

## Who we are

- **Manager:** runs the team, owns the relationship with the CRO.
- **Priya:** senior analyst, segment + pipeline.
- **Aman:** senior analyst, forecasting + variance analysis.
- **Sara:** analyst, ad-hoc requests.
- **Day0 (you):** newly deployed; charter to be discovered via the Day-1 1:1.

## Cadence

- Monday standup, 09:30 SGT (15 min).
- Weekly committee meeting Tuesday 14:00 SGT (1h, manager presents).
- Quarter-end close: last 5 business days of each quarter.

## Working surfaces

- Google Sheets — Q1, Q2, Q3, Q4 revenue trackers, plus the deal-stage tracker. Slug for the Q4 tracker is \`q4-revenue-tracker\`.
- Slack — \`#revops-asks\` (inbound), \`#revops\` (team), \`#standups\` (committee prep).
- Linear — internal team tickets (project: REVOPS).
- Looker — published dashboards.
`,
  },
  {
    slug: 'escalation-paths',
    title: 'Escalation paths',
    body: `# Escalation paths

When in doubt about scope, permissions, or risk, escalate before acting.

## Scope ambiguity

If a request is unclear about *what* we are being asked to do or *whether it falls inside the team's remit*, escalate to the manager via DM.

## Permission gaps

If executing a task would require access we do not currently have, do not work around the permission. File a request via the manager.

## Risk concerns

Default: surface a draft to the manager for review before any side-effect.

Escalation triggers (mandatory):
- The change would alter a number visible in the revenue committee deck.
- The change would touch a Salesforce record.
- The change would send a message outside the team or company.
- The change would touch finance-audited data.

## Out-of-scope asks

Marketing copy, brand voice, social-media replies, hiring decisions, HR matters → out of scope. Politely redirect.
`,
  },
  {
    slug: 'on-call',
    title: 'On-call rotation',
    body: `# On-call rotation

The team operates a tier-1 + tier-2 on-call rotation. Tier-1 carries the pager 24/7; tier-2 is the escalation contact and only pages when tier-1 has been silent for 15 minutes.

## Rotation

- One-week rotations, Monday 09:00 SGT to Monday 09:00 SGT.
- Five-engineer rotation pool (Priya, Aman, Sara, Theo, Ines).
- Anyone can swap their shift directly with another engineer in the pool. Post the swap in #ops-oncall.

## Coverage windows

- Daytime (09:00-21:00 SGT): primary in their normal working hours.
- Nighttime (21:00-09:00 SGT): primary remains responsible. Alerts page through PagerDuty + Slack.
- Weekends: unchanged from weekdays.

## Escalation contacts

- Tier-2 (this week): Sara
- Tier-2 backup: Aman
- Manager-on-call (only for sev-0): Priya

## Day0 note

Day0 is not on the rotation until at least week 4 and only after explicit manager opt-in. Skim this doc but do not respond to pages.
`,
  },
  {
    slug: 'onboarding',
    title: 'Onboarding — first week',
    body: `# Onboarding — first week

Welcome to RevOps. The first week is light by design.

## Day 1
- Manager 1:1 (90 min).
- Read the team overview + escalation paths.

## Day 2-3
- Skim the Q-trackers.
- Read the close-week runbook.
- Schedule three 1:1s with Priya, Aman, Sara.

## Day 4-5
- Sit in on Tuesday committee prep silently.
- Pick up one bounded ad-hoc ask from #revops-asks. Surface a draft, do not ship.

## Week 2 onwards
- Start contributing drafts on real asks.
- Attend Monday standup + Tuesday committee meeting.
- Cold-start posture: draft → manager review → ship.
`,
  },
];

const HOW_TO_GUIDES: Array<{ slug: string; title: string; body: string }> = [
  {
    slug: 'how-to-update-spreadsheet',
    title: 'How to update a spreadsheet (action guide)',
    body: `# How to update a spreadsheet

When you need to add rows to a tracker spreadsheet, emit a structured action in your output. The executor will apply it to the live mock surface.

## Action shape

\`\`\`json
{
  "tool": "spreadsheet.appendRow",
  "args": {
    "sheetSlug": "q4-revenue-tracker",
    "tabName": "closed-won",
    "cells": [
      { "header": "Account", "value": "Acme" },
      { "header": "Amount", "value": "$45,000" },
      { "header": "Close date", "value": "2026-05-02" },
      { "header": "Owner", "value": "Priya" },
      { "header": "Stage", "value": "closed-won" }
    ]
  }
}
\`\`\`

- \`sheetSlug\` matches the spreadsheet you are editing (e.g. \`q4-revenue-tracker\`).
- \`tabName\` matches one of the spreadsheet's existing tabs.
- \`cells\` keys must match the tab's headers exactly (case-sensitive).
- Emit one action per row. Multiple actions in one output are fine.

## Discipline

- If you don't know a cell value (e.g. close date), put \`""\` and flag in \`notes\`.
- Never invent CRM ids; mark missing as \`(not provided)\`.
- Always include the row in your \`draft\` text too so the manager can review what landed.

## Closing the loop

If the work item that triggered this update came from the ticket queue (the candidate \`Source\` line will contain \`ticket-queue\`, e.g. \`spreadsheet / ticket-queue\`), you MUST end your \`actions[]\` with a \`ticket.update\` against the originating ticket so the audit trail is complete. The ticket slug is usually named in the candidate body (e.g. "Tracking ticket: REVOPS-203") or surfaced via the \`Refs:\` line (e.g. \`ticket://REVOPS-203\`) — otherwise pick the most-recently created \`open\` ticket from the env snapshot Tickets section that matches the work.

\`\`\`json
{
  "tool": "ticket.update",
  "args": {
    "slug": "REVOPS-203",
    "status": "done",
    "comment": "Appended 3 rows to closed-won: Acme $45k, Beta Corp $72k, Gamma LLC $28k. Close date and owner left blank — pending manager confirmation before committee."
  }
}
\`\`\`

Set \`status: "done"\` if you fully closed the work, \`"in-progress"\` if only partial.
`,
  },
  {
    slug: 'how-to-post-slack',
    title: 'How to post to Slack (action guide)',
    body: `# How to post to Slack

When you have a draft that should go to a Slack channel or DM thread, emit a \`slack.postMessage\` action.

## Action shape

\`\`\`json
{
  "tool": "slack.postMessage",
  "args": {
    "channelSlug": "revops-asks",
    "threadKey": "thread-pipeline-coverage",
    "body": "Draft for review: Enterprise pipeline coverage over the last 4 weeks…"
  }
}
\`\`\`

- \`channelSlug\` is one of \`revops-asks\`, \`revops\`, \`dm-manager\`, \`dm-priya\`, \`dm-aman\`.
- \`threadKey\` is optional — supply it to keep the message threaded under an existing ask.
- Cold-start posture: \`senderKind\` is set automatically to \`agent-draft\` so the manager can see + edit before forwarding.

## Discipline

- One \`slack.postMessage\` action per logical message.
- Address the recipient by their first name; reference the source ticket/doc inline.
- Never send to a channel that is not in the list above.

## Closing the loop on a public-channel ask

If the work item came from a public channel (e.g. the candidate body says "asked in #revops-asks") and you draft to \`dm-manager\`, you MUST also post a brief threaded ack to the originating channel so the asker knows it's in flight. Use the same \`threadKey\` named in the candidate body.

\`\`\`json
{
  "tool": "slack.postMessage",
  "args": {
    "channelSlug": "revops-asks",
    "threadKey": "thread-pipeline-coverage",
    "body": "Drafting a tier-2 response for Manager review — will post here once approved."
  }
}
\`\`\`

That is two messages total: one to the manager (the full draft) and one threaded ack to the originating channel. Skip the channel ack only if the ask itself was already private (came in via DM).
`,
  },
  {
    slug: 'how-to-update-ticket',
    title: 'How to update a ticket (action guide)',
    body: `# How to update a ticket

## When to use this

Two main triggers:

1. **Closing the loop on a ticket-queue work item.** If the work item's source was the ticket queue, fire \`ticket.update\` against the originating ticket once you've done the work. \`status: "done"\` for full closure, \`"in-progress"\` for partial; one-line \`comment\` summarising what you did.
2. **Cross-linking cited tickets.** If your draft body mentions another ticket slug (e.g. "REVOPS-202 already covers the Looker refresh"), fire a second \`ticket.update\` against that ticket — \`status: "in-progress"\`, one-line cross-link comment — so the cited ticket's audit trail shows the connection.

## Action shape

\`\`\`json
{
  "tool": "ticket.update",
  "args": {
    "slug": "REVOPS-123",
    "status": "in-progress",
    "comment": "Picking this up — drafting the response now."
  }
}
\`\`\`

- \`slug\` is the ticket id (matches an existing \`mockTickets\` row).
- \`status\` is one of \`open\`, \`in-progress\`, \`blocked\`, \`done\`.
- \`comment\` is optional; will be appended with author "Day0".
`,
  },
  {
    slug: 'how-to-reply-tweet',
    title: 'How to reply to a tweet (action guide)',
    body: `# How to reply to a tweet

For social asks (which are typically out-of-scope for the RevOps role), if you do produce a draft reply, emit a \`twitter.reply\` action.

## Action shape

\`\`\`json
{
  "tool": "twitter.reply",
  "args": {
    "tweetSlug": "tweet-1234",
    "body": "Thanks for the feedback — appreciate you trying us out."
  }
}
\`\`\`

- The reply lands as \`isAgentDraft: true\`; the manager publishes manually.
- Most tweet replies are out-of-scope for RevOps. If unsure, surface a Slack draft to the manager instead.
`,
  },
];

export const seedMockEnvironment = internalMutation({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    const upsertDoc = async (
      slug: string,
      title: string,
      body: string,
      category: 'team-doc' | 'how-to-guide',
    ) => {
      const existing = await ctx.db
        .query('mockDocs')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId).eq('slug', slug))
        .unique();
      const payload = { title, body, category, updatedAt: Date.now() };
      if (existing) {
        await ctx.db.patch(existing._id, payload);
        return;
      }
      await ctx.db.insert('mockDocs', { agentId: args.agentId, slug, ...payload });
    };

    for (const d of TEAM_DOCS) await upsertDoc(d.slug, d.title, d.body, 'team-doc');
    for (const g of HOW_TO_GUIDES) await upsertDoc(g.slug, g.title, g.body, 'how-to-guide');

    // Spreadsheet — Q4 Revenue Tracker, two tabs
    const sheetSlug = 'q4-revenue-tracker';
    const sheetExisting = await ctx.db
      .query('mockSpreadsheets')
      .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId).eq('slug', sheetSlug))
      .unique();
    if (!sheetExisting) {
      await ctx.db.insert('mockSpreadsheets', {
        agentId: args.agentId,
        slug: sheetSlug,
        title: 'Q4 Revenue Tracker',
        tabs: [
          {
            name: 'closed-won',
            headers: ['Account', 'Amount', 'Close date', 'Owner', 'Stage'],
          },
          {
            name: 'pipeline',
            headers: ['Account', 'Amount', 'Stage', 'Close date', 'Owner'],
          },
        ],
        updatedAt: Date.now(),
      });
      // Seed a few existing rows so the sheet doesn't look empty
      const seedRow = async (tab: string, cells: Record<string, string>) =>
        ctx.db.insert('mockSpreadsheetRows', {
          agentId: args.agentId,
          sheetSlug,
          tabName: tab,
          cells,
          addedBy: 'Priya',
          addedAt: Date.now(),
        });
      await seedRow('closed-won', {
        Account: 'Northwind',
        Amount: '$120,000',
        'Close date': '2026-04-12',
        Owner: 'Priya',
        Stage: 'closed-won',
      });
      await seedRow('closed-won', {
        Account: 'Contoso',
        Amount: '$58,000',
        'Close date': '2026-04-19',
        Owner: 'Aman',
        Stage: 'closed-won',
      });
      await seedRow('pipeline', {
        Account: 'Initech',
        Amount: '$95,000',
        Stage: 'negotiation',
        'Close date': '2026-06-01',
        Owner: 'Priya',
      });
    }

    // Slack channels
    const ensureChannel = async (slug: string, displayName: string, kind: 'channel' | 'dm') => {
      const existing = await ctx.db
        .query('mockSlackChannels')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId).eq('slug', slug))
        .unique();
      if (existing) return;
      await ctx.db.insert('mockSlackChannels', {
        agentId: args.agentId,
        slug,
        displayName,
        kind,
        createdAt: Date.now(),
      });
    };
    await ensureChannel('revops-asks', '#revops-asks', 'channel');
    await ensureChannel('revops', '#revops', 'channel');
    await ensureChannel('dm-manager', 'DM · Manager', 'dm');
    await ensureChannel('dm-priya', 'DM · Priya', 'dm');
    await ensureChannel('dm-aman', 'DM · Aman', 'dm');

    // Initial Slack messages — set the scene
    const seedMessage = async (
      channelSlug: string,
      threadKey: string | undefined,
      sender: string,
      senderKind:
        | 'agent-draft'
        | 'agent-posted'
        | 'manager'
        | 'teammate'
        | 'requester'
        | 'system',
      body: string,
    ) => {
      const existingMsgs = await ctx.db
        .query('mockSlackMessages')
        .withIndex('by_agent_channel', (q) =>
          q.eq('agentId', args.agentId).eq('channelSlug', channelSlug),
        )
        .collect();
      if (existingMsgs.some((m) => m.body === body && m.sender === sender)) return;
      await ctx.db.insert('mockSlackMessages', {
        agentId: args.agentId,
        channelSlug,
        threadKey,
        sender,
        senderKind,
        body,
        timestamp: Date.now(),
      });
    };
    await seedMessage(
      'revops-asks',
      'thread-pipeline-coverage',
      'Priya',
      'requester',
      'New joiner ask: what does our enterprise segment pipeline coverage look like over the last four weeks? Briefing the CRO Tuesday.',
    );
    await seedMessage(
      'dm-manager',
      undefined,
      'Manager',
      'manager',
      "Three closed-won deals from last Friday's standup need to land in the Q4 Revenue Tracker — Acme ($45k), Beta Corp ($72k), Gamma LLC ($28k). Closed-won tab.",
    );

    // Tweet
    const tweetExisting = await ctx.db
      .query('mockTweets')
      .withIndex('by_agent_slug', (q) =>
        q.eq('agentId', args.agentId).eq('slug', 'tweet-acme-feedback'),
      )
      .unique();
    if (!tweetExisting) {
      await ctx.db.insert('mockTweets', {
        agentId: args.agentId,
        slug: 'tweet-acme-feedback',
        author: 'random_person',
        handle: '@random_person',
        body: '@AcmeCo your product is fine I guess',
        createdAt: Date.now(),
      });
    }

    // Tickets — REVOPS-123, REVOPS-124
    const ensureTicket = async (
      slug: string,
      title: string,
      body: string,
      status: 'open' | 'in-progress' | 'blocked' | 'done',
      priority: string,
    ) => {
      const existing = await ctx.db
        .query('mockTickets')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId).eq('slug', slug))
        .unique();
      if (existing) return;
      await ctx.db.insert('mockTickets', {
        agentId: args.agentId,
        slug,
        title,
        body,
        status,
        priority,
        comments: [],
        updatedAt: Date.now(),
      });
    };
    await ensureTicket(
      'REVOPS-201',
      'Reconcile Q3 closed-won totals against Salesforce',
      'Numbers in the committee deck do not match Salesforce; gap of ~$30k. Trace and reconcile.',
      'open',
      'P2',
    );
    await ensureTicket(
      'REVOPS-202',
      'Refresh Q4 pipeline coverage view in Looker',
      'Pipeline coverage tile is showing stale data. Look into the dbt model dependency.',
      'open',
      'P3',
    );
    await ensureTicket(
      'REVOPS-203',
      'Add Friday standup closed-won deals to Q4 Revenue Tracker',
      "Manager filed: append Acme ($45k), Beta Corp ($72k), Gamma LLC ($28k) to the closed-won tab from last Friday's standup. Close once the rows are in.",
      'open',
      'P1',
    );

    return { ok: true };
  },
});
