import { z } from 'zod';
import { agentJson, makeAgent, MODEL_CALL_TIMEOUT_MS } from '../lib/mastra';
import { log } from '../lib/logger';
import { PLAIN_PUNCTUATION_IN_EVERY_FIELD } from './drafted-text-rules';
import type { Charter } from './charter';
import { filedOnTicketQueue, TICKET_QUEUE_FILING, TICKET_REF_PREFIX } from '../work/office-tickets';
import { charterWords, sharedCharterWords } from '../work/scope';
import type { MockSurfaceSnapshot } from '../work/types';

/**
 * Generate four day-one work items grounded in the boss's charter AND
 * the agent's actual mock environment.
 *
 * No hardcoded slugs in the prompt - we render the live surface
 * snapshot (slack channels, spreadsheets, docs, tweets) so the LLM picks
 * real identifiers that exist on the agent's workbench. Each generated
 * work item references concrete surface rows the executor can later
 * mutate. A ticket-queue item is a new ticket, which the office opens
 * from the item's own words when the batch is seeded.
 *
 * The 4-item mix drives the standard demo narrative:
 *   1. A docs-read item - handled by the builtin `see-internal-docs` skill
 *   2. An action ticket the office can back - triggers the propose-new-skill loop
 *   3. A ticket whose ask reaches beyond the office
 *   4. An out-of-scope item - evaluator skips it
 *
 * The two tickets are the hosted demo's two honest ends (13-FD). On the v0.16.0 redeploy every
 * first ticket asked for what the office does not hold (a CRM, finance's posted charges, an
 * invoice), so 5 of 5 runs answered partly done and a visitor never saw a ticket closed. The
 * generator then saw only the office's slugs and tab names; it now sees what the office holds
 * (rows, messages, team documents) and drafts one ticket whose every ask those records let the
 * role finish in one run, which names them in its references, and one whose ask needs a record
 * or system the office does not hold, as tickets in any office do. Nothing is scripted: the run
 * reads the same office through the same tools and answers in its own words.
 *
 * Mock mode judges scope on the item's own words (`sharedCharterWords`): one
 * word of the role or its willDo clauses places an item in the job. So an
 * out-of-scope item that shares one, typically a sentence comparing the
 * request with the role, would be judged the role's work and wait on a skill,
 * and a read or ticket item that shares none would be skipped. The generator
 * names the role's words up front, asks again for a draft that reads against
 * its purposes, and leaves out an out-of-scope item that still shares a word
 * after every draft.
 */

export const WORK_GEN_SYSTEM = [
  'You generate 4 day-one work items for a newly-deployed autonomous agent.',
  "The boss has just approved the agent's charter; four realistic inbox-style requests now land in the agent's queue - the kind of work a competent new hire would face on their first week.",
  '',
  "You will be given (a) the charter and (b) a snapshot of the agent's actual mock work environment with real slugs/IDs and what each record holds. Use ONLY surface identifiers that appear in the snapshot - never invent slugs the env doesn't have. Each work item's contentRefs must reference real rows the executor can later mutate.",
  '',
  'Generate exactly 4 items, in this order, with this purpose:',
  '',
  '1. Read-and-answer item - sourceSystem MUST be "docs". A question the agent answers by reading internal team docs (the agent has a builtin "see-internal-docs" skill). Pick a topic that fits the role described in the charter and a doc slug that actually exists in the snapshot.',
  '',
  '2. Action item - a new ticket filed for this role on the ticket queue: sourceCategory MUST be "ticket-queue" and sourceSystem MUST be "ticket". The task requires the role\'s write action on that ticket (work it, comment on it and close it). This will trigger the propose-new-skill flow.',
  'Every ask of the action ticket is one the office lets the role finish in this one run: each fact it needs is in the snapshot, named as the snapshot names it (a row, a message or a document), and its contentRefs name those records; the work is a write in the office (a row appended to a tab, a message posted, a comment on the ticket), and the ticket closes once that is written. It never asks for a record, figure, reply or system the snapshot does not show, for anything done outside the office (buying, repairing, calling, meeting), or a draft to review before it closes: the manager approves every write before it lands.',
  '',
  '3. Beyond-the-office item - a second new ticket filed for this role on the ticket queue: sourceCategory MUST be "ticket-queue" and sourceSystem MUST be "ticket", as a colleague would file it. Its ask needs one record or system the snapshot does not show (one the charter or the team docs name), as such tickets arrive in any office; the ticket never says the office lacks anything.',
  '',
  'An item from the ticket queue is a new ticket filed for this role: write it from the charter\'s willDo as its sender filed it, give it no "ticket://" reference, and the office opens the ticket with the item\'s title and summary. The snapshot lists no tickets for this reason.',
  '',
  '4. Out-of-scope item - sourceSystem can be anything. A task that is plausibly forwarded by a colleague but lies outside the role described in the charter: one its willDo leaves out or its willNotDo excludes, without assuming a particular team or profession, and the item itself never says so. May or may not reference an existing surface.',
  '',
  'Discipline:',
  '  - Each contentSummary is 2-3 sentences and includes a direct quoted request from a named person (the named collaborators in the charter, or "Manager" for the boss).',
  '  - contentRefs must use slugs/IDs that appear verbatim in the snapshot. Format: "channel://<slug>", "channel://<slug>#thread-<key>", "twitter://<slug>", "mock-spreadsheet://<slug>", "docs-fixture/<slug>". If the surface doesn\'t exist in the snapshot, do not invent a contentRef for it.',
  '  - externalIds are unique stable strings derived from the surface and topic (e.g. "docs-<slug>", "sheet-<slug>", "tweet-<slug>", "ticket-<slug>"); the two tickets never share one.',
  '  - Vary priorities: ideally one P1, one P2, one low.',
  "  - requesterLabel is a person's name or role; never the agent itself.",
  '  - The title and contentSummary are the request as its sender wrote it, and the manager reads them on the work card: never say how the request should be handled (no "skip this", "route this back", "out of scope") and never mention the agent, the evaluator or Day0.',
  '  - Titles are 8-14 words.',
  // The quoted requests carried an em dash on the hosted office (the v0.16.0 redeploy, finding 5).
  `  - ${PLAIN_PUNCTUATION_IN_EVERY_FIELD}`,
  '  - sourceCategory is one of "ticket-queue", "inbox", or "social-mention".',
  '  - purpose is "read-and-answer", "action", "beyond-the-office" or "out-of-scope": which of the four items above it is.',
].join('\n');

