export interface RedactedCredential {
  label: string;
  plaintext: string;
}

export interface RedactedMarkdown {
  markdown: string;
  title: string;
  credentials: RedactedCredential[];
}

interface CredentialMatch extends RedactedCredential {
  start: number;
  end: number;
}

/**
 * Prefixed provider tokens. Every real value carries at least 24 characters
 * after its prefix, so a short suffix (`ntn_prefix` in prose) is not a token.
 * `.` is excluded because no provider uses it, and it ends sentences.
 */
const SHAPED_VALUE = /(?:ntn_|lin_api_|xox[bpa]-|secret_)[A-Za-z0-9_-]{16,}/gi;
const LABELLED_VALUE = /(?:^|\n)[^\n:]{0,48}\b(?:token|key)\b[^\n:]{0,32}:\s*`?([^\s`]+)`?/gi;
/**
 * A line that declares a sign-in credential and puts its value in code
 * formatting.
 *
 * `token` and `key` appear in prose constantly ("key rotation: quarterly",
 * "token lifetime: 12 hours"), so a value on one of those lines has to look
 * like a secret before it is treated as one. The words here do not have that
 * problem, and a team that writes the value in backticks has said plainly that
 * it is a literal rather than a description - which is what lets a memorable
 * dashboard password be stored instead of read past. Without the backticks
 * nothing is taken, so "Password rotation: quarterly" stays prose.
 */
const DECLARED_VALUE =
  /(?:^|\n)[^\n:]{0,48}\b(?:login|password|passphrase|credential)\b[^\n:]{0,32}:\s*`([^\s`]+)`/gi;
const MARKER = /<credential:[^>]*>/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"_-]+$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Normalise a label fragment for a marker and metadata row. */
function words(value: string): string {
  return value
    .toLowerCase()
    .replace(MARKER, ' ')
    .replace(/[`*_#[\](){}]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Infer the stable system and credential kind from a recognised prefix. */
function shapedLabel(value: string, title: string): string {
  const lower = value.toLowerCase();
  if (lower.startsWith('lin_api_')) return 'linear service token';
  if (lower.startsWith('xoxb-')) return 'slack bot token';
  if (lower.startsWith('xoxp-')) return 'slack user token';
  if (lower.startsWith('xoxa-')) return 'slack app token';
  if (lower.startsWith('ntn_')) return 'notion connection token';
  return `${systemFromTitle(title)} secret`;
}

/** Infer a page system from its title when a labelled line names only a kind. */
function systemFromTitle(title: string): string {
  const normalised = words(title)
    .replace(/\b(?:automation|policy|handbook|documentation|docs|access)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalised || 'system';
}

/**
 * The kinds of credential a labelled line can declare, most specific first.
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
  [/\blogin\b/, 'login'],
  [/\bpassphrase\b/, 'passphrase'],
  [/\bpassword\b/, 'password'],
  [/\btoken\b/, 'token'],
  [/\bcredential\b/, 'credential'],
];

/** Infer a safe metadata label for a labelled credential line. */
function labelledLineLabel(line: string, title: string): string {
  const descriptor = words(line.split(':', 1)[0]);
  const kind =
    CREDENTIAL_KINDS.find(([pattern]: [RegExp, string]): boolean => pattern.test(descriptor))?.[1] ??
    'key';
  const namedSystem = ['linear', 'slack', 'notion'].find((system: string): boolean =>
    new RegExp(`\\b${system}\\b`).test(descriptor),
  );
  return `${namedSystem || systemFromTitle(title)} ${kind}`;
}

/**
 * Decide whether a labelled-line value can be a secret at all.
 *
 * A `token`/`key` line also introduces names (`Key contacts: Alice`), counts
 * (`Token budget: 20000`), scheme words (`Bot token: Bearer xoxb-...`),
 * pointers (`Service token: see the vault`) and locations (a vault URL). None
 * of those is a credential, and storing them would corrupt the page and the
 * owner's credential list. A real key mixes letters and digits or is long.
 *
 * Args:
 *   value: Captured value with trailing punctuation removed.
 *
 * Returns:
 *   True when the value is worth storing and redacting.
 */
export function looksLikeSecret(value: string): boolean {
  if (URL_SCHEME.test(value)) return false;
  const mixed = /[a-z]/i.test(value) && /[0-9]/.test(value);
  return (value.length >= 8 && mixed) || value.length >= 20;
}

/** Create the only safe representation written into documentation tables. */
export function credentialMarker(label: string): string {
  return `<credential: ${label}, stored>`;
}

/**
 * Locate every credential value in one text.
 *
 * Args:
 *   text: Page body or title.
 *   labelContext: Value-free title used to name generic lines.
 *
 * Returns:
 *   Non-overlapping matches in document order.
 */
function findCredentials(text: string, labelContext: string): CredentialMatch[] {
  const matches: CredentialMatch[] = [];
  for (const match of text.matchAll(SHAPED_VALUE)) {
    if (match.index === undefined) continue;
    const plaintext = match[0].replace(TRAILING_PUNCTUATION, '');
    matches.push({
      plaintext,
      label: shapedLabel(plaintext, labelContext),
      start: match.index,
      end: match.index + plaintext.length,
    });
  }
  for (const [pattern, requireSecretShape] of [
    [LABELLED_VALUE, true],
    [DECLARED_VALUE, false],
  ] as const) {
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined || !match[1] || match[1].startsWith('<credential')) continue;
      const plaintext = match[1].replace(TRAILING_PUNCTUATION, '');
      if (requireSecretShape && !looksLikeSecret(plaintext)) continue;
      if (URL_SCHEME.test(plaintext)) continue;
      const start = match.index + match[0].lastIndexOf(match[1]);
      const end = start + plaintext.length;
      if (matches.some((known): boolean => start < known.end && end > known.start)) continue;
      const line = match[0].replace(/^\n/, '');
      matches.push({ plaintext, label: labelledLineLabel(line, labelContext), start, end });
    }
  }
  return matches.sort((left, right): number => left.start - right.start);
}

/** Replace matched values with their markers, working from the end. */
function replaceCredentials(text: string, matches: CredentialMatch[]): string {
  let redacted = text;
  for (const match of [...matches].reverse()) {
    redacted = `${redacted.slice(0, match.start)}${credentialMarker(match.label)}${redacted.slice(match.end)}`;
  }
  return redacted;
}

/**
 * Detect credential values and replace them before any persistence.
 *
 * The title is redacted first, so a token in a heading or a provider page
 * title never reaches `docPages.title`, `mockDocs.title` or a marker label.
 *
 * Args:
 *   markdown: Raw page body returned by a reader.
 *   title: Raw page title used to label generic token lines.
 *
 * Returns:
 *   Redacted Markdown and title, and distinct plaintext values in document
 *   order for immediate storage.
 */
export function redactCredentials(markdown: string, title: string): RedactedMarkdown {
  const titleMatches = findCredentials(title, title.replace(SHAPED_VALUE, ' '));
  const safeTitle = replaceCredentials(title, titleMatches);
  const bodyMatches = findCredentials(markdown, safeTitle);
  const distinct = new Map<string, RedactedCredential>();
  for (const match of [...titleMatches, ...bodyMatches]) {
    if (!distinct.has(match.plaintext)) {
      distinct.set(match.plaintext, { label: match.label, plaintext: match.plaintext });
    }
  }
  return {
    markdown: replaceCredentials(markdown, bodyMatches),
    title: safeTitle,
    credentials: [...distinct.values()],
  };
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
