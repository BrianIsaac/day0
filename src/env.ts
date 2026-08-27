/// <reference types="node" />
import { z } from 'zod';

/**
 * Lazy env validation. All fields are `.optional()` or have defaults so
 * module loading never throws — Convex bundles and loads the modules
 * before the deployment env vars are wired, so a strict t3-env contract
 * would refuse to bundle. Each downstream client (`openai()`, `searchRole()`,
 * `daytona()`) validates the keys it actually needs at first call.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-5.5'),
  OPENAI_IMAGE_MODEL: z.string().default('gpt-image-2'),
  OPENAI_JSON_MODE: z.enum(['auto', 'native', 'prompt']).default('auto'),

  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_AGENT_ID: z.string().optional(),
  // Signs the post-call webhook. Its absence is not the same shape of absence
  // as the two above: without them voice never starts, without this one voice
  // runs and only post-call finalisation is refused. `pnpm check:setup` reports
  // the two separately.
  ELEVENLABS_WEBHOOK_SECRET: z.string().optional(),

  GOOGLE_API_KEY: z.string().optional(),
  GEMINI_LIVE_MODEL: z.string().default('gemini-flash-3.1-live'),

  EXA_API_KEY: z.string().optional(),

  DAYTONA_API_KEY: z.string().optional(),
  DAYTONA_API_URL: z.string().default('https://app.daytona.io/api'),

  // Where the bundled local sandbox (`pnpm sandbox:up`) puts its socket, as
  // the *deployment* sees it. The default is where docker-compose.yml mounts
  // the shared volume inside the backend container, so the documented route
  // configures nothing: an absent socket reads as "no local sandbox", which is
  // checked per run rather than at module load. Override it only for a backend
  // running somewhere else.
  SKILL_SANDBOX_SOCKET: z.string().default('/run/day0-sandbox/skill-sandbox.sock'),

  CONVEX_DEPLOYMENT: z.string().optional(),
  NEXT_PUBLIC_CONVEX_URL: z.string().optional(),
  // Self-hosted backend (docker-compose.yml). Read by the Convex CLI, not by
  // app code; mutually exclusive with CONVEX_DEPLOYMENT.
  CONVEX_SELF_HOSTED_URL: z.string().optional(),
  CONVEX_SELF_HOSTED_ADMIN_KEY: z.string().optional(),

  NEXT_PUBLIC_DEMO_BOSS_EMAIL: z.string().optional(),
  NEXT_PUBLIC_DEMO_TENANT_SLUG: z.string().default('acme-demo'),

  // `true` skips Clerk entirely and runs as one synthetic local user. Refused
  // outside `next dev` — see src/lib/dev-auth.ts.
  NEXT_PUBLIC_DEV_NO_AUTH: z.string().optional(),
  DAY0_SURFACE_MODE: z.enum(['mock', 'real']).default('mock'),
  DAY0_DOCS_ROOT: z.string().default('/docs'),
  DAY0_CREDENTIAL_KEY: z.string().optional(),
  DAY0_NOTION_MCP_AUTH_TOKEN: z.string().optional(),
  // The public origin a provider redirects an OAuth install back to. Absent on
  // the hosted mock and on any run that never provisions a dedicated app.
  DAY0_PUBLIC_URL: z.string().optional(),
  // The bundled browser driver, used only by a `browser-driven` surface. Like
  // the bundled documentation reader, it is configuration, not discovery.
  DAY0_BROWSER_MCP_URL: z.string().optional(),
});

/**
 * `.env.local` spells "not configured" as `KEY=`, and Next hands that
 * through as an empty string rather than dropping the variable. Every
 * reader means *absent* by it, so it is normalised once here rather than
 * re-checked at each call site.
 *
 * The difference is not cosmetic, and it is what the OpenAI-key route runs
 * into: `.env.example` ships `OPENAI_BASE_URL=`, and coming from a local
 * model you are told to clear it back to exactly that. An empty base URL is
 * not an absent one - it is a base to resolve against, and resolving
 * `/responses` against it yields a relative URL that fails before a request
 * is made, with `Failed to parse URL from /responses`.
 */
