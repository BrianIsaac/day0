import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { FETCH_GUARD_SETUP_FILE } from '../../setup/fetch-under-fake-clock';

/**
 * The nested run `tests/setup/fetch-under-fake-clock.test.ts` drives: the guard as the only
 * setup file, over one fixture test, in the two environments the suite's projects use.
 */
export default defineConfig({
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  test: {
    projects: (['node', 'edge-runtime'] as const).map((environment) => ({
      test: {
        name: environment,
        include: ['tests/fixtures/fake-clock-fetch/*.fixture.ts'],
        setupFiles: [FETCH_GUARD_SETUP_FILE],
        environment,
      },
    })),
  },
});
