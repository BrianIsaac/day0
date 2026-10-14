import { afterEach, describe, expect, it, vi } from 'vitest';

const prompts = vi.hoisted(() => [] as string[]);
/** The drafts the fake model returns, one per call, oldest first; an empty batch once they run out. */
const drafts = vi.hoisted(() => [] as unknown[][]);
/** Each call's time limit, and what the fake model does before it answers (12-J item 6, option A). */
const calls = vi.hoisted(() => ({
  timeouts: [] as Array<number | undefined>,
  before: undefined as ((call: number) => void) | undefined,
}));

vi.mock('../../../src/lib/mastra', () => ({
  MODEL_CALL_TIMEOUT_MS: 300_000,
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async ({
    user,
    timeoutMs,
  }: {
    user: string;
    timeoutMs?: number;
  }): Promise<{ items: unknown[] }> => {
    prompts.push(user);
    calls.timeouts.push(timeoutMs);
    calls.before?.(calls.timeouts.length);
    return { items: drafts.shift() ?? [] };
  },
}));

import type { Charter } from '../../../src/agent/charter';
import { log } from '../../../src/lib/logger';
import {
  HANA_ASK,
  KOFI_ASK,
  LARK,
  MANAGER_ASK,
  MOSS,
  NELL,
  PIP,
  QUILL,
  SARA_ASK,
} from '../../fixtures/agent/office-roles-2026-10-07';
import {
  LARK_W19,
  NELL_W19,
  PIP_W19,
  PRIYA_ASK,
} from '../../fixtures/agent/office-roles-2026-10-11';
import { NELL_W20, OFFICE_TEAM_DOCS, PIP_W20 } from '../../fixtures/agent/office-roles-2026-10-13';
import { PLAIN_PUNCTUATION_IN_EVERY_FIELD } from '../../../src/agent/drafted-text-rules';
import {
  GENERATION_ATTEMPTS,
  GENERATION_BUDGET_MS,
  WORK_GEN_SYSTEM,
  generateWorkItemsFromCharter,
} from '../../../src/agent/work-generator';

afterEach((): void => {
  prompts.length = 0;
  drafts.length = 0;
  calls.timeouts.length = 0;
  calls.before = undefined;
  vi.useRealTimers();
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
    // W13-R41 (13-FD's R8): the prompt that asks for no dash writes none as a clause break.
    expect(WORK_GEN_SYSTEM).not.toMatch(/\S - /);
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
      // Re-pinned for W13-R41: the clause dash is a colon.
      '2. Action item: a new ticket filed for this role on the ticket queue: sourceCategory MUST be "ticket-queue" and sourceSystem MUST be "ticket".',
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
      // Re-pinned for W13-R41: the clause dash is a colon.
      '3. Beyond-the-office item: a second new ticket filed for this role on the ticket queue',
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

describe('the generation inside one seeding attempt (12-J item 6, option A)', (): void => {
  it('keeps every draft inside one budget under the platform’s ten minutes, each call given what is left', async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // Each draft takes 200 s; the out-of-scope item reads as the role, so it is asked three times.
    calls.before = (): void => {
      vi.setSystemTime(Date.now() + 200_000);
    };
    drafts.push(
      [READ, ACTION, BEYOND, SAYS_OUT_OF_SCOPE],
      [READ, ACTION, BEYOND, SAYS_OUT_OF_SCOPE],
      [READ, ACTION, BEYOND, PLAIN_OUT_OF_SCOPE],
    );
    await generateWorkItemsFromCharter(HYGIENE, OFFICE as never);
    expect(GENERATION_BUDGET_MS).toBeLessThan(600_000);
    expect(calls.timeouts).toEqual([300_000, 280_000, 80_000]);
  });

  it('keeps the draft in hand when a later draft runs out of the budget', async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    calls.before = (call: number): void => {
      vi.setSystemTime(Date.now() + 250_000);
      if (call === 2) {
        const spent = new Error(
          'agentJson(day0-work-generator): the model call reached its budget',
        );
        spent.name = 'TimeoutError';
        throw spent;
      }
    };
    drafts.push([READ, ACTION, BEYOND, SAYS_OUT_OF_SCOPE]);
    const items = await generateWorkItemsFromCharter(HYGIENE, OFFICE as never);
    expect(calls.timeouts).toHaveLength(2);
    // The first draft is taken as the last one is: its out-of-scope item still reads as the role.
    expect(items.map((item) => item.title)).toEqual([
      "Where is the team's onboarding guide kept?",
      'Close out the routine tickets this week',
      'Match the routine tickets against the CRM export before close',
    ]);
  });

  it('fails the attempt when its first draft runs out of the budget, so the seeding records it and tries again', async (): Promise<void> => {
    calls.before = (): void => {
      const spent = new Error('agentJson(day0-work-generator): the model call reached its budget');
      spent.name = 'TimeoutError';
      throw spent;
    };
    await expect(generateWorkItemsFromCharter(HYGIENE, OFFICE as never)).rejects.toThrow(
      'reached its budget',
    );
  });
});

