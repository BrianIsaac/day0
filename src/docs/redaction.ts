/**
 * Documentation redaction: the first persistence boundary for a page.
 *
 * A page is read from its source, handed to the redaction layer in the
 * `documentation` context, and only the redacted body and title are stored.
 * Every secret the layer found becomes an encrypted credential row and a
 * `<credential: label, stored>` marker in the page; personal data the policy
 * removes becomes a `<redacted: kind>` marker and is not stored anywhere.
 * The marker label names the system and the kind of credential, so the
 * owner's credential list reads as a list of what was found and where.
 */
import {
  KNOWN_VALUE_LABEL,
  redactText,
  type Finding,
  type RedactOptions,
} from '../redaction/redact';
import { explicitlyAssignedCredential, guardReason, QUOTE_PAIRS } from '../redaction/guard';
import type { ModelSpan, SpanModel } from '../redaction/client';
import { PROVIDER_LABELS } from '../redaction/structural';

export interface RedactedCredential {
  label: string;
  plaintext: string;
  explicitlyAssigned?: boolean;
  /**
   * True when the page gave the value between an author's quote pair and the
   * quote is what makes it a value rather than prose, so the re-checks take
   * the phrase whole.
   */
  quoted?: boolean;
}

export interface RedactedMarkdown {
  markdown: string;
  title: string;
  credentials: RedactedCredential[];
}

export interface DocumentationRedactionOptions {
  /** The span model; documentation sync fails closed without one. */
  model?: SpanModel;
  /** Every value the owner already stores, removed before the model is asked. */
  known?: readonly string[];
}

const MARKER = /<credential:[^>]*>|<redacted:[^>]*>/g;

