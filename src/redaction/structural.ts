/**
 * The structural grammar: formats that carry a secret by construction.
 *
 * These are not heuristics about what a secret looks like; they are the
 * syntax of five formats in which the secret's position is fixed. A URL's
 * userinfo password, the body of a PEM private-key block, the three segments
 * of a JSON web token, the value after an `Authorization` scheme word and a
 * provider token with a fixed prefix and alphabet are secrets wherever they
 * occur, whatever a model thinks. The grammar is synchronous and
 * dependency-free, which is why it is also the floor applied where no model
 * can be called: a Convex query rendering an export, and the prompt text
 * assembled from material that was redacted when stored. What is gone is
 * every rule that judged a value by how random it looked.
 */

export type StructuralLabel =
  | 'connection password'
  | 'private key'
  | 'json web token'
  | 'header value'
  | (typeof PROVIDER_SHAPES)[number]['label'];

export interface StructuralSpan {
  start: number;
  end: number;
  label: StructuralLabel;
}

/**
 * Provider tokens with a fixed prefix and a fixed alphabet. A grammar, not a
 * guess: `xoxb-` followed by eight or more token characters is a Slack bot
 * token and nothing else. Most specific first where two share a prefix. The
 * prefixes are case-sensitive and must not follow an identifier character,
 * so `NOTION_SECRET_TOKEN_POLICY` is a variable name and `ntn_prefix` in
 * prose is not a token. `.` is excluded from every tail because no provider
 * uses it and it ends sentences.
 */
export const PROVIDER_SHAPES = [
  { pattern: /lin_api_[A-Za-z0-9_-]{8,}/, label: 'linear service token' },
  { pattern: /xoxe\.xox[abps]-[A-Za-z0-9_-]{8,}/, label: 'slack configuration token' },
  { pattern: /xoxb-[A-Za-z0-9_-]{8,}/, label: 'slack bot token' },
  { pattern: /xoxp-[A-Za-z0-9_-]{8,}/, label: 'slack user token' },
  { pattern: /xoxa-[A-Za-z0-9_-]{8,}/, label: 'slack app token' },
  { pattern: /xox[es]-[A-Za-z0-9_-]{8,}/, label: 'slack token' },
  { pattern: /ntn_[A-Za-z0-9_-]{8,}/, label: 'notion connection token' },
  { pattern: /secret_[A-Za-z0-9_-]{16,}/, label: 'secret' },
  { pattern: /AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/, label: 'aws access key' },
  { pattern: /ghp_[A-Za-z0-9]{36}(?![A-Za-z0-9])/, label: 'github personal access token' },
  { pattern: /github_pat_[A-Za-z0-9_]{40,}/, label: 'github personal access token' },
  { pattern: /sk_live_[A-Za-z0-9]{16,}/, label: 'stripe api key' },
  { pattern: /whsec_[A-Za-z0-9]{16,}/, label: 'webhook signing secret' },
  { pattern: /AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/, label: 'google api key' },
  { pattern: /sk-ant-[A-Za-z0-9_-]{20,}/, label: 'anthropic api key' },
  { pattern: /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/, label: 'openai api key' },
] as const;
const PROVIDER_PREFIX = new RegExp(
  `(?<![A-Za-z0-9_-])(?:${PROVIDER_SHAPES.map((shape): string => `(${shape.pattern.source})`).join('|')})`,
  'g',
);
/** The labels the provider grammar emits, which name the system and the kind at once. */
export const PROVIDER_LABELS: ReadonlySet<string> = new Set(
  PROVIDER_SHAPES.map((shape): string => shape.label),
);

/**
 * The password segment of a connection string. The scheme, user and host
 * stay in the clear: they are the address the runbook needs, and only the
 * password is the credential.
 */
