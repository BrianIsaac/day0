import { surfaceSlug } from '../surfaces/slug';
import type { WorkCandidate } from './types';

/**
 * The inputs a skill body declares and how the executor binds them per run.
 *
 * An authored skill is a procedure for one operation on one surface class;
 * everything that varies between runs is written as an angle-bracket
 * placeholder such as `<record-id>` and declared under a `## Inputs` heading.
 * This module is the one reading of that convention: the author gate checks a
 * body against it before registration, and the executor prompt binds the
 * declared placeholders from the candidate at run time.
 *
 * Kept free of model clients and Convex imports.
 */

/** A placeholder is two or more lowercase words joined by hyphens in angle brackets. */
const PLACEHOLDER = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)>/g;

/** The `## Inputs` section: from its heading to the next level-two heading or the end. */
const INPUTS_SECTION = /^##\s+Inputs\b[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im;

/**
 * The inputs an executor can bind at run time, as the author is taught them.
 * The list is the contract the executor prompt already carries (candidate id
 * and refs, quoted request, reply target, record, runbook, surface record); a
 * skill declares the ones its procedure needs and may add more from those
 * same sources. Each line is a correct `## Inputs` declaration, which is why
 * the gate quotes the first one when it refuses an undeclared placeholder.
 */
export const EXECUTION_INPUT_LINES: readonly string[] = [
  '  - `<record-id>`: the candidate\'s identifier on the surface the work came from (the `Refs:` line or the candidate id).',
  '  - `<requested-value>`: the figure or text the candidate or the runbook names for this run; never a constant in the skill.',
  '  - `<reply-channel>` and `<reply-thread>`: the `Reply target:` line when the work came from a chat channel or thread.',
  '  - `<originating-surface>`: the slug of the surface the work came from; its runbook says how the loop is closed there (an audit comment then a state change on a ticket, a reply in the thread on chat).',
  '  - `<audit-expectation>`: the read-back the runbook prescribes as evidence (an audit line, a returned identifier, a snapshot).',
];

/** One declared input and where this run's value comes from. */
export interface SkillInputBinding {
  name: string;
  /** The value the executor can bind from the candidate row; absent when only the model can read it. */
  value?: string;
  /** Where the value comes from, in the words the executor prompt uses. */
  source: string;
}

/**
 * The distinct placeholders in a piece of text, in order of first use.
 *
 * Args:
 *   text: A skill body, a section of one, or a smoke test.
 *
 * Returns:
 *   Placeholder names without their brackets.
 */
export function skillInputPlaceholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((match): string => match[1]!))];
}

/**
 * The inputs a skill body declares under `## Inputs`.
 *
 * Args:
 *   body: SKILL.md markdown.
 *
 * Returns:
 *   The declared placeholder names, or undefined when the body has no
 *   `## Inputs` section at all.
 */
export function declaredSkillInputs(body: string): string[] | undefined {
  const section = INPUTS_SECTION.exec(body);
  if (!section) return undefined;
  return skillInputPlaceholders(section[1]!);
}

/**
 * The placeholders a body uses without declaring them.
 *
 * Args:
 *   body: SKILL.md markdown.
 *
 * Returns:
 *   Names used anywhere in the body that the `## Inputs` section does not
 *   declare; every placeholder when there is no such section.
 */
export function undeclaredSkillInputs(body: string): string[] {
  const declared = new Set(declaredSkillInputs(body) ?? []);
  return skillInputPlaceholders(body).filter((name: string): boolean => !declared.has(name));
}

const READ_BY_THE_EXECUTOR =
  'read it from the candidate body, its Refs line or the runbook for this run; the skill body carries no value for it';

/**
 * Bind a skill's declared inputs from the candidate for one run.
 *
 * The bindings the candidate row settles are given as values; the rest name
 * their source, because only the executor reading the candidate prose and the
 * runbook can settle them.
 *
 * Args:
 *   body: SKILL.md markdown.
 *   candidate: The work item this run is for.
 *
 * Returns:
 *   One binding per declared input, in declaration order; empty when the body
 *   declares none.
 */
export function bindSkillInputs(
  body: string,
  candidate: Pick<WorkCandidate, 'externalId' | 'contentRefs' | 'sourceSystem' | 'replyTarget'>,
): SkillInputBinding[] {
  const declared = declaredSkillInputs(body) ?? [];
  return declared.map((name: string): SkillInputBinding => {
    switch (name) {
      case 'record-id':
        return { name, value: candidate.externalId, source: 'the candidate id' };
      case 'originating-surface':
        return {
          name,
          value: surfaceSlug(candidate.sourceSystem),
          source: 'the surface the work came from',
        };
      case 'reply-channel':
        return candidate.replyTarget
          ? { name, value: candidate.replyTarget.channel, source: 'the Reply target line' }
          : { name, source: 'no Reply target line: the work did not come from a chat channel' };
      case 'reply-thread':
        return candidate.replyTarget?.threadTs
          ? { name, value: candidate.replyTarget.threadTs, source: 'the Reply target line' }
          : candidate.replyTarget
            ? { name, source: 'the Reply target line names a top-level post, so there is no thread' }
            : { name, source: 'no Reply target line: the work did not come from a chat channel' };
      default:
        return { name, source: READ_BY_THE_EXECUTOR };
    }
  });
}

/**
 * Render the bindings for the executor prompt.
 *
 * Args:
 *   bindings: From `bindSkillInputs`.
 *
 * Returns:
 *   One line per input; empty when there are none.
 */
export function renderSkillInputs(bindings: readonly SkillInputBinding[]): string[] {
  return bindings.map((binding: SkillInputBinding): string =>
    binding.value !== undefined
      ? `  - <${binding.name}> = ${binding.value} (${binding.source})`
      : `  - <${binding.name}>: ${binding.source}`,
  );
}
