/**
 * A branded agent id: a phantom property at compile time, a plain string at
 * runtime, so a Convex `Id<'agents'>` stays distinct from an arbitrary
 * string without a runtime cost.
 */

declare const brand: unique symbol;

/** An agent's id as the work types carry it. */
export type AgentId = string & { readonly [brand]: 'agents' };

/** Brand a string that is known to be an agent id. */
export const asAgentId = (value: string): AgentId => value as AgentId;
