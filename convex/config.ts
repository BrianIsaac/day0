import { query } from './_generated/server';
import { SURFACE_MODE } from '../src/lib/surface-mode';

/** Return the non-secret surface mode for consistent UI labels. */
export const surfaceMode = query({
  args: {},
  handler: (): { mode: 'mock' | 'real'; label: string } => ({
    mode: SURFACE_MODE,
    label: SURFACE_MODE === 'real' ? 'real (local)' : 'mock',
  }),
});
