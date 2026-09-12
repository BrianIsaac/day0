import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import fixtures from '../../fixtures/structured-output/glm-missing-actions.json';
import { executeSchema, generatedActionSchema } from '../../../src/work/execute-skill';
import { agentJsonWithMode } from '../../../src/lib/mastra';

const priya = fixtures[0];
const schemaFor = (fixture: (typeof fixtures)[number]) => executeSchema.extend({
  actions: z.array(generatedActionSchema).min(fixture.actionsMinimum),
});
const violation = (fixture: { message: string; value: unknown }) => Object.assign(new Error(fixture.message), {
  id: 'STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED',
  details: { value: JSON.stringify(fixture.value) },
});

afterEach(() => vi.unstubAllEnvs());

describe('prompt-mode structured repair', () => {
  it.each(fixtures)('captures the live missing-action failure for $taskId', (fixture) => {
    const result = schemaFor(fixture).safeParse(fixture.value);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({ code: 'too_small', path: ['actions'], minimum: 2 }));
  });

  it.fails('feeds the actual schema error and rejected object back before one bounded replacement', async () => {
    const schema = schemaFor(priya);
    const valid = structuredClone(priya.value);
    valid.actions.push({ tool: 'slack.postMessage', args: { channelSlug: 'dm-manager', threadKey: null, body: 'Prepared the requested Priya verification message.' } });
    expect(schema.safeParse(valid).success).toBe(true);
    const generate = vi.fn().mockRejectedValueOnce(violation(priya)).mockResolvedValueOnce({ object: valid });
    const agent = { name: 'fixture-executor', generate } as unknown as Agent;
    const result = await agentJsonWithMode({ agent, user: 'Original task', schema, mode: 'prompt' });
    expect(result.value).toEqual(valid);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0]).toContain('actions');
    expect(generate.mock.calls[1][0]).toContain('>=2');
    expect(generate.mock.calls[1][0]).toContain(JSON.stringify(priya.value));
  });

  it.each(['native', 'prompt'] as const)('keeps a valid first %s reply on its original request and return path', async (mode) => {
    const object = { answer: 'unchanged' };
    const generate = vi.fn().mockResolvedValue({ object });
    const schema = z.object({ answer: z.string() });
    const agent = { name: 'valid-control', generate } as unknown as Agent;
    const result = await agentJsonWithMode({ agent, user: 'Original task', schema, mode });
    expect(result.value).toBe(object);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0]).toBe('Original task');
    expect(generate.mock.calls[0][1].structuredOutput).toEqual({ schema, jsonPromptInjection: mode === 'prompt' });
  });
});
