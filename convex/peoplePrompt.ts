import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { internalQuery, type QueryCtx } from './_generated/server';
import { employeeOwnerScope } from './ownership';
import { confirmedPersonOf } from './itemPeople';
import { collaboratorsOfEmployee, escalationContactOfEmployee } from './people';
import {
  withoutKnownSlackIds,
  type PromptNamed,
  type PromptPeople,
  type PromptPerson,
  type PromptEscalation,
} from '../src/people/prompt-block';

/*
 * What the prompts read of the people graph (wave 13, 13-J; 13-P's "For the People block"): the
 * People block's people, from 13-P's two readers, and the confirmed people a work item's requester
 * and owner resolve to (`workItems.requesterPerson` / `ownerPerson`). Names, roles and what an
 * edge covers only: never a person id, an identity, an address or an evidence quote leaves this
 * module for a prompt. The planner and both executor phases read it in real mode; the scope
 * judgement never does (scope is the charter's).
 */

/** A confirmed person by name and role, as a prompt may print them. */
function named(person: Pick<Doc<'people'>, 'displayName' | 'title' | 'team'>): PromptNamed {
  return {
    displayName: person.displayName,
    ...(person.title === undefined ? {} : { title: person.title }),
    ...(person.team === undefined ? {} : { team: person.team }),
  };
}

/** The most Slack ids of an owner's graph read to keep them out of the block's words. */
const SLACK_IDS_READ = 500;

/**
 * The Slack ids the owner's graph holds (D-5), for the exact match the block's shape rule cannot
 * make: read here and used here, so none of them leaves this module.
 */
async function slackIdsOf(ctx: QueryCtx, userId: string): Promise<string[]> {
  const identities = await ctx.db
    .query('personIdentities')
    .withIndex('by_user_provider_external', (q) => q.eq('userId', userId).eq('provider', 'slack'))
    .take(SLACK_IDS_READ);
  return identities.map((identity) => identity.externalId);
}

/**
 * The People block's people for an employee now: one entry per confirmed person its collaborator,
 * neighbouring-role and dotted-line edges in force reach, in name order, with every such edge to
 * them; and whom it escalates to. No one and the manager for an employee no owner holds.
 *
 * @param ctx - A query or mutation context.
 * @param agent - The employee.
 * @param now - The moment, in epoch milliseconds.
 */
export async function promptPeopleOf(
  ctx: QueryCtx,
  agent: Pick<Doc<'agents'>, '_id' | 'userId'>,
  now: number,
): Promise<PromptPeople> {
  const scope = employeeOwnerScope(agent);
  const [collaborators, escalation, slackIds] = await Promise.all([
    collaboratorsOfEmployee(ctx, agent, now),
    escalationContactOfEmployee(ctx, agent, undefined, now),
    scope === undefined ? [] : slackIdsOf(ctx, scope),
  ]);
  const byPerson = new Map<Id<'people'>, PromptPerson>();
  for (const answer of collaborators) {
    const edge = {
      type: answer.type,
      ...(answer.scope === undefined ? {} : { scope: answer.scope }),
    };
    const known = byPerson.get(answer.personId);
    byPerson.set(
      answer.personId,
      known === undefined
        ? { ...named(answer), edges: [edge] }
        : { ...known, edges: [...known.edges, edge] },
    );
  }
  const contact: PromptEscalation =
    escalation.kind === 'person'
      ? {
          kind: 'person',
          ...named(escalation),
          ...(escalation.scope === undefined ? {} : { scope: escalation.scope }),
        }
      : { kind: 'manager' };
  // A Slack id the graph holds is taken out of every word here, whatever its letters (D-5).
  return withoutKnownSlackIds({ people: [...byPerson.values()], escalation: contact }, slackIds);
}

/**
 * Internal, read by the planner and both executor phases (`convex/workActions.ts`) in real mode:
 * the People block's people for the item's employee now ({@link promptPeopleOf}), and the
 * confirmed person its requester resolves to for the From line, absent for an ambiguous or unknown
 * requester. Reads only.
 */
export const forItem = internalQuery({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<{ people: PromptPeople; requester?: PromptNamed }> => {
    const item = await ctx.db.get(args.workItemId);
    const agent = item === null ? null : await ctx.db.get(item.agentId);
    const scope = agent === null ? undefined : employeeOwnerScope(agent);
    if (item === null || agent === null || scope === undefined) {
      return { people: { people: [], escalation: { kind: 'manager' } } };
    }
    const [people, requester] = await Promise.all([
      promptPeopleOf(ctx, agent, Date.now()),
      confirmedPersonOf(ctx, scope, item.requesterPerson),
    ]);
    return { people, ...(requester === undefined ? {} : { requester: named(requester) }) };
  },
});
