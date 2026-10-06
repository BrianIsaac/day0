import { afterEach, describe, expect, it, vi } from 'vitest';

const prompts = vi.hoisted(() => [] as string[]);
/** The drafts the fake model returns, one per call, oldest first; an empty batch once they run out. */
const drafts = vi.hoisted(() => [] as unknown[][]);

vi.mock('../../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async ({ user }: { user: string }): Promise<{ items: unknown[] }> => {
    prompts.push(user);
    return { items: drafts.shift() ?? [] };
  },
}));

import type { Charter } from '../../../src/agent/charter';
import { PLAIN_PUNCTUATION_IN_EVERY_FIELD } from '../../../src/agent/drafted-text-rules';
import {
  GENERATION_ATTEMPTS,
  WORK_GEN_SYSTEM,
  generateWorkItemsFromCharter,
} from '../../../src/agent/work-generator';

afterEach((): void => {
  prompts.length = 0;
  drafts.length = 0;
});

/** The office the drafts are read against: one tracker, whose slug the action ticket names. */
const OFFICE = {
  howToGuides: [],
  teamDocs: [],
  spreadsheets: [
    {
      slug: 'q4-revenue-tracker',
      title: 'Q4 Revenue Tracker',
      tabs: [{ name: 'closed-won', headers: ['Account', 'Amount'] }],
      rows: [{ tabName: 'closed-won', cells: { Account: 'Northwind', Amount: '$120,000' } }],
    },
  ],
  slackChannels: [],
  tweets: [],
  tickets: [],
};

/** The seeded office's shape in small: a row, a message and a team document, each with its words. */
const OFFICE_WITH_RECORDS = {
  ...OFFICE,
  slackChannels: [
    {
      slug: 'dm-manager',
      displayName: 'DM · Manager',
      kind: 'dm',
      recentMessages: [
        {
          sender: 'Manager',
          body: 'Three closed-won deals from Friday need to land in the tracker: Acme ($45k).',
        },
      ],
    },
  ],
  teamDocs: [
    {
      slug: 'on-call',
      title: 'On-call rotation',
      body: '# On-call rotation\n\n- Tier-2 (this week): Sara',
    },
  ],
};

const HYGIENE = {
  proposedFunction: 'Pipeline hygiene for the sales team.',
  proposedBoundaries: {
    willDo: ['Close out routine tickets in the queue.'],
    willNotDo: [],
    escalationTriggers: [],
  },
} as unknown as Charter;

/** A drafted item as the model returns it. */
function drafted(
  purpose: 'read-and-answer' | 'action' | 'beyond-the-office' | 'out-of-scope',
  title: string,
  contentSummary: string,
): Record<string, unknown> {
  return {
    purpose,
    sourceCategory: 'inbox',
    sourceSystem: 'slack',
    externalId: `slack-${purpose}`,
    title,
    contentSummary,
    contentRefs: [],
    priority: 'P2',
    requesterLabel: 'Aman',
  };
}

