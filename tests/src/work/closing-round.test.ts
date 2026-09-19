import { describe, expect, it } from 'vitest';
import {
  WITHHELD_BY_CLAIM_PREFIX,
  heldItemsOfWithheldRows,
  listedHeldItem,
  withheldByClaim,
  withheldByClaimReason,
  withheldWithClaimedWrite,
  withheldWithClaimedWriteReason,
  type HeldExternalItem,
} from '../../../src/work/claim-key';
import { appliedLedgerPrompt } from '../../../src/work/execute-skill';
import type { AppliedAction } from '../../../src/surfaces/types';
import {
  OPS_REQUESTS_ASK_TITLE,
  revopsAsksClosing,
  revopsAsksClosingLedger,
} from '../../fixtures/work/full-run-4-2026-09-19-revops-asks';

/**
 * The pieces behind the one extra closing round (finding W, 19 September):
 * which holders a set's executor was told of, which held items a ledger's
 * withheld rows were withheld for, and what the second authoring is shown.
 */

const SLUG = 'looker-pipeline-tile';
const tile = { slug: SLUG, class: 'analytics', path: 'browser-driven' };
const slack = { slug: 'slack', class: 'chat', path: 'documented-api' };
const linear = { slug: 'linear', class: 'kanban', path: 'mcp' };

const field: HeldExternalItem = {
  externalId: 'Pipeline coverage', sourceSystem: SLUG, holderName: 'Priya', sameEmployee: true,
  title: OPS_REQUESTS_ASK_TITLE, state: 'executing', pageField: true,
};
const ticket: HeldExternalItem = {
  externalId: 'REVOPS-27', externalAlias: '0d3c7f5e-aaaa-4bbb-8ccc-1234567890ab', sourceSystem: 'linear',
  holderName: 'Priya', sameEmployee: true, title: 'Refresh the Looker pipeline tile', state: 'claimed',
};

describe('which holders a closing set was authored under', (): void => {
  it('matches a page field by its documented label on a browser-driven surface, whatever the case', (): void => {
    expect(listedHeldItem([ticket, field], ['pipeline coverage'], tile)).toBe(field);
    expect(listedHeldItem([{ externalId: 'PIPELINE COVERAGE ', pageField: true }], ['pipeline coverage'], tile)).toBeDefined();
  });

  it('never matches a page field on a surface that is not browser-driven, nor another field', (): void => {
    expect(listedHeldItem([field], ['pipeline coverage'], linear)).toBeUndefined();
    expect(listedHeldItem([field], ['win rate'], tile)).toBeUndefined();
  });

  it('matches a ticket by either name and never by a longer id', (): void => {
    expect(listedHeldItem([ticket], ['revops-27'], linear)).toBe(ticket);
    expect(listedHeldItem([ticket], ['0D3C7F5E-AAAA-4BBB-8CCC-1234567890AB'], linear)).toBe(ticket);
    expect(listedHeldItem([ticket], ['REVOPS-271'], linear)).toBeUndefined();
    expect(listedHeldItem([], ['REVOPS-27'], linear)).toBeUndefined();
  });
});

describe("the held items a ledger's withheld rows were withheld for", (): void => {
  it("reads the run's two withheld rows as the one page field, once", (): void => {
    expect(heldItemsOfWithheldRows(revopsAsksClosing, revopsAsksClosingLedger, [ticket, field], [tile, slack])).toEqual([field]);
  });

  it('finds nothing when no row was withheld for a claim, or the holder is no longer listed', (): void => {
    const landed: AppliedAction[] = revopsAsksClosingLedger.map((row) => ({ ...row, held: undefined, reason: undefined }));
    expect(heldItemsOfWithheldRows(revopsAsksClosing, landed, [field], [tile, slack])).toEqual([]);
    expect(heldItemsOfWithheldRows(revopsAsksClosing, revopsAsksClosingLedger, [ticket], [tile, slack])).toEqual([]);
  });
});

describe('a message withheld with a claimed write', (): void => {
  const claim = withheldByClaimReason({
    target: `the page field "pipeline coverage" on ${SLUG}`, holderName: 'Priya', sameEmployee: true,
    title: OPS_REQUESTS_ASK_TITLE, state: 'executing',
  });
  const reason = withheldWithClaimedWriteReason(claim);

  it("carries the holder's line and is not itself a claim-withheld write", (): void => {
    expect(reason).toContain(`is held by this employee's work item "${OPS_REQUESTS_ASK_TITLE}" (executing)`);
    expect(reason).not.toContain(WITHHELD_BY_CLAIM_PREFIX);
    expect(withheldWithClaimedWrite({ held: true, reason })).toBe(true);
    expect(withheldByClaim({ held: true, reason })).toBe(false);
    expect(withheldWithClaimedWrite({ held: true, reason: claim })).toBe(false);
    expect(withheldWithClaimedWrite({ reason })).toBe(false);
  });

  it('shows the second authoring why a row was withheld, and leaves every other row as it was printed', (): void => {
    const prompt = appliedLedgerPrompt(revopsAsksClosing, [
      ...revopsAsksClosingLedger.slice(0, 3),
      { ...revopsAsksClosingLedger[3]!, held: true, reason, effect: 'http.request slack · POST /chat.postMessage' },
    ]).split('\n');
    expect(prompt[0]).toContain(`held · `);
    expect(prompt[0]).toContain(`· withheld for another work item's claim: the page field "pipeline coverage"`);
    expect(prompt[1]).toContain(`· withheld for another work item's claim: `);
    expect(prompt[2]).toMatch(/· browser_snapshot on looker-pipeline-tile · visible figure 68%$/);
    expect(prompt[3]).toContain('· withheld with the write it reports: ');
    const awaiting = appliedLedgerPrompt(revopsAsksClosing.slice(0, 1), [
      { tool: 'mcp.call', ok: true, held: true, reason: 'awaiting approval', effect: 'mcp.call fill', idempotencyKey: 'k' },
    ]);
    expect(awaiting).toMatch(/· mcp\.call fill$/);
  });
});
