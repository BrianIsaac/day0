'use node';

import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalAction, type ActionCtx } from './_generated/server';
import type { PageScanCards } from './intakeScopeBackfill';
import {
  orientIntakeScope,
  pagesForSystem,
  surfaceDocumentation,
  type IntakeScopeDraft,
  type IntakeScopeQuestion,
  type StoredIntakeScope,
} from './orientationActions';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { isEmptyScope, sentenceScopePicks, upgradeScopeNote } from '../src/surfaces/intake-scope';

/*
 * The `surfaces-intake-scope` pass's page (the round after wave 11, R-S; the wave 11 review's m5):
 * a kanban card proposed before `intakeScope` is scoped as a proposal scopes it today, from the
 * pages that name its system, restricted to the role's handbook, and grounded on the documented
 * values the manager's own words about the system name. The upgrade asks no model: a migration's
 * result must not hang on a model being up, and the proposal itself falls back to these words when
 * its model does not answer. A card the words do not scope keeps the page scan, and the card says
 * so (`pageScanLine`).
 */

/** What one page of the pass read and changed, as `migrations.ts` records it. */
export interface IntakeScopePage {
  readonly read: number;
  readonly changed: number;
  readonly cursor: string;
  readonly isDone: boolean;
  readonly note?: string;
}

/**
 * The pick the upgrade makes in place of the proposal's model: the documented values the
 * manager's own sentences name, with the upgrade's note.
 */
function upgradePick(system: string): (question: IntakeScopeQuestion) => Promise<IntakeScopeDraft> {
  return async (question: IntakeScopeQuestion): Promise<IntakeScopeDraft> => ({
    picks: sentenceScopePicks(question.sentences, question.candidates),
    note: upgradeScopeNote(system),
  });
}

/** What a card's scope is read from: its employee's charter role and the pages naming its system. */
interface ScopeReading {
  readonly role: string | undefined;
  readonly pages: Doc<'docPages'>[];
}

/**
 * The reading for one employee and system, read once per page of the pass: an employee's cards
 * of one system share it, so the stored pages are not read again for each.
 */
function scopeReadings(
  ctx: ActionCtx,
): (agentId: Id<'agents'>, system: string) => Promise<ScopeReading> {
  const read = new Map<string, Promise<ScopeReading>>();
  return async (agentId, system) => {
    const key = `${agentId}\u0000${system}`;
    const known = read.get(key);
    if (known !== undefined) return await known;
    const reading = (async (): Promise<ScopeReading> => {
      const [charter, pages] = await Promise.all([
        ctx.runQuery(internal.orientationData.charterForOrientation, { agentId }),
        pagesForSystem(ctx, agentId, system),
      ]);
      return { role: charter?.proposedFunction, pages };
    })();
    read.set(key, reading);
    return await reading;
  };
}

/**
 * The scope a card proposed before the field would be given today without a model, or undefined
 * when its pages and the manager's words tie no team or project to the role.
 */
async function derivedScope(
  card: Doc<'surfaces'>,
  reading: ScopeReading,
): Promise<StoredIntakeScope | undefined> {
  const { matches } = surfaceDocumentation(reading.pages, card);
  const scope = await orientIntakeScope(card, matches, reading.role, upgradePick(card.displayName));
  return scope === undefined || isEmptyScope(scope, card.class) ? undefined : scope;
}

/**
 * Scope one page of cards intake reads by the page scan. Internal, for `migrations.runPending`;
 * writes each derived scope through `intakeScopeBackfill.recordDerivedScope`, which leaves a card
 * that gained a scope meanwhile, so the page is safe to run twice. In mock mode it reads nothing:
 * intake reads the mock office there, never the page scan.
 */
export const backfillPage = internalAction({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<IntakeScopePage> => {
    if (SURFACE_MODE !== 'real') {
      return {
        read: 0,
        changed: 0,
        cursor: '',
        isDone: true,
        note: 'mock mode: intake reads the mock office, never the page scan, so no card was read',
      };
    }
    const page: PageScanCards = await ctx.runQuery(internal.intakeScopeBackfill.pageScanCards, {
      cursor: args.cursor,
    });
    const readingFor = scopeReadings(ctx);
    let changed = 0;
    for (const card of page.cards) {
      const scope = await derivedScope(card, await readingFor(card.agentId, card.displayName));
      if (scope === undefined) continue;
      const written: boolean = await ctx.runMutation(
        internal.intakeScopeBackfill.recordDerivedScope,
        { surfaceId: card._id, intakeScope: scope },
      );
      if (written) changed += 1;
    }
    return {
      read: page.read,
      changed,
      cursor: page.cursor,
      isDone: page.isDone,
      note: 'a card whose pages and manager’s words tie no team or project to the role keeps the page scan and says so on the card',
    };
  },
});