describe('a draft kept when the budget ran out (W13-R39, W13-R40)', (): void => {
  /** The second draft's call runs out of the budget, so the first draft is the one in hand. */
  const budgetOutOnTheSecondDraft = (): void => {
    calls.before = (call: number): void => {
      if (call === 2) {
        const spent = new Error(
          'agentJson(day0-work-generator): the model call reached its budget',
        );
        spent.name = 'TimeoutError';
        throw spent;
      }
    };
  };

  it('says how many drafts it read, not how many it may ask for', async (): Promise<void> => {
    const warn = vi.spyOn(log, 'warn');
    budgetOutOnTheSecondDraft();
    drafts.push([READ, ACTION, BEYOND, SAYS_OUT_OF_SCOPE]);
    await generateWorkItemsFromCharter(HYGIENE, OFFICE as never);
    expect(warn).toHaveBeenCalledWith(
      'mock work generator left out an out-of-scope item that reads as the role',
      expect.objectContaining({ attempts: 1 }),
    );
    warn.mockRestore();
  });

  it.each([
    [
      'without a beyond-the-office item',
      [READ, ACTION, { ...BEYOND, purpose: 'action' }, PLAIN_OUT_OF_SCOPE],
      'it has no beyond-the-office item',
    ],
    [
      'with a read that shares no word with the role',
      [UNTIED_READ, ACTION, BEYOND, PLAIN_OUT_OF_SCOPE],
      'its read-and-answer item shares no word with the role',
    ],
    [
      'with an action ticket that names no record of the office',
      [READ, UNGROUNDED_ACTION, BEYOND, PLAIN_OUT_OF_SCOPE],
      'its action ticket names no record of the office',
    ],
  ] as const)(
    'fails the attempt rather than seed a draft %s',
    async (_what, draft, fault): Promise<void> => {
      budgetOutOnTheSecondDraft();
      drafts.push([...draft]);
      await expect(generateWorkItemsFromCharter(HYGIENE, OFFICE as never)).rejects.toThrow(
        `the work generator's budget ran out on a draft that ${fault}`,
      );
    },
  );
});

