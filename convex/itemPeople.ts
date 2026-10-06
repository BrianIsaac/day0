import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { employeeOwnerScope } from './ownership';
import type { PersonResolution } from '../src/people/resolution';

/*
 * Whom a work item's requester and owner are in the owner's graph now (wave 13, 13-J): the stored
 * resolutions intake wrote (`workItems.requesterPerson` / `ownerPerson`, 13-P), read back as the
 * confirmed people they still name. A leaf module, so the working agreements' selection and the
 * prompts' readers share it without importing the graph's mutations.
 */

/**
 * The confirmed person a stored resolution names: a `person` answer whose row is still an active
 * person of the owner scope. An ambiguous or unknown answer, a person since dismissed or made
 * inactive, and one of another owner name nobody.
 *
 * @param ctx - A query or mutation context.
 * @param scope - The owner scope.
 * @param resolution - What intake stored for the requester or the owner.
 */
export async function confirmedPersonOf(
  ctx: QueryCtx,
  scope: string,
  resolution: PersonResolution<Id<'people'>> | undefined,
): Promise<Doc<'people'> | undefined> {
  if (resolution?.kind !== 'person') return undefined;
  const person = await ctx.db.get(resolution.personId);
  return person !== null && person.userId === scope && person.status === 'active'
    ? person
    : undefined;
}

/**
 * The confirmed people a work item's requester and owner resolve to, once each, requester first:
 * the people a `person`-scoped working agreement applies through (13-W's selection).
 *
 * @param ctx - A query or mutation context.
 * @param item - The work item.
 * @param agent - Its employee, whose owner scope the people must be of.
 */
export async function itemPersonIds(
  ctx: QueryCtx,
  item: Pick<Doc<'workItems'>, 'requesterPerson' | 'ownerPerson'>,
  agent: Pick<Doc<'agents'>, 'userId'>,
): Promise<Id<'people'>[]> {
  const scope = employeeOwnerScope(agent);
  if (scope === undefined) return [];
  const people = await Promise.all(
    [item.requesterPerson, item.ownerPerson].map(
      async (resolution) => await confirmedPersonOf(ctx, scope, resolution),
    ),
  );
  return [...new Set(people.flatMap((person) => (person === undefined ? [] : [person._id])))];
}
