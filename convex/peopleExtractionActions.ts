'use node';

import { createHash } from 'node:crypto';
import type { FunctionReturnType } from 'convex/server';
import { v, type Infer } from 'convex/values';
import { internalAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { extractedPersonValidator } from './peopleProposals';
import { agentJson, makeAgent } from '../src/lib/mastra';
import {
  EXTRACTION_BATCH_SIZE,
  EXTRACTION_INSTRUCTIONS,
  extractionPrompt,
  groundedPeople,
  peopleExtractionSchema,
  type ExtractedPerson,
  type ExtractionPage,
  type PeopleExtractionResult,
} from '../src/people/extraction';
import { safeFailureMessage } from '../src/surfaces/redact';

/*
 * The documentation's people extraction (wave 13, 13-P; the wave file's section 5.2; A1, N20):
 * after each completed documentation generation, beside discovery, the people its pages name are
 * proposed into the source owner's graph for the manager to confirm. Model-judged with structured
 * output, quote-grounded (`src/people/extraction.ts`), in batches as discovery reads, and skipped
 * for a generation whose pages are the ones the last extraction read (the source's
 * `peopleExtractionFingerprint`).
 */

/** Pages one window of the fingerprint walk reads; a window also stops at its byte bound. */
const FINGERPRINT_WINDOW = 100;

/**
 * How long one invocation keeps extracting before it hands the rest to a scheduled continuation,
 * as discovery's budget: the model call in flight may take its own timeout past it.
 */
const EXTRACT_BUDGET_MS = 4 * 60 * 1000;

/**
 * The most people one apply proposes: they are applied in one transaction, each with a few index
 * reads and writes, which keeps it far inside a mutation's read and write limits (and a
 * continuation's arguments inside a scheduled call's). A generation naming more is applied in
 * chunks of this size (W13-R9).
 */
const EXTRACTION_PEOPLE_LIMIT = 250;

/** What an extraction continuation carries: the fingerprint, where it stands and who it found. */
const progressValidator = v.object({
  fingerprint: v.string(),
  cursor: v.string(),
  people: v.array(extractedPersonValidator),
});

/** The generation one extraction is for. */
interface ExtractionArgs {
  readonly sourceId: Id<'docSources'>;
  readonly runId: Id<'docSyncRuns'>;
}

/** What one invocation of {@link extractSource} reports. */
interface ExtractionOutcome {
  readonly applied: boolean;
  readonly people: number;
  readonly unchanged?: boolean;
  readonly reason?: string;
  /** The rest of the generation was handed to a scheduled continuation. */
  readonly continued?: boolean;
  /** How many applies this invocation made: one per chunk of `EXTRACTION_PEOPLE_LIMIT`. */
  readonly applies?: number;
}

/** One window of the generation, as `peopleProposals.extractionContext` reads it. */
type GenerationWindow = FunctionReturnType<typeof internal.peopleProposals.extractionContext>;

const extractionAgent = makeAgent('day0-people-extraction', EXTRACTION_INSTRUCTIONS);

/** One page's contribution to the generation's fingerprint. */
function pageDigest(page: Doc<'docPages'>): string {
  const hash = createHash('sha256');
  for (const field of [page.ref, page.title, page.url ?? '', page.markdown]) {
    hash.update(field);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** The generation's fingerprint: every page's digest in ref order, whatever order windows came in. */
function fingerprintOf(digests: ReadonlyArray<{ ref: string; digest: string }>): string {
  const hash = createHash('sha256');
  for (const row of [...digests].sort((left, right) => left.ref.localeCompare(right.ref))) {
    hash.update(row.ref);
    hash.update('\0');
    hash.update(row.digest);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** A failure's reason as the source keeps it, with nothing a provider echoed that it should not. */
function safeExtractionError(error: unknown): string {
  return safeFailureMessage(error, '', 'The people extraction failed.', 500);
}

/** A window's pages as the extraction reads them. */
function extractionPages(pages: readonly Doc<'docPages'>[]): ExtractionPage[] {
  return pages.map((page) => ({ ref: page.ref, title: page.title, markdown: page.markdown }));
}

/** An extracted person as a continuation's argument carries it. */
function carried(person: ExtractedPerson): Infer<typeof extractedPersonValidator> {
  return {
    name: person.name,
    ref: person.ref,
    where: person.where,
    quote: person.quote,
    ...(person.email === undefined ? {} : { email: person.email }),
    ...(person.title === undefined ? {} : { title: person.title }),
    ...(person.team === undefined ? {} : { team: person.team }),
    approves: [...person.approves],
    escalationFor: [...person.escalationFor],
  };
}

/** The grounded people of one window, a batch at a time. */
async function windowPeople(
  pages: readonly ExtractionPage[],
): Promise<Infer<typeof extractedPersonValidator>[]> {
  const found: Infer<typeof extractedPersonValidator>[] = [];
  for (let index = 0; index < pages.length; index += EXTRACTION_BATCH_SIZE) {
    const batch = pages.slice(index, index + EXTRACTION_BATCH_SIZE);
    const result = await agentJson<PeopleExtractionResult>({
      agent: extractionAgent,
      user: extractionPrompt(batch),
      schema: peopleExtractionSchema,
    });
    found.push(...groundedPeople(batch, result).map(carried));
  }
  return found;
}

/**
 * Walk the whole generation once for its fingerprint, holding only digests.
 *
 * @returns The source as the first window read it and the fingerprint, or null once the
 *   generation is no longer the one to extract.
 */
async function readGeneration(
  ctx: ActionCtx,
  args: ExtractionArgs,
): Promise<{ source: Doc<'docSources'>; fingerprint: string } | null> {
  const digests: Array<{ ref: string; digest: string }> = [];
  let source: Doc<'docSources'> | undefined;
  let cursor: string | null = null;
  for (;;) {
    const window: GenerationWindow = await ctx.runQuery(
      internal.peopleProposals.extractionContext,
      { ...args, cursor, numItems: FINGERPRINT_WINDOW },
    );
    if (window === null) return null;
    source ??= window.source;
    for (const page of window.pages) digests.push({ ref: page.ref, digest: pageDigest(page) });
    if (window.isDone) break;
    if (window.continueCursor === cursor) {
      throw new Error('The people extraction repeated its read cursor.');
    }
    cursor = window.continueCursor;
  }
  return source === undefined ? null : { source, fingerprint: fingerprintOf(digests) };
}

/**
 * Propose one chunk of what the extraction found; the last chunk of the generation (`final`) also
 * stamps the source as extracted.
 */
async function applyPeople(
  ctx: ActionCtx,
  args: ExtractionArgs,
  fingerprint: string,
  people: readonly Infer<typeof extractedPersonValidator>[],
  final: boolean,
): Promise<ExtractionOutcome> {
  const result = await ctx.runMutation(internal.peopleProposals.applyExtraction, {
    ...args,
    fingerprint,
    people: [...people],
    ...(final ? {} : { partial: true as const }),
  });
  // A proposal whose address reached the graph is looked up on the owner's cards, so the card can
  // say whom it matches (`peopleLookupActions.lookUpAddresses`).
  if (result.applied && result.withAddress.length > 0) {
    await ctx.scheduler.runAfter(0, internal.peopleLookupActions.lookUpAddresses, {
      personIds: result.withAddress,
    });
  }
  return { applied: result.applied, people: people.length };
}

/**
 * Extract the generation window by window from where it stands, proposing each chunk of
 * `EXTRACTION_PEOPLE_LIMIT` people as it fills and the rest once the walk ends (W13-R9). An
 * invocation that has used its budget hands the rest to a scheduled continuation; a model failure
 * is recorded on the source and the proposals made stand.
 */
async function extract(
  ctx: ActionCtx,
  args: ExtractionArgs,
  progress: {
    readonly fingerprint: string;
    readonly cursor: string | null;
    readonly people: readonly Infer<typeof extractedPersonValidator>[];
  },
  startedAt: number,
): Promise<ExtractionOutcome> {
  let { cursor } = progress;
  let people = [...progress.people];
  let applied = 0;
  let applies = 0;
  for (;;) {
    const window: GenerationWindow = await ctx.runQuery(
      internal.peopleProposals.extractionContext,
      { ...args, cursor, numItems: EXTRACTION_BATCH_SIZE },
    );
    if (window === null) return { applied: false, people: 0 };
    people = [...people, ...(await windowPeople(extractionPages(window.pages)))];
    while (people.length > EXTRACTION_PEOPLE_LIMIT) {
      const chunk = people.slice(0, EXTRACTION_PEOPLE_LIMIT);
      const outcome = await applyPeople(ctx, args, progress.fingerprint, chunk, false);
      if (!outcome.applied) return { applied: false, people: applied };
      applied += chunk.length;
      applies += 1;
      people = people.slice(EXTRACTION_PEOPLE_LIMIT);
    }
    if (window.isDone) {
      const outcome = await applyPeople(ctx, args, progress.fingerprint, people, true);
      return {
        ...outcome,
        people: applied + outcome.people,
        applies: applies + (outcome.applied ? 1 : 0),
      };
    }
    if (window.continueCursor === cursor) {
      throw new Error('The people extraction repeated its read cursor.');
    }
    cursor = window.continueCursor;
    if (Date.now() - startedAt >= EXTRACT_BUDGET_MS) {
      await ctx.scheduler.runAfter(0, internal.peopleExtractionActions.extractSource, {
        ...args,
        progress: { fingerprint: progress.fingerprint, cursor, people },
      });
      return { applied: false, people: 0, continued: true };
    }
  }
}

/**
 * Internal, scheduled by documentation sync beside discovery after each completed generation (real
 * mode), and by itself with `progress` when a large generation outlasts one invocation: propose
 * the people the generation's pages name (`peopleProposals.applyExtraction`), skipped with no
 * model call for a generation whose pages the last extraction read. Writes the source's four
 * extraction fields and the owner's proposals; a failure is recorded on the source.
 */
export const extractSource = internalAction({
  args: {
    sourceId: v.id('docSources'),
    runId: v.id('docSyncRuns'),
    progress: v.optional(progressValidator),
  },
  handler: async (ctx, { progress, ...args }): Promise<ExtractionOutcome> => {
    const startedAt = Date.now();
    try {
      if (progress !== undefined) return await extract(ctx, args, progress, startedAt);
      const generation = await readGeneration(ctx, args);
      if (generation === null) return { applied: false, people: 0 };
      if (
        generation.source.peopleExtractionFingerprint === generation.fingerprint &&
        generation.source.lastPeopleExtractionError === undefined
      ) {
        const applied = await ctx.runMutation(internal.peopleProposals.markExtractionUnchanged, {
          ...args,
          fingerprint: generation.fingerprint,
        });
        return { applied, people: 0, unchanged: true };
      }
      return await extract(
        ctx,
        args,
        { fingerprint: generation.fingerprint, cursor: null, people: [] },
        startedAt,
      );
    } catch (error: unknown) {
      // A scheduled function's throw lands where nothing watches: the source records why.
      const reason = safeExtractionError(error);
      await ctx.runMutation(internal.peopleProposals.recordExtractionFailure, { ...args, reason });
      return { applied: false, people: 0, reason };
    }
  },
});
