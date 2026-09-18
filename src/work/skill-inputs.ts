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

/** A list item (`-`, `*`, `+`, `1.`, `1)`) or table row (`|`) up to its first token. */
const DECLARATION_LEAD = /^\s*(?:[-*+]|\d+[.)]|\|)\s*/;

/**
 * A declaration's first token: the placeholder name with or without
 * backticks and with or without angle brackets, followed by the end of the
 * line, whitespace, a colon, a comma, a pipe or a backtick.
 */
const DECLARED_NAME = /^`?<?([a-z][a-z0-9]*(?:-[a-z0-9]+)+)>?`?(?=$|[\s:,|`])/;

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
 * A placeholder written in its angle-bracket form anywhere in the section
 * is declared. So is a list item or table row whose first token is the name
 * without brackets, with or without backticks, when the body uses that name
 * as a placeholder: the author who wrote `- analytics-surface: …` and then
 * `<analytics-surface>` in the procedure has declared the input, in one of
 * the forms markdown makes natural. Prose that merely mentions a name, or a
 * name that is not the first token of its line, declares nothing; the body's
 * own uses must still be `<name>`.
 *
 * Args:
 *   body: SKILL.md markdown.
 *
 * Returns:
 *   The declared placeholder names in declaration order, or undefined when
 *   the body has no `## Inputs` section at all.
 */
export function declaredSkillInputs(body: string): string[] | undefined {
  const section = INPUTS_SECTION.exec(body);
  if (!section) return undefined;
  const used = new Set(skillInputPlaceholders(body));
  const declared: string[] = [];
  for (const line of section[1]!.split('\n')) {
    const lead = DECLARATION_LEAD.exec(line);
    const first = lead ? DECLARED_NAME.exec(line.slice(lead[0].length)) : null;
    if (first && used.has(first[1]!)) declared.push(first[1]!);
    declared.push(...skillInputPlaceholders(line));
  }
  return [...new Set(declared)];
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

/** Where a declaration added for the author says its value comes from. */
const ADDED_DECLARATION_SOURCE = 'read it from the candidate body, its Refs line or the runbook for this run';

/**
 * Declare every placeholder a body uses but does not declare.
 *
 * An author that writes `<closing-state-name>` in an example and never lists
 * it under `## Inputs` has written a procedure the executor can still bind:
 * any input the candidate row does not settle is read from the candidate or
 * its runbook at execution, which is exactly what `bindSkillInputs` tells the
 * executor for it. So real mode declares it in those words instead of refusing
 * the skill, and says so in the log. Each goes on its own list line after the
 * section's last non-blank line, so the author's declarations keep their
 * place; a body with no section gets one at its end.
 *
 * Args:
 *   body: SKILL.md markdown.
 *
 * Returns:
 *   The body with every used placeholder declared, and the names this added
 *   in order of first use; the body unchanged when nothing was missing.
 */
export function declareUndeclaredInputs(body: string): { body: string; declared: string[] } {
  const missing = undeclaredSkillInputs(body);
  if (missing.length === 0) return { body, declared: [] };
  const lines = missing.map((name: string): string => `- \`<${name}>\`: ${ADDED_DECLARATION_SOURCE}.`).join('\n');
  const section = INPUTS_SECTION.exec(body);
  if (!section) return { body: `${body.trimEnd()}\n\n## Inputs\n\n${lines}\n`, declared: missing };
  const contentStart = section.index + section[0].length - section[1]!.length;
  const at = contentStart + section[1]!.trimEnd().length;
  return { body: `${body.slice(0, at)}\n${lines}${body.slice(at)}`, declared: missing };
}

/**
 * What the log says when real mode declared inputs for the author.
 *
 * Args:
 *   names: The placeholder names declared, without brackets.
 *
 * Returns:
 *   One line for the verification log.
 */
export function declaredInputsNote(names: readonly string[]): string {
  const quoted = names.map((name: string): string => `\`<${name}>\``);
  const list = quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}` : quoted[0]!;
  return quoted.length > 1
    ? `SKILL.md used ${list} without declaring them; each was declared under \`## Inputs\` as read from the candidate or its runbook at execution`
    : `SKILL.md used ${list} without declaring it; it was declared under \`## Inputs\` as read from the candidate or its runbook at execution`;
}

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
