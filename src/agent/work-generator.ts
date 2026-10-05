import { z } from 'zod';
import { agentJson, makeAgent, MODEL_CALL_TIMEOUT_MS } from '../lib/mastra';
import { log } from '../lib/logger';
import type { Charter } from './charter';
import { filedOnTicketQueue, TICKET_QUEUE_FILING, TICKET_REF_PREFIX } from '../work/office-tickets';
import { charterWords, sharedCharterWords } from '../work/scope';
import type { MockSurfaceSnapshot } from '../work/types';

/**
 * Generate three day-one work items grounded in the boss's charter AND
 * the agent's actual mock environment.
 *
 * No hardcoded slugs in the prompt - we render the live surface
 * snapshot (slack channels, spreadsheets, docs, tweets) so the LLM picks
 * real identifiers that exist on the agent's workbench. Each generated
 * work item references concrete surface rows the executor can later
 * mutate. A ticket-queue item is a new ticket, which the office opens
 * from the item's own words when the batch is seeded.
 *
 * The 3-item mix drives the standard demo narrative:
 *   1. A docs-read item - handled by the builtin `see-internal-docs` skill
 *   2. An action item - triggers the propose-new-skill loop
 *   3. An out-of-scope item - evaluator skips it
 *
 * Mock mode judges scope on the item's own words (`sharedCharterWords`): one
 * word of the role or its willDo clauses places an item in the job. So an
 * out-of-scope item that shares one, typically a sentence comparing the
 * request with the role, would be judged the role's work and wait on a skill,
 * and a read or action item that shares none would be skipped. The generator
 * names the role's words up front, asks again for a draft that reads against
 * its purposes, and leaves out an out-of-scope item that still shares a word
 * after every draft.
 */

export const WORK_GEN_SYSTEM = [
  'You generate 3 day-one work items for a newly-deployed autonomous agent.',
  "The boss has just approved the agent's charter; three realistic inbox-style requests now land in the agent's queue - the kind of work a competent new hire would face on their first week.",
  '',
  "You will be given (a) the charter and (b) a snapshot of the agent's actual mock work environment with real slugs/IDs. Use ONLY surface identifiers that appear in the snapshot - never invent slugs the env doesn't have. Each work item's contentRefs must reference real rows the executor can later mutate.",
  '',
  'Generate exactly 3 items, in this order, with this purpose:',
  '',
  '1. Read-and-answer item - sourceSystem MUST be "docs". A question the agent answers by reading internal team docs (the agent has a builtin "see-internal-docs" skill). Pick a topic that fits the role described in the charter and a doc slug that actually exists in the snapshot.',
  '',
  '2. Action item - a new ticket filed for this role on the ticket queue: sourceCategory MUST be "ticket-queue" and sourceSystem MUST be "ticket". The task requires the role\'s write action on that ticket (work it, comment on it and close it). This will trigger the propose-new-skill flow.',
  '',
  'An item from the ticket queue is a new ticket filed for this role: write it from the charter\'s willDo as its sender filed it, give it no "ticket://" reference, and the office opens the ticket with the item\'s title and summary. The snapshot lists no tickets for this reason.',
  '',
  '3. Out-of-scope item - sourceSystem can be anything. A task that is plausibly forwarded by a colleague but lies outside the role described in the charter: one its willDo leaves out or its willNotDo excludes, without assuming a particular team or profession, and the item itself never says so. May or may not reference an existing surface.',
  '',
  'Discipline:',
  '  - Each contentSummary is 2-3 sentences and includes a direct quoted request from a named person (the named collaborators in the charter, or "Manager" for the boss).',
  '  - contentRefs must use slugs/IDs that appear verbatim in the snapshot. Format: "channel://<slug>", "channel://<slug>#thread-<key>", "twitter://<slug>", "mock-spreadsheet://<slug>", "docs-fixture/<slug>". If the surface doesn\'t exist in the snapshot, do not invent a contentRef for it.',
  '  - externalIds are unique stable strings derived from the surface and topic (e.g. "docs-<slug>", "sheet-<slug>", "tweet-<slug>", "ticket-<slug>").',
  '  - Vary priorities: ideally one P1, one P2, one low.',
  "  - requesterLabel is a person's name or role; never the agent itself.",
  '  - The title and contentSummary are the request as its sender wrote it, and the manager reads them on the work card: never say how the request should be handled (no "skip this", "route this back", "out of scope") and never mention the agent, the evaluator or Day0.',
  '  - Titles are 8-14 words.',
  '  - sourceCategory is one of "ticket-queue", "inbox", or "social-mention".',
  '  - purpose is "read-and-answer", "action" or "out-of-scope": which of the three items above it is.',
].join('\n');