const OPTIONAL_STRINGS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_IMAGE_MODEL',
  'OPENAI_JSON_MODE',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_AGENT_ID',
  'ELEVENLABS_WEBHOOK_SECRET',
  'GOOGLE_API_KEY',
  'GEMINI_LIVE_MODEL',
  'EXA_API_KEY',
  'DAYTONA_API_KEY',
  'DAYTONA_API_URL',
  'SKILL_SANDBOX_SOCKET',
  'CONVEX_DEPLOYMENT',
  'NEXT_PUBLIC_CONVEX_URL',
  'CONVEX_SELF_HOSTED_URL',
  'CONVEX_SELF_HOSTED_ADMIN_KEY',
  'NEXT_PUBLIC_DEMO_BOSS_EMAIL',
  'NEXT_PUBLIC_DEMO_TENANT_SLUG',
  'NEXT_PUBLIC_DEV_NO_AUTH',
  'DAY0_SURFACE_MODE',
  'DAY0_DOCS_ROOT',
  'DAY0_CREDENTIAL_KEY',
  'DAY0_NOTION_MCP_AUTH_TOKEN',
  'DAY0_PUBLIC_URL',
  'DAY0_BROWSER_MCP_URL',
] as const;

/**
 * Normalising the parsed contract is not enough on its own, because the
 * provider SDKs do not read it: `@ai-sdk/openai` looks `OPENAI_BASE_URL` up
 * in `process.env` itself whenever no explicit `baseURL` is passed, and
 * takes `''` at face value. So the empty variables are dropped from the
 * environment as well, which is the only place a third-party client will
 * agree with us about what "not configured" means.
 */
function dropEmptyFromProcessEnv(): void {
  for (const key of OPTIONAL_STRINGS) {
    if (process.env[key] === '') delete process.env[key];
  }
}

function absentIfEmpty(
  raw: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, value === '' ? undefined : value]),
  );
}

dropEmptyFromProcessEnv();

export const env = schema.parse(
  absentIfEmpty({
    NODE_ENV: process.env.NODE_ENV,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    OPENAI_IMAGE_MODEL: process.env.OPENAI_IMAGE_MODEL,
    OPENAI_JSON_MODE: process.env.OPENAI_JSON_MODE,
    ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
    ELEVENLABS_AGENT_ID: process.env.ELEVENLABS_AGENT_ID,
    ELEVENLABS_WEBHOOK_SECRET: process.env.ELEVENLABS_WEBHOOK_SECRET,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    GEMINI_LIVE_MODEL: process.env.GEMINI_LIVE_MODEL,
    EXA_API_KEY: process.env.EXA_API_KEY,
    DAYTONA_API_KEY: process.env.DAYTONA_API_KEY,
    DAYTONA_API_URL: process.env.DAYTONA_API_URL,
    SKILL_SANDBOX_SOCKET: process.env.SKILL_SANDBOX_SOCKET,
    CONVEX_DEPLOYMENT: process.env.CONVEX_DEPLOYMENT,
    NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL,
    CONVEX_SELF_HOSTED_URL: process.env.CONVEX_SELF_HOSTED_URL,
    CONVEX_SELF_HOSTED_ADMIN_KEY: process.env.CONVEX_SELF_HOSTED_ADMIN_KEY,
    NEXT_PUBLIC_DEMO_BOSS_EMAIL: process.env.NEXT_PUBLIC_DEMO_BOSS_EMAIL,
    NEXT_PUBLIC_DEMO_TENANT_SLUG: process.env.NEXT_PUBLIC_DEMO_TENANT_SLUG,
    NEXT_PUBLIC_DEV_NO_AUTH: process.env.NEXT_PUBLIC_DEV_NO_AUTH,
    DAY0_SURFACE_MODE: process.env.DAY0_SURFACE_MODE,
    DAY0_DOCS_ROOT: process.env.DAY0_DOCS_ROOT,
    DAY0_CREDENTIAL_KEY: process.env.DAY0_CREDENTIAL_KEY,
    DAY0_NOTION_MCP_AUTH_TOKEN: process.env.DAY0_NOTION_MCP_AUTH_TOKEN,
    DAY0_PUBLIC_URL: process.env.DAY0_PUBLIC_URL,
    DAY0_BROWSER_MCP_URL: process.env.DAY0_BROWSER_MCP_URL,
  }),
);
