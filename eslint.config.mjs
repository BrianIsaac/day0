import coreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

/**
 * Next 16 dropped the `next lint` command and `eslint-config-next` now ships
 * flat configs directly, so these are spread rather than pulled through
 * `FlatCompat`. `pnpm lint` runs `eslint .`.
 */
const config = [
  ...coreWebVitals,
  ...nextTypescript,
  {
    ignores: ['.next/**', 'node_modules/**', 'convex/_generated/**'],
  },
];

export default config;
