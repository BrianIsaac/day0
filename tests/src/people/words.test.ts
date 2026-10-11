import { describe, expect, it } from 'vitest';
import {
  edgeLine,
  evidenceText,
  identityLabel,
  possiblySameLine,
  proposedChangeLine,
  proposedEdgeLine,
  proposedInMock,
  readsInMock,
  relationshipNoun,
  waitingLine,
} from '../../../src/people/words';

describe('people words', (): void => {
  it('says that Take looks a proposed address up, and nothing of a lookup where no address is proposed (W14-R18)', (): void => {
    expect(
      proposedChangeLine('Team directory', {
        title: 'Head of revenue operations',
        primaryEmail: 'priya.shah@kestrel.test',
      }),
    ).toBe(
      'Team directory proposes a change: title \u201cHead of revenue operations\u201d, address priya.shah@kestrel.test. What you confirmed stays until you take it. Take looks the new address up in Slack and Linear, and drops the accounts Day0 found by the old one.',
    );
    expect(proposedChangeLine('Team directory', { team: 'Finance' })).toBe(
      'Team directory proposes a change: team \u201cFinance\u201d. What you confirmed stays until you take it.',
    );
  });

  it("shows a table row's quote as words, without its cell bars or code marks", (): void => {
    expect(evidenceText('| Slack | `#ops-requests` asks | Noor Rahman |')).toBe(
      'Slack · #ops-requests asks · Noor Rahman',
    );
    expect(evidenceText('Priya Shah for pipeline.')).toBe('Priya Shah for pipeline.');
  });

  it('says an edge once, with no stop left before what follows it', (): void => {
    expect(edgeLine('collaborator', 'Raising requests through the manager.', '6 Oct', false)).toBe(
      'Collaborator: Raising requests through the manager · since 6 Oct',
    );
    expect(edgeLine('approver', 'NetLedger access', '6 Oct', true)).toBe(
      'Approver: NetLedger access · since 6 Oct · for everyone you manage',
    );
  });

  it('says a proposed edge and one waiting on a confirmed person in one form', (): void => {
    expect(proposedEdgeLine('collaborator', 'Linear access.')).toBe('Collaborator: Linear access.');
    expect(waitingLine('collaborator', 'Linear access')).toBe(
      'Collaborator: Linear access (waiting on you).',
    );
    expect(proposedEdgeLine('dotted-line contact', undefined)).toBe('Dotted-line contact.');
  });

  it('tells two people of one name apart by role and standing', (): void => {
    expect(possiblySameLine('Lee Tan', 'proposed')).toBe(
      'Possibly the same as Lee Tan (also proposed).',
    );
    expect(possiblySameLine('Lee Tan', 'confirmed', 'Linear admin')).toBe(
      'Possibly the same as Lee Tan, Linear admin (already confirmed).',
    );
  });

  it('names an identity and a relationship read from a stored row', (): void => {
    expect(identityLabel({ provider: 'slack', externalId: 'U1', displayName: 'lee' })).toBe(
      'Slack @lee',
    );
    expect(relationshipNoun('approval-authority')).toBe('approver');
    expect(relationshipNoun(undefined)).toBe('relationship');
  });
});

describe('the Proposed card in the hosted office (13-FD)', (): void => {
  it('says what a deployment of your own does, of the hosted office as every mock-mode sentence does', (): void => {
    expect(proposedInMock('Mira')).toBe(
      'In a deployment of your own, Mira proposes people from the one-to-one and your documentation for you to confirm. The hosted office keeps the names the one-to-one gave the charter, below.',
    );
    expect(proposedInMock('Mira')).not.toMatch(/this demo|[\u2013\u2014]/i);
  });
});

describe('what the employee reads from People in the hosted office (13-FD)', (): void => {
  it('says the employee reads the people as its charter names them, where no graph is kept', (): void => {
    expect(readsInMock('Mira')).toBe(
      'The hosted office keeps no graph, so Mira reads the people only as its charter names them.',
    );
    expect(readsInMock('Mira')).not.toMatch(/regenerated|[\u2013\u2014]/);
  });
});
