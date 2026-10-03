import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { eventsOfType } from './eventLog';
import { isEventOf } from '../src/events/contract';

/*
 * The latest re-join a Slack renewal made for each of an employee's cards (`surface.channels-
 * rejoined`, AS10; 11-AC's item 5), read from the employee's own record for the card to say: the
 * channels the bot re-joined itself and those that need a person in them to add it. No Convex
 * function lives here; `surfaces.listForAgent` reads it.
 */

/** The most re-join lines of one employee read for its cards, newest first. */
const REJOIN_LINES_READ = 50;

/** A card's latest re-join after a renewal, as its record line says it. */
export interface LastRejoin {
  readonly joined: readonly string[];
  readonly needsPerson: readonly string[];
  /** Slack's words when it refused a join. */
  readonly reason?: string;
  /** When the re-join was recorded. */
  readonly at: number;
}

/**
 * The newest re-join of each of an employee's cards, by card, from the employee's record; a card
 * no renewal re-joined is absent.
 *
 * @param agentId - The employee.
 */
export async function latestRejoins(
  ctx: Pick<QueryCtx, 'db'>,
  agentId: Id<'agents'>,
): Promise<ReadonlyMap<Id<'surfaces'>, LastRejoin>> {
  const lines = await eventsOfType(ctx, agentId, 'surface.channels-rejoined')
    .order('desc')
    .take(REJOIN_LINES_READ);
  const latest = new Map<Id<'surfaces'>, LastRejoin>();
  for (const line of lines) {
    if (!isEventOf(line, 'surface.channels-rejoined')) continue;
    const { surfaceId, joined, needsPerson, reason } = line.payload;
    if (latest.has(surfaceId)) continue;
    latest.set(surfaceId, {
      joined: [...joined],
      needsPerson: [...needsPerson],
      ...(reason === undefined ? {} : { reason }),
      at: line.createdAt,
    });
  }
  return latest;
}
