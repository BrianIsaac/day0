/**
 * What the bed's `.env.local` says, and what the rehearsal reads from the
 * operator's files without ever writing to them.
 */

/**
 * Application values copied from the operator's env file into the bed's.
 * Nothing here is a provider credential the agent acts with: the Linear key
 * and the Slack token are entered on their cards, as the operator does.
 */
export const COPIED_KEYS: readonly string[] = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CONVEX_OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_JSON_MODE',
  'OPENAI_STRUCTURED_REPAIR_ATTEMPTS',
  'OPENAI_MAX_OUTPUT_TOKENS',
  'OPENAI_REASONING_EFFORT',
  'EXA_API_KEY',
  'DAYTONA_API_KEY',
  'DAYTONA_API_URL',
  'NEXT_PUBLIC_DEMO_BOSS_EMAIL',
  'NEXT_PUBLIC_DEMO_TENANT_SLUG',
  'LOOKER_TILE_USER',
  'LOOKER_TILE_PASSWORD',
  'PLAYWRIGHT_ALLOWED_ORIGINS',
];

/**
 * Values the bed always generates or leaves empty, whatever the source says:
 * the admin key belongs to the new volume, the no-auth and credential keys are
 * minted for the bed, a cloud selector would point the CLI elsewhere, and the
 * two provider tokens must never reach the deployment env (the sync script
 * would push them under their retired names).
 */
export const NEVER_COPIED_KEYS: readonly string[] = [
  'CONVEX_SELF_HOSTED_ADMIN_KEY',
  'CONVEX_DEPLOYMENT',
  'DEV_NO_AUTH_SECRET',
  'DEV_NO_AUTH_SIGNING_KEY',
  'DEV_NO_AUTH_JWKS',
  'DAY0_CREDENTIAL_KEY',
  'DAY0_NOTION_MCP_AUTH_TOKEN',
  'LINEAR_API_KEY',
  'SLACK_BOT_TOKEN',
  'DAY0_TEST_SLACK_API_URL',
  'DAY0_TEST_SLACK_AUTHORIZE_URL',
  'DAY0_PUBLIC_URL',
];

export interface BedPorts {
  backend: number;
  site: number;
  dashboard: number;
  app: number;
}

export interface BedEnvInput {
  project: string;
  ports: BedPorts;
  /** Absolute host path of the documentation folder, mounted read-only. */
  docsHostDir: string;
  /** The operator's env values, read-only. */
  source: Readonly<Record<string, string>>;
}

/** Where the bed's backend reaches the two components it starts. */
const BROWSER_MCP_URL = 'http://playwright-mcp:8931/mcp';
const REDACTOR_URL = 'http://redactor:8000';

/**
 * The values the bed's `.env.local` carries on top of `.env.example`.
 *
 * Args:
 *   input: The project, its ports, the documentation mount and the source values.
 *
 * Returns:
 *   Names and values to write; keys in `NEVER_COPIED_KEYS` come out empty.
 */
export function bedEnvValues(input: BedEnvInput): Record<string, string> {
  const values: Record<string, string> = {
    COMPOSE_PROJECT_NAME: input.project,
    CONVEX_BIND_ADDR: '127.0.0.1',
    CONVEX_PORT: String(input.ports.backend),
    CONVEX_SITE_PROXY_PORT: String(input.ports.site),
    CONVEX_DASHBOARD_PORT: String(input.ports.dashboard),
    CONVEX_SELF_HOSTED_URL: `http://127.0.0.1:${input.ports.backend}`,
    NEXT_PUBLIC_CONVEX_URL: `http://127.0.0.1:${input.ports.backend}`,
    NEXT_PUBLIC_CONVEX_SITE_URL: `http://127.0.0.1:${input.ports.site}`,
    NEXT_PUBLIC_DEV_NO_AUTH: 'true',
    DAY0_SURFACE_MODE: 'real',
    DAY0_DOCS_HOST_DIR: input.docsHostDir,
    DAY0_DOCS_ROOT: '/docs',
    DAY0_BROWSER_MCP_URL: BROWSER_MCP_URL,
    DAY0_REDACTOR_URL: REDACTOR_URL,
  };
  for (const key of COPIED_KEYS) {
    const value = input.source[key];
    if (value !== undefined && value !== '') values[key] = value;
  }
  for (const key of NEVER_COPIED_KEYS) values[key] = '';
  return values;
}

/**
 * Why the source env cannot drive a bed, if it cannot.
 *
 * Args:
 *   source: The operator's env values.
 *
 * Returns:
 *   The refusal, or undefined.
 */
export function envRefusal(source: Readonly<Record<string, string>>): string | undefined {
  if (!source.OPENAI_API_KEY?.trim() && !source.OPENAI_BASE_URL?.trim()) {
    return 'the source env has neither OPENAI_API_KEY nor OPENAI_BASE_URL, and every step of the loop is a model call.';
  }
  if (!source.NEXT_PUBLIC_DEMO_BOSS_EMAIL?.trim()) {
    return 'the source env has no NEXT_PUBLIC_DEMO_BOSS_EMAIL; real mode resolves the manager DM from it at deploy and cannot be corrected on a live agent.';
  }
  return undefined;
}

export interface RehearsalSecrets {
  linearApiKey?: string;
  slackBotToken?: string;
}

/**
 * Parse an env-format file into its values.
 *
 * Args:
 *   text: The file's text.
 *
 * Returns:
 *   Names and values; a quoted value loses its quotes.
 */
export function parseEnvText(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return values;
}

/**
 * The two provider tokens out of the secrets file.
 *
 * Args:
 *   text: The file's text.
 *
 * Returns:
 *   Whichever of the two are present and non-empty.
 */
export function parseSecrets(text: string): RehearsalSecrets {
  const values = parseEnvText(text);
  const secrets: RehearsalSecrets = {};
  if (values.LINEAR_API_KEY) secrets.linearApiKey = values.LINEAR_API_KEY;
  if (values.SLACK_BOT_TOKEN) secrets.slackBotToken = values.SLACK_BOT_TOKEN;
  return secrets;
}

/**
 * Why the secrets cannot drive a rehearsal, if they cannot.
 *
 * Args:
 *   secrets: The parsed secrets.
 *
 * Returns:
 *   The refusal, or undefined. A missing Slack token is not a refusal: the
 *   run records that the Slack card was left unapproved.
 */
export function secretsRefusal(secrets: RehearsalSecrets): string | undefined {
  if (!secrets.linearApiKey) {
    return 'the secrets file has no LINEAR_API_KEY; nothing could be assigned, verified or put back in Linear.';
  }
  return undefined;
}
