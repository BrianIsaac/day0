'use node';

import type { PaginationResult } from 'convex/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { ActionCtx } from './_generated/server';
import { PAGED_READ } from './docSources';
import { linkedRunbookExcerpts, type AuthorPromptSkill } from './skillAuthorPrompt';
import type { SurfaceRecord } from '../src/surfaces/types';
import { log } from '../src/lib/logger';

/**
 * An employee's documentation read a window at a time (F2 D5 of the wave 3.5 landing).
 *
 * Reading every page of every source an employee reads in one query fails once the corpus passes
 * a query's 16 MiB read, which a real company folder does. A caller that needs to look across the
 * whole corpus (the Slack app's manifest template, a skill's linked runbooks) walks it here: each
 * of the employee's sources, one bounded page of its stored pages at a time (`PAGED_READ`, the
 * read the deploy mirror and the finishing sync use), and keeps only what it needs of each window.
 *
 * Node runtime: every caller is a `'use node'` action, and the linked runbooks are read through
 * `skillAuthorPrompt`, which is one, so this module is too (the standard's 1.5).
 */

/** What a caller does after one window: read on, or stop because it has what it needs. */
export type WindowVerdict = 'continue' | 'stop';

/**
 * Walk the pages an employee reads, a window at a time, in the order the whole read gave them
 * (the employee's sources by owner, each source's pages by their index), logging each window's
 * size.
 *
 * @param ctx - The action's context; each window is its own query.
 * @param agentId - The employee whose documentation is read.
 * @param reader - What the read is for, named in the log.
 * @param visit - Called with each window in order; `'stop'` ends the walk.
 */
export async function forEachDocumentationWindow(
  ctx: ActionCtx,
  agentId: Id<'agents'>,
  reader: string,
  visit: (pages: readonly Doc<'docPages'>[]) => WindowVerdict,
): Promise<void> {
  const sources: Doc<'docSources'>[] = await ctx.runQuery(
    internal.docSources.sourcesForAgentInternal,
    { agentId },
  );
  for (const source of sources) {
    let cursor: string | null = null;
    for (;;) {
      const window: PaginationResult<Doc<'docPages'>> = await ctx.runQuery(
        internal.docSources.pagesForSourceInternal,
        { sourceId: source._id, paginationOpts: { numItems: PAGED_READ.numItems, cursor } },
      );
      log.info('documentation window read', {
        reader,
        agentId,
        sourceId: source._id,
        pages: window.page.length,
        characters: window.page.reduce(
          (total: number, page: Doc<'docPages'>): number => total + page.markdown.length,
          0,
        ),
      });
      if (visit(window.page) === 'stop') return;
      if (window.isDone) break;
      cursor = window.continueCursor;
    }
  }
}

/**
 * The employee's pages that can be a skill's linked runbooks, read a window at a time: of each
 * window, only the pages `linkedRunbookExcerpts` would take from it, in the order the whole read
 * gave them. A page among the skill's linked runbooks is among its own window's, since the pages
 * that outrank it there are a subset of those that outrank it across the corpus and leave it at
 * least as much of the character budget, so selecting again over what is kept takes the pages a
 * whole read would. A skill with no target surface links no page, and nothing is read.
 *
 * @param ctx - The action's context.
 * @param agentId - The employee whose documentation is read.
 * @param skill - The skill whose runbooks are wanted.
 * @param surfaces - The employee's surfaces, which name the target.
 * @param reader - What the read is for, named in the log.
 */
export async function linkedRunbookPages(
  ctx: ActionCtx,
  agentId: Id<'agents'>,
  skill: AuthorPromptSkill,
  surfaces: readonly SurfaceRecord[],
  reader: string,
): Promise<Doc<'docPages'>[]> {
  if (!skill.targetSurface) return [];
  const kept: Doc<'docPages'>[] = [];
  await forEachDocumentationWindow(ctx, agentId, reader, (pages) => {
    const linked = new Set(
      linkedRunbookExcerpts(skill, surfaces, pages).map(({ page }) => page._id),
    );
    kept.push(...pages.filter((page) => linked.has(page._id)));
    return 'continue';
  });
  return kept;
}
