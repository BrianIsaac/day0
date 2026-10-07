import { describe, expect, it } from 'vitest';
import { otherRolesAskThreads } from '../../../src/work/office-asks';
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
