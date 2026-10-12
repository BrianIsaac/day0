import { registerHooks } from 'node:module';

/*
 * Loaded with `--import` ahead of the signed-in markup script: `convex/react` and
 * `next/navigation` resolve to the doubles beside this file, for `import` and `require` alike,
 * so the product's own components render from a fixture with no backend and no router.
 */
const DOUBLES = {
  'convex/react': new URL('./convex-react.ts', import.meta.url).href,
  'next/navigation': new URL('./next-navigation.ts', import.meta.url).href,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const double = DOUBLES[specifier];
    return double ? { url: double, shortCircuit: true } : nextResolve(specifier, context);
  },
});
