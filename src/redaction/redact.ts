/**
 * One interface for every redaction in Day0.
 *
 * Three layers, in the order they are applied:
 *   1. the exact values a transport already holds (the credential it just
 *      sent), removed literally, JSON-escaped and URL-encoded: defence in
 *      depth that a model miss must never get past;
 *   2. the structural grammar, for the formats whose secret position is
 *      syntax;
 *   3. the span model, whose secret spans pass the guard and whose personal
 *      data spans are kept or removed by the entity policy for the context.
 *
 * A caller that persists text asks for the context it is persisting into and
 * says what to do when the model cannot be reached: documentation sync fails
 * closed, a ledger outcome degrades to the first two layers and says so.
 */
import { redactValue } from '../surfaces/secrets';
import { RedactorUnavailableError, type ModelSpan, type SpanModel } from './client';
import { guardSecretSpan, personalDataGuardReason } from './guard';
import {
  dispositionFor,
  MODEL_LABELS,
  MODEL_THRESHOLD,
  REQUESTED_LABELS,
  THRESHOLDS,
  type EntityKind,
  type RedactionContext,
} from './policy';
import { mergeSpans, replaceSpans, structuralSpans } from './structural';

export const REDACTED = '<redacted>';

export interface Finding {
  kind: EntityKind;
  /** The model's label or the structural rule that found it. */
  label: string;
  start: number;
  end: number;
  value: string;
  /** Whether the policy removed it from the text. */
  redacted: boolean;
}

export type RedactionDegradation = 'structural-only';

export interface RedactedText {
  text: string;
  findings: Finding[];
  /** Set when the model was not consulted and only the exact and structural layers ran. */
  degraded?: RedactionDegradation;
}

export interface RedactOptions {
  /** The span model; undefined means none is configured. */
  model?: SpanModel;
  /** Exact values the caller already holds, removed before anything else. */
  known?: readonly string[];
  /** What to do when the model is not configured or cannot be reached. */
  onUnavailable: 'throw' | 'structural';
  /** The marker a redacted secret becomes; personal data always names its kind. */
  secretMarker?: (finding: Finding) => string;
}

/** The marker for a redacted personal-data span. */
export function personalDataMarker(kind: EntityKind): string {
  return `<redacted: ${kind}>`;
}

/**
 * Classify the model's spans by the policy and the guard.
 *
 * Args:
 *   text: The text the spans index into.
 *   spans: What the model returned.
 *
 * Returns:
 *   Findings the policy can dispose of, guard applied to secrets.
 */
function classify(text: string, spans: ModelSpan[]): Array<Omit<Finding, 'redacted'>> {
  const findings: Array<Omit<Finding, 'redacted'>> = [];
  for (const span of spans) {
    const kind = MODEL_LABELS[span.label];
    if (!kind || span.score < THRESHOLDS[kind]) continue;
    if (kind === 'secret') {
      const guarded = guardSecretSpan(text, span, span.label);
      if (!guarded) continue;
      findings.push({ kind, label: span.label, ...guarded, value: text.slice(guarded.start, guarded.end) });
      continue;
    }
    const value = text.slice(span.start, span.end).trim();
    if (!value || personalDataGuardReason(kind, value)) continue;
    const start = span.start + text.slice(span.start, span.end).indexOf(value);
    findings.push({ kind, label: span.label, start, end: start + value.length, value });
  }
  return findings;
}

/**
 * Redact one text for one context.
 *
 * Args:
 *   text: Untrusted text about to be persisted or shown.
 *   context: Where it is going.
 *   options: The model, known values and the unavailability rule.
 *
 * Returns:
 *   The text with every span the policy removes replaced, the findings that
 *   led there, and whether the model was part of it.
 *
 * Raises:
 *   RedactorUnavailableError: When the model is missing or unreachable and
 *     the caller asked to fail closed.
 */
export async function redactText(
  text: string,
  context: RedactionContext,
  options: RedactOptions,
): Promise<RedactedText> {
  let base = text;
  for (const value of options.known ?? []) base = redactValue(base, value);
  const structural = structuralSpans(base).map(
    (span): Omit<Finding, 'redacted'> => ({
      kind: 'secret',
      label: span.label,
      start: span.start,
      end: span.end,
      value: base.slice(span.start, span.end),
    }),
  );
  let modelFindings: Array<Omit<Finding, 'redacted'>> = [];
  let degraded: RedactionDegradation | undefined;
  if (!options.model) {
    if (options.onUnavailable === 'throw') {
      throw new RedactorUnavailableError('no redaction component is configured (DAY0_REDACTOR_URL)');
    }
    degraded = 'structural-only';
  } else {
    try {
      modelFindings = classify(base, await options.model.spans(base, REQUESTED_LABELS, MODEL_THRESHOLD));
    } catch (error) {
      if (!(error instanceof RedactorUnavailableError) || options.onUnavailable === 'throw') throw error;
      degraded = 'structural-only';
    }
  }
  const findings: Finding[] = mergeSpans([...structural, ...modelFindings]).map(
    (finding): Finding => ({ ...finding, redacted: dispositionFor(context, finding.kind) === 'redact' }),
  );
  const marker = options.secretMarker ?? ((): string => REDACTED);
  const redacted = replaceSpans(
    base,
    findings.filter((finding: Finding): boolean => finding.redacted),
    (finding: Finding): string => (finding.kind === 'secret' ? marker(finding) : personalDataMarker(finding.kind)),
  );
  return degraded ? { text: redacted, findings, degraded } : { text: redacted, findings };
}

/**
 * The synchronous floor: exact values and the structural grammar only.
 *
 * For the places that cannot await a model: a Convex query rendering an
 * export, and prompt text assembled from material that was redacted when it
 * was stored.
 *
 * Args:
 *   text: Untrusted text.
 *   known: Exact values to remove first.
 *
 * Returns:
 *   The text with every exact value and structural secret replaced.
 */
export function redactStructural(text: string, known: readonly string[] = []): string {
  let base = text;
  for (const value of known) base = redactValue(base, value);
  return replaceSpans(base, structuralSpans(base), (): string => REDACTED);
}
