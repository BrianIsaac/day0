import { z } from 'zod';
import type { MockSurfaceSnapshot } from './types';

/*
 * The procedure contract: the runtime trails the loaded documentation prescribes (an audit
 * comment on the originating ticket, a recap to the manager's channel), parsed from the pages'
 * own words. Pure (zod and string matching), so the documentation selection's query can keep
 * every page that yields a trail without loading the executor's model client (wave 14, 14-R).
 */

const sourceCategorySchema = z.enum([
  'inbox',
  'ticket-queue',
  'event-stream',
  'live-document',
  'meeting-transcript',
  'calendar',
]);

const procedureDestinationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('originating-reference'),
      refPrefix: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('manager-channel'),
      argument: z.string().min(1),
      value: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('reply-target'),
      argument: z.string().min(1),
    })
    .strict(),
]);

/** The procedure contract the executor answers with: which runtime trail each action follows, validated. */
export const procedureContractSchema = z
  .object({
    trails: z.array(
      z
        .object({
          id: z.string().min(1),
          appliesTo: z
            .object({
              sourceCategories: z.array(sourceCategorySchema),
            })
            .strict(),
          effect: z
            .object({
              tool: z.string().min(1),
              destination: procedureDestinationSchema,
              requiredPayload: z.array(z.string().min(1)),
              nonEmptyPayload: z.array(z.string().min(1)),
              statusTransition: z
                .object({
                  argument: z.string().min(1),
                  full: z.string().min(1),
                  partial: z.string().min(1),
                })
                .strict()
                .nullable(),
            })
            .strict(),
          evidence: z
            .object({
              documentRef: z.string().min(1),
              title: z.string().min(1),
              excerpt: z.string().min(1),
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict();

/** A validated procedure contract. */
export type ProcedureContract = z.infer<typeof procedureContractSchema>;

type ProcedureDocument = MockSurfaceSnapshot['howToGuides'][number];

const SOURCE_CATEGORIES = sourceCategorySchema.options;
const STATUS_VALUE = '(open|in-progress|blocked|done)';

function documentedSourceCategories(body: string): Array<z.infer<typeof sourceCategorySchema>> {
  const lower = body.toLowerCase();
  return SOURCE_CATEGORIES.filter((category) => {
    const spaced = category.replaceAll('-', ' ');
    return lower.includes(category) || lower.includes(spaced);
  });
}

function firstCapture(body: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const value = pattern.exec(body)?.[1];
    if (value) return value.toLowerCase();
  }
  return undefined;
}

function documentedFullStatus(body: string): string | undefined {
  return firstCapture(body, [
    new RegExp(
      `status\\s*:\\s*[\u0060"']*${STATUS_VALUE}[\u0060"']*\\s+for\\s+(?:full|complete)`,
      'i',
    ),
    new RegExp(
      `(?:full(?:y)?\\s+(?:closed?|complete)|completed?[^.;\\n]{0,30})[^.;\\n]{0,80}?status[\u0060"']*\\s+(?:to|as)\\s+[\u0060"']*${STATUS_VALUE}`,
      'i',
    ),
  ]);
}

function documentedPartialStatus(body: string): string | undefined {
  return firstCapture(body, [
    new RegExp(`[\u0060"']*${STATUS_VALUE}[\u0060"']*\\s+for\\s+partial`, 'i'),
    new RegExp(
      `(?:unfinished|incomplete|partial(?:ly)?)[^.;\\n]{0,80}?status[\u0060"']*\\s+(?:to|as)\\s+[\u0060"']*${STATUS_VALUE}`,
      'i',
    ),
  ]);
}

function documentedManagerDestination(body: string): string | undefined {
  return firstCapture(body, [
    /put\s+[`"']([^`"']+)[`"']\s+in\s+[`"']?channelSlug/i,
    /(?:draft|recap|report|summary)[^\n.]{0,120}?(?:to|in)\s+[`"']([^`"']+)[`"']/i,
    /channelSlug[`"']?\s+(?:to|is|value)?\s*[`"']([^`"']+)[`"']/i,
  ]);
}

function procedureExcerpt(document: ProcedureDocument, pattern: RegExp): string {
  return (
    document.body
      .split('\n')
      .map((line) => line.trim())
      // A cite line labels the text below it (wave 14, 14-R); it is never the procedure's words.
      .find((line) => !line.startsWith('[cite: ') && pattern.test(line)) ??
    document.body.trim().slice(0, 320)
  );
}

function semanticTrailKey(trail: Omit<ProcedureContract['trails'][number], 'id'>): string {
  return JSON.stringify({
    appliesTo: trail.appliesTo,
    tool: trail.effect.tool,
    destination: trail.effect.destination,
    statusTransition: trail.effect.statusTransition,
  });
}

/**
 * Parse only procedure facts present in the runtime-loaded document bodies.
 * Unrecognised wording returns an empty contract; no built-in policy is used.
 */
export function parseProcedureContract(
  documents: Pick<MockSurfaceSnapshot, 'howToGuides' | 'teamDocs'>,
): ProcedureContract {
  const candidates: Array<Omit<ProcedureContract['trails'][number], 'id'>> = [];
  const loaded = [...documents.howToGuides, ...documents.teamDocs];
  for (const document of loaded) {
    const body = document.body;
    if (/ticket\.update/i.test(body) && /originat(?:ing|ed)/i.test(body)) {
      const full = documentedFullStatus(body);
      const partial = documentedPartialStatus(body);
      const sourceCategories = documentedSourceCategories(body);
      const requiresComment =
        /(?:non-empty|one-line)[^\n.]{0,30}[\u0060"']?comment/i.test(body) ||
        /(?:add|supply|include)[^\n.]{0,50}[\u0060"']?comment[^\n.]{0,50}(?:summaris|summariz|explain|record)/i.test(
          body,
        );
      if (full && partial && sourceCategories.length > 0) {
        candidates.push({
          appliesTo: { sourceCategories },
          effect: {
            tool: 'ticket.update',
            destination: { kind: 'originating-reference', refPrefix: 'ticket://' },
            requiredPayload: requiresComment ? ['comment'] : [],
            nonEmptyPayload: requiresComment ? ['comment'] : [],
            statusTransition: { argument: 'status', full, partial },
          },
          evidence: {
            documentRef: document.slug,
            title: document.title,
            excerpt: procedureExcerpt(document, /originat(?:ing|ed)/i),
          },
        });
      }
    }

    if (
      /slack\.postMessage/i.test(body) &&
      /(?:manager|supervisor|boss|lead)[^\n.]{0,80}(?:channel|dm|private)|(?:channel|dm|private)[^\n.]{0,80}(?:manager|supervisor|boss|lead)/i.test(
        body,
      ) &&
      /(?:draft|recap|report|summary)/i.test(body) &&
      /channelSlug/i.test(body) &&
      /[\u0060"']?body[\u0060"']?/i.test(body)
    ) {
      const destination = documentedManagerDestination(body);
      if (destination) {
        candidates.push({
          appliesTo: { sourceCategories: [] },
          effect: {
            tool: 'slack.postMessage',
            destination: { kind: 'manager-channel', argument: 'channelSlug', value: destination },
            requiredPayload: ['body'],
            nonEmptyPayload: ['body'],
            statusTransition: null,
          },
          evidence: {
            documentRef: document.slug,
            title: document.title,
            excerpt: procedureExcerpt(document, /(?:manager|supervisor|boss|lead)/i),
          },
        });
      }
    }
  }

  const merged = new Map<string, Omit<ProcedureContract['trails'][number], 'id'>>();
  for (const candidate of candidates) {
    const key = semanticTrailKey(candidate);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, candidate);
      continue;
    }
    const requiredPayload = [
      ...new Set([...existing.effect.requiredPayload, ...candidate.effect.requiredPayload]),
    ];
    const nonEmptyPayload = [
      ...new Set([...existing.effect.nonEmptyPayload, ...candidate.effect.nonEmptyPayload]),
    ];
    merged.set(key, {
      ...existing,
      effect: { ...existing.effect, requiredPayload, nonEmptyPayload },
      evidence:
        candidate.effect.nonEmptyPayload.length > existing.effect.nonEmptyPayload.length
          ? candidate.evidence
          : existing.evidence,
    });
  }
  const trails = [...merged.values()].map((trail, index) => ({
    id: `trail-${index + 1}`,
    ...trail,
  }));
  const parsed = procedureContractSchema.safeParse({ trails });
  return parsed.success ? parsed.data : { trails: [] };
}
