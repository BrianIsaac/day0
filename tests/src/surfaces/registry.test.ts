import { describe, expect, it } from 'vitest';
import { MOCK_TOOLS, mockAdapter } from '../../../src/surfaces/mock';
import { resolveAdapters } from '../../../src/surfaces/registry';

describe('surface adapter registry', (): void => {
  it.each(['mock', 'real'] as const)(
    'keeps every legacy mock verb available in %s mode',
    (mode): void => {
      const adapters = resolveAdapters(mode, []);
      expect([...adapters.keys()]).toEqual(MOCK_TOOLS);
      for (const tool of MOCK_TOOLS) expect(adapters.get(tool)).toBe(mockAdapter);
    },
  );
});
