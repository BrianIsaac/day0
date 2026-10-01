import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CharterCardBody } from '../../../../../app/agent/[agentId]/charter/CharterCard';
import { CharterDocument } from '../../../../../app/agent/[agentId]/charter/CharterDocument';
import { AgentZoneContext } from '../../../../../app/components/time';

const body: CharterCardBody = {
  whyThisHire: 'Small RevOps team needs relief from tier-2 asks.',
  proposedFunction: 'Own triage for owned, prioritized tier-2 asks.',
  shortTermGoals: {
    day30: 'Produce clean tier-2 answer drafts.',
    day60: 'No day-60 milestone was stated. Tier-2 triage continues.',
    day90: 'Cover close-week tracker maintenance.',
  },
  proposedBoundaries: {
    willDo: ['Triage owned, prioritized tier-2 asks.', 'Draft tier-2 answers.'],
    willNotDo: ['Edit Salesforce records.', 'Own forecasting work assigned to Aman.'],
    escalationTriggers: ['An ask needs escalation.'],
  },
  namedCollaborators: [{ name: 'Priya', topic: 'segment and pipeline' }],
  namedSystems: [
    { name: 'Salesforce', class: 'crm', whereMentioned: 'read-only' },
    { name: 'Slack', class: 'chat', whereMentioned: '#revops-asks' },
  ],
  priorityReading: ['team-overview', 'escalation-paths'],
  openQuestions: ['Whether dbt PR access is needed.', 'What topic Sara should be contacted about.'],
};

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<AgentZoneContext value="UTC">{node}</AgentZoneContext>);
}

