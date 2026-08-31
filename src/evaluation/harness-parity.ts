import { env } from '../env';
import {
  MODEL_CALL_TIMEOUT_MS,
  MODEL_PROVIDER_MAX_RETRIES,
  MODEL_RETRY_POLICY,
  MODEL_TEMPERATURE,
} from '../lib/mastra';
import { MODEL } from '../lib/openai';

export interface ArmHarnessParameters {
  modelId: string;
  temperature: number;
  modelCallAbortMs: number;
  taskTimeoutMs: Record<string, number>;
  retryPolicy: {
    providerMaxRetries: number;
    outer: typeof MODEL_RETRY_POLICY;
  };
  providerClient: string;
  providerBaseUrl: string;
  contextLimitTokens: number | null;
  structuredOutputMode: 'auto' | 'native' | 'prompt';
  modelSeed: null;
}

export interface EvaluationHarnessParameters {
  day0: ArmHarnessParameters;
  baseline: ArmHarnessParameters;
}

export const INTENTIONAL_ARM_DIFFERENCES = {
  onboardingPipeline: {
    day0: 'runtime charter, loaded documents, approved plan, and exact-action gate',
    baseline: 'none',
  },
  executionTurn: {
    day0: 'one governed structured executor turn after onboarding',
    baseline: 'one five-tool in-generation loop',
  },
} as const;

export type IntentionalArmDifferences = typeof INTENTIONAL_ARM_DIFFERENCES;

function configuredContextLimit(): number | null {
  const value = Number(process.env.OLLAMA_CONTEXT_LENGTH);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function providerBaseUrl(): string {
  return process.env.CONVEX_OPENAI_BASE_URL ?? env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
}

function armParameters(taskTimeoutMs: Record<string, number>): ArmHarnessParameters {
  return {
    modelId: MODEL,
    temperature: MODEL_TEMPERATURE,
    modelCallAbortMs: MODEL_CALL_TIMEOUT_MS,
    taskTimeoutMs: { ...taskTimeoutMs },
    retryPolicy: {
      providerMaxRetries: MODEL_PROVIDER_MAX_RETRIES,
      outer: MODEL_RETRY_POLICY,
    },
    providerClient:
      providerBaseUrl() !== 'https://api.openai.com/v1'
        ? '@ai-sdk/openai chat-completions through Mastra'
        : 'Mastra OpenAI model router',
    providerBaseUrl: providerBaseUrl(),
    contextLimitTokens: configuredContextLimit(),
    structuredOutputMode: env.OPENAI_JSON_MODE,
    modelSeed: null,
  };
}

/** Resolve each arm independently, then assert equality before evidence starts. */
export function evaluationHarnessParameters(
  taskTimeoutMs: Record<string, number>,
): EvaluationHarnessParameters {
  const parameters = {
    day0: armParameters(taskTimeoutMs),
    baseline: armParameters(taskTimeoutMs),
  };
  assertEvaluationHarnessParity(parameters);
  return parameters;
}

/** Fail before a run if any harness/model parameter differs across arms. */
export function assertEvaluationHarnessParity(parameters: EvaluationHarnessParameters): void {
  const day0 = parameters.day0 as unknown as Record<string, unknown>;
  const baseline = parameters.baseline as unknown as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(day0), ...Object.keys(baseline)])].sort();
  const different = keys.filter(
    (key) => JSON.stringify(day0[key]) !== JSON.stringify(baseline[key]),
  );
  if (different.length > 0) {
    throw new Error(`evaluation harness differs between arms: ${different.join(', ')}`);
  }
}
