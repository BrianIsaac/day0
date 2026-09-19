import { surfaceSlug } from '../surfaces/slug';
import type { SurfaceMode } from '../surfaces/types';
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

/** The taught input that says which surface carries a reply. */
export const REPLY_SURFACE_INPUT = 'reply-surface';

/**
 * The taught inputs in real mode. They differ from the recorded list where a
 * live author went wrong: the recorded lines give a reply channel and thread
 * and no surface to send them on, and describe `<originating-surface>` as
 * where "a reply in the thread on chat" closes the loop, so a draft could
 * address the thread reply to the ticket surface (demo rehearsal 2, 19 Sep
 * 2026). These name the surface as its own input, which the executor binds
 * from the candidate, so a body never has to work it out.
 */
const REAL_EXECUTION_INPUT_LINES: readonly string[] = [
  EXECUTION_INPUT_LINES[0]!,
  EXECUTION_INPUT_LINES[1]!,
  '  - `<reply-channel>` and `<reply-thread>`: the channel and thread of the `Reply target:` line when the work came from a chat channel or thread. The reply is an action on `<reply-surface>`, the connected chat surface the `Reply target:` line names, by that surface\'s own path (`http.request` on an API surface); never on `<originating-surface>` unless that is the chat surface.',
  `  - \`<${REPLY_SURFACE_INPUT}>\`: the slug of the connected chat surface the \`Reply target:\` line's channel is on; the executor binds it whenever there is a \`Reply target:\` line. Every reply action's \`surface\` is \`<${REPLY_SURFACE_INPUT}>\`: a ticket surface never carries a reply.`,
  '  - `<originating-surface>`: the slug of the surface the work came from; its runbook says how the loop is closed there (an audit comment then a state change on a ticket). It is a ticket surface for a ticket and the chat surface for a chat ask, so a reply is never routed through it: a reply goes to `<reply-surface>`.',
  EXECUTION_INPUT_LINES[4]!,
];

/**
 * The taught input lines for a surface mode.
 *
 * Args:
 *   mode: The deployment's surface mode.
 *
 * Returns:
 *   The recorded list in mock mode, the very array, so the mock author's
 *   prompt is the one the recorded runs used; in real mode the list that
 *   names the reply surface.
 */
export function executionInputLines(mode: SurfaceMode): readonly string[] {
  return mode === 'real' ? REAL_EXECUTION_INPUT_LINES : EXECUTION_INPUT_LINES;
}

/**
 * The taught inputs the executor binds by value from the candidate row that
 * say where a write lands: the record and the reply target. The smoke harness
 * holds a case that supplies one to carrying it into an action argument, so a
 * write aimed at a constant cannot pass on the strength of a varying comment.
 * `<originating-surface>` is bound by value too but routes rather than
 * addresses, so a procedure may read it without sending it.
 * `<reply-surface>` has its own rule in the harness: it is held against the
 * action that carries the reply channel, not against every case, because a
 * case may give it and owe no reply.
 */
export const CANDIDATE_BOUND_TARGET_INPUTS: readonly string[] = ['record-id', 'reply-channel', 'reply-thread'];

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
 * What every declaration the system added ends with. The manager approves a
 * skill before its body exists, so the body itself has to say which of its
 * inputs the author never declared: the mark travels with the body through a
 * park, a refusal and an export, and the skills panel reads it back.
 */
const ADDED_DECLARATION_MARK = 'Declared by Day0: the author used it without declaring it.';

const ADDED_DECLARATION = new RegExp(
  `^\\s*[-*+]\\s*\`<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)>\`:.*${ADDED_DECLARATION_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
);

/** Words that make a placeholder name a credential whatever surrounds them. */
const CREDENTIAL_WORDS = new Set(['secret', 'secrets', 'password', 'passwd', 'passphrase', 'credential', 'credentials', 'bearer', 'authorization']);

/** A key or token qualified as one that authenticates; `<team-key>` and `<page-token>` are neither. */
const CREDENTIAL_KEY_OR_TOKEN = /(?:^|-)(?:api|access|secret|private|signing|bot|user|app|auth|oauth|refresh|session|service)-(?:key|token)(?:-|$)/;

/**
 * Whether a placeholder's name says its value is a credential.
 *
 * Args:
 *   name: A placeholder name without its brackets.
 *
 * Returns:
 *   True for a name such as `slack-bot-token`, `api-key` or `admin-password`.
 */
export function isCredentialInputName(name: string): boolean {
  return name.split('-').some((word: string): boolean => CREDENTIAL_WORDS.has(word)) || CREDENTIAL_KEY_OR_TOKEN.test(name);
}

/**
 * Why a credential-named input is refused, one reason per name.
 *
 * Declaring such a name for the author would tell the executor to read a
 * credential out of a candidate or a runbook and write it into an action, the
 * one thing `{{secret}}` exists to make unnecessary.
 *
 * Args:
 *   names: Placeholder names `declareUndeclaredInputs` would not declare.
 *
 * Returns:
 *   The reasons, in the order given.
 */
export function credentialInputIssues(names: readonly string[]): string[] {
  return names.map(
    (name: string): string =>
      `SKILL.md uses \`<${name}>\` as an input; a credential is never an input the executor reads from a candidate: write \`{{secret}}\` where it goes and the server substitutes the stored credential`,
  );
}

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
 * place; a body with no section gets one at its end. A name that says it is
 * a credential is never declared: it is left for the gate to refuse.
 *
 * Args:
 *   body: SKILL.md markdown.
 *
 * Returns:
 *   The body with every other used placeholder declared, the names this added
 *   in order of first use, and the credential names it left undeclared; the
 *   body unchanged when nothing was added.
 */
