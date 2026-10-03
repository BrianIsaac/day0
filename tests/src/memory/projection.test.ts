import { describe, expect, it } from 'vitest';
import {
  PROJECTION_CUT_NOTE,
  PROJECTION_LIMIT,
  projectKnowledge,
  type ProjectionInput,
} from '../../../src/memory/projection';

const approvedAt = Date.UTC(2026, 8, 26, 6, 23);

/** Mira as the record prototype draws her. */
function mira(overrides: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    name: 'Mira',
    managerEmail: 'sam@revops.example',
    zone: 'Asia/Singapore',
    charter: {
      version: '0.1',
      approvedAt,
      body: {
        proposedFunction: 'Own triage for tier-2 asks in #revops-asks.',
        proposedBoundaries: {
          willDo: ['Draft replies to tier-2 asks.'],
          willNotDo: ['Touch forecasting.'],
          escalationTriggers: ['A customer names a contract.'],
        },
        namedCollaborators: [
          { name: 'Priya', topic: 'segment and pipeline' },
          { name: 'Aman', topic: 'forecasting' },
        ],
        adjacentRoles: [{ who: 'Aman', staysOutOfTheirLaneBy: 'leaving forecasts to him' }],
        constraints: [
          { kind: 'system-boundary', quote: 'Only post in #revops-asks.', wording: [] },
          { kind: 'reporting-line', quote: 'Copy Sara on escalations.', wording: [], struck: true },
        ],
        answeredQuestions: [
          { question: 'What topic should Sara be contacted about?', answer: 'Renewals.' },
        ],
      },
    },
    agreements: ['Name the ticket in every reply.'],
    skills: [
      { name: 'see-internal-docs', sourceType: 'builtin' },
      { name: 'kanban-comment-and-close', sourceType: 'agent-authored' },
    ],
    surfaces: [
      { displayName: 'Slack', verdict: 'connected', expiresAt: Date.UTC(2026, 11, 25, 4) },
      { displayName: 'Looker', verdict: 'proposed' },
    ],
    documentation: ['RevOps runbooks'],
    office: 'real',
    ...overrides,
  };
}

describe('projectKnowledge', (): void => {
  it('projects the charter, people, agreements, skills, connections and documentation', (): void => {
    const { text, cut } = projectKnowledge(mira());
    expect(cut).toBe(false);
    expect(text.split('\n')).toEqual([
      'Charter 0.1, approved 26 Sep 2026: Own triage for tier-2 asks in #revops-asks.',
      'Will do: Draft replies to tier-2 asks.',
      'Will not do: Touch forecasting.',
      'Escalates when: A customer names a contract.',
      'Rules you confirmed: Only post in #revops-asks.',
      'Rules you struck: Copy Sara on escalations.',
      'Answered: What topic should Sara be contacted about? Renewals.',
      'People: you (sam@revops.example, manager), Priya (segment and pipeline), Aman (forecasting)',
      "  stays out of Aman's lane: leaving forecasts to him",
      'Working agreements: Name the ticket in every reply.',
      'Skills: see-internal-docs (built in), kanban-comment-and-close',
      'Connections: Slack (connected until 25 Dec 2026), Looker (waiting for you)',
      'Documentation: RevOps runbooks',
    ]);
  });

  it('says what is not there yet before the first approval', (): void => {
    const { text } = projectKnowledge(
      mira({ charter: null, agreements: [], skills: [], surfaces: [], documentation: [] }),
    );
    expect(text.split('\n')).toEqual([
      'Charter: none approved yet.',
      'People: you (sam@revops.example, manager)',
      'Working agreements: none kept yet',
      'Skills: none registered yet',
      'Connections: none yet',
      'Documentation: none linked',
    ]);
  });

  it('reads an older charter body that lacks every field without throwing', (): void => {
    const { text } = projectKnowledge(mira({ charter: { version: '0.1', body: null } }));
    expect(text.split('\n')[0]).toBe('Charter 0.1: no function written');
  });

  it('stays within 4,000 characters, cut at a word and said to be cut', (): void => {
    const agreements = Array.from(
      { length: 120 },
      (_, index) => `Agreement ${index} about how replies are worded.`,
    );
    const { text, cut } = projectKnowledge(mira({ agreements }));
    expect(cut).toBe(true);
    expect(text.length).toBeLessThanOrEqual(PROJECTION_LIMIT);
    expect(text.endsWith(`\n${PROJECTION_CUT_NOTE}`)).toBe(true);
    expect(text).toContain('Charter 0.1');
    expect(text).not.toContain('Skills:');
    const partial = text.split('\n').at(-2) ?? '';
    expect(partial.startsWith('Working agreements: ')).toBe(true);
    expect(partial).toMatch(/\S$/);
  });

  it('says a declared connection is being looked into, not waiting for the manager', (): void => {
    const { text } = projectKnowledge(
      mira({ surfaces: [{ displayName: 'Looker', verdict: 'declared' }] }),
    );
    expect(text).toContain('Connections: Looker (being looked into)');
  });

  it("names the mock office's systems and whom the employee acts as there, in the Surfaces tab's words (round 0141 R-D item 3)", (): void => {
    const { text } = projectKnowledge(mira({ office: 'mock', surfaces: [] }));
    expect(text.split('\n')).toContain(
      "Connections: the mock office's Slack, Spreadsheet, Docs, Tickets and Social; acts as Mira, its own app in this office",
    );
    expect(text).not.toContain('Connections: none yet');
  });
});
