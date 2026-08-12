import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

/**
 * Next 16 dropped `next lint` and eslint-config-next now ships native
 * flat configs, so the FlatCompat bridge this file used to carry is
 * gone. `pnpm lint` runs the ESLint CLI directly.
 *
 * The two scoped downgrades below keep the gate honest: both findings
 * still print on every run, they just don't fail the build over
 * patterns that pre-date the lint runner working at all.
 */
const config = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    files: ['convex/**/*.ts'],
    rules: {
      // Convex actions annotate their `ctx` params as `any` on purpose —
      // the generated `api` types otherwise close a circular inference
      // loop through the action that references them. `any` stays an
      // error everywhere outside convex/.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
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
    ignores: ['.next/**', 'node_modules/**', 'convex/_generated/**'],
  },
];

export default config;
