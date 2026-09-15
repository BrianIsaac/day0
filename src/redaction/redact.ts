/**
 * One interface for every redaction in Day0.
 *
 * Three layers, in the order they are applied:
 *   1. the exact values the caller holds: the credential a transport just
 *      sent and every value Day0 stores for the owner, removed literally,
 *      JSON-escaped and URL-encoded: defence in depth that a model miss must
 *      never get past, and never degraded;
 *   2. the structural grammar, for the formats whose secret position is
 *      syntax;
 *   3. the span model, whose secret spans pass the guard and whose personal
 *      data spans are kept or removed by the entity policy for the context.
 *
 * A caller that persists text asks for the context it is persisting into and
 * says what to do when the model cannot be reached: documentation sync fails
 * closed, a ledger outcome degrades to the first two layers and says so.
 */
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
  /**
   * Exact values the caller already holds: the transport's credential and
   * the owner's stored values. Removed before anything else, whatever the
   * model does.
   */
  known?: readonly string[];
  /** What to do when the model is not configured or cannot be reached. */
  onUnavailable: 'throw' | 'structural';
  /** The marker a redacted secret becomes; personal data always names its kind. */
  secretMarker?: (finding: Finding) => string;
}

/** The label of a span the exact-value layer found; a structural rule that also covers it names it instead. */
export const KNOWN_VALUE_LABEL = 'known credential';

/**
 * Every occurrence of every known value, in each representation a provider
 * or a page may carry it: literal, JSON-escaped and URL-encoded.
 *
 * Args:
 *   text: The original text.
 *   known: The exact values.
 *
 * Returns:
 *   Spans in the original text, unmerged.
 */
export function knownValueSpans(text: string, known: readonly string[]): Array<Omit<Finding, 'redacted'>> {
  const spans: Array<Omit<Finding, 'redacted'>> = [];
  for (const value of known) {
    if (!value) continue;
    const representations = new Set([value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]);
    for (const representation of representations) {
      let from = 0;
      for (;;) {
        const index = text.indexOf(representation, from);
        if (index === -1) break;
        spans.push({
          kind: 'secret',
          label: KNOWN_VALUE_LABEL,
          start: index,
          end: index + representation.length,
          value: representation,
        });
        from = index + representation.length;
      }
    }
  }
  return spans;
}

/** The text with every known span overwritten in place, so offsets hold and the model never sees the value. */
function maskSpans(text: string, spans: ReadonlyArray<{ start: number; end: number }>): string {
  let masked = text;
  for (const span of spans) {
    masked = `${masked.slice(0, span.start)}${'x'.repeat(span.end - span.start)}${masked.slice(span.end)}`;
  }
  return masked;
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
  const base = text;
  const known = knownValueSpans(base, options.known ?? []);
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
      const masked = maskSpans(base, known);
      modelFindings = classify(masked, await options.model.spans(masked, REQUESTED_LABELS, MODEL_THRESHOLD));
    } catch (error) {
      if (!(error instanceof RedactorUnavailableError) || options.onUnavailable === 'throw') throw error;
      degraded = 'structural-only';
    }
  }
  // Known spans come last so a structural or model finding that covers the
  // same characters keeps its more specific label after the merge.
  const candidates = [...structural, ...modelFindings, ...known];
  const removed = mergeSpans(candidates.filter((finding) => dispositionFor(context, finding.kind) === 'redact'));
  const findings: Finding[] = [
    ...removed.map((finding): Finding => ({ ...finding, value: base.slice(finding.start, finding.end), redacted: true })),
    ...candidates.filter((finding) => dispositionFor(context, finding.kind) === 'keep')
      .map((finding): Finding => ({ ...finding, redacted: false })),
  ].sort((left, right) => left.start - right.start);
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
  const spans = mergeSpans([...structuralSpans(text), ...knownValueSpans(text, known)]);
  return replaceSpans(text, spans, (): string => REDACTED);
}