/** What each of the three drafted items is for, in the order the prompt lists them. */
export const WORK_ITEM_PURPOSES = ['read-and-answer', 'action', 'out-of-scope'] as const;

/** How many drafts the generator asks for before it leaves out an out-of-scope item that reads as the role's work. */
export const GENERATION_ATTEMPTS = 3;

/**
 * The most one seeding's generation may take, every draft together (12-J item 6, option A): under
 * the ten minutes Convex gives an action, with room for the seeding's own reads and writes, so a
 * slow model ends in the seeding's record and its next attempt rather than in a kill that records
 * nothing. Three drafts at a call's own limit would take a quarter of an hour.
 */
export const GENERATION_BUDGET_MS = 480_000;

export const workGenSchema = z.object({
  items: z
    .array(
      z.object({
        purpose: z.enum(WORK_ITEM_PURPOSES),
        sourceCategory: z.string(),
        sourceSystem: z.string(),
        externalId: z.string(),
        title: z.string(),
        contentSummary: z.string(),
        contentRefs: z.array(z.string()),
        priority: z.string(),
        requesterLabel: z.string(),
      }),
    )
    .min(3)
    .max(3),
});

/** One drafted item as the model returns it, its purpose included. */
type DraftedWorkItem = z.infer<typeof workGenSchema>['items'][number];

/** One generated work item as the office seeds it; its purpose stays with the generator. */
export type GeneratedWorkItem = Omit<DraftedWorkItem, 'purpose'>;

const workGeneratorAgent = makeAgent('day0-work-generator', WORK_GEN_SYSTEM);

/**
 * Render the mock environment snapshot as a compact, slug-forward
 * description the LLM can copy identifiers out of without hallucinating.
 */
function renderMockSnapshot(env: MockSurfaceSnapshot): string {
  const lines: string[] = [];
  if (env.slackChannels.length) {
    lines.push('Slack channels and DMs:');
    for (const c of env.slackChannels) {
      lines.push(`  - slug "${c.slug}" (${c.kind}, displayed as "${c.displayName}")`);
    }
  }
  if (env.spreadsheets.length) {
    lines.push('Spreadsheets:');
    for (const s of env.spreadsheets) {
      const tabs = s.tabs.map((t) => t.name).join(', ');
      lines.push(`  - slug "${s.slug}" titled "${s.title}" with tabs: ${tabs}`);
    }
  }
  if (env.teamDocs.length) {
    lines.push('Team docs (read-only):');
    for (const d of env.teamDocs) {
      lines.push(`  - slug "${d.slug}" titled "${d.title}"`);
    }
  }
  if (env.tweets.length) {
    lines.push('Tweets the agent could reply to:');
    for (const t of env.tweets) {
      lines.push(`  - slug "${t.slug}" by ${t.handle} (${t.author}): "${t.body.slice(0, 140)}"`);
    }
  }
  // The office's seeded tickets are left out: they are another role's work, and a generator that
  // saw them copied one into every role's queue (a finance close-out employee drew "Add Friday
  // standup closed-won deals", declined it, and the run stopped). A ticket-queue item is the
  // role's own new ticket, which the office opens from the item (`openTicketsForDraftedWork`).
  return lines.join('\n');
}

