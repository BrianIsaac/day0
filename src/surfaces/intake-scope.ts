/**
 * The queues one employee reads on a work-bearing surface.
 *
 * Signatures only; the behaviour lands with the change that makes its tests
 * pass.
 */

export type ScopeField = 'team' | 'project' | 'channel';

export interface ScopePage {
  sourceId?: string;
  ref: string;
  markdown: string;
}

export interface ScopeValue {
  value: string;
  sourceId?: string;
  ref: string;
  quote: string;
}

export interface ScopeCandidate extends ScopeValue {
  field: ScopeField;
}

export interface IntakeScope {
  team?: ScopeValue;
  project?: ScopeValue;
  channels?: ScopeValue[];
  notes?: string[];
}

export interface ScopePick {
  field: ScopeField;
  value: string;
  ref: string;
}

export interface IntakeScopePresentation {
  line: string;
  empty: boolean;
  quotes: ScopeValue[];
  notes: string[];
}

export function scopeFieldsFor(_surfaceClass: string): ScopeField[] {
  void [_surfaceClass];
  return [];
}

export function scopeCandidates(
  _pages: readonly ScopePage[],
  _fields: readonly ScopeField[],
): ScopeCandidate[] {
  void [_pages, _fields];
  return [];
}

export function groundScopePicks(
  _picks: readonly ScopePick[],
  _candidates: readonly ScopeCandidate[],
): IntakeScope {
  void [_picks, _candidates];
  return {};
}

export function sentenceScopePicks(
  _sentences: readonly string[],
  _candidates: readonly ScopeCandidate[],
): ScopePick[] {
  void [_sentences, _candidates];
  return [];
}

export function approvedLinearScope(_scope: IntakeScope): { team?: string; project?: string } {
  void [_scope];
  return {};
}

export function approvedChannelNames(_scope: IntakeScope): string[] {
  void [_scope];
  return [];
}

export function emptyScopeReason(_system: string, _surfaceClass: string): string {
  void [_system, _surfaceClass];
  return '';
}

export function presentIntakeScope(
  _system: string,
  _surfaceClass: string,
  _scope: IntakeScope,
): IntakeScopePresentation {
  void [_system, _surfaceClass, _scope];
  return { line: '', empty: true, quotes: [], notes: [] };
}

export function scopeDrift(_scope: IntakeScope, _pages: readonly ScopePage[]): ScopeValue[] {
  void [_scope, _pages];
  return [];
}
