/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agents from "../agents.js";
import type * as charters from "../charters.js";
import type * as coworker from "../coworker.js";
import type * as events from "../events.js";
import type * as mock from "../mock.js";
import type * as mockSeed from "../mockSeed.js";
import type * as onboarding from "../onboarding.js";
import type * as reset from "../reset.js";
import type * as seed from "../seed.js";
import type * as skillActions from "../skillActions.js";
import type * as skills from "../skills.js";
import type * as voice from "../voice.js";
import type * as work from "../work.js";
import type * as workActions from "../workActions.js";
import type * as workspace from "../workspace.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agents: typeof agents;
  charters: typeof charters;
  coworker: typeof coworker;
  events: typeof events;
  mock: typeof mock;
  mockSeed: typeof mockSeed;
  onboarding: typeof onboarding;
  reset: typeof reset;
  seed: typeof seed;
  skillActions: typeof skillActions;
  skills: typeof skills;
  voice: typeof voice;
  work: typeof work;
  workActions: typeof workActions;
  workspace: typeof workspace;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