/** An out-of-scope item that reads as the role's work, with the words that make it so. */
interface RoleReading {
  readonly item: DraftedWorkItem;
  readonly words: readonly string[];
}

/**
 * How a draft reads against the scope rule mock mode judges by (`sharedCharterWords`): the
 * out-of-scope items that share a word with the role, which would be judged its work, and the
 * read-and-answer and action items that share none, which would be skipped.
 */
interface DraftReading {
  readonly asTheRole: readonly RoleReading[];
  readonly untied: readonly DraftedWorkItem[];
  /** Whether the action item is somewhere other than a ticket on the ticket queue (D2). */
  readonly actionOffTheQueue: boolean;
}

function readDraft(items: readonly DraftedWorkItem[], charter: Charter): DraftReading {
  return {
    asTheRole: items
      .filter((item) => item.purpose === 'out-of-scope')
      .map((item) => ({ item, words: sharedCharterWords(item, charter) }))
      .filter((reading) => reading.words.length > 0),
    untied: items.filter(
      (item) => item.purpose !== 'out-of-scope' && sharedCharterWords(item, charter).length === 0,
    ),
    actionOffTheQueue: items.some((item) => item.purpose === 'action' && !filedOnTicketQueue(item)),
  };
}

/** Whether a draft reads against the scope rule as its purposes say, its action on the queue. */
function readsAsIntended(reading: DraftReading): boolean {
  return (
    reading.asTheRole.length === 0 && reading.untied.length === 0 && !reading.actionOffTheQueue
  );
}

/** What the next draft is told about the last one's items that read against their purpose. */
function askAgain(reading: DraftReading): string {
  const lines: string[] = [];
  if (reading.asTheRole.length > 0) {
    const words = [...new Set(reading.asTheRole.flatMap((one) => one.words))].join(', ');
    lines.push(
      `The out-of-scope item in your last draft shares these words with the charter's role and duties, so it reads as this role's work: ${words}.`,
    );
  }
  for (const item of reading.untied) {
    lines.push(
      `The ${item.purpose} item in your last draft shares no word with the role and its duties, so it reads as another role's work: word it in the charter's own terms.`,
    );
  }
  if (reading.actionOffTheQueue) {
    lines.push(
      `The action item in your last draft is not a ticket on the ticket queue: file it there, with sourceCategory "${TICKET_QUEUE_FILING.sourceCategory}" and sourceSystem "${TICKET_QUEUE_FILING.sourceSystem}".`,
    );
  }
  lines.push(
    "Draft all three items again. The out-of-scope request uses none of the role's words and never compares itself with the role: it is only the request as its sender wrote it.",
  );
  return lines.join(' ');
}

function withoutPurpose(item: DraftedWorkItem): GeneratedWorkItem {
  return {
    sourceCategory: item.sourceCategory,
    sourceSystem: item.sourceSystem,
    externalId: item.externalId,
    title: item.title,
    contentSummary: item.contentSummary,
    contentRefs: item.contentRefs,
    priority: item.priority,
    requesterLabel: item.requesterLabel,
  };
}

/**
 * Draft the three day-one work items for an approved charter, from the office the employee works
 * in. An out-of-scope item that shares a word with the role, or an action item that is not a
 * ticket on the ticket queue, is drafted again, up to `GENERATION_ATTEMPTS` drafts; the last
 * draft's out-of-scope item is left out if it still reads as the role, and its action item filed
 * on the queue (D2 (b)).
 *
 * @param charter - The approved charter; its struck clauses are never work.
 * @param mockEnv - The employee's office, whose identifiers the items name.
 * @returns The items to seed, without their purpose.
 */
