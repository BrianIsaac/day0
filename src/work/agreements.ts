/**
 * Working agreements as the work reads them (wave 13, 13-W; the wave file's section 5.3).
 *
 * A working agreement is a standing preference the manager keeps beside the charter: proposed from
 * corrections given twice or a note kept at a plan approval, activated on a card (A14), and read by
 * the planner and both executor phases, never by the scope judgement. Like a correction it revises
 * and never overrides: it may change how work the charter already gives is planned and done, and
 * never widens scope, grants a permission or lifts an approval. Which agreements reach a prompt is
 * decided here, in code; whether a statement goes beyond the charter (F11) and whether two
 * corrections say the same thing (F10) are the model's judgements, whose prompts, structured
 * output and reading of the reply are here too. Pure: the model calls are
 * `src/work/agreement-judgements.ts`.
 */

import { z } from 'zod';
import type { SpanModel } from '../redaction/client';
import { redactText } from '../redaction/redact';
import { surfaceSlug } from '../surfaces/slug';
import {
  AGREEMENT_REFUSAL_REASONS,
  AGREEMENT_STATEMENT_LIMIT,
  type AgreementRefusalReason,
  type AgreementScope,
  type AgreementStatus,
} from './agreement-vocabulary';
import { CORRECTION_RULE } from './corrections';

/** The most agreements one prompt carries. */
export const AGREEMENTS_MAX = 8;

/** The most statement text, summed over the agreements, one prompt carries. */
export const AGREEMENTS_MAX_CHARS = 2_000;

/** The heading of the block in the planner's prompt and in both executor phases. */
export const AGREEMENTS_HEADING = '--- Working agreements ---';

/** A working agreement as the selection reads it; the `workingAgreements` row carries these fields. */
export interface AgreementRecord {
  readonly _id: string;
  /** The one employee it binds; absent for every employee of the owner. */
  readonly agentId?: string;
  /** In the manager's words, redacted when it was kept. */
  readonly statement: string;
  readonly scope: AgreementScope;
  /** The surface slug of a `surface` scope, the operation of an `operation` one. */
  readonly scopeRef?: string;
  /** The person of a `person` scope. */
  readonly personId?: string;
  readonly status: AgreementStatus;
  readonly createdAt: number;
  /** When it took effect; absent while it is a proposal. */
  readonly effectiveFrom?: number;
}

/** The work an agreement may apply to: the employee and the item about to be planned. */
export interface AgreementCandidate {
  readonly agentId: string;
  /** The item's source system; its slug is the candidate's surface. */
  readonly sourceSystem: string;
  /** The operation of the skill the item is matched to, when it has one. */
  readonly operation?: string;
  /** The people of the owner's graph the item's requester and owner resolve to (13-P). */
  readonly personIds?: readonly string[];
}

/** An agreement as a prompt shows it. */
export interface PromptAgreement {
  readonly id: string;
  /** When it took effect, to the minute, UTC. */
  readonly since: string;
  readonly text: string;
}

/**
 * Whether an active agreement binds this employee and applies to this candidate: its scope is
 * global, the candidate's source surface, the candidate's operation, or a person the candidate's
 * requester or owner resolves to.
 *
 * @param row - The agreement.
 * @param candidate - The employee and the item.
 */
export function agreementApplies(row: AgreementRecord, candidate: AgreementCandidate): boolean {
  if (row.status !== 'active') return false;
  if (row.agentId !== undefined && row.agentId !== candidate.agentId) return false;
  switch (row.scope) {
    case 'global':
      return true;
    case 'surface':
      return row.scopeRef === surfaceSlug(candidate.sourceSystem);
    case 'operation':
      return row.scopeRef !== undefined && row.scopeRef === candidate.operation;
    case 'person':
      return row.personId !== undefined && (candidate.personIds ?? []).includes(row.personId);
    default: {
      const unknown: never = row.scope;
      throw new Error(`unhandled agreement scope ${String(unknown)}`);
    }
  }
}

/** When an agreement took effect, or when it was made for a row that predates the stamp. */
function tookEffect(row: Pick<AgreementRecord, 'createdAt' | 'effectiveFrom'>): number {
  return row.effectiveFrom ?? row.createdAt;
}