const READ = drafted(
  'read-and-answer',
  "Where is the team's onboarding guide kept?",
  'Aman asked: "Where is it?"',
);
/** A read-and-answer item that shares no word with the role, so the scope rule would skip it. */
const UNTIED_READ = drafted(
  'read-and-answer',
  'Where is the onboarding guide kept?',
  'Aman asked: "Where is it?"',
);
/** The action item as the mock office files it: a ticket on the ticket queue (D2), naming its record. */
const ACTION = {
  ...drafted('action', 'Close out the routine tickets this week', 'Priya: "Please close them."'),
  sourceCategory: 'ticket-queue',
  sourceSystem: 'ticket',
  externalId: 'ticket-action',
  contentRefs: ['mock-spreadsheet://q4-revenue-tracker'],
};
/** The same action ticket naming no record the office holds (13-FD: the redeploy's five). */
const UNGROUNDED_ACTION = { ...ACTION, contentRefs: [] };
/** The second ticket: an ask that needs a system the office does not hold (13-FD). */
const BEYOND = {
  ...drafted(
    'beyond-the-office',
    'Match the routine tickets against the CRM export before close',
    'Aman filed: "Please check the routine tickets against the CRM export."',
  ),
  sourceCategory: 'ticket-queue',
  sourceSystem: 'ticket',
  externalId: 'ticket-beyond',
};
/** The same action drafted as a Slack ask, which left a visitor's first queue with no ticket run. */
const SLACK_ACTION = drafted(
  'action',
  'Close out the routine tickets this week',
  'Priya: "Please close them."',
);
/** Bed 2's Ned: the action on the ticket queue, but a Slack item, which runs as a Slack reply. */
const SLACK_ACTION_ON_THE_QUEUE = { ...SLACK_ACTION, sourceCategory: 'ticket-queue' };
/** The review's out-of-scope item: its own words name the role it lies outside. */
const SAYS_OUT_OF_SCOPE = drafted(
  'out-of-scope',
  'Can you rewrite the Acme homepage copy?',
  'Aman forwarded: "Marketing wants a new homepage." This is a marketing task with no connection to pipeline hygiene.',
);
const PLAIN_OUT_OF_SCOPE = drafted(
  'out-of-scope',
  'Can you rewrite the Acme homepage copy?',
  'Aman forwarded: "Marketing wants a fresh homepage by Friday."',
);

describe('generated demo work prompt', (): void => {
  it('derives role mismatch from the runtime charter without naming the seeded office', (): void => {
    expect(WORK_GEN_SYSTEM).not.toMatch(/RevOps|revenue operations/i);
    expect(WORK_GEN_SYSTEM).toContain('outside the role described in the charter');
  });

  it('keeps how an item is handled out of the words the manager reads on its card (N29)', (): void => {
    // The out-of-scope item once told the model the evaluator should skip it, and the model wrote
    // "the agent should skip and route this back" into the item the manager read.
    expect(WORK_GEN_SYSTEM).not.toMatch(/should skip/i);
    expect(WORK_GEN_SYSTEM).toContain('never say how the request should be handled');
  });
});

describe('the charter the generator reads', (): void => {
  it('leaves out the clauses a strike took out, which are the record and not work', async (): Promise<void> => {
    const charter = {
      proposedFunction: 'Own triage.',
      proposedBoundaries: { willDo: ['Triage asks.'], willNotDo: [], escalationTriggers: [] },
      struckClauses: [{ field: 'willDo', text: 'Own the forecast deck.' }],
    } as unknown as Charter;
    const office = {
      howToGuides: [],
      teamDocs: [],
      spreadsheets: [],
      slackChannels: [],
      tweets: [],
      tickets: [],
    };
    await generateWorkItemsFromCharter(charter, office as never);
    expect(prompts.at(-1)).toContain('Triage asks.');
    expect(prompts.at(-1)).not.toContain('Own the forecast deck.');
  });
});

describe('the out-of-scope item the generator drafts (round 0141 R-D item 2)', (): void => {
  it('asks again, naming the shared words, when the out-of-scope item reads as the role’s work', async (): Promise<void> => {
    drafts.push(
      [READ, ACTION, BEYOND, SAYS_OUT_OF_SCOPE],
      [READ, ACTION, BEYOND, PLAIN_OUT_OF_SCOPE],
    );
    const items = await generateWorkItemsFromCharter(HYGIENE, OFFICE as never);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('pipeline, hygiene');
    expect(items.map((item) => item.contentSummary)).toContain(
      'Aman forwarded: "Marketing wants a fresh homepage by Friday."',
    );
  });

  it('leaves the out-of-scope item out when every draft still reads as the role’s work', async (): Promise<void> => {
    for (let attempt = 0; attempt < GENERATION_ATTEMPTS; attempt += 1) {
      drafts.push([READ, ACTION, BEYOND, SAYS_OUT_OF_SCOPE]);
    }
    const items = await generateWorkItemsFromCharter(HYGIENE, OFFICE as never);
    expect(prompts).toHaveLength(GENERATION_ATTEMPTS);
    expect(items.map((item) => item.title)).toEqual([
      "Where is the team's onboarding guide kept?",
      'Close out the routine tickets this week',
      'Match the routine tickets against the CRM export before close',
    ]);
  });

  it('takes a first draft whose out-of-scope item shares no word with the role, and returns no purpose', async (): Promise<void> => {
    drafts.push([READ, ACTION, BEYOND, PLAIN_OUT_OF_SCOPE]);
    const items = await generateWorkItemsFromCharter(HYGIENE, OFFICE as never);
    expect(prompts).toHaveLength(1);
    expect(items).toHaveLength(4);
    expect(items[3]).not.toHaveProperty('purpose');
  });
});