/** What each of the four drafted items is for, in the order the prompt lists them. */
export const WORK_ITEM_PURPOSES = [
  'read-and-answer',
  'action',
  'beyond-the-office',
  'out-of-scope',
] as const;

/** One of {@link WORK_ITEM_PURPOSES}. */
type WorkItemPurpose = (typeof WORK_ITEM_PURPOSES)[number];

/** The purposes the office files on its ticket queue: the ticket it can back and the one it cannot. */
const TICKET_PURPOSES: ReadonlySet<WorkItemPurpose> = new Set(['action', 'beyond-the-office']);

/** The most rows of one tab, and messages of one channel, the generator is shown: the latest. */
const ROWS_SHOWN = 10;
const MESSAGES_SHOWN = 6;

/**
 * The most team documents whose words the generator is shown, and the most lines of each: the
 * seeded office's seven fit whole (the longest is 22 lines), and a large mirrored documentation
 * source cannot swell the prompt past what the model takes (the 13-FD second pass). A document
 * past the first twelve is listed by its slug and title.
 */
const TEAM_DOCS_SHOWN = 12;
const TEAM_DOC_LINES_SHOWN = 40;

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
    .min(4)
    .max(4),
});

/** One drafted item as the model returns it, its purpose included. */
type DraftedWorkItem = z.infer<typeof workGenSchema>['items'][number];

/** One generated work item as the office seeds it; its purpose stays with the generator. */
export type GeneratedWorkItem = Omit<DraftedWorkItem, 'purpose'>;

const workGeneratorAgent = makeAgent('day0-work-generator', WORK_GEN_SYSTEM);

