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
  OPENAI_MODEL: z.string().default('gpt-5.5'),
  OPENAI_IMAGE_MODEL: z.string().default('gpt-image-2'),

  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_AGENT_ID: z.string().optional(),

  GOOGLE_API_KEY: z.string().optional(),
  GEMINI_LIVE_MODEL: z.string().default('gemini-flash-3.1-live'),

  EXA_API_KEY: z.string().optional(),

  DAYTONA_API_KEY: z.string().optional(),
  DAYTONA_API_URL: z.string().default('https://app.daytona.io/api'),

  CONVEX_DEPLOYMENT: z.string().optional(),
  NEXT_PUBLIC_CONVEX_URL: z.string().optional(),

  NEXT_PUBLIC_DEMO_BOSS_EMAIL: z.string().optional(),
  NEXT_PUBLIC_DEMO_TENANT_SLUG: z.string().default('acme-demo'),
});

export const env = schema.parse({
  NODE_ENV: process.env.NODE_ENV,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_IMAGE_MODEL: process.env.OPENAI_IMAGE_MODEL,
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID: process.env.ELEVENLABS_AGENT_ID,
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  GEMINI_LIVE_MODEL: process.env.GEMINI_LIVE_MODEL,
  EXA_API_KEY: process.env.EXA_API_KEY,
  DAYTONA_API_KEY: process.env.DAYTONA_API_KEY,
  DAYTONA_API_URL: process.env.DAYTONA_API_URL,
  CONVEX_DEPLOYMENT: process.env.CONVEX_DEPLOYMENT,
  NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL,
  NEXT_PUBLIC_DEMO_BOSS_EMAIL: process.env.NEXT_PUBLIC_DEMO_BOSS_EMAIL,
  NEXT_PUBLIC_DEMO_TENANT_SLUG: process.env.NEXT_PUBLIC_DEMO_TENANT_SLUG,
});