export const CONNECTION_PASSWORD = /(?<![A-Za-z0-9])([a-z][a-z0-9+.-]*):\/\/[^\s/:@`'"<>]*:([^\s/@`'"<>]+)@/gi;
const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----\s*([\s\S]*?)\s*-----END [A-Z ]*PRIVATE KEY-----/g;
const JSON_WEB_TOKEN = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g;
/**
 * The value after an `Authorization` scheme word. Eight characters keeps
 * "Bearer header." in prose out; a placeholder (`Bearer <token>`,
 * `Bearer {{secret}}`, `Bearer YOUR_TOKEN`) is left as the safe form it is.
 */
const HEADER_VALUE = /\b(?:Bearer|Basic)\s+([^\s,;"'`<>\\]{8,})/g;
/** A named credential header: `X-Api-Key: value`, `Api-Key: value`, `X-Auth-Token: value`. */
const CREDENTIAL_HEADER = /\b(?:X-Api-Key|Api-Key|X-Auth-Token|X-Access-Token)\s*:\s*([^\s,;"'`<>\\]{8,})/gi;
/** curl's `-u user:password` and `--user user:password`. */
const CURL_USER = /(?:^|\s)(?:-u|--user)\s+[^\s:@"']+:([^\s"']+)/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;
/** A value that refers to a secret rather than carrying one: `<password>`, `${VAR}`, `{{ secret }}`. */
export const REFERENCE_START = /^[<${]/;
export const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
/** An upper-case name with no digits is a placeholder or a variable name, never a value. */
const UPPER_NAME = /^[A-Z][A-Z_]{2,}$/;

/**
 * Locate every structural secret in a text.
 *
 * Args:
 *   text: Any text.
 *
 * Returns:
 *   Non-overlapping spans in document order.
 */
export function structuralSpans(text: string): StructuralSpan[] {
  const spans: StructuralSpan[] = [];
  for (const match of text.matchAll(CONNECTION_PASSWORD)) {
    if (match.index === undefined || REFERENCE_START.test(match[2])) continue;
    const start = match.index + match[0].lastIndexOf(`${match[2]}@`);
    spans.push({ start, end: start + match[2].length, label: 'connection password' });
  }
  for (const match of text.matchAll(PEM_BLOCK)) {
    if (match.index === undefined || !match[1]) continue;
    const start = match.index + match[0].indexOf(match[1]);
    spans.push({ start, end: start + match[1].length, label: 'private key' });
  }
  for (const match of text.matchAll(JSON_WEB_TOKEN)) {
    if (match.index === undefined) continue;
    spans.push({ start: match.index, end: match.index + match[0].length, label: 'json web token' });
  }
  for (const match of text.matchAll(PROVIDER_PREFIX)) {
    if (match.index === undefined) continue;
    const group = match.slice(1).findIndex((value): boolean => value !== undefined);
    const label = PROVIDER_SHAPES[Math.max(group, 0)].label;
    spans.push({ start: match.index, end: match.index + match[0].length, label });
  }
  for (const pattern of [HEADER_VALUE, CREDENTIAL_HEADER, CURL_USER]) {
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue;
      const value = match[1].replace(TRAILING_PUNCTUATION, '');
      if (REFERENCE_START.test(value) || UPPER_NAME.test(value) || value.startsWith('<credential:')) continue;
      const start = match.index + match[0].lastIndexOf(match[1]);
      spans.push({ start, end: start + value.length, label: 'header value' });
    }
  }
  return mergeSpans(spans);
}

/** Drop spans inside an earlier one and sort the rest by position. */
export function mergeSpans<T extends { start: number; end: number }>(spans: T[]): T[] {
  const sorted = [...spans].sort(
    (left, right): number => left.start - right.start || right.end - left.end,
  );
  const kept: T[] = [];
  for (const span of sorted) {
    const last = kept[kept.length - 1];
    if (last && span.start < last.end) continue;
    kept.push(span);
  }
  return kept;
}

/**
 * Replace spans with a marker, working from the end so offsets hold.
 *
 * Args:
 *   text: The text the spans index into.
 *   spans: Non-overlapping spans.
 *   marker: What each span becomes, given its span.
 *
 * Returns:
 *   The text with every span replaced.
 */
export function replaceSpans<T extends { start: number; end: number }>(
  text: string,
  spans: T[],
  marker: (span: T) => string,
): string {
  let out = text;
  for (const span of [...spans].sort((left, right): number => right.start - left.start)) {
    out = `${out.slice(0, span.start)}${marker(span)}${out.slice(span.end)}`;
  }
  return out;
}
