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

interface ProviderShape {
  pattern: RegExp;
  label: string | ((title: string) => string);
}

/**
 * Prefixed provider tokens, most specific first where two share a prefix.
 *
 * Every real value carries a fixed tail after its prefix (`AKIA` and `AIza`
 * exactly, the others at least 16 characters), so a short suffix
 * (`ntn_prefix` in prose) is not a token. `.` is excluded from every tail
 * because no provider uses it and it ends sentences. The prefixes are
 * case-sensitive and must not follow an identifier character, so an
 * environment variable name (`NOTION_SECRET_TOKEN_POLICY`) is not a token.
 */
const PROVIDER_SHAPES: readonly ProviderShape[] = [
  { pattern: /lin_api_[A-Za-z0-9_-]{16,}/, label: 'linear service token' },
  { pattern: /xoxb-[A-Za-z0-9_-]{16,}/, label: 'slack bot token' },
  { pattern: /xoxp-[A-Za-z0-9_-]{16,}/, label: 'slack user token' },
  { pattern: /xoxa-[A-Za-z0-9_-]{16,}/, label: 'slack app token' },
  { pattern: /ntn_[A-Za-z0-9_-]{16,}/, label: 'notion connection token' },
  {
    pattern: /secret_[A-Za-z0-9_-]{16,}/,
    label: (title: string): string => `${systemFromTitle(title)} secret`,
  },
  { pattern: /AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/, label: 'aws access key' },
  { pattern: /ghp_[A-Za-z0-9]{36}(?![A-Za-z0-9])/, label: 'github personal access token' },
  { pattern: /github_pat_[A-Za-z0-9_]{40,}/, label: 'github personal access token' },
  { pattern: /sk_live_[A-Za-z0-9]{16,}/, label: 'stripe api key' },
  { pattern: /whsec_[A-Za-z0-9]{16,}/, label: 'webhook signing secret' },
  { pattern: /AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/, label: 'google api key' },
  { pattern: /sk-ant-[A-Za-z0-9_-]{20,}/, label: 'anthropic api key' },
  { pattern: /sk-[A-Za-z0-9_-]{20,}/, label: 'openai api key' },
  {
    pattern: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/,
    label: (title: string): string => `${systemFromTitle(title)} json web token`,
  },
];
const SHAPED_VALUE = new RegExp(
  `(?<![A-Za-z0-9_-])(?:${PROVIDER_SHAPES.map((shape): string => `(${shape.pattern.source})`).join('|')})`,
  'g',
);
/**
 * The password segment of a connection string. The scheme, user and host
 * stay in the clear: they are the address the runbook needs, and only the
 * password is the credential.
 */
const CONNECTION_PASSWORD = /(?<![A-Za-z0-9])([a-z][a-z0-9+.-]*):\/\/[^\s/:@`'"<>]*:([^\s/@`'"<>]+)@/gi;
/**
 * The value after the `Bearer` scheme word. Twelve characters keeps
 * "Bearer header." in prose out, and the value must still look like a secret
 * so "Bearer YOUR_TOKEN_HERE" is read as the placeholder it is.
 */
const BEARER_VALUE = /\bBearer\s+([^\s,;"'`<>]{12,})/gi;
const LABELLED_VALUE = /(?:^|\n)[^\n:]{0,48}\b(?:token|key|secret)\b[^\n:]{0,32}:\s*`?([^\s`]+)`?/gi;
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
/** A value that refers to a secret rather than carrying one: `<password>`, `${VAR}`, `{{ secret }}`. */
const REFERENCE_START = /^[<${]/;



/** Normalise a label fragment for a marker and metadata row. */
function words(value: string): string {
  return value
    .toLowerCase()
    .replace(MARKER, ' ')
    .replace(/[`*_#[\](){}]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
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
  [/\bclient secret\b/, 'client secret'],
  [/\bsigning secret\b/, 'signing secret'],
  [/\blogin\b/, 'login'],
  [/\bpassphrase\b/, 'passphrase'],
  [/\bpassword\b/, 'password'],
  [/\btoken\b/, 'token'],
  [/\bsecret\b/, 'secret'],
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
 * pointers (`Service token: see the vault`), locations (a vault URL),
 * and references (`${LINEAR_TOKEN}`). None of those is a credential, and
 * storing them would corrupt the page and the owner's credential list. A real
 * key mixes letters and digits or is long.
 *
 * Args:
 *   value: Captured value with trailing punctuation removed.
 *
 * Returns:
 *   True when the value is worth storing and redacting.
 */
export function looksLikeSecret(value: string): boolean {
  if (URL_SCHEME.test(value) || REFERENCE_START.test(value)) return false;
  const mixed = /[a-z]/i.test(value) && /[0-9]/.test(value);
  return (value.length >= 8 && mixed) || value.length >= 20;
}

/** Create the only safe representation written into documentation tables. */
export function credentialMarker(label: string): string {
  return `<credential: ${label}, stored>`;
}

/** Label a provider-shaped match by the alternative that captured it. */
function shapedLabel(match: RegExpMatchArray, title: string): string {
  const index = match.slice(1).findIndex((group): boolean => group !== undefined);
  const label = PROVIDER_SHAPES[Math.max(index, 0)].label;
  return typeof label === 'string' ? label : label(title);
}

/**
 * Locate every credential value in one text.
 *
 * Provider shapes are taken wherever they occur. Every other detector
 * captures a value out of its context (a connection string, a `Bearer`
 * scheme word, a labelled or declaring line), so it yields to any match
 * already found on the same characters and, where the context is a mere
 * word, the value must also look like a secret.
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
  const overlaps = (start: number, end: number): boolean =>
    matches.some((known): boolean => start < known.end && end > known.start);
  for (const match of text.matchAll(SHAPED_VALUE)) {
    if (match.index === undefined) continue;
    const plaintext = match[0].replace(TRAILING_PUNCTUATION, '');
    matches.push({
      plaintext,
      label: shapedLabel(match, labelContext),
      start: match.index,
      end: match.index + plaintext.length,
    });
  }
  for (const match of text.matchAll(CONNECTION_PASSWORD)) {
    if (match.index === undefined || REFERENCE_START.test(match[2])) continue;
    const start = match.index + match[0].lastIndexOf(`${match[2]}@`);
    const end = start + match[2].length;
    if (overlaps(start, end)) continue;
    const label = `${match[1].toLowerCase()} connection secret`;
    matches.push({ plaintext: match[2], label, start, end });
  }
  for (const match of text.matchAll(BEARER_VALUE)) {
    if (match.index === undefined) continue;
    const plaintext = match[1].replace(TRAILING_PUNCTUATION, '');
    if (!looksLikeSecret(plaintext)) continue;
    const start = match.index + match[0].lastIndexOf(match[1]);
    const end = start + plaintext.length;
    if (overlaps(start, end)) continue;
    matches.push({ plaintext, label: `${systemFromTitle(labelContext)} bearer token`, start, end });
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
      if (overlaps(start, end)) continue;
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
