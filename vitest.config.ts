import { defineConfig } from 'vitest/config';

export default defineConfig({
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
        test: {
          name: 'node',
          include: ['tests/src/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});
