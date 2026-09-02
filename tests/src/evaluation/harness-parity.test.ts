import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertEvaluationHarnessParity,
  evaluationHarnessParameters,
  harnessDiagnostics,
  INTENTIONAL_ARM_DIFFERENCES,
  type EvaluationHarnessParameters,
} from '../../../src/evaluation/harness-parity';

const taskTimeoutMs = {
  read: 240_000,
  write: 300_000,
  scope: 180_000,
};

afterEach((): void => {
  vi.unstubAllEnvs();
});

describe('evaluation harness parity', (): void => {
  it('keeps every harness and model knob identical across arms', (): void => {
    const parameters = evaluationHarnessParameters(taskTimeoutMs);

    expect(parameters.day0).toEqual(parameters.baseline);
    expect(parameters.day0.retryPolicy.providerMaxRetries).toBe(2);
    expect(() => assertEvaluationHarnessParity(parameters)).not.toThrow();
    expect(Object.keys(parameters.day0).sort()).toEqual([
      'contextLimitTokens',
      'effectiveTemperature',
      'modelCallAbortMs',
      'modelId',
      'modelSeed',
      'ollamaModelDigest',
      'ollamaVersion',
      'providerBaseUrl',
      'providerClient',
      'providerWarnings',
      'retryPolicy',
      'skillVerificationSandboxBackend',
      'structuredOutputMode',
      'taskTimeoutMs',
      'temperature',
    ]);
  });

  it('fails closed when any arm parameter diverges', (): void => {
    const parameters = evaluationHarnessParameters(taskTimeoutMs);
    const divergent: EvaluationHarnessParameters = {
      ...parameters,
      baseline: { ...parameters.baseline, temperature: parameters.baseline.temperature + 0.1 },
    };

    expect(() => assertEvaluationHarnessParity(divergent)).toThrow(
      'evaluation harness differs between arms: temperature',
    );
  });

  it('records the provider endpoint used inside the evaluation backend', (): void => {
    vi.stubEnv('CONVEX_OPENAI_BASE_URL', 'http://model:11434/v1');

    const parameters = evaluationHarnessParameters(taskTimeoutMs, {
      readOllamaMetadata: () => ({ version: '0.32.9', modelDigest: 'sha256:bed-model' }),
    });

    expect(parameters.day0.providerBaseUrl).toBe('http://model:11434/v1');
    expect(parameters.baseline.providerBaseUrl).toBe('http://model:11434/v1');
    expect(harnessDiagnostics(parameters.day0)).toMatchObject({
      ollamaVersion: '0.32.9',
      ollamaModelDigest: 'sha256:bed-model',
    });
  });

  it('normalises an empty backend base URL and ignores host Ollama context for hosted OpenAI', (): void => {
    vi.stubEnv('CONVEX_OPENAI_BASE_URL', '');
    vi.stubEnv('OLLAMA_CONTEXT_LENGTH', '16384');

    const parameters = evaluationHarnessParameters(taskTimeoutMs);
    const diagnostics = harnessDiagnostics(parameters.day0);

    expect(parameters.day0.providerBaseUrl).toBe('https://api.openai.com/v1');
    expect(parameters.day0.providerClient).toBe(
      '@ai-sdk/openai chat-completions through Mastra',
    );
    expect(parameters.day0.contextLimitTokens).toBeNull();
    expect(diagnostics.effectiveTemperature).toBeNull();
    expect(diagnostics.providerWarnings).toContain(
      'unsupported (temperature): temperature is not supported for reasoning models',
    );
  });

  it('whitelists only the two intentional onboarding-mechanism differences', (): void => {
    expect(Object.keys(INTENTIONAL_ARM_DIFFERENCES)).toEqual([
      'onboardingPipeline',
      'executionTurn',
    ]);
    expect(INTENTIONAL_ARM_DIFFERENCES.onboardingPipeline).toEqual({
      day0: 'runtime charter, loaded documents, approved plan, and exact-action gate',
      baseline: 'none',
    });
    expect(INTENTIONAL_ARM_DIFFERENCES.executionTurn).toEqual({
      day0: 'one governed structured executor turn after onboarding',
      baseline: 'one five-tool in-generation loop',
    });
  });
});
