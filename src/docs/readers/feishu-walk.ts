/**
 * Where a Feishu listing walk stands between two batches, carried in the run's cursor.
 *
 * Feishu lists a wiki one parent at a time and a Drive folder one folder at a
 * time, so listing the whole source again for every batch of 25 pages asks
 * for each listing page once a batch: a space of a few hundred parents costs
 * minutes of requests a batch at 100 a minute (second pass, 8 October 2026).
 * The walk is carried instead: the parents still to list, the page of the
 * current one to read next, how many of its items an earlier batch took, and
 * the counts that bound the source. It is the reader's own cursor, as a
 * provider's is (`isListingCursor` is false for it), so a run resumed after
 * an interruption reads the source from the first page again; within a run,
 * a node added to a parent already listed is read at the next sync.
 */
import { ListingChangedError } from './batch';

/** The walk's place: what is left to list and how much has been. */
export interface FeishuWalk {
  /** The parents (or folders) still to list, the current one first; null is the space's top level. */
  readonly queue: readonly (string | null)[];
  /** The current parent's listing page to read next; null for its first. */
  readonly pageToken: string | null;
  /** How many items of that page an earlier batch already took. */
  readonly skip: number;
  /** How many nodes and folders the walk has listed. */
  readonly listed: number;
  /** How many listing requests the walk has made. */
  readonly requests: number;
}

/** The prefix that marks a walk cursor, so a cursor any other reader wrote is told apart. */
const WALK_PREFIX = 'feishu-walk:';

/**
 * The walk at its start.
 *
 * @param root - The first parent: null for a wiki space's top level, the folder token for a folder.
 */
export function firstWalk(root: string | null): FeishuWalk {
  return { queue: [root], pageToken: null, skip: 0, listed: 0, requests: 0 };
}

/**
 * The cursor that carries a walk to the next batch.
 *
 * @param walk - Where the walk stands.
 */
export function walkCursor(walk: FeishuWalk): string {
  return `${WALK_PREFIX}${Buffer.from(JSON.stringify(walk), 'utf8').toString('base64url')}`;
}

/** Whether a value is a count: a whole number, not negative. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The walk a cursor carries.
 *
 * @param cursor - A run's cursor.
 * @throws ListingChangedError for a cursor this reader did not write, so the sync reads the source
 *   again from the first page rather than guessing where it stood.
 */
export function walkFromCursor(cursor: string): FeishuWalk {
  if (!cursor.startsWith(WALK_PREFIX)) throw new ListingChangedError();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor.slice(WALK_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    // Not a walk this reader wrote: the source is read again from its first page.
    throw new ListingChangedError();
  }
  const walk = value as Partial<FeishuWalk> | null;
  if (
    walk === null ||
    typeof walk !== 'object' ||
    !Array.isArray(walk.queue) ||
    walk.queue.length === 0 ||
    !walk.queue.every((parent: unknown) => parent === null || typeof parent === 'string') ||
    !(walk.pageToken === null || typeof walk.pageToken === 'string') ||
    !isCount(walk.skip) ||
    !isCount(walk.listed) ||
    !isCount(walk.requests)
  ) {
    throw new ListingChangedError();
  }
  return {
    queue: walk.queue,
    pageToken: walk.pageToken,
    skip: walk.skip,
    listed: walk.listed,
    requests: walk.requests,
  };
}