describe('the ticket-queue item the generator drafts (round 0141 R-D item 1, the bed walk)', (): void => {
  it("shows the generator none of the office's seeded tickets to copy into the role's queue", async (): Promise<void> => {
    const office = {
      ...OFFICE,
      tickets: [
        {
          slug: 'REVOPS-203',
          title: 'Add Friday standup closed-won deals to Q4 Revenue Tracker',
          status: 'open',
        },
      ],
    };
    await generateWorkItemsFromCharter(HYGIENE, office as never);
    expect(prompts.at(-1)).not.toContain('REVOPS-203');
    expect(prompts.at(-1)).not.toContain('Add Friday standup closed-won deals');
  });

  it('tells the generator a ticket-queue item is a new ticket the office opens from its own words', (): void => {
    expect(WORK_GEN_SYSTEM).toContain(
      'An item from the ticket queue is a new ticket filed for this role',
    );
  });
});

describe('the role words the out-of-scope item avoids (round 0141 R-D item 2, the bed walk)', (): void => {
  it("names the role's words in the first draft's brief, so the first draft can keep clear of them", async (): Promise<void> => {
    await generateWorkItemsFromCharter(HYGIENE, OFFICE as never);
    expect(prompts[0]).toContain(
      'The out-of-scope item uses none of these words from the role and its duties: pipeline, hygiene, sales, team, close, routine, tickets, queue.',
    );
  });
});

describe('the in-scope items the generator drafts (round 0141 R-D item 1, the second pass)', (): void => {
  it('asks again when a read or action item shares no word with the role, which the scope rule would skip', async (): Promise<void> => {
    drafts.push(
      [UNTIED_READ, ACTION, BEYOND, PLAIN_OUT_OF_SCOPE],
      [READ, ACTION, BEYOND, PLAIN_OUT_OF_SCOPE],
    );
    const items = await generateWorkItemsFromCharter(HYGIENE, OFFICE as never);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(
      'The read-and-answer item in your last draft shares no word with the role and its duties',
    );
    expect(items.map((item) => item.title)).toContain("Where is the team's onboarding guide kept?");
  });

  it('keeps an in-scope item that still shares no word after every draft, never leaving it out', async (): Promise<void> => {
    for (let attempt = 0; attempt < GENERATION_ATTEMPTS; attempt += 1) {
      drafts.push([UNTIED_READ, ACTION, BEYOND, PLAIN_OUT_OF_SCOPE]);
    }
    const items = await generateWorkItemsFromCharter(HYGIENE, OFFICE as never);
    expect(items).toHaveLength(4);
  });

  it('no longer asks the model to make the mismatch of the out-of-scope item clear', (): void => {
    expect(WORK_GEN_SYSTEM).not.toMatch(/make the mismatch clear/i);
    expect(WORK_GEN_SYSTEM).toContain('the item itself never says so');
  });
});

describe("the role's words the in-scope items use (D2, the bed walk)", (): void => {
  it("names the role's words in the first draft's brief for the read and action items too, since the scope rule skips an item that shares none", async (): Promise<void> => {
    await generateWorkItemsFromCharter(HYGIENE, OFFICE as never);
    expect(prompts[0]).toContain(
      'The read-and-answer item and the action item each use at least one of these words from the role and its duties, as the sender would: pipeline, hygiene, sales, team, close, routine, tickets, queue.',
    );
  });
});