export async function generateWorkItemsFromCharter(
  charter: Charter,
  mockEnv: MockSurfaceSnapshot,
): Promise<GeneratedWorkItem[]> {
  const brief = [
    'Charter:',
    // The clauses a strike took out are the record's, never work to generate from.
    JSON.stringify({ ...charter, struckClauses: undefined }, null, 2),
    '',
    'Live mock environment snapshot (use these EXACT slugs in contentRefs):',
    renderMockSnapshot(mockEnv),
    '',
    // Named up front: an item that shares one is judged the role's work, and a re-ask that names
    // only the last draft's words let the next draft reach for another (the bed walk). The in-scope
    // items are told the same words, since an action ticket that shares none is skipped and the
    // visitor's queue has no ticket run (D2, the pre-tag's bed walk).
    `The out-of-scope item uses none of these words from the role and its duties: ${charterWords(charter).join(', ')}.`,
    `The read-and-answer item and the action item each use at least one of these words from the role and its duties, as the sender would: ${charterWords(charter).join(', ')}.`,
    '',
    'Generate the 3 day-one work items now.',
  ].join('\n');
  const deadline = Date.now() + GENERATION_BUDGET_MS;
  const ask = async (user: string): Promise<z.infer<typeof workGenSchema>> =>
    await agentJson<z.infer<typeof workGenSchema>>({
      agent: workGeneratorAgent,
      user,
      schema: workGenSchema,
      timeoutMs: Math.min(MODEL_CALL_TIMEOUT_MS, deadline - Date.now()),
    });
  let draft = await ask(brief);
  for (let attempt = 1; attempt < GENERATION_ATTEMPTS; attempt += 1) {
    const reading = readDraft(draft.items, charter);
    if (readsAsIntended(reading)) return draft.items.map(withoutPurpose);
    const again = await askedAgain(() => ask(`${brief}\n\n${askAgain(reading)}`), attempt);
    if (again === undefined) break;
    draft = again;
  }
  // The last draft is taken as it reads, but for an out-of-scope item that still reads as the
  // role's work, which is left out rather than queued as the role's work with a skill to approve.
  // An in-scope item is never left out: the queue keeps its read and its action.
  const reading = readDraft(draft.items, charter);
  if (reading.asTheRole.length > 0) {
    log.warn('mock work generator left out an out-of-scope item that reads as the role', {
      attempts: GENERATION_ATTEMPTS,
      words: reading.asTheRole.flatMap((one) => one.words),
    });
  }
  if (reading.actionOffTheQueue) {
    log.warn('mock work generator filed an action item on the ticket queue itself', {
      attempts: GENERATION_ATTEMPTS,
    });
  }
  const leftOut = new Set(reading.asTheRole.map((one) => one.item));
  return draft.items
    .filter((item) => !leftOut.has(item))
    .map(onTheTicketQueue)
    .map(withoutPurpose);
}

/**
 * A draft asked for again, or undefined when the budget ran out first: the draft in hand is then
 * taken as the last draft is. Any other failure is the seeding's.
 */
async function askedAgain<T>(ask: () => Promise<T>, attempt: number): Promise<T | undefined> {
  try {
    return await ask();
  } catch (err: unknown) {
    if (!(err instanceof Error) || err.name !== 'TimeoutError') throw err;
    log.warn('mock work generator kept the draft in hand when the budget ran out', {
      attempt: attempt + 1,
    });
    return undefined;
  }
}

/**
 * The action item filed as a ticket on the ticket queue, its words kept, where the last draft put
 * it elsewhere: the office opens the ticket from them, so the visitor's first queue has a ticket
 * run (D2 (b)). Every other item is returned as drafted.
 */
function onTheTicketQueue(item: DraftedWorkItem): DraftedWorkItem {
  return item.purpose === 'action' && !filedOnTicketQueue(item)
    ? {
        ...item,
        ...TICKET_QUEUE_FILING,
        // A reference to where it was drafted (a channel, a sheet) is not the ticket's to act on.
        contentRefs: item.contentRefs.filter((ref) => ref.startsWith(TICKET_REF_PREFIX)),
      }
    : item;
}
