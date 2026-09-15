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
import { redactText, type Finding, type RedactOptions } from '../redaction/redact';
import type { SpanModel } from '../redaction/client';
import { PROVIDER_LABELS } from '../redaction/structural';

export interface RedactedCredential {
  label: string;
  plaintext: string;
}

export interface RedactedMarkdown {
  markdown: string;
  title: string;
  credentials: RedactedCredential[];
}

export interface DocumentationRedactionOptions {
  /** The span model; documentation sync fails closed without one. */
  model?: SpanModel;
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
  const namedSystem = ['linear', 'slack', 'notion', 'github', 'stripe', 'aws', 'google', 'openai', 'anthropic', 'postgres', 'mysql', 'redis'].find(
    (system: string): boolean => new RegExp(`\\b${system}\\b`).test(descriptor),
  );
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
 * Redact a page before any persistence.
 *
 * The title is redacted first, so a token in a heading never reaches
 * `docPages.title`, `mockDocs.title` or a marker label.
 *
 * Args:
 *   markdown: Raw page body returned by a reader.
 *   title: Raw page title.
 *   options: The span model and any exact values the reader holds.
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
        labels.set(finding.value, credentialLabel(lineAround(context, finding), finding.label, safeTitle));
      }
      return credentialMarker(labels.get(finding.value) ?? finding.label);
    };
  const base: Omit<RedactOptions, 'secretMarker'> = { model: options.model, onUnavailable: 'throw' };
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
  for (const finding of [...titleResult.findings, ...bodyResult.findings]) {
    if (finding.kind !== 'secret' || credentials.some((row) => row.plaintext === finding.value)) continue;
    credentials.push({ label: labels.get(finding.value) ?? finding.label, plaintext: finding.value });
  }
  return { markdown: bodyResult.text, title: safeTitle, credentials };
}

/**
 * Build a deterministic source reference for every credential on a page.
 *
 * Args:
 *   pageRef: Stable provider page reference.
 *   credential: Extracted credential metadata.
 *   total: Number of distinct credentials found on the page.
 *   index: Stable zero-based position when the page contains several values.
 *
 * Returns:
 *   Exact page ref for the common single-value case, or a label-qualified ref
 *   when a page contains more than one value.
 */
export function credentialSourceRef(
  pageRef: string,
  credential: RedactedCredential,
  total: number,
  index = 0,
): string {
  return total === 1
    ? pageRef
    : `${pageRef}#credential=${index + 1}-${encodeURIComponent(credential.label)}`;
}
