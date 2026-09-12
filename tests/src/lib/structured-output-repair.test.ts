import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import fixtures from '../../fixtures/structured-output/glm-missing-actions.json';
import { executeSchema, generatedActionSchema } from '../../../src/work/execute-skill';
import { agentJsonWithMode } from '../../../src/lib/mastra';
import { env } from '../../../src/env';
import { log } from '../../../src/lib/logger';

const priya = fixtures[0];
const schemaFor = (fixture: (typeof fixtures)[number]) =>
  executeSchema.extend({
    actions: z.array(generatedActionSchema).min(fixture.actionsMinimum),
  });
const violation = (fixture: { message: string; value: unknown }) =>
  Object.assign(new Error(fixture.message), {
    id: 'STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED',
    details: { value: JSON.stringify(fixture.value) },
  });

afterEach(() => {
  env.OPENAI_STRUCTURED_REPAIR_ATTEMPTS = 2;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('prompt-mode structured repair', () => {
  it.each(fixtures)('captures the live missing-action failure for $taskId', (fixture) => {
    const result = schemaFor(fixture).safeParse(fixture.value);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ code: 'too_small', path: ['actions'], minimum: 2 }),
      );
  });

  it('feeds the actual schema error and rejected object back before one bounded replacement', async () => {
    const schema = schemaFor(priya);
    const valid = structuredClone(priya.value);
    valid.actions.push({
      tool: 'slack.postMessage',
      args: {
        channelSlug: 'dm-manager',
        threadKey: null,
        body: 'Prepared the requested Priya verification message.',
      },
    });
    expect(schema.safeParse(valid).success).toBe(true);
    const generate = vi
      .fn()
      .mockRejectedValueOnce(violation(priya))
      .mockResolvedValueOnce({ object: valid });
    const agent = { name: 'fixture-executor', generate } as unknown as Agent;
    const result = await agentJsonWithMode({
      agent,
      user: 'Original task',
      schema,
      mode: 'prompt',
    });
    expect(result.value).toEqual(valid);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0]).toContain('actions');
    expect(generate.mock.calls[1][0]).toContain('>=2');
    expect(generate.mock.calls[1][0]).toContain(JSON.stringify(priya.value));
  });

  it.each(['native', 'prompt'] as const)(
    'keeps a valid first %s reply on its original request and return path',
    async (mode) => {
      const object = { answer: 'unchanged' };
      const generate = vi.fn().mockResolvedValue({ object });
      const schema = z.object({ answer: z.string() });
      const agent = { name: 'valid-control', generate } as unknown as Agent;
      const result = await agentJsonWithMode({ agent, user: 'Original task', schema, mode });
      expect(result.value).toBe(object);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(generate.mock.calls[0][0]).toBe('Original task');
      expect(generate.mock.calls[0][1].structuredOutput).toEqual({
        schema,
        jsonPromptInjection: mode === 'prompt',
      });
    },
  );
});