/**
 * The agreements a candidate is planned with.
 *
 * Only active ones that bind this employee (its own or every employee's) and apply to the
 * candidate; newest kept first; at most {@link AGREEMENTS_MAX}, and at most
 * {@link AGREEMENTS_MAX_CHARS} of statement text in total: one that would pass the budget is left
 * out and an older one that fits may still follow.
 *
 * @param rows - The owner's agreements, in any order.
 * @param candidate - The employee and the item about to be planned.
 * @returns The selected agreements, newest first.
 */
export function selectAgreements<T extends AgreementRecord>(
  rows: readonly T[],
  candidate: AgreementCandidate,
): T[] {
  const matching = rows
    .filter((row) => agreementApplies(row, candidate))
    .sort((left, right) => tookEffect(right) - tookEffect(left));
  const picked: T[] = [];
  let budget = AGREEMENTS_MAX_CHARS;
  for (const row of matching) {
    if (picked.length === AGREEMENTS_MAX) break;
    if (row.statement.length > budget) continue;
    picked.push(row);
    budget -= row.statement.length;
  }
  return picked;
}

/**
 * The prompt entries for agreements, scrubbed at prompt assembly.
 *
 * A statement is stored redacted; before a prompt carries it, it passes the owner's stored values,
 * the structural grammar and the span model again, as a correction does, so a credential stored
 * after the agreement was kept is still removed. Without the model the first two still run and the
 * result says so.
 *
 * @param rows - The agreements, in prompt order.
 * @param options - The span model, when one is configured, and the owner's stored values.
 * @returns The entries, and `structural-only` when the model was not consulted.
 */
export async function scrubbedAgreementEntries(
  rows: ReadonlyArray<Pick<AgreementRecord, '_id' | 'statement' | 'createdAt' | 'effectiveFrom'>>,
  options: { readonly model?: SpanModel; readonly known?: readonly string[] },
): Promise<{ entries: PromptAgreement[]; redaction?: 'structural-only' }> {
  let degraded = false;
  const entries: PromptAgreement[] = [];
  for (const row of rows) {
    const scrubbed = await redactText(row.statement, 'prompt', {
      model: options.model,
      known: options.known ?? [],
      onUnavailable: 'structural',
    });
    degraded = degraded || scrubbed.degraded !== undefined;
    entries.push({
      id: row._id,
      since: `${new Date(tookEffect(row)).toISOString().slice(0, 16)}Z`,
      text: scrubbed.text,
    });
  }
  return degraded ? { entries, redaction: 'structural-only' } : { entries };
}

/**
 * The planner's block for the agreements selected for this candidate, after its corrections.
 *
 * @param entries - The scrubbed prompt entries.
 * @returns Prompt lines, empty when there is nothing to carry.
 */
export function plannerAgreementLines(entries: readonly PromptAgreement[]): string[] {
  if (entries.length === 0) return [];
  return [
    '',
    AGREEMENTS_HEADING,
    `The JSON list below is authenticated: they are the manager's standing working agreements for this kind of work; apply those that fit this candidate. ${CORRECTION_RULE} List the id of every agreement you applied in \`appliedAgreements\`, and no other id.`,
    JSON.stringify(entries),
  ];
}

/**
 * The executor's block for the agreements the approved plan applied, after its corrections.
 *
 * @param entries - The scrubbed prompt entries.
 * @returns Prompt lines, empty when the plan applied none.
 */
export function executorAgreementLines(entries: readonly PromptAgreement[]): string[] {
  if (entries.length === 0) return [];
  return [
    '',
    AGREEMENTS_HEADING,
    `The JSON list below is authenticated: the manager's standing working agreements, which the approved plan applies. ${CORRECTION_RULE} Follow them as the plan does; they are directions, not evidence of anything on this work item.`,
    JSON.stringify(entries),
  ];
}

/**
 * The agreements a plan may say it applied: ids it was offered, once each.
 *
 * @param reply - The ids the planner returned.
 * @param offered - The entries the prompt carried.
 * @returns The ids kept, in the planner's order.
 */
