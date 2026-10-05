import { describe, expect, it } from 'vitest';
import {
  edgeHeldAt,
  edgeInForce,
  resolveMatches,
  scopeCovers,
  type EdgeSpan,
} from '../../../src/people/resolution';

/** An edge the manager confirmed at 10, in force from 10. */
const confirmed: EdgeSpan = { status: 'active', effectiveFrom: 10, confirmedAt: 10 };

describe('people resolution', (): void => {
  it('answers one person for matches that all name the same person, however many identities they came through', (): void => {
    expect(resolveMatches(['p1'])).toEqual({ kind: 'person', personId: 'p1' });
    expect(resolveMatches(['p1', 'p1'])).toEqual({ kind: 'person', personId: 'p1' });
  });

  it('answers ambiguous with the count for matches naming two people, and never picks one', (): void => {
    expect(resolveMatches(['p1', 'p2', 'p1'])).toEqual({ kind: 'ambiguous', candidates: 2 });
  });

  it('answers unknown for no match, never a guess', (): void => {
    expect(resolveMatches([])).toEqual({ kind: 'unknown' });
  });

  it('holds a confirmed edge from when it took effect until it ended, and not after', (): void => {
    const ended: EdgeSpan = { ...confirmed, status: 'superseded', effectiveUntil: 20 };
    expect(edgeHeldAt(ended, 9)).toBe(false);
    expect(edgeHeldAt(ended, 10)).toBe(true);
    expect(edgeHeldAt(ended, 19)).toBe(true);
    expect(edgeHeldAt(ended, 20)).toBe(false);
    expect(edgeHeldAt(confirmed, 1_000)).toBe(true);
  });

  it('never holds a proposal, a disputed edge or one retired before it was ever in force', (): void => {
    expect(edgeHeldAt({ status: 'proposed', effectiveFrom: 10 }, 15)).toBe(false);
    expect(edgeHeldAt({ ...confirmed, status: 'disputed' }, 15)).toBe(false);
    expect(edgeHeldAt({ status: 'retired', effectiveFrom: 10 }, 15)).toBe(false);
  });

  it('counts only an active edge as in force now, so a retired one held in the past is not', (): void => {
    expect(edgeInForce(confirmed, 15)).toBe(true);
    const retired: EdgeSpan = { ...confirmed, status: 'retired', effectiveUntil: 20 };
    expect(edgeInForce(retired, 15)).toBe(false);
    expect(edgeHeldAt(retired, 15)).toBe(true);
  });

  it('covers a scope whose every word the edge names, in any case or order, and an unscoped edge covers every scope', (): void => {
    expect(scopeCovers('NetLedger access requests', 'netledger access')).toBe(true);
    expect(scopeCovers('Access to NetLedger', 'NetLedger')).toBe(true);
    expect(scopeCovers('NetLedger access', 'Linear access')).toBe(false);
    expect(scopeCovers(undefined, 'Linear access')).toBe(true);
  });

  it('covers no scope from words that carry no letter or digit', (): void => {
    expect(scopeCovers('NetLedger access', ' - ')).toBe(false);
  });
});
