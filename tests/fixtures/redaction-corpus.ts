import { readFileSync } from 'node:fs';

/**
 * The labelled redaction corpus under `tests/fixtures/redaction/corpus.json`.
 *
 * The file carries `{{slot}}` placeholders where a token-shaped value goes; the
 * values are assembled here at runtime, from parts, so that no committed file
 * holds a string a secret scanner would report. Placeholders that are not slot
 * names (`{{secret}}`, `{{ secret }}`) are working material and stay literal.
 */

export type CorpusContext = 'documentation' | 'outcome' | 'record' | 'prompt';
export type SpanKind = 'secret' | 'pii' | 'working';

export interface CorpusSpan {
  /** The literal value after slot expansion; every occurrence is the span. */
  value: string;
  kind: SpanKind;
  label: string;
  role?: string;
  /** For a secret the transport already holds: the exact-value layer is given it. */
  known?: string;
  note?: string;
}

export interface CorpusCase {
  id: string;
  source: string;
  context: CorpusContext;
  language: 'en' | 'zh' | 'mixed';
  text: string;
  spans: CorpusSpan[];
}

const MIXED = 'aB3dE5fG7hI9jK1lM2nO4pQ6rS8tU0vW';
const MIXED_LONG = `${MIXED}xY1zA2bC3dE4fG5hI6jK7lM8nO9pQ0rS`;
const BEARER_VALUE = `opaque+${MIXED.slice(0, 24)}`;

