import { describe, expect, it } from 'vitest';
import { carriedDeclaredReads } from '../../../src/work/promised-reads';
import type { MockAction } from '../../../src/work/types';
import { log1RefusedClosing } from '../../fixtures/work/full-run-3-2026-09-19-log-1';

const linear = { slug: 'linear', displayName: 'Linear' };
const slack = { slug: 'slack', displayName: 'Slack' };
const tile = { slug: 'looker', displayName: 'Looker pipeline tile' };
const surfaces = [
  { slug: 'linear', path: 'mcp' as const },
  { slug: 'slack', path: 'documented-api' as const },
  { slug: 'looker', path: 'browser-driven' as const },
];

const snapshot: MockAction = { tool: 'mcp.call', args: { surface: 'looker', tool: 'browser_snapshot', toolArgsJson: '{}' } };

describe('carriedDeclaredReads', () => {
  const [read, comment, done] = log1RefusedClosing.actions;

  it('returns the read LOG-1\'s refused closing set carried for its declared Linear read', (): void => {
    expect(carriedDeclaredReads([{ step: 1, surface: linear }], log1RefusedClosing.actions, surfaces)).toEqual([read]);
  });

  it('returns nothing when no read is unmet, or the set carries no read of the surface', (): void => {
    expect(carriedDeclaredReads([], log1RefusedClosing.actions, surfaces)).toEqual([]);
    expect(carriedDeclaredReads([{ step: 1, surface: linear }], [comment!, done!], surfaces)).toEqual([]);
  });

  it('returns nothing unless every unmet read is covered: a half-covered gap is still the gate\'s to refuse', (): void => {
    const unmet = [{ step: 1, surface: linear }, { step: 4, surface: slack }];
    expect(carriedDeclaredReads(unmet, log1RefusedClosing.actions, surfaces)).toEqual([]);
  });

  it('never takes a write for a read, and never applies a browser read with no page behind it', (): void => {
    expect(carriedDeclaredReads([{ step: 3, surface: linear }], [comment!], surfaces)).toEqual([]);
    expect(carriedDeclaredReads([{ step: 2, surface: tile }], [snapshot], surfaces)).toEqual([]);
  });
});
