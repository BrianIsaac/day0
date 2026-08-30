declare global {
  interface ImportMeta {
    /** Vite's lazy glob import, available to vitest at runtime. */
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

/**
 * Every Convex module, for node-environment tests that drive actions whose
 * call graph spans the deployment (charter approval, orientation). Modules
 * are loaded lazily, so a test that resets the module registry to change
 * the surface mode gets freshly evaluated modules on the next harness call.
 *
 * Returns:
 *   A convex-test module map keyed by path relative to this file.
 */
export function allConvexModules(): Record<string, () => Promise<unknown>> {
  return import.meta.glob('../../convex/**/*.ts');
}