/** Normalise a label fragment for a marker and metadata row. */
function words(value: string): string {
  return value
    .toLowerCase()
    .replace(MARKER, ' ')
    .replace(/[`*_#[\](){}]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Infer a page system from its title when a line names only a kind. */
function systemFromTitle(title: string): string {
  const normalised = words(title)
    .replace(/\b(?:automation|policy|handbook|documentation|docs|access)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalised || 'system';
}

/**
 * The kinds of credential a line can declare, most specific first.
 *
 * Order is the whole rule: "dashboard login" has to be tried before "login",
 * and "service token" before "token", or the label would lose the part that
 * distinguishes one stored credential from another on the same page.
 */
const CREDENTIAL_KINDS: readonly [RegExp, string][] = [
  [/\bdashboard login\b/, 'dashboard login'],
  [/\bservice token\b/, 'service token'],
  [/\bconfiguration token\b/, 'configuration token'],
  [/\bbot token\b/, 'bot token'],
  [/\bapp token\b/, 'app token'],
  [/\buser token\b/, 'user token'],
  [/\bapi key\b/, 'api key'],
  [/\bclient secret\b/, 'client secret'],
  [/\bsigning secret\b/, 'signing secret'],
  [/\baccess key\b/, 'access key'],
  [/\blogin\b/, 'login'],
  [/\bpassphrase\b/, 'passphrase'],
  [/\bpassword\b/, 'password'],
  [/\btoken\b/, 'token'],
  [/\bsecret\b/, 'secret'],
  [/\bcredential\b/, 'credential'],
  [/\bkey\b/, 'key'],
];

/** What the model or the grammar called it, as the kind word of a label. */
const LABEL_KINDS: Readonly<Record<string, string>> = {
  password: 'password',
  'api key': 'api key',
  'secret key': 'secret',
  'access token': 'token',
  'private key': 'private key',
  credential: 'credential',
  'authentication token': 'token',
  'connection password': 'connection secret',
  'json web token': 'json web token',
  'header value': 'bearer token',
  secret: 'secret',
  [KNOWN_VALUE_LABEL]: 'credential',
};

/**
 * Name a stored credential from the line it was found on.
 *
 * The line's own words win ("Service token (RevOps automation):" names a
 * service token), then a system the line names, then the page title; the
 * model's label supplies the kind when the line does not.
 *
 * Args:
 *   line: The line the value sits on, value removed.
 *   label: The model's label or the structural rule.
 *   title: The redacted page title.
 *
 * Returns:
 *   A short label safe to store beside the ciphertext.
 */
function credentialLabel(line: string, label: string, title: string): string {
  // A provider grammar names the system and the kind itself.
  if (PROVIDER_LABELS.has(label) && label !== 'secret') return label;
  const descriptor = words(line.split(/[:=：]/, 1)[0]);
  const lineKind = CREDENTIAL_KINDS.find(([pattern]: [RegExp, string]): boolean =>
    pattern.test(descriptor),
  )?.[1];
  const kind = lineKind ?? LABEL_KINDS[label] ?? 'credential';
  const namedSystem = [
    'linear',
    'slack',
    'notion',
    'github',
    'stripe',
    'aws',
    'google',
    'openai',
    'anthropic',
    'postgres',
    'mysql',
    'redis',
  ].find((system: string): boolean => new RegExp(`\\b${system}\\b`).test(descriptor));
  return `${namedSystem || systemFromTitle(title)} ${kind}`;
}

/** Create the only safe representation written into documentation tables. */
export function credentialMarker(label: string): string {
  return `<credential: ${label}, stored>`;
}

/** The line a finding sits on, with the value itself blanked. */
function lineAround(text: string, finding: Finding): string {
  const start = text.lastIndexOf('\n', finding.start - 1) + 1;
  const endIndex = text.indexOf('\n', finding.end);
  const end = endIndex === -1 ? text.length : endIndex;
  return `${text.slice(start, finding.start)} ${text.slice(finding.end, end)}`;
}

/**
 * The most characters one request to the redaction component carries: about
 * six of the component's own 1,400-character prediction windows, twice the
 * longest page the tracked company bed sends today, and far under the
 * component's body limit, so no page fails on its size and each request has
 * the whole deadline for one window.
 */
const REDACTOR_WINDOW_CHARS = 8_000;
/** How far consecutive windows overlap, so a value one window cuts is whole in the next. */
const REDACTOR_WINDOW_OVERLAP = 400;

/** One window of a text: where it starts in the text, and what it holds. */
export interface TextWindow {
  readonly start: number;
  readonly text: string;
}

/**
 * Cut a text into overlapping windows of at most `size` characters, each
 * ending at a line break, or failing that a word break, where one falls in
 * its second half, and each
 * after the first starting after a break inside the overlap. A run with no
 * break is cut where it must be, never inside a surrogate pair.
 *
 * @param text - The text to cut.
 * @param size - The most characters a window holds.
 * @param overlap - How far a window reaches back into the one before.
 */
export function textWindows(text: string, size: number, overlap: number): TextWindow[] {
  const windows: TextWindow[] = [];
  let start = 0;
  for (;;) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1);
      const breakAt =
        newline > start + size / 2 ? newline : text.slice(start, end).search(/\s\S*$/) + start;
      if (breakAt > start + size / 2) end = breakAt + 1;
      else if (/[\ud800-\udbff]/.test(text.charAt(end - 1))) end -= 1;
    }
    windows.push({ start, text: text.slice(start, end) });
    if (end >= text.length) return windows;
    const reach = Math.max(end - overlap, start + 1);
    const afterBreak = text.slice(reach, end).search(/\s/);
    let next = afterBreak === -1 ? reach : reach + afterBreak + 1;
    if (/[\udc00-\udfff]/.test(text.charAt(next))) next -= 1;
    start = Math.max(next, start + 1);
  }
}

/**
 * The span model asked one window at a time.
 *
 * The component's HTTP client puts one deadline on a whole request and the
 * component refuses a body past its limit, so a long page sent whole failed
 * the source on a size or a time that had nothing to do with what the page
 * held. Each window is its own request with its own deadline; spans come back
 * at their offsets in the whole text, a span two windows both saw once.
 *
 * @param model - The span model to ask.
 * @returns A span model with the same name that never sends more than one
 *   window of a text.
 */
export function windowedSpanModel(model: SpanModel): SpanModel {
  return {
    name: model.name,
    async spans(text: string, labels: readonly string[], threshold: number): Promise<ModelSpan[]> {
      if (text.length <= REDACTOR_WINDOW_CHARS) return await model.spans(text, labels, threshold);
      const spans = new Map<string, ModelSpan>();
      for (const window of textWindows(text, REDACTOR_WINDOW_CHARS, REDACTOR_WINDOW_OVERLAP)) {
        for (const span of await model.spans(window.text, labels, threshold)) {
          const shifted = {
            ...span,
            start: span.start + window.start,
            end: span.end + window.start,
          };
          const key = `${shifted.start}:${shifted.end}:${shifted.label}`;
          if (!spans.has(key) || spans.get(key)!.score < shifted.score) spans.set(key, shifted);
        }
      }
      return [...spans.values()];
    },
  };
}

/**
 * Redact a page before any persistence.
 *
 * The title is redacted first, so a token in a heading never reaches
 * `docPages.title`, `mockDocs.title` or a marker label.
 *
 * Args:
 *   markdown: Raw page body returned by a reader.
 *   title: Raw page title.
 *   options: The span model and the owner's stored values.
 *
 * Returns:
 *   Redacted Markdown and title, and distinct plaintext values in document
 *   order for immediate storage.
 *
 * Raises:
 *   RedactorUnavailableError: When no model is configured or it cannot be
 *     reached; a page is never persisted unredacted.
 */
export async function redactCredentials(
  markdown: string,
  title: string,
  options: DocumentationRedactionOptions,
): Promise<RedactedMarkdown> {
  // Labels are decided as markers are written; the credential list is then
  // built in document order, title first, each value once.
  const labels = new Map<string, string>();
  let safeTitle = 'Documentation';
  const collect =
    (context: string) =>
    (finding: Finding): string => {
      if (!labels.has(finding.value)) {
        labels.set(
          finding.value,
          credentialLabel(lineAround(context, finding), finding.label, safeTitle),
        );
      }
      return credentialMarker(labels.get(finding.value) ?? finding.label);
    };
  const base: Omit<RedactOptions, 'secretMarker'> = {
    model: options.model ? windowedSpanModel(options.model) : undefined,
    known: options.known,
    onUnavailable: 'throw',
  };
  const titleResult = await redactText(title, 'documentation', {
    ...base,
    secretMarker: collect(title),
  });
  safeTitle = titleResult.text;
  const bodyResult = await redactText(markdown, 'documentation', {
    ...base,
    secretMarker: collect(markdown),
  });
  const credentials: RedactedCredential[] = [];
  for (const [context, findings] of [
    [title, titleResult.findings],
    [markdown, bodyResult.findings],
  ] as const) {
    for (const finding of findings) {
      if (finding.kind !== 'secret') continue;
      const quotedHere = quotedByAuthor(context, finding.start, finding.end);
      const assigned =
        explicitlyAssignedCredential(context, finding.start, finding.end) &&
        guardReason(finding.value) !== undefined &&
        guardReason(finding.value, { assigned: true, quoted: quotedHere }) === undefined;
      // Kept only where the quote is what lets the guard take the value, as
      // `explicitlyAssigned` is kept only where the assignment is.
      const quoted =
        quotedHere &&
        guardReason(finding.value, { assigned: true }) !== undefined &&
        guardReason(finding.value, { assigned: true, quoted: true }) === undefined;
      const existing = credentials.find((row) => row.plaintext === finding.value);
      if (existing) {
        if (assigned) existing.explicitlyAssigned = true;
        if (quoted) existing.quoted = true;
        continue;
      }
      // A stored value met in its escaped or encoded form is the same
      // credential, not a new one; met literally it is stored again so the
      // page's own row keeps its reference through a re-sync.
      if (finding.label === KNOWN_VALUE_LABEL && !options.known?.includes(finding.value)) continue;
      credentials.push({
        label: labels.get(finding.value) ?? finding.label,
        plaintext: finding.value,
        ...(assigned ? { explicitlyAssigned: true } : {}),
        ...(quoted ? { quoted: true } : {}),
      });
    }
  }
  return { markdown: bodyResult.text, title: safeTitle, credentials };
}

/**
 * Whether a found value sits between one of the author's quote pairs, the
 * marks right against it on either side.
 *
 * @param text - The text the value was found in.
 * @param start - Where the value starts.
 * @param end - Where it ends.
 */
function quotedByAuthor(text: string, start: number, end: number): boolean {
  return QUOTE_PAIRS.some(
    ([open, close]) =>
      text.slice(Math.max(0, start - open.length), start) === open &&
      text.slice(end, end + close.length) === close,
  );
}