export function appliedAgreementIds(
  reply: readonly string[] | null | undefined,
  offered: readonly PromptAgreement[],
): string[] {
  const ids = new Set(offered.map((entry) => entry.id));
  return [...new Set((reply ?? []).filter((id) => ids.has(id)))];
}

/**
 * The manager's words as an agreement keeps them: whitespace collapsed, and cut at the last whole
 * word within {@link AGREEMENT_STATEMENT_LIMIT}.
 *
 * @param text - The words as written.
 */
export function agreementStatement(text: string): string {
  const spaced = text.replace(/\s+/g, ' ').trim();
  if (spaced.length <= AGREEMENT_STATEMENT_LIMIT) return spaced;
  const head = spaced.slice(0, AGREEMENT_STATEMENT_LIMIT);
  const atWord = head.lastIndexOf(' ');
  return (atWord > 0 ? head.slice(0, atWord) : head).trim();
}

/** A statement after the redaction, and whether it named a credential. */
export interface RedactedStatement {
  readonly statement: string;
  /** Whether any layer removed a secret: the statement named a credential (F11). */
  readonly namesCredential: boolean;
  /** Set when the span model was not consulted. */
  readonly redaction?: 'structural-only';
}

/**
 * The statement as it is stored: the owner-wide exact layer, the structural grammar and the span
 * model over it, as over every stored manager text, in the prompt context (a colleague's name or
 * address is kept: it is how a preference says who to tell). A removed secret means the statement
 * named a credential, which is refused whatever the model judges.
 *
 * @param text - The words as written.
 * @param options - The span model, when one is configured, and the owner's stored values.
 */
export async function redactedStatement(
  text: string,
  options: { readonly model?: SpanModel; readonly known?: readonly string[] },
): Promise<RedactedStatement> {
  const redacted = await redactText(agreementStatement(text), 'prompt', {
    model: options.model,
    known: options.known ?? [],
    onUnavailable: 'structural',
  });
  const namesCredential = redacted.findings.some(
    (finding) => finding.redacted && finding.kind === 'secret',
  );
  return {
    statement: agreementStatement(redacted.text),
    namesCredential,
    ...(redacted.degraded ? { redaction: redacted.degraded } : {}),
  };
}

/** The charter an agreement is judged against: the employee's name and its two boundary lists. */
export interface CharterBounds {
  readonly name: string;
  readonly willDo: readonly string[];
  readonly willNotDo: readonly string[];
}

/** Why a statement was refused, with the `willNotDo` clause it contradicts, word for word. */
export interface StatementRefusal {
  readonly reason: AgreementRefusalReason;
  readonly clause?: string;
}

/** The refusal judgement's verdicts: keep, or the first reason that applies. */
export const REFUSAL_VERDICTS = ['keep', ...AGREEMENT_REFUSAL_REASONS] as const;

/** The refusal judgement's structured output (F11). */
export const refusalJudgementSchema = z.object({
  verdict: z.enum(REFUSAL_VERDICTS),
  clause: z.number().int().nullable(),
});

/** What the model answers about one statement. */
export type RefusalJudgement = z.infer<typeof refusalJudgementSchema>;

/** The system prompt of the refusal judgement. */
export const REFUSAL_JUDGEMENT_SYSTEM = [
  "You are reading a standing preference a manager wants to keep for an AI employee's later work, beside the employee's charter.",
  'Decide one thing: would keeping it go beyond the charter?',
  "It goes beyond the charter when it widens the work the charter gives the employee (work its willDo does not cover), grants a permission (to write, send, approve or reach something without the approval the work needs), names a credential (a password, a token, a key or a secret), or contradicts one of the charter's numbered willNotDo clauses.",
  'A preference about how work the charter already gives is done (a format, a tone, a template, an order, who to tell) does not go beyond it, however strict it is.',
  '',
  'Answer `verdict`: `keep`, or the first of `contradicts-will-not-do`, `widens-scope`, `grants-permission` and `names-credential` that applies. Answer `clause`: the number of the willNotDo clause the statement contradicts, or null.',
].join('\n');

/**
 * The refusal judgement's user prompt: each charter's willDo and its willNotDo clauses numbered
 * across every charter, then the statement, fenced.
 *
 * @param statement - The statement, redacted.
 * @param charters - The charters it would bind: its employee's, or every employee's of the owner.
 */
