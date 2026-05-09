import { agentText, makeAgent } from '../lib/mastra';
import { searchRole, type ExaResult } from '../lib/exa';

/**
 * Good-habits memory pipeline. Adapted from Protean's
 * `src/agent/good-habits.ts`: Tavily → Exa, Anthropic Opus → Mastra
 * Agent on GPT-5.5. The merge logic is identical (idempotent regex on
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
  return results
    .map((r, idx) => `[${idx + 1}] ${r.title}\nURL: ${r.url}\n${r.text}`)
    .join('\n\n');
}

export interface DistilArgs {
  role: string;
  results: ExaResult[];
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
    agent: goodHabitsAgent,
    user: userPrompt,
  });
  return stripFence(raw);
}

/**
 * End-to-end orchestrator: Exa search + Mastra distillation.
 */
export async function researchAndDistil(role: string): Promise<{
  fragment: string;
  results: ExaResult[];
  norms: number;
}> {
  const results = await searchRole(role);
  const fragment = await distilGoodHabits({ role, results });
  return { fragment, results, norms: countNorms(fragment) };
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
