import { describe, expect, it } from 'vitest';
import { otherRolesAskThreads } from '../../../src/work/office-asks';
import type { Charter } from '../../../src/agent/charter';
import { charterWords } from '../../../src/work/scope';
import { LARK, MOSS, NELL, PIP, QUILL } from '../../fixtures/agent/office-roles-2026-10-07';

describe("the office's company-wide asks by role (finding 2 of the v0.17.0 redeploy)", (): void => {
  it("names every other role's ask for each of the redeploy's five employees", (): void => {
    const drive = 'office-asks#thread-drive-access';
    const monitor = 'office-asks#thread-spare-monitor';
    const charge = 'office-asks#thread-double-charge';
    expect([...otherRolesAskThreads(charterWords(NELL))]).toEqual([monitor, charge]);
    expect([...otherRolesAskThreads(charterWords(PIP))]).toEqual([drive, monitor]);
    expect([...otherRolesAskThreads(charterWords(QUILL))]).toEqual([drive, charge]);
    expect([...otherRolesAskThreads(charterWords(LARK))]).toEqual([drive, monitor, charge]);
    expect([...otherRolesAskThreads(charterWords(MOSS))]).toEqual([drive, monitor, charge]);
  });
});

describe('the ask pool beside roles outside the redeploy five (the second pass)', (): void => {
  const role = (proposedFunction: string, willDo: string[]): Charter =>
    ({
      proposedFunction,
      proposedBoundaries: { willDo, willNotDo: [], escalationTriggers: [] },
    }) as unknown as Charter;
  const drive = 'office-asks#thread-drive-access';
  const charge = 'office-asks#thread-double-charge';

  it("shows an IT support role the drive lock-out and not the customer's invoice", (): void => {
    const others = otherRolesAskThreads(
      charterWords(
        role('Act as the IT support desk: answer password and sign-in questions.', [
          'Reset passwords with the wiki steps.',
        ]),
      ),
    );
    expect(others.has(drive)).toBe(false);
    expect(others.has(charge)).toBe(true);
  });

  it('keeps the drive lock-out from a customer support role whose clauses say access', (): void => {
    const others = otherRolesAskThreads(
      charterWords(
        role('Act as the customer support coordinator.', [
          'Give customers access to the help centre articles.',
        ]),
      ),
    );
    expect(others.has(drive)).toBe(true);
    expect(others.has(charge)).toBe(false);
  });
});
