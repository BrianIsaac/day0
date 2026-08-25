export interface RedactedCredential {
  label: string;
  plaintext: string;
}

export interface RedactedMarkdown {
  markdown: string;
  credentials: RedactedCredential[];
}

interface CredentialMatch extends RedactedCredential {
  start: number;
  end: number;
}

const SHAPED_VALUE = /(?:ntn_|lin_api_|xox[bpa]-|secret_)[A-Za-z0-9._-]{6,}/gi;
const LABELLED_VALUE = /(?:^|\n)[^\n:]{0,48}\b(?:token|key)\b[^\n:]{0,32}:\s*`?([^\s`]+)`?/gi;

/** Normalise a label fragment for a marker and metadata row. */
function words(value: string): string {
  return value
    .toLowerCase()
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

/** Infer a safe metadata label for a generic `token` or `key` line. */
function labelledLineLabel(line: string, title: string): string {
  const descriptor = words(line.split(':', 1)[0]);
  const kind = /\bservice token\b/.test(descriptor)
    ? 'service token'
    : /\bconfiguration token\b/.test(descriptor)
      ? 'configuration token'
      : /\bbot token\b/.test(descriptor)
        ? 'bot token'
        : /\bapp token\b/.test(descriptor)
          ? 'app token'
          : /\buser token\b/.test(descriptor)
            ? 'user token'
            : /\bapi key\b/.test(descriptor)
              ? 'api key'
              : /\btoken\b/.test(descriptor)
                ? 'token'
                : 'key';
  const namedSystem = ['linear', 'slack', 'notion'].find((system: string): boolean =>
    new RegExp(`\\b${system}\\b`).test(descriptor),
  );
  return `${namedSystem || systemFromTitle(title)} ${kind}`;
}

/** Create the only safe representation written into documentation tables. */
export function credentialMarker(label: string): string {
  return `<credential: ${label}, stored>`;
}

/**
 * Detect credential values and replace them before any persistence.
 *
 * Args:
 *   markdown: Raw page body returned by a reader.
 *   title: Page title used to label generic token lines.
 *
 * Returns:
 *   Redacted Markdown and distinct plaintext values for immediate storage.
 */
export function redactCredentials(markdown: string, title: string): RedactedMarkdown {
  const matches: CredentialMatch[] = [];
  for (const match of markdown.matchAll(SHAPED_VALUE)) {
    if (match.index === undefined) continue;
    matches.push({
      plaintext: match[0],
      label: shapedLabel(match[0], title),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  for (const match of markdown.matchAll(LABELLED_VALUE)) {
    if (match.index === undefined || !match[1] || match[1].startsWith('<credential')) continue;
    const valueOffset = match[0].lastIndexOf(match[1]);
    const start = match.index + valueOffset;
    const end = start + match[1].length;
    if (matches.some((known): boolean => start < known.end && end > known.start)) continue;
    const line = match[0].replace(/^\n/, '');
    matches.push({
      plaintext: match[1],
      label: labelledLineLabel(line, title),
      start,
      end,
    });
  }
  matches.sort((left, right): number => left.start - right.start);
  const credentials: RedactedCredential[] = [];
  const distinct = new Map<string, RedactedCredential>();
  let redacted = markdown;
  for (const match of [...matches].reverse()) {
    redacted = `${redacted.slice(0, match.start)}${credentialMarker(match.label)}${redacted.slice(match.end)}`;
    distinct.set(match.plaintext, { label: match.label, plaintext: match.plaintext });
  }
  credentials.push(...distinct.values());
  return { markdown: redacted, credentials };
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
