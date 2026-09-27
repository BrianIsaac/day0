import type { Agent } from '@mastra/core/agent';
import { agentText, makeAgent } from '../lib/mastra';
import { searchRole, type ExaResult, type RoleSearch } from '../lib/exa';
import { log } from '../lib/logger';

/**
 * Good-habits memory pipeline. Adapted from Protean's
 * `src/agent/good-habits.ts`: Tavily → Exa, Anthropic Opus → Mastra
 * Agent on GPT-5.6 Terra. The merge logic is identical (idempotent regex on
 * the `## Good-habits memory` header so quarterly refreshes don't
 * duplicate).
 */

const SECTION_HEADER = '## Good-habits memory';

const SYSTEM_PROMPT = [
  'You are a senior practitioner distilling role norms for an autonomous workplace agent.',
  'You receive web search results about what makes someone competent in a given role.',
  'Produce a concise AGENTS.md fragment (15-25 short bullets) capturing the discipline of doing the role well — habits, anti-patterns, and professional conventions a new hire should internalise from day one.',
  '',
  'OUTPUT FORMAT — pure markdown, exactly:',
  '',
  '## Good-habits memory (role: <role>)',
  '',
  '- <Norm phrased as an actionable habit>. (<source URL>)',
  '- <Failure mode phrased as a do-not>. (<source URL>)',
  '- ...',
  '',
  'Discipline:',
  '  - Each bullet MUST end with a source URL in parentheses. Never strip or paraphrase the URL.',
  '  - Prefer concrete habits over generic platitudes. "Confirm scope before estimating" beats "be a good communicator".',
  '  - Mix habits + failure modes; both feed the Layer-2 quality-fit filter that decides whether work is worth claiming.',
  '  - Return raw markdown only — no code fence, no preamble.',
].join('\n');

const goodHabitsAgent = makeAgent('day0-good-habits', SYSTEM_PROMPT);

function formatResults(results: ExaResult[]): string {
  if (results.length === 0) return '(no search results returned)';
  return results.map((r, idx) => `[${idx + 1}] ${r.title}\nURL: ${r.url}\n${r.text}`).join('\n\n');
}

export interface DistilArgs {
  role: string;
  results: ExaResult[];
  /** The distilling agent; the shared good-habits agent when omitted. */
  agent?: Agent;
}

export async function distilGoodHabits(args: DistilArgs): Promise<string> {
  const userPrompt = [
    `Role: ${args.role}`,
    '',
    'SOURCES:',
    formatResults(args.results),
    '',
    `Produce the AGENTS.md fragment now. Header line MUST be "${SECTION_HEADER} (role: ${args.role})".`,
  ].join('\n');

  const raw = await agentText({
    agent: args.agent ?? goodHabitsAgent,
    user: userPrompt,
  });
  return stripFence(raw);
}

export interface GoodHabitsResult {
  fragment: string;
  results: ExaResult[];
  norms: number;
  /** True when research was unavailable and no fragment was produced. */
  skipped: boolean;
  skipReason?: string;
}

/** The web search and the distilling agent the research step calls out to. */
export interface GoodHabitsSources {
  readonly search: (role: string) => Promise<RoleSearch>;
  readonly agent: Agent;
}

/**
 * End-to-end orchestrator: Exa search + Mastra distillation.
 *
 * With no sources there is nothing to distil — every bullet in the
 * fragment must carry a source URL, so a source-less run would just
 * invent them. Skipping is the honest degradation: the caller logs it
 * and the onboarding loop continues with AGENTS.md untouched.
 *
 * A distillation that fails (a reply cut at the output limit, a content
 * refusal, any other model error) is skipped the same way, so
 * `postCharterApproval` still reaches the real-mode seeding.
 */
export async function researchAndDistil(
  role: string,
  sources: GoodHabitsSources = { search: searchRole, agent: goodHabitsAgent },
): Promise<GoodHabitsResult> {
  const search = await sources.search(role);
  if (search.skipped) {
    return {
      fragment: '',
      results: search.results,
      norms: 0,
      skipped: true,
      skipReason: search.skipReason,
    };
  }
  let fragment: string;
  try {
    fragment = await distilGoodHabits({ role, results: search.results, agent: sources.agent });
  } catch (err) {
    const reason = `good-habits distillation failed: ${err instanceof Error ? err.message : String(err)}`;
    log.warn('good-habits distillation skipped', { role, reason });
    return { fragment: '', results: search.results, norms: 0, skipped: true, skipReason: reason };
  }
  return {
    fragment,
    results: search.results,
    norms: countNorms(fragment),
    skipped: false,
  };
}

/**
 * Idempotent merge — replaces a prior `## Good-habits memory` block
 * if present, otherwise appends. Pure string transform, no I/O.
 */
export function mergeGoodHabits(existing: string, fragment: string): string {
  const trimmedFragment = fragment.trim();
  if (!trimmedFragment) return existing;

  const existingTrimmed = existing.trim();
  if (!existingTrimmed) return `${trimmedFragment}\n`;

  const headerPattern = new RegExp(`(^|\\n)${escapeRegex(SECTION_HEADER)}.*?(?=\\n## |\\n?$)`, 's');
  if (headerPattern.test(existingTrimmed)) {
    const replaced = existingTrimmed.replace(headerPattern, (match) => {
      const leading = match.startsWith('\n') ? '\n' : '';
      return `${leading}${trimmedFragment}`;
    });
    return `${replaced.trim()}\n`;
  }

  return `${existingTrimmed}\n\n${trimmedFragment}\n`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:markdown|md)?\n?/i, '')
    .replace(/```$/i, '')
    .trim();
}

export function countNorms(fragment: string): number {
  return fragment.split('\n').filter((line) => line.trim().startsWith('- ')).length;
}
