import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { KnowledgeProjection } from '../../../../../app/agent/[agentId]/record/KnowledgeProjection';
import { projectKnowledge } from '../../../../../src/memory/projection';

/** Mira's projection, made from rows by the projector the backend runs. */
const projection = projectKnowledge({
  name: 'Mira',
  managerEmail: 'sam@revops.example',
  zone: 'UTC',
  charter: {
    version: '0.1',
    approvedAt: Date.UTC(2026, 8, 26),
    body: { proposedFunction: 'Own triage for tier-2 asks in #revops-asks.' },
  },
  agreements: [],
  skills: [{ name: 'see-internal-docs', sourceType: 'builtin' }],
  surfaces: [{ displayName: 'Slack', verdict: 'connected', expiresAt: Date.UTC(2026, 11, 25) }],
  documentation: [],
});

describe('KnowledgeProjection', (): void => {
  it('draws the projection behind a disclosure, under the employee’s name, for the manager only', (): void => {
    const html = renderToStaticMarkup(<KnowledgeProjection name="Mira" projection={projection} />);
    expect(html).toContain('>What Mira knows</h2>');
    expect(html).toContain('regenerated on change');
    expect(html).toContain('Mira never reads it; it is for you.');
    expect(html).toMatch(/<details[^>]*>(?!.*<details).*Read the projection/s);
    expect(html).toContain(
      'Charter 0.1, approved 26 Sep 2026: Own triage for tier-2 asks in #revops-asks.',
    );
    expect(html).toContain('Connections: Slack (connected until 25 Dec 2026)');
    expect(html).not.toContain('Cut at 4,000 characters');
  });

  it('says it is loading rather than drawing an empty projection, and says when one was cut', (): void => {
    const loading = renderToStaticMarkup(
      <KnowledgeProjection name="Mira" projection={undefined} />,
    );
    expect(loading).toContain('Loading the projection');
    expect(loading).not.toContain('Read the projection');
    const cut = renderToStaticMarkup(
      <KnowledgeProjection name="Mira" projection={{ text: 'Charter 0.1', cut: true }} />,
    );
    expect(cut).toContain('Cut at 4,000 characters, the projection&#x27;s bound.');
  });
});