describe('the action item the mock office files on its ticket queue (D2 (b), a product call)', (): void => {
  it('tells the generator the action item is a new ticket on the ticket queue, never another surface', (): void => {
    expect(WORK_GEN_SYSTEM).toContain(
      '2. Action item - a new ticket filed for this role on the ticket queue: sourceCategory MUST be "ticket-queue" and sourceSystem MUST be "ticket".',
    );
    expect(WORK_GEN_SYSTEM).not.toContain('pick whichever surface best fits');
  });

  it.each([
    { name: 'a Slack ask', action: SLACK_ACTION },
    { name: 'a Slack item on the ticket queue', action: SLACK_ACTION_ON_THE_QUEUE },
  ])(
    'asks again when the action item is $name, not a ticket on the queue',
    async ({ action }): Promise<void> => {
      drafts.push(
        [READ, action, BEYOND, PLAIN_OUT_OF_SCOPE],
        [READ, ACTION, BEYOND, PLAIN_OUT_OF_SCOPE],
      );
      const items = await generateWorkItemsFromCharter(HYGIENE, OFFICE as never);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain(
        'The action item in your last draft is not a ticket on the ticket queue: file it there, with sourceCategory "ticket-queue" and sourceSystem "ticket".',
      );
      expect(items[1]).toMatchObject({ sourceCategory: 'ticket-queue', sourceSystem: 'ticket' });
    },
  );

  it('files the action item on the ticket queue itself when every draft puts it elsewhere, keeping its words and no channel to act on', async (): Promise<void> => {
    const inChannel = { ...SLACK_ACTION, contentRefs: ['channel://revops-asks'] };
    for (let attempt = 0; attempt < GENERATION_ATTEMPTS; attempt += 1) {
      drafts.push([READ, inChannel, BEYOND, PLAIN_OUT_OF_SCOPE]);
    }
    const items = await generateWorkItemsFromCharter(HYGIENE, OFFICE as never);
    expect(prompts).toHaveLength(GENERATION_ATTEMPTS);
    expect(items[1]).toMatchObject({
      sourceCategory: 'ticket-queue',
      sourceSystem: 'ticket',
      title: 'Close out the routine tickets this week',
      contentSummary: 'Priya: "Please close them."',
      contentRefs: [],
    });
  });
});