/** A text as one indented line under its record: newlines folded, quotes kept as written. */
function shown(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Render the mock environment snapshot as a compact, slug-forward
 * description the LLM can copy identifiers out of without hallucinating, with
 * what each record holds (13-FD): a tab's latest rows, a channel's latest
 * messages and each team document, so a ticket asks only for what is there.
 */
function renderMockSnapshot(env: MockSurfaceSnapshot): string {
  const lines: string[] = [];
  if (env.slackChannels.length) {
    lines.push('Slack channels and DMs:');
    for (const c of env.slackChannels) {
      lines.push(`  - slug "${c.slug}" (${c.kind}, displayed as "${c.displayName}")`);
      const messages = c.recentMessages.slice(-MESSAGES_SHOWN);
      if (messages.length === 0) lines.push('      (no messages)');
      for (const m of messages) {
        const thread = m.threadKey ? ` [thread ${m.threadKey}]` : '';
        lines.push(`      ${m.sender}${thread}: "${shown(m.body)}"`);
      }
    }
  }
  if (env.spreadsheets.length) {
    lines.push('Spreadsheets:');
    for (const s of env.spreadsheets) {
      const tabs = s.tabs.map((t) => t.name).join(', ');
      lines.push(`  - slug "${s.slug}" titled "${s.title}" with tabs: ${tabs}`);
      for (const tab of s.tabs) {
        lines.push(`      tab "${tab.name}" (${tab.headers.join(' | ')}):`);
        const rows = s.rows.filter((row) => row.tabName === tab.name).slice(-ROWS_SHOWN);
        if (rows.length === 0) lines.push('        (no rows)');
        for (const row of rows) {
          lines.push(`        ${tab.headers.map((header) => row.cells[header] ?? '').join(' | ')}`);
        }
      }
    }
  }
  if (env.teamDocs.length) {
    lines.push('Team docs (read-only):');
    env.teamDocs.forEach((d, index) => {
      if (index >= TEAM_DOCS_SHOWN) {
        lines.push(`  - slug "${d.slug}" titled "${d.title}"`);
        return;
      }
      lines.push(`  - slug "${d.slug}" titled "${d.title}":`);
      const words = d.body.split('\n').filter((line) => line.trim() !== '');
      for (const line of words.slice(0, TEAM_DOC_LINES_SHOWN)) lines.push(`      ${line.trim()}`);
    });
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

/** The references a drafted item may name that point at a record the office holds, by prefix. */
const RECORD_PREFIXES = ['mock-spreadsheet://', 'channel://', 'docs-fixture/', 'twitter://'];

/**
 * Every reference to a record the snapshot shows the generator, as a drafted item writes it
 * without a thread or a fragment: `mock-spreadsheet://<slug>`, `channel://<slug>`,
 * `docs-fixture/<slug>`, `twitter://<slug>`. The how-to guides are not among them: the snapshot
 * never shows them, and a ticket that names only one names nothing it asks for (the 13-FD second
 * pass). Naming a record is the floor of a ticket the office can back, not proof of it.
 */
function officeRecords(env: MockSurfaceSnapshot): ReadonlySet<string> {
  return new Set([
    ...env.spreadsheets.map((s) => `mock-spreadsheet://${s.slug}`),
    ...env.slackChannels.map((c) => `channel://${c.slug}`),
    ...env.teamDocs.map((d) => `docs-fixture/${d.slug}`),
    ...env.tweets.map((tw) => `twitter://${tw.slug}`),
  ]);
}

/** Whether a drafted item names at least one record the office holds. */
function namesAnOfficeRecord(item: DraftedWorkItem, records: ReadonlySet<string>): boolean {
  return item.contentRefs.some(
    (ref) =>
      RECORD_PREFIXES.some((prefix) => ref.startsWith(prefix)) &&
      records.has(ref.split(/[#?]/, 1)[0] ?? ref),
  );
}

/** An out-of-scope item that reads as the role's work, with the words that make it so. */
interface RoleReading {
  readonly item: DraftedWorkItem;
  readonly words: readonly string[];
}

/**
 * How a draft reads against the scope rule mock mode judges by (`sharedCharterWords`) and against
 * the office: the out-of-scope items that share a word with the role, which would be judged its
 * work; the in-scope items that share none, which would be skipped; the purposes it left out; the
 * tickets it filed somewhere other than the queue; and whether its action ticket names no record
 * the office holds.
 */
interface DraftReading {
  readonly asTheRole: readonly RoleReading[];
  readonly untied: readonly DraftedWorkItem[];
  readonly missing: readonly WorkItemPurpose[];
  /** The ticket items filed somewhere other than a ticket on the ticket queue (D2). */
  readonly offTheQueue: readonly DraftedWorkItem[];
  /** Whether the action ticket names no record of an office that holds some (13-FD). */
  readonly actionUngrounded: boolean;
}

function readDraft(
  items: readonly DraftedWorkItem[],
  charter: Charter,
  records: ReadonlySet<string>,
): DraftReading {
  return {
    asTheRole: items
      .filter((item) => item.purpose === 'out-of-scope')
      .map((item) => ({ item, words: sharedCharterWords(item, charter) }))
      .filter((reading) => reading.words.length > 0),
    untied: items.filter(
      (item) => item.purpose !== 'out-of-scope' && sharedCharterWords(item, charter).length === 0,
    ),
    missing: WORK_ITEM_PURPOSES.filter(
      (purpose) => !items.some((item) => item.purpose === purpose),
    ),
    offTheQueue: items.filter(
      (item) => TICKET_PURPOSES.has(item.purpose) && !filedOnTicketQueue(item),
    ),
    // An office that holds no record at all leaves nothing to name, so nothing is asked again.
    actionUngrounded:
      records.size > 0 &&
      items.some((item) => item.purpose === 'action' && !namesAnOfficeRecord(item, records)),
  };
}

/** Whether a draft reads against the scope rule as its purposes say, both tickets on the queue. */
function readsAsIntended(reading: DraftReading): boolean {
  return (
    reading.asTheRole.length === 0 &&
    reading.untied.length === 0 &&
    reading.missing.length === 0 &&
    reading.offTheQueue.length === 0 &&
    !reading.actionUngrounded
  );
}

/** What the next draft is told about the last one's items that read against their purpose. */
function askAgain(reading: DraftReading): string {
  const lines: string[] = [];
  for (const purpose of reading.missing) {
    lines.push(`Your last draft has no ${purpose} item: draft all four, one of each purpose.`);
  }
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
  for (const item of reading.offTheQueue) {
    lines.push(
      `The ${item.purpose} item in your last draft is not a ticket on the ticket queue: file it there, with sourceCategory "${TICKET_QUEUE_FILING.sourceCategory}" and sourceSystem "${TICKET_QUEUE_FILING.sourceSystem}".`,
    );
  }
  if (reading.actionUngrounded) {
    lines.push(
      "The action item in your last draft names no record the snapshot holds: ask only for work the snapshot's rows, messages or documents let the role finish, and name those records in its contentRefs.",
    );
  }
  lines.push(
    "Draft all four items again. The out-of-scope request uses none of the role's words and never compares itself with the role: it is only the request as its sender wrote it.",
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
 * Draft the four day-one work items for an approved charter, from the office the employee works
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
    'The beyond-the-office item uses at least one of them too.',
    '',
    'Generate the 4 day-one work items now.',
  ].join('\n');
  const records = officeRecords(mockEnv);
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
    const reading = readDraft(draft.items, charter, records);
    if (readsAsIntended(reading)) return seeded(draft.items);
    const again = await askedAgain(() => ask(`${brief}\n\n${askAgain(reading)}`), attempt);
    if (again === undefined) break;
    draft = again;
  }
  // The last draft is taken as it reads, but for an out-of-scope item that still reads as the
  // role's work, which is left out rather than queued as the role's work with a skill to approve.
  // An in-scope item is never left out: the queue keeps its read and its tickets, an action ticket
  // that names no record of the office included (its run then says what it could not do).
  const reading = readDraft(draft.items, charter, records);
  if (reading.asTheRole.length > 0) {
    log.warn('mock work generator left out an out-of-scope item that reads as the role', {
      attempts: GENERATION_ATTEMPTS,
      words: reading.asTheRole.flatMap((one) => one.words),
    });
  }
  if (reading.offTheQueue.length > 0) {
    log.warn('mock work generator filed a ticket item on the ticket queue itself', {
      attempts: GENERATION_ATTEMPTS,
      purposes: reading.offTheQueue.map((item) => item.purpose),
    });
  }
  if (reading.actionUngrounded) {
    log.warn('mock work generator kept an action ticket that names no record of the office', {
      attempts: GENERATION_ATTEMPTS,
    });
  }
  if (reading.missing.length > 0) {
    log.warn('mock work generator seeded a draft without every purpose', {
      attempts: GENERATION_ATTEMPTS,
      missing: reading.missing,
    });
  }
  const leftOut = new Set(reading.asTheRole.map((one) => one.item));
  return seeded(draft.items.filter((item) => !leftOut.has(item)).map(onTheTicketQueue));
}

/**
 * The drafted items as the office seeds them: without their purpose, and with every external id
 * its own. The seed merges two items of one source under one external id into one row, so a second
 * ticket that repeats the first's id is given the next free one (`<id>-2`, then `-3`).
 */
function seeded(items: readonly DraftedWorkItem[]): GeneratedWorkItem[] {
  const taken = new Set<string>();
  return items.map((item): GeneratedWorkItem => {
    let externalId = item.externalId;
    for (let next = 2; taken.has(`${item.sourceSystem}:${externalId}`); next += 1) {
      externalId = `${item.externalId}-${next}`;
    }
    taken.add(`${item.sourceSystem}:${externalId}`);
    return withoutPurpose({ ...item, externalId });
  });
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
 * A ticket item filed as a ticket on the ticket queue, its words kept, where the last draft put
 * it elsewhere: the office opens the ticket from them, so the visitor's first queue has its ticket
 * runs (D2 (b)). Every other item is returned as drafted.
 */
function onTheTicketQueue(item: DraftedWorkItem): DraftedWorkItem {
  return TICKET_PURPOSES.has(item.purpose) && !filedOnTicketQueue(item)
    ? {
        ...item,
        ...TICKET_QUEUE_FILING,
        // A reference to where it was drafted (a channel, a sheet) is not the ticket's to act on.
        contentRefs: item.contentRefs.filter((ref) => ref.startsWith(TICKET_REF_PREFIX)),
      }
    : item;
}
