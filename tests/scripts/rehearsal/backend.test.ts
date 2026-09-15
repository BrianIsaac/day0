import { describe, expect, it } from 'vitest';
import {
  agentNamed,
  allSourcesSynced,
  batchHeld,
  competingClaims,
  failedSource,
  orientationDone,
  skipKind,
  surfaceSummary,
  ticketItem,
  type SurfaceRow,
  type WorkItemRow,
} from '../../../scripts/rehearsal/backend';

function surface(slug: string, verdict: string): SurfaceRow {
  return { _id: slug, slug, displayName: slug, class: 'x', verdict, credentialLanded: false };
}

function item(overrides: Partial<WorkItemRow>): WorkItemRow {
  return {
    _id: 'w1',
    sourceSystem: 'linear',
    externalId: 'REVOPS-7',
    title: 'REVOPS-7 refresh the tile',
    state: 'discovered',
    ...overrides,
  };
}

describe('selections over the backend rows', (): void => {
  it('finds the deployed agent by name and the linked sources once every one has synced', (): void => {
    const agents = [
      { _id: 'a2', name: 'worker 1', state: 'deployed', createdAt: 2 },
      { _id: 'a1', name: 'other', state: 'active', createdAt: 1 },
    ];
    expect(agentNamed(agents, 'worker 1')?._id).toBe('a2');
    expect(agentNamed(agents, 'nobody')).toBeUndefined();
    expect(allSourcesSynced([])).toBe(false);
    expect(allSourcesSynced([{ _id: 's', label: 'team', status: 'linking', pageCount: 0 }])).toBe(false);
    expect(allSourcesSynced([{ _id: 's', label: 'team', status: 'synced', pageCount: 7 }])).toBe(true);
    const errored = { _id: 's', label: 'team', status: 'error', pageCount: 0, lastError: 'redactor' };
    expect(failedSource([errored])).toBe(errored);
  });

  it('reads orientation as done when nothing is declared and the three cards exist', (): void => {
    expect(orientationDone([])).toBe(false);
    expect(orientationDone([surface('linear', 'declared')])).toBe(false);
    const cards = [
      surface('linear', 'proposed'),
      surface('slack', 'proposed'),
      surface('northstar-crm', 'absent'),
    ];
    expect(orientationDone(cards)).toBe(false);
    expect(orientationDone([...cards, surface('looker-pipeline-tile', 'proposed')])).toBe(true);
    expect(surfaceSummary(cards)).toBe('linear: proposed, slack: proposed, northstar-crm: absent');
  });

  it('finds the ticket item by its identifier and the claims that compete with it', (): void => {
    const items = [
      item({ _id: 'w0', externalId: 'C0BS/1787746453.202809', title: 'Slack mention', state: 'claimed' }),
      item({ _id: 'w1', externalId: 'REVOPS-7', state: 'needs-skill' }),
      item({ _id: 'w2', externalId: 'REVOPS-5', title: 'REVOPS-5 audit', state: 'skipped' }),
    ];
    expect(ticketItem(items)?._id).toBe('w1');
    expect(ticketItem(items, 'REVOPS-5')?._id).toBe('w2');
    expect(ticketItem([], 'REVOPS-7')).toBeUndefined();
    expect(competingClaims(items, 'w1').map((row) => row._id)).toEqual(['w0']);
  });

  it('classes a skip and reads a held batch', (): void => {
    expect(skipKind({ skipReason: 'quality-fit-fail: bare ticket' })).toBe('quality-fit');
    expect(skipKind({ skipReason: 'out-of-scope: no charter or current documented-system overlap' })).toBe(
      'out-of-scope',
    );
    expect(skipKind({ skipReason: 'low-value: 1' })).toBe('other');
    expect(skipKind({})).toBe('other');
    expect(batchHeld({ state: 'actions-pending', actionVerdicts: [{ disposition: 'auto' }, { disposition: 'held' }] })).toBe(true);
    expect(batchHeld({ state: 'actions-pending', actionVerdicts: [{ disposition: 'auto' }] })).toBe(false);
    expect(batchHeld({ state: 'executing', actionVerdicts: [{ disposition: 'held' }] })).toBe(false);
  });
});