export function declareUndeclaredInputs(body: string): { body: string; declared: string[]; credentials: string[] } {
  const undeclared = undeclaredSkillInputs(body);
  const credentials = undeclared.filter(isCredentialInputName);
  const missing = undeclared.filter((name: string): boolean => !isCredentialInputName(name));
  if (missing.length === 0) return { body, declared: [], credentials };
  const lines = missing
    .map((name: string): string => `- \`<${name}>\`: ${ADDED_DECLARATION_SOURCE}. ${ADDED_DECLARATION_MARK}`)
    .join('\n');
  const section = INPUTS_SECTION.exec(body);
  if (!section) return { body: `${body.trimEnd()}\n\n## Inputs\n\n${lines}\n`, declared: missing, credentials };
  const contentStart = section.index + section[0].length - section[1]!.length;
  const at = contentStart + section[1]!.trimEnd().length;
  return { body: `${body.slice(0, at)}\n${lines}${body.slice(at)}`, declared: missing, credentials };
}

/**
 * The inputs a body says the system declared for its author.
 *
 * Args:
 *   body: SKILL.md markdown.
 *
 * Returns:
 *   The names on `## Inputs` lines that carry the system's mark, in order;
 *   empty when the author declared everything it used.
 */
export function systemDeclaredInputs(body: string): string[] {
  const section = INPUTS_SECTION.exec(body);
  if (!section) return [];
  return section[1]!
    .split('\n')
    .map((line: string): string | undefined => ADDED_DECLARATION.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
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

const NO_REPLY_TARGET = 'no Reply target line: the work did not come from a chat channel';

/**
 * The taught inputs a body leaves undeclared that the executor binds anyway.
 *
 * A skill registered before `<reply-surface>` was taught declares a reply
 * channel or thread and no surface for them. It still runs: in real mode the
 * executor binds the reply surface for it, and the skills list shows the
 * input as bound by Day0. A body that declares no reply input implies none.
 *
 * Args:
 *   body: SKILL.md markdown.
 *
 * Returns:
 *   `['reply-surface']` for such a body, otherwise empty.
 */
export function impliedSkillInputs(body: string): string[] {
  const declared = declaredSkillInputs(body) ?? [];
  const replies = declared.includes('reply-channel') || declared.includes('reply-thread');
  return replies && !declared.includes(REPLY_SURFACE_INPUT) ? [REPLY_SURFACE_INPUT] : [];
}

/**
 * Bind a skill's declared inputs from the candidate for one run.
 *
 * The bindings the candidate row settles are given as values; the rest name
 * their source, because only the executor reading the candidate prose and the
 * runbook can settle them.
 *
 * The reply surface is the surface the Reply target is on. A Reply target is
 * stored only on work that came from a chat surface, whose slug is the
 * candidate's source system, which is also where the ask-reply composition
 * addresses a reply. In real mode a body that declares a reply channel or
 * thread and no reply surface gets the binding after its own, when the work
 * has a Reply target: that is how a skill registered before the input was
 * taught sends its reply to the right surface. Mock mode adds nothing, so a
 * recorded bed's executor prompt is the one it was.
 *
 * Args:
 *   body: SKILL.md markdown.
 *   candidate: The work item this run is for.
 *   mode: The surface mode of the run.
 *
 * Returns:
 *   One binding per declared input, in declaration order, then any the
 *   executor adds; empty when the body declares none.
 */
export function bindSkillInputs(
  body: string,
  candidate: Pick<WorkCandidate, 'externalId' | 'contentRefs' | 'sourceSystem' | 'replyTarget'>,
  mode: SurfaceMode = 'mock',
): SkillInputBinding[] {
  const declared = declaredSkillInputs(body) ?? [];
  const replySurface = candidate.replyTarget ? surfaceSlug(candidate.sourceSystem) : undefined;
  const implied: SkillInputBinding[] =
    mode === 'real' && replySurface !== undefined && impliedSkillInputs(body).length > 0
      ? [
          {
            name: REPLY_SURFACE_INPUT,
            value: replySurface,
            source:
              'the chat surface the Reply target line is on; this skill was registered before the input was taught, so Day0 binds it: send the reply to <reply-channel> on this surface, never on <originating-surface> unless it is this surface',
          },
        ]
      : [];
  const bound = declared.map((name: string): SkillInputBinding => {
    switch (name) {
      case 'record-id':
        return { name, value: candidate.externalId, source: 'the candidate id' };
      case 'originating-surface':
        return {
          name,
          value: surfaceSlug(candidate.sourceSystem),
          source: 'the surface the work came from',
        };
      case REPLY_SURFACE_INPUT:
        return replySurface !== undefined
          ? { name, value: replySurface, source: 'the chat surface the Reply target line is on; every reply action goes to it' }
          : { name, source: NO_REPLY_TARGET };
      case 'reply-channel':
        return candidate.replyTarget
          ? { name, value: candidate.replyTarget.channel, source: 'the Reply target line' }
          : { name, source: NO_REPLY_TARGET };
      case 'reply-thread':
        return candidate.replyTarget?.threadTs
          ? { name, value: candidate.replyTarget.threadTs, source: 'the Reply target line' }
          : candidate.replyTarget
            ? { name, source: 'the Reply target line names a top-level post, so there is no thread' }
            : { name, source: NO_REPLY_TARGET };
      default:
        return { name, source: READ_BY_THE_EXECUTOR };
    }
  });
  return [...bound, ...implied];
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