describe("the office's asks a role is shown (finding 2 of the v0.17.0 redeploy, 13-FD's R4)", (): void => {
  /** 13-FD's office in small: the three company-wide asks and the manager's own. */
  const OFFICE_ASKS = {
    ...OFFICE,
    slackChannels: [
      {
        slug: 'office-asks',
        displayName: '#office-asks',
        kind: 'channel',
        recentMessages: [
          { sender: 'Kofi', threadKey: 'thread-drive-access', body: KOFI_ASK },
          { sender: 'Sara', threadKey: 'thread-spare-monitor', body: SARA_ASK },
          { sender: 'Hana', threadKey: 'thread-double-charge', body: HANA_ASK },
        ],
      },
      {
        slug: 'dm-manager',
        displayName: 'DM · Manager',
        kind: 'dm',
        recentMessages: [{ sender: 'Manager', body: MANAGER_ASK }],
      },
    ],
  };
  const asks = { Kofi: KOFI_ASK, Sara: SARA_ASK, Hana: HANA_ASK };

  it.each([
    ['Nell, the IT helpdesk triager', NELL, ['Kofi']],
    ['Pip, the support triage coordinator', PIP, ['Hana']],
    ['Quill, the facilities coordinator', QUILL, ['Sara']],
    ['Lark, the revenue operations coordinator', LARK, []],
    ['Moss, the finance close assistant', MOSS, []],
  ] as const)(
    'shows %s the company-wide asks of its own role and no other',
    async (_who, charter, own) => {
      await generateWorkItemsFromCharter(charter, OFFICE_ASKS as never);
      const prompt = prompts.at(-1) ?? '';
      for (const [sender, words] of Object.entries(asks)) {
        if ((own as readonly string[]).includes(sender)) expect(prompt, sender).toContain(words);
        else expect(prompt, sender).not.toContain(words);
      }
      // The manager's own ask is the office's own team's, shown to every role as before.
      expect(prompt).toContain(MANAGER_ASK);
    },
  );

  it('tells a role with no ask of its own where asks arrive, never that the channel is empty (W14-R49)', async (): Promise<void> => {
    const told =
      '      (no ask for this role is open here; company-wide asks arrive in this channel)';
    await generateWorkItemsFromCharter(MOSS, OFFICE_ASKS as never);
    const moss = prompts.at(-1) ?? '';
    expect(moss).toContain(
      `  - slug "office-asks" (channel, displayed as "#office-asks")\n${told}`,
    );
    // A role with an ask of its own is shown the ask and no such line.
    await generateWorkItemsFromCharter(NELL, OFFICE_ASKS as never);
    expect(prompts.at(-1) ?? '').not.toContain('company-wide asks arrive in this channel');
    // A channel that holds nothing still reads as empty.
    await generateWorkItemsFromCharter(MOSS, {
      ...OFFICE_ASKS,
      slackChannels: [{ ...OFFICE_ASKS.slackChannels[0], recentMessages: [] }],
    } as never);
    expect(prompts.at(-1) ?? '').toContain('      (no messages)');
  });
});

describe("the revenue team's ask a role is shown (W19-3, the v0.19.0 walk)", (): void => {
  /** The office as the walk's employees saw it: Priya's ask in #revops-asks, Hana's in #office-asks. */
  const WALKED = {
    ...OFFICE,
    slackChannels: [
      {
        slug: 'revops-asks',
        displayName: '#revops-asks',
        kind: 'channel',
        recentMessages: [
          { sender: 'Priya', threadKey: 'thread-pipeline-coverage', body: PRIYA_ASK },
        ],
      },
      {
        slug: 'office-asks',
        displayName: '#office-asks',
        kind: 'channel',
        recentMessages: [{ sender: 'Hana', threadKey: 'thread-double-charge', body: HANA_ASK }],
      },
    ],
  };

  it.each([
    ['Nell, the IT helpdesk triager', NELL_W19, false],
    ['Pip, the support triage coordinator', PIP_W19, false],
    ['Lark, the revenue operations coordinator', LARK_W19, true],
  ] as const)('shows %s Priya’s ask only if it is its role’s', async (_who, charter, shown) => {
    await generateWorkItemsFromCharter(charter, WALKED as never);
    const prompt = prompts.at(-1) ?? '';
    if (shown) expect(prompt).toContain(PRIYA_ASK);
    else {
      expect(prompt).not.toContain(PRIYA_ASK);
      expect(prompt).toContain(
        '  - slug "revops-asks" (channel, displayed as "#revops-asks")\n      (no ask for this role is open here)',
      );
    }
  });
});

