import { describe, expect, it } from 'vitest';
import { internal } from '../../convex/_generated/api';

describe('orientation data boundary', (): void => {
  it('exposes only internal queries', (): void => {
    expect(internal.orientationData.pagesForAgent).toBeDefined();
    expect(internal.orientationData.surfacesForAgent).toBeDefined();
  });
});
