import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@convex',
        replacement: fileURLToPath(new URL('./convex', import.meta.url)),
      },
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
    ],
  },
  test: {
    passWithNoTests: true,
    // One zone for every run, the runner's and a developer's alike, so a
    // test that formats a time reads the same text everywhere. UTC, because
    // the pinned backend image runs in it; code that needs another zone names
    // it (`src/lib/zone.ts`).
    env: { TZ: 'UTC' },
    projects: [
      {
        test: {
          name: 'convex',
          include: ['tests/convex/**/*.test.ts'],
          setupFiles: ['tests/setup/clean-env.ts'],
          environment: 'edge-runtime',
          // The first test of a file that resets the module registry imports
          // every Convex module again: over a second on a quiet machine, and
          // past the 5 s default when several suites share the cores.
          testTimeout: 20_000,
        },
      },
      {
        resolve: {
          alias: [
            {
              find: '@convex',
              replacement: fileURLToPath(new URL('./convex', import.meta.url)),
            },
            { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
          ],
        },
        test: {
          name: 'node',
          setupFiles: ['tests/setup/clean-env.ts'],
          include: [
            'tests/*.test.ts',
            'tests/setup/**/*.test.ts',
            'tests/fake-slack/**/*.test.ts',
            'tests/looker-tile/**/*.test.ts',
            'tests/src/**/*.test.ts',
            'tests/app/**/*.test.ts',
            'tests/app/**/*.test.tsx',
            // The browser job's pure helpers; its specs are Playwright's (`*.spec.ts`).
            'tests/browser/**/*.test.ts',
            'tests/evaluation/**/*.test.ts',
            'tests/scripts/**/*.test.ts',
            'tests/bed/**/*.test.ts',
            'evaluation/gate/**/*.test.ts',
          ],
          environment: 'node',
          // The script tests spawn processes, which a loaded machine starts slowly.
          testTimeout: 20_000,
        },
      },
    ],
  },
});
