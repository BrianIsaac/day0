import { skillShapeFor } from './skill-shape';

/**
 * The mock office's tickets for the work its charter generator drafts (the wave 11 review's M10).
 *
 * The generator is a model call told to use only the tickets the office holds, and nothing held
 * it to that: a ticket item drafted on a slug the office does not hold could never close, and the
 * visitor's first approved ticket run stopped on it. So the office opens a ticket of its own for
 * every drafted item from the ticket queue that names none it holds, in the office's key shape,
 * with the item's own words, and the item names that ticket first. An item on a held ticket is
 * left as drafted, and a reference to a ticket the office does not hold is dropped from any item,
 * since an action on it could only fail.
 */

/** The reference prefix a ticket in the mock office is named by (`ticket://REVOPS-201`). */
export const TICKET_REF_PREFIX = 'ticket://';

/** The key prefix the office numbers from when it holds no ticket in the `KEY-123` shape. */
export const FALLBACK_TICKET_PREFIX = 'TICKET';

/** The source category of an item that came from the ticket queue. */
const TICKET_QUEUE = 'ticket-queue';

/**
 * Where the mock office files a new employee's action item: a ticket on its ticket queue, so
 * every visitor's first queue has a ticket run (decision D2 (b), a product call, flagged).
 */
export const TICKET_QUEUE_FILING = {
  sourceCategory: TICKET_QUEUE,
  sourceSystem: 'ticket',
} as const;

/** A ticket key the office numbers: a prefix of letters and digits, a dash, a number. */
const NUMBERED_KEY = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;

/** What a drafted item carries that decides which ticket, if any, it works on. */
export interface TicketGroundingItem {
  readonly sourceCategory: string;
  readonly sourceSystem: string;
  readonly title: string;
  readonly contentSummary: string;
  readonly contentRefs: readonly string[];
  readonly priority?: string;
}

/** A ticket the office opens for a drafted item that named none it holds. */
export interface OpenedTicket {
  readonly slug: string;
  readonly title: string;
  readonly body: string;
  readonly priority?: string;
}

/** The drafted items as the office seeds them, and the tickets it opens for them. */
export interface GroundedTicketWork<T extends TicketGroundingItem> {
  readonly items: T[];
  readonly opened: OpenedTicket[];
}

/**
 * Whether an item is ticket work: it came from the ticket queue, or its source system is a ticket
 * system. Its run closes the loop on the ticket it came from, so that ticket has to exist.
 *
 * @param item - The drafted item.
 */
export function isTicketWork(item: TicketGroundingItem): boolean {
  return (
    item.sourceCategory === TICKET_QUEUE ||
    skillShapeFor(item, [], 'mock').surfaceClass === 'kanban'
  );
}

/**
 * Whether an item is filed as a ticket on the ticket queue, so its run works the ticket: it came
 * from the queue and its source system is a ticket system. An item from the queue on another
 * system (a Slack ask filed there) runs as that system's work, and no ticket closes.
 *
 * @param item - The drafted item.
 */
export function filedOnTicketQueue(
  item: Pick<TicketGroundingItem, 'sourceCategory' | 'sourceSystem' | 'title' | 'contentSummary'>,
): boolean {
  return (
    item.sourceCategory === TICKET_QUEUE &&
    skillShapeFor(item, [], 'mock').surfaceClass === 'kanban'
  );
}

/** The slug a `ticket://` reference names, or undefined for any other reference. */
function ticketSlugOf(ref: string): string | undefined {
  if (!ref.startsWith(TICKET_REF_PREFIX)) return undefined;
  return ref.slice(TICKET_REF_PREFIX.length).split(/[/?#]/, 1)[0] || undefined;
}

/**
 * The prefix the office numbers its tickets under: the one most of its keys carry, the first seen
 * on a tie, or `FALLBACK_TICKET_PREFIX` when no key is in the numbered shape.
 */
function officePrefix(slugs: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const slug of slugs) {
    const prefix = NUMBERED_KEY.exec(slug)?.[1];
    if (prefix !== undefined) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  let chosen: string | undefined;
  for (const [prefix, count] of counts) {
    if (chosen === undefined || count > (counts.get(chosen) ?? 0)) chosen = prefix;
  }
  return chosen ?? FALLBACK_TICKET_PREFIX;
}

/** The next key under `prefix` above every key the office has taken. */
function nextSlug(prefix: string, taken: ReadonlySet<string>): string {
  let highest = 0;
  for (const slug of taken) {
    const match = NUMBERED_KEY.exec(slug);
    if (match?.[1] === prefix) highest = Math.max(highest, Number(match[2]));
  }
  return `${prefix}-${highest + 1}`;
}

/**
 * Ground a drafted batch in the office's tickets.
 *
 * @param items - The items as the generator drafted them, in order.
 * @param heldSlugs - The slugs of the tickets the office holds for this employee.
 * @returns The items as they are seeded, in the same order, and the tickets to open first.
 */
export function groundTicketWork<T extends TicketGroundingItem>(
  items: readonly T[],
  heldSlugs: readonly string[],
): GroundedTicketWork<T> {
  const prefix = officePrefix(heldSlugs);
  const taken = new Set(heldSlugs);
  const held = new Set(heldSlugs);
  const opened: OpenedTicket[] = [];
  const grounded = items.map((item): T => {
    const kept = item.contentRefs.filter((ref) => {
      const slug = ticketSlugOf(ref);
      return slug === undefined || held.has(slug);
    });
    const origin = item.contentRefs.map(ticketSlugOf).find((slug) => slug !== undefined);
    if (!isTicketWork(item) || (origin !== undefined && held.has(origin))) {
      return { ...item, contentRefs: kept };
    }
    const slug = nextSlug(prefix, taken);
    taken.add(slug);
    opened.push({
      slug,
      title: item.title,
      body: item.contentSummary,
      ...(item.priority !== undefined ? { priority: item.priority } : {}),
    });
    return { ...item, contentRefs: [`${TICKET_REF_PREFIX}${slug}`, ...kept] };
  });
  return { items: grounded, opened };
}