describe('repair bounds and evidence', () => {
  it('uses the latest validation error on the second repair and records both attempts', async () => {
    const info = vi.spyOn(log, 'info');
    const second = Object.assign(new Error('notes: expected string, received number'), {
      id: 'STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED',
      details: { value: '{"notes":42}' },
    });
    const generate = vi
      .fn()
      .mockRejectedValueOnce(violation(priya))
      .mockRejectedValueOnce(second)
      .mockResolvedValueOnce({ object: { ok: true } });
    await agentJsonWithMode({
      agent: { name: 'bounds', generate } as unknown as Agent,
      user: 'Original',
      schema: {},
      mode: 'prompt',
    });
    expect(generate.mock.calls[2][0]).toContain('notes: expected string');
    expect(generate.mock.calls[2][0]).toContain('{"notes":42}');
    expect(generate.mock.calls[2][0]).not.toContain(priya.message);
    expect(info).toHaveBeenLastCalledWith('structured-output-call', {
      diagnostics: expect.objectContaining({
        firstReplyValid: false,
        validationFailures: 2,
        repairAttempts: 2,
        coercions: 0,
        outcome: 'valid',
      }),
    });
  });

  it('fails closed at the cap and records exhausted repairs', async () => {
    const info = vi.spyOn(log, 'info');
    const generate = vi.fn().mockRejectedValue(violation(priya));
    await expect(
      agentJsonWithMode({
        agent: { name: 'exhausted', generate } as unknown as Agent,
        user: 'Original',
        schema: {},
        mode: 'prompt',
      }),
    ).rejects.toThrow('did not satisfy the schema');
    expect(generate).toHaveBeenCalledTimes(3);
    expect(info).toHaveBeenLastCalledWith('structured-output-call', {
      diagnostics: expect.objectContaining({
        validationFailures: 3,
        repairAttempts: 2,
        coercions: 0,
        outcome: 'failed',
      }),
    });
  });

  it.each(['disabled', 'native'])('preserves the old failure path when %s', async (setting) => {
    if (setting === 'disabled') env.OPENAI_STRUCTURED_REPAIR_ATTEMPTS = 0;
    const generate = vi.fn().mockRejectedValue(violation(priya));
    await expect(
      agentJsonWithMode({
        agent: { name: setting, generate } as unknown as Agent,
        user: 'Original',
        schema: {},
        mode: setting === 'native' ? 'native' : 'prompt',
      }),
    ).rejects.toThrow('did not satisfy the schema');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each([
    new TypeError('local bug'),
    Object.assign(new Error('payment required'), { statusCode: 402 }),
    Object.assign(new Error('unauthorised'), { statusCode: 401 }),
  ])('does not treat transport or local errors as repairable schemas: %s', async (error) => {
    const info = vi.spyOn(log, 'info');
    const generate = vi.fn().mockRejectedValue(error);
    await expect(
      agentJsonWithMode({
        agent: { name: 'unrelated', generate } as unknown as Agent,
        user: 'Original',
        schema: {},
        mode: 'prompt',
      }),
    ).rejects.toBe(error);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenLastCalledWith('structured-output-call', {
      diagnostics: expect.objectContaining({
        firstReplyValid: null,
        validationFailures: 0,
        repairAttempts: 0,
        coercions: 0,
        outcome: 'failed',
      }),
    });
  });

  it.each(fixtures)(
    'repairs captured wrapper and schema through real Mastra for $captureId',
    async (fixture) => {
      const requests: Record<string, unknown>[] = [];
      const valid = structuredClone(fixture.value);
      valid.actions.push({
        tool: 'slack.postMessage',
        args: { channelSlug: 'dm-manager', threadKey: null, body: 'Requested message prepared.' },
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_input: unknown, init?: RequestInit) => {
          requests.push(JSON.parse(String(init?.body)));
          return new Response(
            JSON.stringify({
              id: 'reply',
              created: 1,
              model: 'test',
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: {
                    role: 'assistant',
                    content: requests.length === 1 ? fixture.raw : JSON.stringify(valid),
                  },
                },
              ],
              usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }),
      );
      const { createOpenAI } = await import('@ai-sdk/openai');
      const { Agent: RealAgent } = await import('@mastra/core/agent');
      const agent = new RealAgent({
        id: 'captured',
        name: 'captured',
        instructions: 'Return the required actions.',
        model: createOpenAI({ apiKey: 'test-key', baseURL: 'https://example.test/v1' }).chat(
          'test',
        ),
      });
      const result = await agentJsonWithMode({
        agent,
        user: 'Preserve the request and loaded procedures.',
        schema: schemaFor(fixture),
        mode: 'prompt',
      });
      expect(result.value).toEqual(valid);
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1])).toContain('Too small');
      expect(requests[0]).not.toHaveProperty('response_format');
    },
  );

  it.each(['native', 'prompt'] as const)(
    'preserves the complete first %s wire request when the switch is toggled for valid JSON',
    async (mode) => {
      const requests: unknown[] = [];
      vi.stubEnv('OPENAI_API_KEY', 'test-key');
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_input: unknown, init?: RequestInit) => {
          requests.push(JSON.parse(String(init?.body)));
          return new Response(
            JSON.stringify({
              id: 'resp_test',
              created_at: 1,
              model: 'test',
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  id: 'msg_test',
                  content: [{ type: 'output_text', text: '{"ok":true}', annotations: [] }],
                },
              ],
              usage: { input_tokens: 20, output_tokens: 5 },
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }),
      );
      const info = vi.spyOn(log, 'info');
      const { createOpenAI } = await import('@ai-sdk/openai');
      const { Agent: RealAgent } = await import('@mastra/core/agent');
      const agent = new RealAgent({
        id: 'wire-control',
        name: 'wire-control',
        instructions: 'Return JSON.',
        model: createOpenAI({ apiKey: 'test-key' }).responses('gpt-5.6-terra'),
      });
      const schema = z.object({ ok: z.boolean() });
      for (const attempts of [0, 2]) {
        env.OPENAI_STRUCTURED_REPAIR_ATTEMPTS = attempts;
        await expect(
          agentJsonWithMode({ agent, user: 'Original', schema, mode }),
        ).resolves.toMatchObject({ value: { ok: true } });
      }
      expect(requests[0]).toEqual(requests[1]);
      expect(info).toHaveBeenLastCalledWith('structured-output-call', {
        diagnostics: expect.objectContaining({
          firstReplyValid: true,
          repairAttempts: 0,
          coercions: 0,
          outcome: 'valid',
        }),
      });
    },
  );
});

it('retries a transient repair request without restarting the original response or its schema budget', async () => {
  vi.useFakeTimers();
  try {
    const generate = vi
      .fn()
      .mockRejectedValueOnce(violation(priya))
      .mockRejectedValueOnce(
        Object.assign(new Error('temporary service error'), { statusCode: 503 }),
      )
      .mockResolvedValueOnce({ object: { ok: true } });
    const result = agentJsonWithMode({
      agent: { name: 'transient-repair', generate } as unknown as Agent,
      user: 'Original',
      schema: {},
      mode: 'prompt',
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toMatchObject({ value: { ok: true } });
    expect(generate).toHaveBeenCalledTimes(3);
    expect(generate.mock.calls[0][0]).toBe('Original');
    expect(generate.mock.calls[1][0]).toContain('Structured response correction');
    expect(generate.mock.calls[2][0]).toBe(generate.mock.calls[1][0]);
  } finally {
    vi.useRealTimers();
  }
});

it('never retries a schema failure as transport because the agent name sounds transient', async () => {
  vi.useFakeTimers();
  try {
    const generate = vi.fn().mockRejectedValue(violation(priya));
    const result = agentJsonWithMode({
      agent: { name: 'temporary-rate-limit-reviewer', generate } as unknown as Agent,
      user: 'Original', schema: {}, mode: 'prompt',
    });
    const rejected = expect(result).rejects.toThrow('did not satisfy the schema');
    await vi.runAllTimersAsync();
    await rejected;
    expect(generate).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});