describe('the charter as one document', (): void => {
  it('opens every section, draws the 60-day gap as a gap, and names the systems on one line', (): void => {
    const html = render(
      <CharterDocument
        body={body}
        manager="sam@kestrel.example"
        strikes={{ pending: true, changes: [] }}
      />,
    );
    for (const title of [
      'Why this hire',
      'Proposed function',
      'Will do',
      'Will not do',
      'Escalates when',
      'Reports to',
      'Systems named',
      'People',
      'Priority reading',
      'Open questions',
    ]) {
      expect(html).toContain(`>${title}</h3>`);
    }
    expect(html).not.toContain('<details');
    expect(html.match(/data-goal="gap"/g)).toHaveLength(1);
    expect(html).toContain('60 days · no goal stated');
    expect(html).toContain('<p>Salesforce (crm), Slack (chat)</p>');
    expect(html).toContain('<b class="font-semibold">Priya</b>, segment and pipeline');
  });

  it('names the manager it reports to and sends a handover to People, never to the header', (): void => {
    const html = render(
      <CharterDocument
        body={body}
        manager="sam@kestrel.example"
        peopleHref="/agent/agent-1/people"
        strikes={{ pending: true, changes: [] }}
      />,
    );
    expect(html).not.toContain('change it there');
    expect(html).not.toContain('named in the header');
    // The address on its own line, never opening a sentence; the sentence names no control
    // People may not offer (an evaluation employee, an unverified sign-in; second pass).
    expect(html).toContain('<p class="font-mono [overflow-wrap:anywhere]">sam@kestrel.example</p>');
    expect(html).toMatch(
      /<p>Handovers to another manager are on <a [^>]*href="\/agent\/agent-1\/people"[^>]*>People<\/a>\.<\/p>/,
    );
  });

  it('names who struck, answered and added on the record, as the actors say', (): void => {
    const approved: CharterCardBody = {
      ...body,
      proposedBoundaries: {
        ...body.proposedBoundaries,
        willDo: ['Triage tier-2 asks.', 'Draft tier-2 answers.'],
        willNotDo: ['Edit Salesforce records.'],
      },
      openQuestions: [],
      answeredQuestions: [
        {
          question: 'What topic Sara should be contacted about.',
          answer: 'Ad-hoc asks.',
          answeredAt: '2026-09-29T14:38:00.000Z',
        },
      ],
    };
    const html = render(
      <CharterDocument
        body={approved}
        actors={{
          struck: () => 'sam@kestrel.example',
          answered: () => 'sam@kestrel.example',
          added: () => 'you',
        }}
        strikes={{
          pending: false,
          changes: [
            { field: 'willNotDo', text: 'Own forecasting work assigned to Aman.' },
            {
              field: 'willDo',
              text: 'Triage owned, prioritized tier-2 asks.',
              rewrittenAs: 'Triage tier-2 asks.',
            },
          ],
        }}
      />,
    );
    expect(html).toMatch(
      /<s[^>]*>Own forecasting work assigned to Aman\.<\/s> struck by sam@kestrel\.example/,
    );
    expect(html).toMatch(/\(before the strike by sam@kestrel\.example: <s[^>]*>Triage owned/);
    expect(html).toMatch(/answered by sam@kestrel\.example at [^<]*14:38/);
    expect(html).not.toContain('by you');
    expect(html).not.toContain('your strike');
  });

  it("strikes in place the clauses a draft's strikes will take out, and says so", (): void => {
    const html = render(
      <CharterDocument
        body={body}
        strikes={{
          pending: true,
          changes: [
            { field: 'willNotDo', text: 'Own forecasting work assigned to Aman.' },
            {
              field: 'willDo',
              text: 'Triage owned, prioritized tier-2 asks.',
              rewrittenAs: 'Triage tier-2 asks.',
            },
          ],
        }}
      />,
    );
    expect(html).toMatch(
      /<s[^>]*>Own forecasting work assigned to Aman\.<\/s> leaves the charter on approval/,
    );
    expect(html).toMatch(
      /<s[^>]*>Triage owned, prioritized tier-2 asks\.<\/s> on approval reads:<\/span> <span[^>]*>Triage tier-2 asks\.<\/span>/,
    );
  });

  it('keeps on the record what the strikes took out, struck, and writes the answered question in', (): void => {
    const approved: CharterCardBody = {
      ...body,
      proposedBoundaries: { ...body.proposedBoundaries, willNotDo: ['Edit Salesforce records.'] },
      openQuestions: ['Whether dbt PR access is needed.'],
      answeredQuestions: [
        {
          question: 'What topic Sara should be contacted about.',
          answer: 'Ad-hoc asks and the on-call rota.',
          answeredAt: '2026-09-29T14:38:00.000Z',
        },
      ],
    };
    const html = render(
      <CharterDocument
        body={approved}
        strikes={{
          pending: false,
          changes: [{ field: 'willNotDo', text: 'Own forecasting work assigned to Aman.' }],
        }}
      />,
    );
    expect(html).toMatch(/<li>Edit Salesforce records\.<\/li>/);
    expect(html).toMatch(/<s[^>]*>Own forecasting work assigned to Aman\.<\/s> struck by you/);
    // Walk m20: an answered question carries a check and its answer, never the struck rule's mark.
    expect(html).not.toMatch(/<s[^>]*>What topic Sara/);
    expect(html).toMatch(
      /<li class="relative list-none"><svg aria-hidden="true"[^>]*>.*?<\/svg>What topic Sara should be contacted about\.<span[^>]*>answered by you at [^<]*14:38[^<]*: <span[^>]*>Ad-hoc asks and the on-call rota\.<\/span><\/span><\/li>/,
    );
    expect(html).toContain('<li>Whether dbt PR access is needed.</li>');
  });

  it('shows no strike on a function an amendment has rewritten since, nor on a clause put back', (): void => {
    const html = render(
      <CharterDocument
        body={{ ...body, proposedFunction: 'Own the finance close.' }}
        strikes={{
          pending: false,
          changes: [
            {
              field: 'proposedFunction',
              text: 'Own triage for owned, prioritized tier-2 asks.',
              rewrittenAs: 'Own triage for tier-2 asks.',
            },
            { field: 'willNotDo', text: 'Edit Salesforce records.' },
          ],
        }}
      />,
    );
    expect(html).toContain('<p>Own the finance close.</p>');
    expect(html).not.toContain('before your strike');
    expect(html).not.toMatch(/<s[^>]*>Edit Salesforce records\.<\/s>/);
    expect(html).toContain('<li>Edit Salesforce records.</li>');
  });
});
