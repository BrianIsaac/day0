/**
 * Branded id types — phantom property at compile time, plain string at
 * runtime. Keeps Convex `Id<'agents'>` etc. distinct from arbitrary
 * strings without paying a runtime cost.
 */

declare const _brand: unique symbol;

export type AgentId = string & { readonly [_brand]: 'agents' };
export type CharterId = string & { readonly [_brand]: 'charters' };
export type WorkItemId = string & { readonly [_brand]: 'workItems' };
export type SkillId = string & { readonly [_brand]: 'skills' };
export type VoiceSessionId = string & { readonly [_brand]: 'voiceSessions' };

export const asAgentId = (s: string): AgentId => s as AgentId;
export const asCharterId = (s: string): CharterId => s as CharterId;
export const asWorkItemId = (s: string): WorkItemId => s as WorkItemId;
export const asSkillId = (s: string): SkillId => s as SkillId;
export const asVoiceSessionId = (s: string): VoiceSessionId => s as VoiceSessionId;