describe('the team documents a role is shown (16-FW’s F7; finding 3 of the v0.20.0 walk)', (): void => {
  const WHOLE_OFFICE = { ...OFFICE, teamDocs: OFFICE_TEAM_DOCS };
  const shownTo = async (charter: Charter): Promise<string> => {
    await generateWorkItemsFromCharter(charter, WHOLE_OFFICE as never);
    return prompts.at(-1) ?? '';
  };

  it('shows the support triage role no example of a revenue operations ask: 16-FW’s "pipeline coverage figures" ticket', async (): Promise<void> => {
    const prompt = await shownTo(PIP_W20);
    expect(prompt).not.toContain('pipeline coverage');
    expect(prompt).not.toContain('slug "team-overview"');
    // Its own ask's page, whole, and the office's own pages.
    expect(prompt).toContain('slug "billing-replies" titled "Customer billing replies":');
    expect(prompt).toContain('billing reviews duplicate charges within two business days');
    expect(prompt).toContain('slug "on-call" titled "On-call rotation":');
    expect(prompt).toContain('slug "escalation-paths" titled "Escalation paths":');
    expect(prompt).toContain('slug "onboarding" titled "Onboarding: first week":');
  });

  it('shows the IT helpdesk role no supplies page: the walk’s "desk monitor has failed" ticket, which its charter places with facilities', async (): Promise<void> => {
    const prompt = await shownTo(NELL_W20);
    expect(prompt).not.toContain('supply cupboard');
    expect(prompt).not.toContain('Spare monitors');
    expect(prompt).not.toContain('slug "office-supplies"');
    expect(prompt).not.toContain('slug "billing-replies"');
    expect(prompt).toContain('slug "it-access" titled "IT access and passwords":');
    expect(prompt).toContain('Sign out of the drive app on every device.');
  });

  it('shows the revenue role its team overview whole, as before', async (): Promise<void> => {
    const prompt = await shownTo(LARK_W19);
    expect(prompt).toContain('slug "team-overview" titled "Team overview: RevOps":');
    expect(prompt).toContain("What's our pipeline coverage on enterprise?");
    expect(prompt).not.toContain('slug "it-access"');
  });

  it('asks again for an action ticket that names only a page the role is not shown', async (): Promise<void> => {
    const onSupplies = {
      ...ACTION,
      title: 'Answer the routine access ticket about the spare monitor',
      contentRefs: ['docs-fixture/office-supplies'],
    };
    const onAccess = { ...onSupplies, contentRefs: ['docs-fixture/it-access'] };
    const read = { ...READ, title: 'Which wiki steps answer routine access questions?' };
    const beyond = { ...BEYOND, title: 'Sort the routine access tickets against the CRM export' };
    drafts.push(
      [read, onSupplies, beyond, PLAIN_OUT_OF_SCOPE],
      [read, onAccess, beyond, PLAIN_OUT_OF_SCOPE],
    );
    const items = await generateWorkItemsFromCharter(NELL_W20, {
      ...WHOLE_OFFICE,
      spreadsheets: [],
    } as never);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(
      'The action item in your last draft names no record the snapshot holds',
    );
    expect(items.map((item) => item.contentRefs)).toContainEqual(['docs-fixture/it-access']);
  });

  it('tells the generator that the three items of the role’s own work ask for nothing its will-not-do clauses exclude', (): void => {
    expect(WORK_GEN_SYSTEM).toContain(
      "Items 1 to 3 are this role's own work to do itself: none asks for anything a will-not-do clause excludes or the charter places with another person or team.",
    );
  });
});

