import { undeclaredSkillInputs, declaredSkillInputs } from './skill-inputs';

/**
 * The static gate on an authored skill, run before any sandbox spends a run.
 *
 * A skill serves every later work item of its shape, so its body may carry no
 * value from the item that first needed it: the gate reads that item's
 * identifiers, figures, quoted phrases and reply target and refuses a body or
 * smoke test that repeats any of them. It also holds the placeholder contract
 * the executor binds by: every angle-bracket input declared under `## Inputs`,
 * and `{{secret}}` the only double-brace placeholder, because the transport
 * refuses any other.
 *
 * Refusals are reasons, not exceptions: the authoring action records them on
 * the row so the next attempt is told what to correct.
 */

/** The work item an authored skill was proposed for, as the gate reads it. */
export interface AuthoredSkillInstance {
  externalId: string;
  title: string;
  contentSummary: string;
  contentRefs: readonly string[];
  replyTarget?: { channel: string; threadTs?: string };
}

const DOUBLE_BRACE = /\{\{\s*([^}]*?)\s*\}\}/g;
const SECRET_PLACEHOLDER = /^secret(?:[:.][A-Za-z0-9_-]+)?$/;
const PERCENTAGE = /\d+(?:[.,]\d+)?\s?%/g;
const CURRENCY = /[$£€]\s?\d[\d,]*(?:\.\d+)?\s?[kKmMbB]?(?![A-Za-z0-9])/g;
const WHOLE_NUMBER = /(?<![A-Za-z0-9_.,-])(?:\d{1,3}(?:,\d{3})+|\d{2,})(?:\.\d+)?(?![A-Za-z0-9%]|[.,]\d)/g;
const QUOTED = /["“]([^"”\n]{3,})["”]/g;
const MIN_LITERAL_LENGTH = 2;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The values of one work item that a skill body must not repeat.
 *
 * Args:
 *   instance: The work item the skill was proposed for.
 *
 * Returns:
 *   Distinct literals: the identifier, every reference and its tail, the reply
 *   channel and thread, and each percentage, amount, whole number and quoted
 *   phrase in the title and summary.
 */
export function instanceLiterals(instance: AuthoredSkillInstance): string[] {
  const prose = `${instance.title}\n${instance.contentSummary}`;
  const found: string[] = [instance.externalId];
  for (const ref of instance.contentRefs) {
    found.push(ref);
    const tail = ref.split('://')[1];
    if (tail) found.push(tail);
  }
  if (instance.replyTarget) {
    found.push(instance.replyTarget.channel);
    if (instance.replyTarget.threadTs) found.push(instance.replyTarget.threadTs);
  }
  for (const pattern of [PERCENTAGE, CURRENCY, WHOLE_NUMBER]) {
    for (const match of prose.matchAll(pattern)) found.push(match[0]);
  }
  for (const match of prose.matchAll(PERCENTAGE)) found.push(match[0].replace(/\s?%$/, ''));
  for (const match of prose.matchAll(QUOTED)) found.push(match[1]!);
  return [
    ...new Set(
      found.map((value: string): string => value.trim()).filter(
        (value: string): boolean => value.length >= MIN_LITERAL_LENGTH,
      ),
    ),
  ];
}

/** Whole-token containment: `REVOPS-7` is not in `REVOPS-70`, nor `74` in `3.74`. */
function containsLiteral(text: string, literal: string): boolean {
  const pattern = new RegExp(
    `(?<![A-Za-z0-9]|[.,](?=\\d))${escapeRegExp(literal)}(?![A-Za-z0-9]|[.,]\\d)`,
    'i',
  );
  return pattern.test(text);
}

function doubleBraceIssues(label: string, text: string): string[] {
  const names = [...new Set([...text.matchAll(DOUBLE_BRACE)].map((match): string => match[1]!))];
  return names
    .filter((name: string): boolean => !SECRET_PLACEHOLDER.test(name))
    .map(
      (name: string): string =>
        `${label} uses \`{{${name}}}\`; \`{{secret}}\` is the only double-brace placeholder, every other per-run value is an angle-bracket input`,
    );
}

/**
 * Why an authored skill is not a reusable procedure, if it is not.
 *
 * Args:
 *   args: The authored body and smoke test, and the work item the skill was
 *     proposed for when one is known.
 *
 * Returns:
 *   Every reason found, in a fixed order; empty when the skill passes.
 */
export function authoredSkillIssues(args: {
  body: string;
  smokeTest: string;
  instance?: AuthoredSkillInstance | null;
}): string[] {
  const issues: string[] = [];
  issues.push(...doubleBraceIssues('SKILL.md', args.body));
  issues.push(...doubleBraceIssues('smoke.py', args.smokeTest));

  const declared = declaredSkillInputs(args.body);
  if (declared === undefined) {
    issues.push(
      'SKILL.md declares no `## Inputs` section; every value that varies per run is an angle-bracket input declared there',
    );
  }
  for (const name of undeclaredSkillInputs(args.body)) {
    if (declared === undefined) break;
    issues.push(`SKILL.md uses \`<${name}>\` without declaring it under \`## Inputs\``);
  }

  if (args.instance) {
    const found = instanceLiterals(args.instance)
      .map((literal: string): { literal: string; where: string[] } => ({
        literal,
        where: [
          containsLiteral(args.body, literal) ? 'SKILL.md' : undefined,
          containsLiteral(args.smokeTest, literal) ? 'smoke.py' : undefined,
        ].filter((label): label is string => label !== undefined),
      }))
      .filter((hit): boolean => hit.where.length > 0);
    // `74%` is reported once, not again as `74`.
    const distinct = found.filter(
      (hit): boolean =>
        !found.some(
          (other): boolean => other.literal !== hit.literal && other.literal.includes(hit.literal),
        ),
    );
    for (const hit of distinct) {
      issues.push(
        `${hit.where.join(' and ')} carries the first work item's value \`${hit.literal}\`; a skill reads it from the candidate at execution and names the input it stands for`,
      );
    }
  }
  return issues;
}
