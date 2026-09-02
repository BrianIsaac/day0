import { execFileSync } from 'node:child_process';
import { env } from '../env';
import {
  MODEL_CALL_TIMEOUT_MS,
  MODEL_CONFIG,
  MODEL_PROVIDER_MAX_RETRIES,
  MODEL_RETRY_POLICY,
  MODEL_TEMPERATURE,
  providerWarningTexts,
} from '../lib/mastra';
import { MODEL } from '../lib/openai';

/**
 * Provider facts recorded alongside the knobs. They describe the bed rather
 * than configure it, so they are diagnostics, but they live on the same record
 * so the per-arm table proves both arms saw the same provider.
 */
export interface ArmHarnessDiagnostics {
  effectiveTemperature: number | null;
  providerWarnings: string[];
  ollamaVersion: string | null;
  ollamaModelDigest: string | null;
}

export interface ArmHarnessParameters extends ArmHarnessDiagnostics {
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
  /**
   * Harness v2 is a single fixed bed contract: the harness preflight proves
   * the deployment selects the local sandbox before any evidence is written,
   * so the record carries the literal it enforces rather than a value read
   * from the operator shell.
   */
  skillSandboxBackend: 'local';
}

export interface EvaluationHarnessParameters {
  day0: ArmHarnessParameters;
  baseline: ArmHarnessParameters;
}

export interface OllamaMetadata {
  version: string | null;
  modelDigest: string | null;
}

export interface HarnessParityDependencies {
  readOllamaMetadata?: (baseUrl: string, model: string) => OllamaMetadata;
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

function nonEmpty(value: string | undefined): string | undefined {
  const normalised = value?.trim();
  return normalised ? normalised : undefined;
}

function configuredBaseUrl(): string | undefined {
  return nonEmpty(process.env.CONVEX_OPENAI_BASE_URL) ?? nonEmpty(env.OPENAI_BASE_URL);
}

function configuredContextLimit(customBaseUrl: string | undefined): number | null {
  if (!customBaseUrl) return null;
  const value = Number(process.env.OLLAMA_CONTEXT_LENGTH);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function providerBaseUrl(): string {
  return configuredBaseUrl() ?? 'https://api.openai.com/v1';
}

function expectedProviderWarnings(): string[] {
  const reasoningModel =
    MODEL.startsWith('o1') ||
    MODEL.startsWith('o3') ||
    MODEL.startsWith('o4-mini') ||
    (MODEL.startsWith('gpt-5') && !MODEL.startsWith('gpt-5-chat'));
  return reasoningModel
    ? providerWarningTexts([
        {
          type: 'unsupported',
          feature: 'temperature',
          details: 'temperature is not supported for reasoning models',
        },
      ])
    : [];
}

function curlJson(url: string, body?: object): unknown {
  const args = ['--fail', '--silent', '--show-error', '--max-time', '2'];
  if (body) {
    args.push('-H', 'Content-Type: application/json', '--data', JSON.stringify(body));
  }
  args.push(url);
  return JSON.parse(
    execFileSync('curl', args, {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  ) as unknown;
}

function ollamaHostBaseUrl(actualBaseUrl: string): string {
  const hostBaseUrl = nonEmpty(process.env.OPENAI_BASE_URL) ?? actualBaseUrl;
  return hostBaseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

function digestFromShow(show: unknown): string | null {
  if (!show || typeof show !== 'object') return null;
  const row = show as { digest?: unknown; modelfile?: unknown };
  if (typeof row.digest === 'string' && row.digest.trim()) return row.digest.trim();
  if (typeof row.modelfile !== 'string') return null;
  const digest = /sha256[-:]([a-f0-9]{64})/i.exec(row.modelfile)?.[1];
  return digest ? `sha256:${digest.toLowerCase()}` : null;
}

function readOllamaMetadata(baseUrl: string, model: string): OllamaMetadata {
  const host = ollamaHostBaseUrl(baseUrl);
  try {
    const version = curlJson(`${host}/api/version`) as { version?: unknown };
    const show = curlJson(`${host}/api/show`, { model });
    return {
      version: typeof version.version === 'string' ? version.version : null,
      modelDigest: digestFromShow(show),
    };
  } catch {
    return { version: null, modelDigest: null };
  }
}

function armParameters(
  taskTimeoutMs: Record<string, number>,
  dependencies: HarnessParityDependencies,
): ArmHarnessParameters {
  const customBaseUrl = configuredBaseUrl();
  const warnings = expectedProviderWarnings();
  const ollama = customBaseUrl
    ? (dependencies.readOllamaMetadata ?? readOllamaMetadata)(providerBaseUrl(), MODEL)
    : { version: null, modelDigest: null };
  const parameters: ArmHarnessParameters = {
    modelId: MODEL,
    temperature: MODEL_TEMPERATURE,
    modelCallAbortMs: MODEL_CALL_TIMEOUT_MS,
    taskTimeoutMs: { ...taskTimeoutMs },
    retryPolicy: {
      providerMaxRetries: MODEL_PROVIDER_MAX_RETRIES,
      outer: MODEL_RETRY_POLICY,
    },
    providerClient:
      MODEL_CONFIG.provider === 'openai.chat'
        ? '@ai-sdk/openai chat-completions through Mastra'
        : MODEL_CONFIG.provider,
    providerBaseUrl: providerBaseUrl(),
    contextLimitTokens: configuredContextLimit(customBaseUrl),
    structuredOutputMode: env.OPENAI_JSON_MODE,
    modelSeed: null,
    skillSandboxBackend: 'local',
    effectiveTemperature: warnings.some((warning) => warning.includes('(temperature)'))
      ? null
      : MODEL_TEMPERATURE,
    providerWarnings: warnings,
    ollamaVersion: ollama.version,
    ollamaModelDigest: ollama.modelDigest,
  };
  return parameters;
}

export function harnessDiagnostics(parameters: ArmHarnessParameters): ArmHarnessDiagnostics {
  const { effectiveTemperature, providerWarnings, ollamaVersion, ollamaModelDigest } = parameters;
  return { effectiveTemperature, providerWarnings, ollamaVersion, ollamaModelDigest };
}

/** Snapshot provider facts once, copy them to both arms, then assert parity. */
export function evaluationHarnessParameters(
  taskTimeoutMs: Record<string, number>,
  dependencies: HarnessParityDependencies = {},
): EvaluationHarnessParameters {
  const shared = armParameters(taskTimeoutMs, dependencies);
  const parameters = {
    day0: structuredClone(shared),
    baseline: structuredClone(shared),
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