describe('one ask drafted as more than one item (finding 2 of the v0.20.0 hosted walk)', (): void => {
  // Rows `A-Pip-docs-full.txt` and `A-Pip-tB-full.txt`: the docs item and the P1 ticket both
  // quote Hana's one ask, so it was answered three times in her thread and the docs item's run
  // closed the ticket that the other item held.
  const HANA_QUOTED =
    '"Northwind wrote in that invoice INV-2207 charged them twice this month. Can someone post the first reply here for me to send them?"';
  const docsItem = {
    ...drafted(
      'read-and-answer',
      'Question on the first reply to a duplicate charge',
      `Hana asked in the thread: ${HANA_QUOTED} She wants to know what the approved wording should cover before it goes to the customer. Please answer in the thread where she asked, following the customer billing replies document.`,
    ),
    sourceSystem: 'docs',
    externalId: 'docs-billing-replies',
    requesterLabel: 'Hana',
  };
  const ticket = {
    ...ACTION,
    title: 'Log and work the Northwind duplicate charge ask',
    contentSummary: `Hana reported: ${HANA_QUOTED} Please log this ask on the ticket queue, post the first reply in her thread following the customer billing replies document, and close the ticket once the reply is written.`,
    externalId: 'ticket-northwind-double-charge',
    requesterLabel: 'Hana',
  };
  const ownTicket = {
    ...ticket,
    title: 'Log the social mention about the late invoice email',
    contentSummary:
      'Manager: "Please log the open social mention about the late invoice email on the ticket queue and note what was replied." Close the ticket once it is logged.',
    externalId: 'ticket-social-mention',
  };
  const beyond = {
    ...BEYOND,
    title: 'Check the CRM record behind the Northwind invoice query',
    contentSummary:
      'Hana added: "While you are on the Northwind duplicate charge, it would help to confirm what the CRM shows for that account before billing reviews it." Please log each finding on the ticket queue.',
  };

  it('asks again, naming the two items, when two of them quote the same request', async (): Promise<void> => {
    drafts.push(
      [docsItem, ticket, beyond, PLAIN_OUT_OF_SCOPE],
      [docsItem, ownTicket, beyond, PLAIN_OUT_OF_SCOPE],
    );
    const items = await generateWorkItemsFromCharter(PIP_W20, OFFICE as never);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(
      'The read-and-answer item and the action item in your last draft quote the same request, so one ask would be worked twice: each item is its own request, from its own message.',
    );
    expect(items.map((item) => item.title)).toContain(
      'Log the social mention about the late invoice email',
    );
  });

  it('takes a draft whose items each quote their own request, the same asker or not', async (): Promise<void> => {
    drafts.push([docsItem, ownTicket, beyond, PLAIN_OUT_OF_SCOPE]);
    await generateWorkItemsFromCharter(PIP_W20, OFFICE as never);
    expect(prompts).toHaveLength(1);
  });

  it('keeps both items when every draft still quotes one request twice, and says so in the log', async (): Promise<void> => {
    const warned = vi.spyOn(log, 'warn').mockImplementation((): void => undefined);
    for (let attempt = 0; attempt < GENERATION_ATTEMPTS; attempt += 1) {
      drafts.push([docsItem, ticket, beyond, PLAIN_OUT_OF_SCOPE]);
    }
    const items = await generateWorkItemsFromCharter(PIP_W20, OFFICE as never);
    expect(items).toHaveLength(4);
    expect(warned.mock.calls.map((call) => call[0])).toContain(
      'mock work generator seeded two items that are one ask',
    );
    warned.mockRestore();
  });

  // The bed day0-w17fw, 13 October 2026, on the hosted model with the first form of this check:
  // the IT helpdesk role's read item quoted Kofi's ask and its ticket quoted the manager ("A
  // helpdesk ticket came in from Kofi about the shared drive ..."), both naming Kofi's thread.
  it('asks again when two items name one thread, whatever each quotes', async (): Promise<void> => {
    const kofiRead = {
      ...drafted(
        'read-and-answer',
        'Kofi is locked out of the shared drive after a password change',
        'Kofi asked in #office-asks: "I changed my password this morning and the shared drive now says access denied. What are the steps to get back in?" Please answer in his thread using the IT access and passwords doc. It is a routine access question.',
      ),
      sourceSystem: 'docs',
      externalId: 'docs-it-access',
      contentRefs: ['docs-fixture/it-access', 'channel://office-asks#thread-drive-access'],
      requesterLabel: 'Kofi',
    };
    const kofiTicket = {
      ...ACTION,
      title: 'Reply to the shared drive lockout thread and close the ticket out',
      contentSummary:
        'Manager filed this one: "A helpdesk ticket came in from Kofi about the shared drive saying access denied after his password change. Post the reply in his thread using the wiki steps, comment on the ticket with what you sent, and close it."',
      externalId: 'ticket-drive-lockout-reply',
      contentRefs: ['docs-fixture/it-access', 'channel://office-asks#thread-drive-access'],
      requesterLabel: 'Manager',
    };
    const ownTicket = {
      ...kofiTicket,
      title: 'Post the shared drive sign-back steps in the office asks channel',
      contentSummary:
        'Manager filed this ticket: "The same access question keeps arriving each Monday, so please post the shared drive sign-back steps in #office-asks so the team can self-serve, then comment on this ticket and close it."',
      externalId: 'ticket-shared-drive-self-serve-steps',
      contentRefs: ['docs-fixture/it-access', 'channel://office-asks'],
    };
    const beyond = { ...BEYOND, title: 'Add the new starter to the SSO group for ticket access' };
    drafts.push(
      [kofiRead, kofiTicket, beyond, PLAIN_OUT_OF_SCOPE],
      [kofiRead, ownTicket, beyond, PLAIN_OUT_OF_SCOPE],
    );
    const office = {
      ...OFFICE,
      teamDocs: OFFICE_TEAM_DOCS,
      slackChannels: [
        {
          slug: 'office-asks',
          displayName: '#office-asks',
          kind: 'channel',
          recentMessages: [{ sender: 'Kofi', threadKey: 'thread-drive-access', body: KOFI_ASK }],
        },
      ],
    };
    const items = await generateWorkItemsFromCharter(NELL_W20, office as never);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(
      `The read-and-answer item in your last draft is answered in its asker's thread, "channel://office-asks#thread-drive-access", and the action item names that thread too, so one ask would be worked twice: draft the action item from another message, and leave that thread out of its contentRefs.`,
    );
    expect(items.map((item) => item.externalId)).toContain('ticket-shared-drive-self-serve-steps');
  });

  it('reads the thread a read-and-answer item is given from its asker as that item’s thread', async (): Promise<void> => {
    // The read item names no thread and its asker has one; the ticket names that thread.
    const read = {
      ...drafted(
        'read-and-answer',
        'How should we word a first reply to a duplicate charge ticket',
        'Hana asked in the inbox, "Before I send anything to Northwind, what does our billing replies doc say a first reply to a duplicate charge should cover?" Please log each ask.',
      ),
      sourceSystem: 'docs',
      externalId: 'docs-billing-replies',
      requesterLabel: 'Hana',
    };
    const ticket204 = {
      ...ACTION,
      title: 'Log the first reply for the Northwind duplicate charge ask',
      contentSummary:
        'Hana filed this ask: "Northwind wrote in that invoice INV-2207 charged them twice this month. Can someone post the first reply here for me to send them?" Please log it.',
      contentRefs: ['channel://office-asks#thread-double-charge', 'docs-fixture/billing-replies'],
      requesterLabel: 'Hana',
    };
    const office = {
      ...OFFICE,
      teamDocs: OFFICE_TEAM_DOCS,
      slackChannels: [
        {
          slug: 'office-asks',
          displayName: '#office-asks',
          kind: 'channel',
          recentMessages: [{ sender: 'Hana', threadKey: 'thread-double-charge', body: HANA_ASK }],
        },
      ],
    };
    drafts.push([read, ticket204, beyond, PLAIN_OUT_OF_SCOPE]);
    await generateWorkItemsFromCharter(PIP_W20, office as never);
    expect(prompts.length).toBeGreaterThan(1);
    // The read item named no thread, so the line does not say it did (the continuation's second
    // pass): it says where the item's answer goes, and which item to draft again.
    expect(prompts[1]).toContain(
      `The read-and-answer item in your last draft is answered in its asker's thread, "channel://office-asks#thread-double-charge", and the action item names that thread too`,
    );
    expect(prompts[1]).not.toContain('both name the thread');
  });

  it('says two tickets that name one thread both name it', async (): Promise<void> => {
    const first = {
      ...ACTION,
      title: 'Log the first reply for the Northwind duplicate charge ask',
      contentSummary:
        'Manager filed this: "Log what we told Northwind about invoice INV-2207 on the ticket queue."',
      externalId: 'ticket-northwind-log',
      contentRefs: ['channel://office-asks#thread-double-charge', 'docs-fixture/billing-replies'],
      requesterLabel: 'Manager',
    };
    const second = {
      ...BEYOND,
      title: 'Check the Northwind renewal date for their billing question',
      contentRefs: ['channel://office-asks#thread-double-charge'],
    };
    const read = {
      ...drafted(
        'read-and-answer',
        'What does our billing replies doc say about refunds',
        'Support lead asked, "What does our customer billing replies doc say we may promise about a refund?" Please read it and answer.',
      ),
      sourceSystem: 'docs',
      externalId: 'docs-billing-replies',
      requesterLabel: 'Support lead',
    };
    drafts.push([read, first, second, PLAIN_OUT_OF_SCOPE]);
    await generateWorkItemsFromCharter(PIP_W20, { ...OFFICE, teamDocs: OFFICE_TEAM_DOCS } as never);
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts[1]).toContain(
      'in your last draft both name the thread "channel://office-asks#thread-double-charge", so one ask would be worked twice: each item is its own request, from its own message.',
    );
  });

  it('tells the generator that the four items are four requests', (): void => {
    expect(WORK_GEN_SYSTEM).toContain(
      'The four items are four different requests: no two quote, answer or act on the same message or ask.',
    );
  });
});

