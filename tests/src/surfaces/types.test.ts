import { describe, expect, expectTypeOf, it } from 'vitest';
import { isSurfacePath } from '../../../src/surfaces/types';
import type { AppliedAction, SurfaceAdapter } from '../../../src/surfaces/types';

describe('surface contracts', (): void => {
  it('recognises only supported discovery paths', (): void => {
    expect(isSurfacePath('mcp')).toBe(true);
    expect(isSurfacePath('browser-driven')).toBe(true);
    expect(isSurfacePath('custom-adapter')).toBe(false);
    expect(isSurfacePath(null)).toBe(false);
  });

  it('keeps ledger and adapter fields typed', (): void => {
    expectTypeOf<AppliedAction>().toHaveProperty('idempotencyKey');
    expectTypeOf<AppliedAction>().toHaveProperty('providerId');
    expectTypeOf<SurfaceAdapter>().toHaveProperty('apply');
  });
});
