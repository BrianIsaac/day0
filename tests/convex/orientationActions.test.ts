/** @vitest-environment node */

import { describe, expect, it } from 'vitest';
import {
  evidenceLine,
  explicitlyDeniesSurface,
  registryRemoteEndpoint,
  relevantSystemText,
} from '../../convex/orientationActions';

describe('orientation evidence selection', (): void => {
  it('returns the exact documentation line naming a system', (): void => {
    expect(evidenceLine('# Systems\nUse Linear for the queue.\n', 'Linear')).toBe(
      'Use Linear for the queue.',
    );
    expect(evidenceLine('# Systems\nNo match.\n', 'Slack')).toBeUndefined();
  });

  it('does not apply another system denial to the named system', (): void => {
    const page = [
      '# Systems',
      '',
      '| Linear | Formal queue |',
      '| Northstar CRM | No approved connection surface is recorded. |',
    ].join('\n');
    expect(explicitlyDeniesSurface(page, 'Linear')).toBe(false);
    expect(explicitlyDeniesSurface(page, 'Northstar CRM')).toBe(true);
    const queue = [
      '## REVOPS-402',
      '',
      '- Source: Linear project `REVOPS`',
      '- Request: inspect Northstar CRM.',
      '- Acceptance: if no approved surface exists, ask the manager.',
    ].join('\n');
    expect(explicitlyDeniesSurface(queue, 'Linear')).toBe(false);
  });

  it('uses the whole content of a dedicated runbook', (): void => {
    const page = '# How to update Linear\n\nUse MCP.\n\nEndpoint: https://mcp.linear.app/mcp';
    expect(relevantSystemText(page, 'Linear')).toContain('https://mcp.linear.app/mcp');
  });

  it('selects a matching Streamable HTTP registry remote only', (): void => {
    const payload = {
      servers: [
        {
          server: {
            name: 'app.linear/linear',
            title: 'Linear',
            remotes: [
              { type: 'sse', url: 'https://mcp.linear.app/sse' },
              { type: 'streamable-http', url: 'https://mcp.linear.app/mcp' },
            ],
          },
        },
      ],
    };
    expect(registryRemoteEndpoint(payload, 'Linear')).toBe('https://mcp.linear.app/mcp');
    expect(registryRemoteEndpoint(payload, 'Unrelated CRM')).toBeUndefined();
  });
});
