import { describe, expect, it } from 'vitest';
import {
  convergeDiscoveryCandidates,
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

  it('merges same-class candidates on a documented endpoint or host', (): void => {
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
          'Operations connector endpoint: https://ops.example.test/v2',
        ),
      ]),
    ).toHaveLength(1);
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
