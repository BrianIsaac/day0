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
import {
  GENERATION_ATTEMPTS,
  WORK_GEN_SYSTEM,
  generateWorkItemsFromCharter,
} from '../../../src/agent/work-generator';

afterEach((): void => {
  prompts.length = 0;
  drafts.length = 0;
});

const OFFICE = {
  howToGuides: [],
  teamDocs: [],
  spreadsheets: [],
  slackChannels: [],
  tweets: [],
  tickets: [],
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
  purpose: 'read-and-answer' | 'action' | 'out-of-scope',
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
const ACTION = drafted(
  'action',
  'Close out the routine tickets this week',
  'Priya: "Please close them."',
);
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
    drafts.push([READ, ACTION, SAYS_OUT_OF_SCOPE], [READ, ACTION, PLAIN_OUT_OF_SCOPE]);
    const items = await generateWorkItemsFromCharter(HYGIENE, OFFICE as never);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('pipeline, hygiene');
    expect(items.map((item) => item.contentSummary)).toContain(
      'Aman forwarded: "Marketing wants a fresh homepage by Friday."',
    );
  });

  it('leaves the out-of-scope item out when every draft still reads as the role’s work', async (): Promise<void> => {
    for (let attempt = 0; attempt < GENERATION_ATTEMPTS; attempt += 1) {
      drafts.push([READ, ACTION, SAYS_OUT_OF_SCOPE]);
    }
    const items = await generateWorkItemsFromCharter(HYGIENE, OFFICE as never);
    expect(prompts).toHaveLength(GENERATION_ATTEMPTS);
    expect(items.map((item) => item.title)).toEqual([
      "Where is the team's onboarding guide kept?",
      'Close out the routine tickets this week',
    ]);
  });

  it('takes a first draft whose out-of-scope item shares no word with the role, and returns no purpose', async (): Promise<void> => {
    drafts.push([READ, ACTION, PLAIN_OUT_OF_SCOPE]);
    const items = await generateWorkItemsFromCharter(HYGIENE, OFFICE as never);
    expect(prompts).toHaveLength(1);
    expect(items).toHaveLength(3);
    expect(items[2]).not.toHaveProperty('purpose');
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
    drafts.push([UNTIED_READ, ACTION, PLAIN_OUT_OF_SCOPE], [READ, ACTION, PLAIN_OUT_OF_SCOPE]);
    const items = await generateWorkItemsFromCharter(HYGIENE, OFFICE as never);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(
      'The read-and-answer item in your last draft shares no word with the role and its duties',
    );
    expect(items.map((item) => item.title)).toContain("Where is the team's onboarding guide kept?");
  });

  it('keeps an in-scope item that still shares no word after every draft, never leaving it out', async (): Promise<void> => {
    for (let attempt = 0; attempt < GENERATION_ATTEMPTS; attempt += 1) {
      drafts.push([UNTIED_READ, ACTION, PLAIN_OUT_OF_SCOPE]);
    }
    const items = await generateWorkItemsFromCharter(HYGIENE, OFFICE as never);
    expect(items).toHaveLength(3);
  });

  it('no longer asks the model to make the mismatch of the out-of-scope item clear', (): void => {
    expect(WORK_GEN_SYSTEM).not.toMatch(/make the mismatch clear/i);
    expect(WORK_GEN_SYSTEM).toContain('the item itself never says so');
  });
});