/** Runtime-assembled slot values, keyed by the placeholder name in the corpus. */
export const CORPUS_SLOTS: Readonly<Record<string, string>> = {
  linear_token: `${['lin', 'api'].join('_')}_${MIXED}xyz12345`,
  slack_bot_token: `${['xox', 'b'].join('')}-1234567890-${MIXED}`,
  slack_user_token: `${['xox', 'p'].join('')}-1234567890-${MIXED}`,
  slack_app_token: `${['xox', 'a'].join('')}-1234567890-${MIXED}`,
  slack_config_token: `${['xox', 'e'].join('')}.${['xox', 'p'].join('')}-1-${MIXED}${MIXED.slice(0, 8)}`,
  notion_token: `${['nt', 'n'].join('')}_${MIXED}${MIXED.slice(0, 11)}`,
  notion_secret: `${['sec', 'ret'].join('')}_${MIXED}${MIXED.slice(0, 11)}`,
  aws_key: ['AK', 'IA', 'IOSFODNN7EXAMPLE'].join(''),
  github_classic: ['gh', 'p_', MIXED, 'wxyz'].join(''),
  github_fine: ['github', '_pat_', MIXED.slice(0, 22), '_', MIXED_LONG.slice(0, 59)].join(''),
  stripe_key: ['sk', '_live_', MIXED.slice(0, 24)].join(''),
  stripe_webhook: ['wh', 'sec_', MIXED].join(''),
  google_key: ['AI', 'za', 'Sy', MIXED, 'x'].join(''),
  openai_key: ['sk', '-proj-', MIXED, MIXED.slice(0, 16)].join(''),
  openai_plain: ['sk', '-', MIXED, MIXED.slice(0, 16)].join(''),
  anthropic_key: ['sk', '-ant-', 'api03-', MIXED, MIXED.slice(0, 16)].join(''),
  jwt: [
    'eyJ',
    'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    '.',
    'eyJ',
    'zdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0',
    '.',
    'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  ].join(''),
  db_password: ['w4reh0use', 'R3ad0nly', 'P4ss'].join(''),
  bearer_value: BEARER_VALUE,
  bearer_value_encoded: encodeURIComponent(BEARER_VALUE),
  client_secret: MIXED,
  api_key_mixed: `q7Mz2Kv9Tx4Wp6Rn8Js3${MIXED.slice(0, 12)}`,
  pem_body: [
    `b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW${MIXED.slice(0, 6)}`,
    `QyNTUxOQAAACB${MIXED}${MIXED_LONG.slice(0, 30)}AAAAEAAAAA`,
  ].join('\n'),
  basic_auth: Buffer.from('revops:hunter2').toString('base64'),
  credential_key_hex: `3f2a9c1e7b5d4a6f8e0c2b1d9a7f6e5c4b3a2d1e${'0f8fad5bd9cb469fa16570867728950e'.slice(0, 24)}`,
};

const SLOT = /\{\{([a-z_]+)\}\}/g;

/** Replace every known slot; unknown placeholders stay literal. */
function expand(text: string): string {
  return text.replace(SLOT, (match: string, name: string): string => CORPUS_SLOTS[name] ?? match);
}

/**
 * Load the corpus with every slot expanded.
 *
 * Returns:
 *   Every case, in file order, with concrete span values.
 */
export function loadRedactionCorpus(): CorpusCase[] {
  const raw = JSON.parse(
    readFileSync(new URL('./redaction/corpus.json', import.meta.url), 'utf8'),
  ) as { cases: CorpusCase[] };
  return raw.cases.map(
    (entry: CorpusCase): CorpusCase => ({
      ...entry,
      text: expand(entry.text),
      spans: entry.spans.map(
        (span: CorpusSpan): CorpusSpan => ({
          ...span,
          value: expand(span.value),
          ...(span.known ? { known: CORPUS_SLOTS[span.known] ?? span.known } : {}),
        }),
      ),
    }),
  );
}

/** The exact values a transport already holds for one case. */
export function knownValues(entry: CorpusCase): string[] {
  return [...new Set(entry.spans.flatMap((span: CorpusSpan): string[] => (span.known ? [span.known] : [])))];
}

/** Count non-overlapping occurrences of a value. */
export function occurrences(text: string, value: string): number {
  if (!value) return 0;
  return text.split(value).length - 1;
}

export interface ScoreMiss {
  id: string;
  label: string;
  value: string;
}

export interface RedactionScore {
  /** Secret spans with every occurrence removed. */
  truePositives: number;
  /** Secret spans with at least one occurrence surviving. */
  falseNegatives: number;
  /** Spans the policy keeps that lost at least one occurrence. */
  falsePositives: number;
  precision: number;
  recall: number;
  misses: ScoreMiss[];
  damaged: ScoreMiss[];
}

/**
 * Score one redaction function over the corpus by value survival.
 *
 * A span "must go" when it is a secret, or when `mustRedact` says the policy
 * redacts that span in the case's context; every other span must survive
 * intact. Detection is judged on the output text alone, so a redactor is free
 * to replace a value with any marker.
 *
 * Args:
 *   cases: Corpus cases to score.
 *   redact: The function under test, given the whole case.
 *   mustRedact: Whether a non-secret span is one the policy removes.
 *
 * Returns:
 *   Counts, precision and recall, and the spans missed or damaged.
 */
export function scoreRedaction(
  cases: CorpusCase[],
  redact: (entry: CorpusCase) => string,
  mustRedact: (span: CorpusSpan, entry: CorpusCase) => boolean = (): boolean => false,
): RedactionScore {
  const score: RedactionScore = {
    truePositives: 0,
    falseNegatives: 0,
    falsePositives: 0,
    precision: 0,
    recall: 0,
    misses: [],
    damaged: [],
  };
  for (const entry of cases) {
    const output = redact(entry);
    for (const span of entry.spans) {
      const before = occurrences(entry.text, span.value);
      const after = occurrences(output, span.value);
      const target = span.kind === 'secret' || mustRedact(span, entry);
      if (target) {
        if (after === 0) score.truePositives += 1;
        else {
          score.falseNegatives += 1;
          score.misses.push({ id: entry.id, label: span.label, value: span.value });
        }
      } else if (after < before) {
        score.falsePositives += 1;
        score.damaged.push({ id: entry.id, label: span.label, value: span.value });
      }
    }
  }
  const detected = score.truePositives + score.falsePositives;
  const targets = score.truePositives + score.falseNegatives;
  score.precision = detected === 0 ? 1 : score.truePositives / detected;
  score.recall = targets === 0 ? 1 : score.truePositives / targets;
  return score;
}
