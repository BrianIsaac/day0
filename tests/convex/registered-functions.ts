/*
 * What a Convex module registers, read off its exports: a helpers split moves no registered
 * function (its `api.*` and `internal.*` path is a string the app, the actions and the scheduler
 * hold), and a module's mirror test pins the list by this.
 */

/** What Convex sets on a function a module exports. */
interface RegisteredFunction {
  readonly isQuery?: boolean;
  readonly isMutation?: boolean;
  readonly isAction?: boolean;
  readonly isPublic?: boolean;
  readonly exportArgs?: () => string;
}

/**
 * A module's registered functions, each as its name, its visibility and its kind, sorted.
 *
 * @param module - The module's namespace, as `import * as` gives it.
 */
export function registeredIn(module: object): string[] {
  return Object.entries(module as Record<string, RegisteredFunction | undefined>)
    .filter(([, value]) => value?.exportArgs !== undefined)
    .map(([name, value]) => {
      const kind = value?.isQuery ? 'query' : value?.isMutation ? 'mutation' : 'action';
      return `${name} ${value?.isPublic === true ? 'public' : 'internal'} ${kind}`;
    })
    .sort((left, right) => left.localeCompare(right));
}
