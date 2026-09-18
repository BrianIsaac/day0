import { describe, expect, it } from 'vitest';
import {
  awaitsManagerProposal,
  charterNamesWorkSystems,
  namedByCharter,
  type DiscoveryEvidenceLike,
} from '../../../src/surfaces/charter-cards';

const documented: DiscoveryEvidenceLike = { kind: 'documentation', current: true };
const named: DiscoveryEvidenceLike = { kind: 'charter', current: true };
const retired: DiscoveryEvidenceLike = { kind: 'charter', current: false };

describe('which documented systems become cards', (): void => {
  it('counts only work systems as a charter naming systems', (): void => {
    expect(charterNamesWorkSystems(undefined)).toBe(false);
    expect(charterNamesWorkSystems([])).toBe(false);
    expect(charterNamesWorkSystems([{ class: 'docs' }])).toBe(false);
    expect(charterNamesWorkSystems([{ class: 'docs' }, { class: 'kanban' }])).toBe(true);
  });

  it('reads the charter naming a system from a current charter entry only', (): void => {
    expect(namedByCharter({ discoveryEvidence: [documented, named] })).toBe(true);
    expect(namedByCharter({ discoveryEvidence: [documented, retired] })).toBe(false);
    expect(namedByCharter({ discoveryEvidence: [documented] })).toBe(false);
    expect(namedByCharter({})).toBe(false);
  });

  it('holds back a declared system the charter does not name, and only then', (): void => {
    const unnamed = { verdict: 'declared', discoveryEvidence: [documented] };
    expect(awaitsManagerProposal(unnamed, true)).toBe(true);
    expect(awaitsManagerProposal(unnamed, false)).toBe(false);
    expect(awaitsManagerProposal({ ...unnamed, discoveryEvidence: [documented, named] }, true)).toBe(
      false,
    );
    expect(awaitsManagerProposal({ ...unnamed, verdict: 'proposed' }, true)).toBe(false);
    expect(awaitsManagerProposal({ ...unnamed, verdict: 'connected' }, true)).toBe(false);
  });
});
