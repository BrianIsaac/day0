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
});
