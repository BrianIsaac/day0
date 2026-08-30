import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, modelName } from '../../../src/lib/model-name';

describe('model name', (): void => {
  it('falls back to the shipped default when unset or empty', (): void => {
    expect(modelName({})).toBe(DEFAULT_MODEL);
    expect(modelName({ OPENAI_MODEL: '' })).toBe(DEFAULT_MODEL);
    expect(modelName({ OPENAI_MODEL: ' qwen3:8b ' })).toBe('qwen3:8b');
  });
});
