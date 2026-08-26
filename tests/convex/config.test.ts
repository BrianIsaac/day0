import { describe, expect, it } from 'vitest';
import { convexTest } from 'convex-test';
import { api } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';

describe('public surface configuration', (): void => {
  it('returns only the mock mode and its public label', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await expect(harness.query(api.config.surfaceMode, {})).resolves.toEqual({
      mode: 'mock',
      label: 'mock',
    });
  });
});