describe('a read-and-answer item names the thread its asker asks in (W19-4, the v0.19.0 walk)', (): void => {
  /** Pip's office: Hana's ask in #office-asks and the billing replies page. */
  const PIPS_OFFICE = {
    ...OFFICE,
    slackChannels: [
      {
        slug: 'office-asks',
        displayName: '#office-asks',
        kind: 'channel',
        recentMessages: [{ sender: 'Hana', threadKey: 'thread-double-charge', body: HANA_ASK }],
      },
    ],
    teamDocs: [{ slug: 'billing-replies', title: 'Customer billing replies', body: '# Replies' }],
  };
  /** Pip's docs item as the walk's row `A-Pip-docs-full.txt` shows it: Hana's, no thread. */
  const HANAS_DOCS_ASK = {
    ...drafted(
      'read-and-answer',
      'What does the billing doc say about duplicate charge replies',
      'Hana asked: "Before I send anything to Northwind, can you read the billing doc and tell me exactly what our first reply to a duplicate charge should say?" Please read the customer billing replies doc and summarise the guidance.',
    ),
    sourceSystem: 'docs',
    externalId: 'docs-billing-replies',
    contentRefs: ['docs-fixture/billing-replies'],
    requesterLabel: 'Hana',
  };
  const PIP_ACTION = {
    ...ACTION,
    title: 'Log the Northwind support ask on the ticket queue',
    contentSummary: 'Hana: "Please log the support ask."',
    contentRefs: ['docs-fixture/billing-replies'],
  };
  const PIP_BEYOND = { ...BEYOND, contentSummary: 'Hana filed: "Check the support CRM export."' };
  const PIP_OUT = PLAIN_OUT_OF_SCOPE;

  it('gives Hana’s docs ask her thread, so the answer goes back where she asks', async (): Promise<void> => {
    drafts.push([HANAS_DOCS_ASK, PIP_ACTION, PIP_BEYOND, PIP_OUT]);
    const items = await generateWorkItemsFromCharter(PIP_W19, PIPS_OFFICE as never);
    expect(items.find((item) => item.externalId === 'docs-billing-replies')?.contentRefs).toEqual([
      'docs-fixture/billing-replies',
      'channel://office-asks#thread-double-charge',
    ]);
  });

  it('gives no thread to an asker with no ask of the role’s, and keeps a thread the draft named', async (): Promise<void> => {
    const nells = { ...HANAS_DOCS_ASK, requesterLabel: 'Kofi' };
    const named = {
      ...HANAS_DOCS_ASK,
      externalId: 'docs-named',
      contentRefs: ['channel://office-asks#thread-double-charge'],
    };
    drafts.push([nells, PIP_ACTION, PIP_BEYOND, PIP_OUT]);
    const [first] = await generateWorkItemsFromCharter(PIP_W19, PIPS_OFFICE as never);
    expect(first?.contentRefs).toEqual(['docs-fixture/billing-replies']);
    drafts.push([named, PIP_ACTION, PIP_BEYOND, PIP_OUT]);
    const [second] = await generateWorkItemsFromCharter(PIP_W19, PIPS_OFFICE as never);
    expect(second?.contentRefs).toEqual(['channel://office-asks#thread-double-charge']);
  });

  it('reads the asker by the first word of a label such as "Hana (Support)" (the second pass)', async (): Promise<void> => {
    drafts.push([
      { ...HANAS_DOCS_ASK, requesterLabel: 'Hana (Support)' },
      PIP_ACTION,
      PIP_BEYOND,
      PIP_OUT,
    ]);
    const [first] = await generateWorkItemsFromCharter(PIP_W19, PIPS_OFFICE as never);
    expect(first?.contentRefs).toContain('channel://office-asks#thread-double-charge');
  });

  // The v0.20.0 hosted walk's finding 8: Lark's docs item for Aman (row `A-Lark-docs-full.txt`)
  // named #revops, where no message of Aman's is, and no thread; the plan said "in the thread
  // where Aman asked", and the run posted unthreaded with a note saying so to the manager alone.
  // The item's contentRefs are not on the row: rebuilt as the item's words name them.
  const AMANS_SUMMARY =
    'Aman asked in the team channel, "At quarter end, which sheet do we treat as the source of truth, and who signs off the revenue total?" The answer is in the team overview doc, which describes the close-week process and the Q-trackers. Please reply in the channel where the question was asked.';
  const AMANS_DOCS_ASK = {
    ...drafted(
      'read-and-answer',
      'Question in the team channel about where closed deals land',
      AMANS_SUMMARY,
    ),
    sourceSystem: 'docs',
    externalId: 'docs-team-overview',
    contentRefs: ['docs-fixture/team-overview', 'channel://revops'],
    requesterLabel: 'Aman',
  };
  const WITH_REVOPS = {
    ...PIPS_OFFICE,
    slackChannels: [
      ...PIPS_OFFICE.slackChannels,
      {
        slug: 'revops',
        displayName: '#revops',
        kind: 'channel',
        recentMessages: [{ sender: 'Sara', body: 'Noted, thanks.' }],
      },
    ],
  };

  it('a read item whose asker has no thread answers in the channel and says so', async (): Promise<void> => {
    drafts.push([AMANS_DOCS_ASK, PIP_ACTION, PIP_BEYOND, PIP_OUT]);
    const [first] = await generateWorkItemsFromCharter(PIP_W19, WITH_REVOPS as never);
    expect(first?.contentRefs).toEqual(['docs-fixture/team-overview', 'channel://revops']);
    expect(first?.contentSummary).toBe(
      `${AMANS_SUMMARY} No thread holds Aman's ask, so the answer is posted in #revops itself, not in a thread.`,
    );
  });

  it('says nothing of a thread for an asker who has one, or an item that names one', async (): Promise<void> => {
    const hanas = { ...AMANS_DOCS_ASK, requesterLabel: 'Hana' };
    const threaded = {
      ...AMANS_DOCS_ASK,
      contentRefs: ['docs-fixture/team-overview', 'channel://office-asks#thread-double-charge'],
    };
    for (const item of [hanas, threaded]) {
      drafts.push([item, PIP_ACTION, PIP_BEYOND, PIP_OUT]);
      const [first] = await generateWorkItemsFromCharter(PIP_W19, WITH_REVOPS as never);
      expect(first?.contentSummary).toBe(AMANS_SUMMARY);
    }
  });

  it('asks the generator to name the thread itself', (): void => {
    expect(WORK_GEN_SYSTEM).toContain(
      'When the question was asked in a thread the snapshot shows, its contentRefs name that thread too ("channel://<slug>#<thread>"), so the answer goes back where it was asked.',
    );
  });
});

describe("the generator's words for the charter's clauses (W15-R16)", (): void => {
  it('names the clauses in words, never by the charter’s field keys', (): void => {
    expect(WORK_GEN_SYSTEM).not.toMatch(/willDo|willNotDo/);
    expect(WORK_GEN_SYSTEM).toContain(
      'one its will-do clauses leave out or its will-not-do clauses exclude',
    );
  });
});