describe('the first tickets the office can and cannot back (13-FD, the v0.16.0 redeploy finding 2)', (): void => {
  it('shows the generator what the office holds, its rows, messages and team documents, not only their names', async (): Promise<void> => {
    await generateWorkItemsFromCharter(HYGIENE, OFFICE_WITH_RECORDS as never);
    expect(prompts[0]).toContain('Northwind');
    expect(prompts[0]).toContain('$120,000');
    expect(prompts[0]).toContain(
      'Three closed-won deals from Friday need to land in the tracker: Acme ($45k).',
    );
    expect(prompts[0]).toContain('Tier-2 (this week): Sara');
  });

  it('asks for an action ticket the office lets the role finish in the run, closing once it is written', (): void => {
    expect(WORK_GEN_SYSTEM).toContain(
      'Every ask of the action ticket is one the office lets the role finish in this one run:',
    );
    expect(WORK_GEN_SYSTEM).toContain(
      'or a draft to review before it closes: the manager approves every write before it lands.',
    );
  });

  it('asks for a second ticket whose ask needs what the office does not hold, never saying so', (): void => {
    expect(WORK_GEN_SYSTEM).toContain(
      '3. Beyond-the-office item - a second new ticket filed for this role on the ticket queue',
    );
    expect(WORK_GEN_SYSTEM).toContain('the ticket never says the office lacks anything');
  });

  it('seeds both tickets on the queue, the workable one first', async (): Promise<void> => {
    drafts.push([READ, ACTION, BEYOND, PLAIN_OUT_OF_SCOPE]);
    const items = await generateWorkItemsFromCharter(HYGIENE, OFFICE as never);
    expect(prompts).toHaveLength(1);
    expect(items.map((item) => [item.title, item.sourceCategory])).toEqual([
      ["Where is the team's onboarding guide kept?", 'inbox'],
      ['Close out the routine tickets this week', 'ticket-queue'],
      ['Match the routine tickets against the CRM export before close', 'ticket-queue'],
      ['Can you rewrite the Acme homepage copy?', 'inbox'],
    ]);
  });

  it('asks again when the action ticket names no record the office holds', async (): Promise<void> => {
    drafts.push(
      [READ, UNGROUNDED_ACTION, BEYOND, PLAIN_OUT_OF_SCOPE],
      [READ, ACTION, BEYOND, PLAIN_OUT_OF_SCOPE],
    );
    const items = await generateWorkItemsFromCharter(HYGIENE, OFFICE as never);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(
      "The action item in your last draft names no record the snapshot holds: ask only for work the snapshot's rows, messages or documents let the role finish, and name those records in its contentRefs.",
    );
    expect(items[1]?.contentRefs).toEqual(['mock-spreadsheet://q4-revenue-tracker']);
  });

  it('asks again when a draft leaves out one of the four items', async (): Promise<void> => {
    drafts.push([READ, ACTION, PLAIN_OUT_OF_SCOPE], [READ, ACTION, BEYOND, PLAIN_OUT_OF_SCOPE]);
    const items = await generateWorkItemsFromCharter(HYGIENE, OFFICE as never);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(
      'Your last draft has no beyond-the-office item: draft all four, one of each purpose.',
    );
    expect(items).toHaveLength(4);
  });

  it('asks again when the action ticket names only a how-to guide, which the snapshot never shows (the second pass)', async (): Promise<void> => {
    const office = {
      ...OFFICE,
      howToGuides: [{ slug: 'how-to-update-ticket', title: 'How to update a ticket', body: '' }],
    };
    drafts.push(
      [
        READ,
        { ...ACTION, contentRefs: ['docs-fixture/how-to-update-ticket'] },
        BEYOND,
        PLAIN_OUT_OF_SCOPE,
      ],
      [READ, ACTION, BEYOND, PLAIN_OUT_OF_SCOPE],
    );
    await generateWorkItemsFromCharter(HYGIENE, office as never);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain('how-to-update-ticket');
    expect(prompts[1]).toContain(
      'The action item in your last draft names no record the snapshot holds',
    );
  });

  it("shows at most twelve team documents' words, forty lines each, and lists the rest by name (the second pass)", async (): Promise<void> => {
    const page = (n: number) => ({
      slug: `page-${n}`,
      title: `Page ${n}`,
      body: Array.from({ length: 60 }, (_, line) => `page ${n} line ${line + 1}`).join('\n'),
    });
    const office = { ...OFFICE, teamDocs: Array.from({ length: 15 }, (_, n) => page(n + 1)) };
    await generateWorkItemsFromCharter(HYGIENE, office as never);
    const prompt = prompts[0] ?? '';
    expect(prompt).toContain('page 1 line 40');
    expect(prompt).not.toContain('page 1 line 41');
    expect(prompt).toContain('page 12 line 1');
    expect(prompt).not.toContain('page 13 line 1');
    expect(prompt).toContain('slug "page-15" titled "Page 15"');
  });

  it('keeps the two tickets apart when the draft gives them one external id', async (): Promise<void> => {
    drafts.push([READ, ACTION, { ...BEYOND, externalId: 'ticket-action' }, PLAIN_OUT_OF_SCOPE]);
    const items = await generateWorkItemsFromCharter(HYGIENE, OFFICE as never);
    expect(new Set(items.map((item) => item.externalId)).size).toBe(items.length);
    expect(items[1]?.externalId).toBe('ticket-action');
  });
});

describe('the punctuation of the requests the generator drafts (13-FD, the v0.16.0 redeploy finding 5)', (): void => {
  it('states the house copy rule to the generator, whose quoted requests carried an em dash on the hosted office', (): void => {
    expect(WORK_GEN_SYSTEM).toContain(PLAIN_PUNCTUATION_IN_EVERY_FIELD);
    expect(WORK_GEN_SYSTEM).not.toMatch(/[\u2013\u2014]/);
  });
});
