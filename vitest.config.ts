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
    projects: [
      {
        test: {
          name: 'convex',
          include: ['tests/convex/**/*.test.ts'],
          environment: 'edge-runtime',
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
          include: [
            'tests/*.test.ts',
            'tests/fake-slack/**/*.test.ts',
            'tests/looker-tile/**/*.test.ts',
            'tests/src/**/*.test.ts',
            'tests/app/**/*.test.ts',
            'tests/app/**/*.test.tsx',
            'tests/scripts/**/*.test.ts',
          ],
          environment: 'node',
        },
      },
    ],
  },
});
