import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

/**
 * Next 16 dropped `next lint` and eslint-config-next now ships native
 * flat configs, so the FlatCompat bridge this file used to carry is
 * gone. `pnpm lint` runs the ESLint CLI directly.
 *
 * The one scoped downgrade below keeps the gate honest: the finding
 * still prints on every run, it just does not fail the build over a
 * pattern that pre-dates the lint runner working at all.
 */
const config = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    files: ['app/**/*.tsx'],
    rules: {
      // react-hooks v7 (new with Next 16) flags the effects that mirror
      // Convex rows into local UI state. They are deliberate and
      // correct; reworking them as derived state is its own change.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'convex/_generated/**',
      '.claude/**',
      'docs/**',
      'docs-fixture/**',
      'docs-local/**',
    ],
  },
];

export default config;
