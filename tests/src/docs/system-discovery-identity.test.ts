import { describe, expect, it } from 'vitest';
import {
  convergeDiscoveryCandidates,
  documentedSystemIdentity,
  sameSystemForHostlessMention,
  type DiscoveredSystemCandidate,
} from '../../../src/docs/system-discovery';

function candidate(
  name: string,
  className: DiscoveredSystemCandidate['class'],
  ref: string,
  quote: string,
): DiscoveredSystemCandidate {
  return { name, class: className, ref, quote };
}

describe('documentation system identity convergence', (): void => {
  it('matches a hostless manager alias to one qualified documented system', (): void => {
    const mention = documentedSystemIdentity({
      name: 'Looker',
      quotes: ['Pipeline numbers are on the Looker tile, web UI only.'],
    });
    const documented = documentedSystemIdentity({
      name: 'Looker pipeline tile',
      endpoints: ['http://looker-tile:8080/'],
    });

    expect(sameSystemForHostlessMention('analytics', mention, 'analytics', documented)).toBe(true);
    expect(sameSystemForHostlessMention('other', mention, 'analytics', documented)).toBe(false);
    expect(
      sameSystemForHostlessMention(
        'analytics',
        documentedSystemIdentity({
          name: 'Looker',
          endpoints: ['https://different-looker.example.test/'],
        }),
        'analytics',
        documented,
      ),
    ).toBe(false);
  });

  it('attaches a transport description and its page to the named system', (): void => {
    const systems = convergeDiscoveryCandidates([
      candidate(
        'Slack',
        'chat',
        'onboarding.md',
        '| Slack | #revops-asks receives inbound requests. | Messaging administrator |',
      ),
      candidate(
        'Slack Web API',
        'chat',
        'runbooks/how-to-post-slack.md',
        'The approved transport is the Slack Web API over HTTPS at `https://slack.com/api/`.',
      ),
    ]);

    expect(systems).toHaveLength(1);
    expect(systems[0]).toMatchObject({
      name: 'Slack',
      mergedNames: ['Slack Web API'],
      transportOnly: false,
      identity: { hosts: ['slack.com'] },
      evidence: [
        expect.objectContaining({ ref: 'onboarding.md' }),
        expect.objectContaining({ ref: 'runbooks/how-to-post-slack.md' }),
      ],
    });
  });

  it('merges same-class candidates on an exact documented endpoint', (): void => {
    expect(
      convergeDiscoveryCandidates([
        candidate(
          'Incident queue',
          'kanban',
          'systems/incidents.md',
          'Incident queue API: https://ops.example.test/v1/incidents',
        ),
        candidate(
          'Operations connector',
          'kanban',
          'runbooks/incidents.md',
          'Operations connector endpoint: https://ops.example.test/v1/incidents/',
        ),
      ]),
    ).toHaveLength(1);
  });

  it('merges a product and its qualified name on one documented host', (): void => {
    const systems = convergeDiscoveryCandidates([
      candidate('Slack', 'chat', 'onboarding.md', 'Slack workspace: https://slack.com/'),
      candidate(
        'Slack workspace',
        'chat',
        'runbooks/slack.md',
        'Slack workspace API: https://slack.com/api',
      ),
    ]);
    expect(systems.map((system) => system.name)).toEqual(['Slack']);
    expect(systems[0]?.mergedNames).toEqual(['Slack workspace']);
  });

  it('keeps differently named same-class systems on a shared host distinct', (): void => {
    expect(
      convergeDiscoveryCandidates([
        candidate('Linear', 'kanban', 'linear.md', 'Linear endpoint: https://api.example.com/linear'),
        candidate('Jira', 'kanban', 'jira.md', 'Jira endpoint: https://api.example.com/jira'),
      ]).map((system) => system.name),
    ).toEqual(['Linear', 'Jira']);
    expect(
      convergeDiscoveryCandidates([
        candidate('Ops portal', 'other', 'ops.md', 'Ops portal: https://tools.example.test/ops'),
        candidate('Payroll', 'other', 'payroll.md', 'Payroll: https://tools.example.test/payroll'),
      ]).map((system) => system.name),
    ).toEqual(['Ops portal', 'Payroll']);
  });

  it('keeps the documented system name over a shorter alias found later', (): void => {
    const systems = convergeDiscoveryCandidates([
      candidate(
        'Looker pipeline tile',
        'analytics',
        'systems/looker-pipeline-tile.md',
        '# Looker pipeline tile',
      ),
      candidate(
        'Looker',
        'analytics',
        'runbooks/how-to-refresh-the-tile.md',
        'Dashboard login (Looker tile): `pipeline-tile-local` (username `revops`).',
      ),
    ]);
    expect(systems.map((system) => system.name)).toEqual(['Looker pipeline tile']);
    expect(systems[0]?.mergedNames).toEqual(['Looker']);
  });

  it.each([
    ['Linear', 'Linear MCP', 'kanban'],
    ['Looker', 'Looker pipeline tile web UI', 'analytics'],
  ] as const)('treats %s and %s as a product plus transport name', (name, transport, className) => {
    expect(
      convergeDiscoveryCandidates([
        candidate(name, className, 'onboarding.md', `${name} is the team system.`),
        candidate(
          transport,
          className,
          `runbooks/${name.toLowerCase()}.md`,
          `The approved transport is the ${transport}.`,
        ),
      ]),
    ).toHaveLength(1);
  });

  it('keeps two Slack workspaces with conflicting documented hosts distinct', (): void => {
    const systems = convergeDiscoveryCandidates([
      candidate(
        'Slack Sales',
        'chat',
        'sales.md',
        'Slack Sales workspace API: https://slack.sales.example.test/api/',
      ),
      candidate(
        'Slack Support',
        'chat',
        'support.md',
        'Slack Support workspace API: https://slack.support.example.test/api/',
      ),
    ]);

    expect(systems.map((system) => system.name)).toEqual(['Slack Sales', 'Slack Support']);
  });

  it('keeps Linear and a Linear-backed internal tool on another endpoint distinct', (): void => {
    const systems = convergeDiscoveryCandidates([
      candidate(
        'Linear',
        'kanban',
        'linear.md',
        'Linear MCP endpoint: https://mcp.linear.app/mcp',
      ),
      candidate(
        'Linear-backed internal tool',
        'kanban',
        'internal-tool.md',
        'Linear-backed internal tool endpoint: https://work-router.example.test/api',
      ),
    ]);

    expect(systems.map((system) => system.name)).toEqual([
      'Linear',
      'Linear-backed internal tool',
    ]);
  });

  it('marks a transport line with no system candidate as evidence-only', (): void => {
    expect(
      convergeDiscoveryCandidates([
        candidate(
          'Slack Web API',
          'chat',
          'runbooks/how-to-post-slack.md',
          'The approved transport is the Slack Web API over HTTPS at `https://slack.com/api/`.',
        ),
      ])[0],
    ).toMatchObject({ transportOnly: true });
  });
});