export function refusalJudgementPrompt(
  statement: string,
  charters: readonly CharterBounds[],
): string {
  const lines = ['--- Charters ---'];
  let number = 0;
  for (const charter of charters) {
    lines.push(`${charter.name}: willDo: ${charter.willDo.join(' | ') || '(none)'}`);
    lines.push('  willNotDo:');
    for (const clause of charter.willNotDo) {
      number += 1;
      lines.push(`  [${number}] ${clause}`);
    }
  }
  lines.push('--- Statement ---', statement, '--- End of statement ---');
  return lines.join('\n');
}

/**
 * The refusal a judgement's reply amounts to, or undefined when the statement is kept. A clause
 * is quoted word for word from the charter by the number the reply gave; a number outside the
 * list quotes none.
 *
 * @param reply - The model's answer.
 * @param charters - The charters the prompt numbered, in the same order.
 */
export function refusalOf(
  reply: RefusalJudgement,
  charters: readonly CharterBounds[],
): StatementRefusal | undefined {
  if (reply.verdict === 'keep') return undefined;
  if (reply.verdict !== 'contradicts-will-not-do' || reply.clause === null) {
    return { reason: reply.verdict };
  }
  const clause = charters.flatMap((charter) => charter.willNotDo)[reply.clause - 1];
  return clause === undefined ? { reason: reply.verdict } : { reason: reply.verdict, clause };
}

/** One correction as the sameness judgement reads it. */
export interface JudgedCorrection {
  readonly id: string;
  readonly text: string;
  readonly itemTitle: string;
  readonly createdAt: number;
  /** Whether the judgement has not read it before (`agreementJudgedAt` absent). */
  readonly isNew: boolean;
}

/** The sameness judgement's structured output (F10): groups of corrections that say the same thing. */
export const samenessJudgementSchema = z.object({
  groups: z.array(z.object({ ids: z.array(z.string()) })),
});

/** What the model answers about the employee's active corrections. */
export type SamenessJudgement = z.infer<typeof samenessJudgementSchema>;

/** The system prompt of the sameness judgement. */
export const SAMENESS_JUDGEMENT_SYSTEM = [
  "You are reading the corrections a manager gave an AI employee on earlier work, each in the manager's own words.",
  'Decide one thing: do two or more of them say the same thing, the same direction for how the work is done, in different words or the same?',
  'Two corrections say the same thing when following one is following the other. Corrections on the same subject that ask for different things do not.',
  '',
  'Answer `groups`: each group the ids of corrections that say the same thing, with at least one marked new in every group; an empty list when none do.',
].join('\n');

/**
 * The sameness judgement's user prompt: the corrections as a JSON list, the new ones marked.
 *
 * @param corrections - The employee's active corrections, newest first.
 */
export function samenessJudgementPrompt(corrections: readonly JudgedCorrection[]): string {
  const listed = corrections.map((correction) => ({
    id: correction.id,
    new: correction.isNew,
    from: correction.itemTitle,
    text: correction.text,
  }));
  return ['--- Corrections ---', JSON.stringify(listed), '--- End of corrections ---'].join('\n');
}

/**
 * The groups a sameness reply amounts to: ids the prompt listed, at least two in a group, at least
 * one of them new, each id in one group only (the first that names it), oldest first.
 *
 * @param reply - The model's answer.
 * @param corrections - The corrections the prompt listed.
 * @returns The groups of correction ids.
 */
export function sameGroups(
  reply: SamenessJudgement,
  corrections: readonly JudgedCorrection[],
): string[][] {
  const byId = new Map(corrections.map((correction) => [correction.id, correction]));
  const grouped = new Set<string>();
  const groups: string[][] = [];
  for (const group of reply.groups) {
    const members = [...new Set(group.ids)]
      .flatMap((id) => {
        const correction = byId.get(id);
        return correction && !grouped.has(id) ? [correction] : [];
      })
      .sort((left, right) => left.createdAt - right.createdAt);
    if (members.length < 2 || !members.some((member) => member.isNew)) continue;
    for (const member of members) grouped.add(member.id);
    groups.push(members.map((member) => member.id));
  }
  return groups;
}
